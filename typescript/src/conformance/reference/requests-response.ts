/**
 * The two `requests-response.ts` helpers n8n's loop calls, ported beside it (see
 * `stack-reference.ts` for the port and the pinned commit its line numbers are of).
 */
import type { EngineRequest, EngineResponse, IRunNodeResponse } from 'n8n-workflow';

/** `makeEngineResponse()` (`requests-response.ts:296`). */
export function makeEngineResponse(): EngineResponse {
  return { actionResponses: [], metadata: {} } as unknown as EngineResponse;
}

/** `isEngineRequest()` (`requests-response.ts:290`). */
export function isEngineRequest(value: IRunNodeResponse | EngineRequest): value is EngineRequest {
  return !!value && 'actions' in value;
}
