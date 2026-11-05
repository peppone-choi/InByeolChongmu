import type { Analysis } from '../domain/schema.js';
import type { Message } from '../storage/store.js';
export type RunInput = {
  run_id: string;
  request_id: string;
  conversation_id: string;
  customer_handle: string;
  context_label: string;
  reference_time: string;
  expires_at?: string;
  snapshots: { products: string; policies: string; orders: string };
  history: Array<Pick<Message, 'role' | 'text' | 'request_id'>>;
  context_truncated: boolean;
};
export type AgentRun = {
  id: string;
  seller_id: string;
  request_id: string;
  conversation_id: string;
  status: 'running' | 'succeeded' | 'failed';
  input: RunInput;
  analysis: Analysis | null;
  proposed: Analysis | null;
  http_status: number | null;
  model_calls: number;
};
export type ToolTrace = {
  call_id: string;
  name: string;
  success: boolean;
  result: unknown;
};
export interface AgentRunner {
  readiness(): { ready: boolean; code: string | null };
  run(run: AgentRun): Promise<Analysis>;
  stop(): Promise<void>;
}
