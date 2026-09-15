/**
 * The host both legs of a differential run execute on: the `FakeHost` mirror with n8n's
 * enqueue available (`ReferenceHost`), plus a trace of every `runNode` start and finish.
 * The trace is what the ordering gate reads; `leg.ts` builds one host per leg.
 */
import type { SchedulerHost } from '../../n8n/host.js';
import { ReferenceHost } from '../reference/reference-host.js';
import { activationKey, type TraceEvent } from '../trace.js';

/** The host both engines run on: the `FakeHost` mirror plus a `runNode` trace. */
export class TracingHost extends ReferenceHost {
  readonly trace: TraceEvent[] = [];
  private seq = 0;
  private readonly t0 = performance.now();
  private readonly attempts = new Map<string, number>();

  override async runNode(
    ...args: Parameters<SchedulerHost['runNode']>
  ): ReturnType<SchedulerHost['runNode']> {
    const node = args[1].node.name;
    const runIndex = args[3];
    const key = activationKey(node, runIndex);
    const attempt = this.attempts.get(key) ?? 0;
    this.attempts.set(key, attempt + 1);
    this.mark('start', node, runIndex, attempt);
    try {
      return await super.runNode(...args);
    } finally {
      this.mark('finish', node, runIndex, attempt);
    }
  }

  private mark(kind: TraceEvent['kind'], node: string, runIndex: number, attempt: number): void {
    this.trace.push({ seq: this.seq++, kind, node, runIndex, attempt, at: performance.now() - this.t0 });
  }
}
