/**
 * Canned node behaviours: what `FakeHost.runNode` returns for a node, per fixture.
 */
import type { EngineRequest, EngineResponse, IExecuteData, IRunExecutionData, IRunNodeResponse } from 'n8n-workflow';
import type { FakeHost } from './fake-host.js';

export interface ScriptContext {
  readonly executionData: IExecuteData;
  readonly runIndex: number;
  readonly runExecutionData: IRunExecutionData;
  readonly host: FakeHost;
  /** How many times this node's `runNode` was called before (attempts across retries). */
  readonly call: number;
  /**
   * The `EngineResponse` the engine handed this activation — `execute(this, response)`'s second
   * argument. An agent script reads its own tool results here, which is what lets it decide
   * whether to ask again *without* keeping state in a closure: the differ runs one fixture on
   * both engines, so a stateful script would let the first run starve the second.
   */
  readonly response: EngineResponse | undefined;
}

/** A canned node: returns the `runNode` response (or throws, or returns an `EngineRequest`). */
export type NodeScript = (ctx: ScriptContext) => IRunNodeResponse | EngineRequest | Promise<IRunNodeResponse | EngineRequest>;

/** Pass-through: the first input's items become the single output (n8n's disabled-node shape). */
export const passThrough: NodeScript = ({ executionData }) => ({ data: [executionData.data.main?.[0] ?? []] });

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
