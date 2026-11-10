import type { Store } from '../storage/store.js';
import type { RoomDetail, RoomSummary } from '../domain/http-contract.js';
import { executionView } from '../agent/run-view.js';
import { extractionSources } from '../agent/extraction-sources.js';
export function roomDetail(
  store: Store,
  seller: string,
  id: string,
): RoomDetail {
  const conversation = store.conversation(seller, id),
    message = store.latestMessage(seller, id);
  const run = message ? store.runForRequest(seller, message.request_id) : null;
  const messages = store.messages(seller, id);
  return {
    conversation,
    messages,
    extraction_sources: run ? extractionSources(run, messages) : [],
    latest: message
      ? {
          request_id: message.request_id,
          text: message.text,
          snapshots: run?.input.snapshots ?? null,
          status: run?.status ?? 'received',
          expires_at: run?.input.expires_at ?? null,
          http_status: run?.http_status ?? null,
          analysis: run?.analysis ?? null,
          execution: run ? executionView(store, run) : null,
        }
      : null,
  };
}
export function roomSummary(
  store: Store,
  seller: string,
  id: string,
): RoomSummary {
  const conversation = store.conversation(seller, id),
    message = store.latestMessage(seller, id),
    run = message ? store.runForRequest(seller, message.request_id) : null;
  return {
    ...conversation,
    latest: message
      ? {
          request_id: message.request_id,
          status: run?.status ?? 'received',
          expires_at: run?.input.expires_at ?? null,
          http_status: run?.http_status ?? null,
          preview: message.text.slice(0, 200),
          analysis_status: run?.analysis?.status ?? null,
          classification: run?.analysis?.classification ?? null,
          priority: run?.analysis?.priority ?? 'normal',
        }
      : null,
  };
}
