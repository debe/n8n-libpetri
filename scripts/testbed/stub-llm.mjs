/**
 * A deterministic, offline stand-in for an OpenAI chat model, so the agent workflow exercises
 * `ai_tool` dispatch without a key, a bill or a network.
 *
 * n8n reaches it through the **credential's** `url`, not the node's `options.baseURL`:
 * `LmChatOpenAi.node.ts` only calls `assertOpenAiCredentialAllowsUrl` when `options.baseURL` is
 * set, and otherwise takes `credentials.url` unguarded.
 *
 * The script is fixed and the round is the point:
 *
 * - **First call** (no `role: "tool"` message yet) → one `tool_calls` response naming *every*
 *   tool the agent offered, in one assistant message. That is the shape the net models as a
 *   fan-out: `A_dispatch` fires per call, `A/pending` counts them, and `A_collect` is the sink
 *   that closes the round when the last one lands (ADR 0008 §1). One tool call would exercise
 *   the round; two exercise the *pending marker*, which is the part no host loop has.
 * - **Second call** (tool results present) → a plain assistant answer, `finish_reason: "stop"`,
 *   which ends the agent.
 *
 * One exception, and it is the point of the budget workflow: a prompt carrying the marker
 * `[stub:loop]` makes the stub **never** stop — every call answers with tool calls again. A
 * model that never decides it is finished is the shape a call bound exists for, and this
 * reproduces it deterministically and offline. The marker travels in the workflow's
 * own prompt text, so the workflow is self-describing in the editor and no second credential,
 * env var or seed change is needed to arm it.
 *
 * Tool names and arguments are read off the request's own `tools` array rather than hardcoded,
 * so renaming a node in the editor cannot desynchronise the stub from the workflow.
 */
import { createServer } from 'node:http';

const PORT = Number.parseInt(process.env.STUB_LLM_PORT ?? '5699', 10);
const HOST = process.env.STUB_LLM_HOST ?? '127.0.0.1';
const MODEL = 'stub-model';

/**
 * Milliseconds to wait before answering a chat completion. **Zero by default**, because every
 * timing number this repository reports is taken with the stub answering instantly, and a stub
 * that pauses would put itself into those wall clocks.
 *
 * It exists for recordings. A real model takes on the order of a second to answer and a real
 * tool a few hundred milliseconds, so an agent round has visible beats: the model thinks, a tool
 * runs, the model thinks again. With an instant stub the whole sequence collapses — the
 * escalation ladder finishes in about 700 ms — and a recording of it shows a canvas that turns
 * green all at once rather than a round unfolding. `--llm-latency` on the launcher sets this.
 */
const LATENCY_MS = Math.max(0, Number.parseInt(process.env.STUB_LLM_LATENCY_MS ?? '0', 10) || 0);

/** Fills one tool's argument object from its own JSON schema. Strings get a value the tool can use. */
function argumentsFor(tool) {
  const schema = tool?.function?.parameters ?? {};
  const properties = schema.properties ?? {};
  const required = Array.isArray(schema.required) ? schema.required : Object.keys(properties);
  const args = {};
  for (const key of required) {
    const property = properties[key] ?? {};
    if (property.type === 'number' || property.type === 'integer') args[key] = 23;
    else if (property.type === 'boolean') args[key] = true;
    else if (property.type === 'array') args[key] = [];
    else if (property.type === 'object') args[key] = {};
    // The Calculator parses this; every other tool here takes free text.
    else args[key] = '23 * 19';
  }
  return JSON.stringify(args);
}

/** Every message's text, whatever shape the content took, so a marker is found in any of them. */
function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join(' ');
  return '';
}

function reply(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const answered = messages.some((m) => m?.role === 'tool');
  // The confused agent. It never reaches `stop`, so what ends the run is whatever bound the
  // engine puts on it — which is exactly what the budget workflow measures.
  const looping = messages.some((m) => textOf(m).includes('[stub:loop]'));

  if ((looping || !answered) && tools.length > 0) {
    return {
      role: 'assistant',
      content: '',
      tool_calls: tools.map((tool, index) => ({
        id: `call_stub_${index + 1}`,
        type: 'function',
        function: { name: tool.function?.name ?? `tool_${index}`, arguments: argumentsFor(tool) },
      })),
      finish_reason: 'tool_calls',
    };
  }

  // Sorted, deliberately. The tool results arrive in whatever order the round collected them,
  // and at k > 1 the two tools run concurrently (divergence #23). An answer that echoed that
  // order would push scheduler ordering into the *data* channel, and the legacy/libpetri data
  // comparison would report a difference that is really an ordering difference — which
  // `executionOrder` and the happens-before check already measure, separately and on purpose.
  const results = messages
    .filter((m) => m?.role === 'tool')
    .map((m) => String(m.content ?? '').trim())
    .sort();
  const summary = results.length > 0 ? results.join(' | ') : 'no tools were called';
  return {
    role: 'assistant',
    content: `Both tools were dispatched in a single round and their results came back as: ${summary}.`,
    finish_reason: 'stop',
  };
}

function completion(message) {
  const { finish_reason, ...rest } = message;
  return {
    id: `chatcmpl-stub-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, message: { content: null, ...rest }, logprobs: null, finish_reason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/** Minimal SSE form of the same answer, in case a caller asks for `stream: true`. */
function stream(response, message) {
  const { finish_reason, ...rest } = message;
  const head = { id: `chatcmpl-stub-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL };
  const send = (delta, finish = null) =>
    response.write(`data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  send({ role: 'assistant' });
  if (rest.tool_calls) {
    rest.tool_calls.forEach((call, index) => send({ tool_calls: [{ index, id: call.id, type: 'function', function: call.function }] }));
  } else if (rest.content) {
    send({ content: rest.content });
  }
  send({}, finish_reason);
  response.write('data: [DONE]\n\n');
  response.end();
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

/**
 * Per-key call counters for `/flaky`, so a workflow can ask for a service that fails a fixed
 * number of times and then recovers. Keyed by the caller (the workflow passes `$execution.id`),
 * which is what makes a second run of the same workflow start from zero again.
 */
const flakyCalls = new Map();

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);

  // A service that fails `fail` times per key and then succeeds. The point of the testbed's
  // failure-policy workflow: a real HTTP node, a real non-2xx, a real n8n node error.
  if (url.pathname.endsWith('/flaky')) {
    const key = url.searchParams.get('key') ?? 'default';
    const fail = Number.parseInt(url.searchParams.get('fail') ?? '2', 10);
    const seen = (flakyCalls.get(key) ?? 0) + 1;
    flakyCalls.set(key, seen);
    if (seen <= fail) {
      return json(response, 503, { error: `flaky: call ${seen} of ${fail} fails`, call: seen });
    }
    return json(response, 200, { ok: true, call: seen, recoveredAfter: fail });
  }

  // A healthy service that simply takes a while, so a fan-out has something to overlap.
  if (url.pathname.endsWith('/slow')) {
    const ms = Math.min(30_000, Number.parseInt(url.searchParams.get('ms') ?? '1000', 10));
    const name = url.searchParams.get('name') ?? 'service';
    return setTimeout(() => json(response, 200, { ok: true, service: name, tookMs: ms }), ms);
  }

  // A service that never answers. Under `retryOnFail` a node waiting on this is held until
  // n8n's whole-execution timeout; under `executionPolicy.timeoutMs` the attempt is abandoned
  // (IO-013) and the chain escalates. The socket is deliberately left open — IO-013 is explicit
  // that abandoned work is not cancelled, and this is where that shows.
  if (url.pathname.endsWith('/hang')) {
    return; // no response, ever
  }

  if (request.method === 'GET' && url.pathname.endsWith('/models')) {
    return json(response, 200, { object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'n8n-libpetri-testbed' }] });
  }

  if (request.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(response, 400, { error: { message: 'stub-llm: request body is not JSON' } });
      }
      const message = reply(body);
      const kind = message.tool_calls ? `tool_calls(${message.tool_calls.map((c) => c.function.name).join(', ')})` : 'answer';
      process.stdout.write(`[stub-llm] ${body.messages?.length ?? 0} messages, ${body.tools?.length ?? 0} tools -> ${kind}${LATENCY_MS ? ` after ${LATENCY_MS} ms` : ''}\n`);
      const answer = () => (body.stream === true ? stream(response, message) : json(response, 200, completion(message)));
      return LATENCY_MS > 0 ? setTimeout(answer, LATENCY_MS) : answer();
    });
    return;
  }

  process.stdout.write(`[stub-llm] unhandled ${request.method} ${url.pathname}\n`);
  return json(response, 404, { error: { message: `stub-llm: no route for ${request.method} ${url.pathname}` } });
});

server.listen(PORT, HOST, () => process.stdout.write(`[stub-llm] listening on http://${HOST}:${PORT}/v1\n`));
