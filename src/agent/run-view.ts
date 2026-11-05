import type { Store } from '../storage/store.js';
import type { AgentRun } from './types.js';
import type { ExecutionView } from '../domain/http-contract.js';
export function executionView(store: Store, run: AgentRun): ExecutionView {
  return {
    run_id: run.id,
    runtime: 'flue',
    model_calls: run.model_calls,
    tool_calls: store.traces(run.id).map((trace) => {
      const pending =
        typeof trace.result === 'object' &&
        trace.result !== null &&
        'pending' in trace.result &&
        trace.result.pending === true;
      return {
        id: trace.call_id,
        name: trace.name,
        success: trace.success,
        status:
          pending && run.status === 'running'
            ? 'running'
            : trace.success
              ? 'succeeded'
              : 'failed',
      };
    }),
  };
}
