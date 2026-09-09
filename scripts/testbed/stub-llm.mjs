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
 * Tool names and arguments are read off the request's own `tools` array rather than hardcoded,
 * so renaming a node in the editor cannot desynchronise the stub from the workflow.
 */
import { createServer } from 'node:http';

const PORT = Number.parseInt(process.env.STUB_LLM_PORT ?? '5699', 10);
const HOST = process.env.STUB_LLM_HOST ?? '127.0.0.1';
const MODEL = 'stub-model';

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

function reply(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const answered = messages.some((m) => m?.role === 'tool');

  if (!answered && tools.length > 0) {
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

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);

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
      process.stdout.write(`[stub-llm] ${body.messages?.length ?? 0} messages, ${body.tools?.length ?? 0} tools -> ${kind}\n`);
      if (body.stream === true) return stream(response, message);
      return json(response, 200, completion(message));
    });
    return;
  }

  process.stdout.write(`[stub-llm] unhandled ${request.method} ${url.pathname}\n`);
  return json(response, 404, { error: { message: `stub-llm: no route for ${request.method} ${url.pathname}` } });
});

server.listen(PORT, HOST, () => process.stdout.write(`[stub-llm] listening on http://${HOST}:${PORT}/v1\n`));
