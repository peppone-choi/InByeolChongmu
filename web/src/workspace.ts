import { api, ApiError, type Api } from './api.js';
import type {
  Health,
  Resources,
  RoomDetail,
  RoomSummary,
  ChatResult,
} from '../../src/domain/http-contract.js';
import type { ChatRequest } from '../../src/domain/schema.js';
type Pending = {
  input: ChatRequest;
  sending: boolean;
  error: string | null;
  terminal: boolean;
};
export type State = {
  loading: boolean;
  authenticated: boolean;
  error: string | null;
  health: Health | null;
  resources: Resources | null;
  rooms: RoomSummary[];
  details: Record<string, RoomDetail>;
  activeId: string | null;
  pending: Record<string, Pending>;
};
export class Workspace {
  private state: State = {
    loading: true,
    authenticated: false,
    error: null,
    health: null,
    resources: null,
    rooms: [],
    details: {},
    activeId: null,
    pending: {},
  };
  private listeners = new Set<() => void>();
  private loads = new Map<string, number>();
  constructor(
    private transport: Pick<
      Api,
      | 'session'
      | 'login'
      | 'health'
      | 'resources'
      | 'rooms'
      | 'room'
      | 'create'
      | 'chat'
    > = api,
    private uuid: () => string = () => crypto.randomUUID(),
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private patch(update: Partial<State>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((fn) => fn());
  }
  private error(error: unknown) {
    if (error instanceof ApiError && error.status === 401)
      this.patch({ authenticated: false });
    return error instanceof Error ? error.message : '연결을 확인해 주세요.';
  }
  async start() {
    this.patch({ loading: true, error: null });
    try {
      const session = await this.transport.session();
      this.patch({ authenticated: session.authenticated });
      if (!session.authenticated) return;
      const [health, resources, rooms] = await Promise.all([
        this.transport.health(),
        this.transport.resources(),
        this.transport.rooms(),
      ]);
      this.patch({ health, resources, rooms });
      const selected = this.state.activeId ?? rooms[0]?.id;
      if (selected) await this.select(selected);
    } catch (error) {
      this.patch({ error: this.error(error) });
    } finally {
      this.patch({ loading: false });
    }
  }
  async clearChats() {
    for (const [id, n] of this.loads) this.loads.set(id, n + 1);
    this.patch({ rooms: [], details: {}, pending: {}, activeId: null });
    await this.start();
  }
  async refreshResources() {
    const resources = await this.transport.resources();
    this.patch({ resources });
    return resources;
  }
  async reloadRooms() {
    try {
      this.patch({ rooms: await this.transport.rooms() });
    } catch (error) {
      this.patch({ error: this.error(error) });
    }
  }
  acceptResources(resources: Resources) {
    this.patch({ resources });
  }
  async reanalyze(id: string) {
    const latest = this.state.details[id]?.latest;
    if (latest) await this.send(id, latest.text);
  }
  async login(token: string) {
    await this.transport.login(token);
    await this.start();
  }
  async select(id: string) {
    this.patch({ activeId: id });
    try {
      await this.refresh(id);
    } catch (error) {
      this.patch({ error: this.error(error) });
    }
  }
  async refresh(id: string) {
    const sequence = (this.loads.get(id) ?? 0) + 1;
    this.loads.set(id, sequence);
    const detail = await this.transport.room(id);
    if (this.loads.get(id) !== sequence) return;
    this.patch({ details: { ...this.state.details, [id]: detail } });
    const latest = detail.latest;
    if (
      !this.state.pending[id] &&
      latest &&
      (latest.status === 'running' || latest.status === 'received')
    ) {
      this.setPending(id, {
        input: {
          schema_version: '0.1',
          request_id: latest.request_id,
          conversation_id: id,
          customer_handle: detail.conversation.customer_handle,
          text: latest.text,
          attachments: [],
        },
        sending: false,
        error:
          latest.status === 'running'
            ? '저장된 실행이 있습니다. 결과 확인으로 이어서 확인하세요.'
            : '저장한 DM의 분석을 시작할 수 있습니다.',
        terminal: false,
      });
    }
  }
  private setPending(id: string, value: Pending) {
    this.patch({ pending: { ...this.state.pending, [id]: value } });
  }
  async add(handle: string, context: string, text: string) {
    const room = await this.transport.create(handle, context);
    const summary: RoomSummary = { ...room, latest: null };
    this.patch({
      rooms: [summary, ...this.state.rooms],
      activeId: room.id,
      details: {
        ...this.state.details,
        [room.id]: { conversation: room, messages: [], latest: null },
      },
    });
    void this.send(room.id, text);
    return room.id;
  }
  async send(id: string, text: string) {
    if (this.state.pending[id]?.sending) return;
    const room = this.state.rooms.find((r) => r.id === id);
    if (!room) return;
    const input: ChatRequest = {
      schema_version: '0.1',
      request_id: this.uuid(),
      conversation_id: id,
      customer_handle: room.customer_handle,
      text,
      attachments: [],
    };
    this.setPending(id, {
      input,
      sending: false,
      error: null,
      terminal: false,
    });
    await this.execute(id, input);
  }
  async retry(id: string) {
    const pending = this.state.pending[id],
      latest = this.state.details[id]?.latest;
    if (pending?.sending) return;
    if (pending) {
      const input = pending.terminal
        ? { ...pending.input, request_id: this.uuid() }
        : pending.input;
      await this.execute(id, input);
    } else if (latest) {
      const room = this.state.details[id]!.conversation;
      await this.execute(id, {
        schema_version: '0.1',
        request_id:
          latest.status === 'failed' ? this.uuid() : latest.request_id,
        conversation_id: id,
        customer_handle: room.customer_handle,
        text: latest.text,
        attachments: [],
      });
    }
  }
  private async execute(id: string, input: ChatRequest) {
    this.setPending(id, { input, sending: true, error: null, terminal: false });
    let polling = false;
    const poll = setInterval(() => {
      if (!polling) {
        polling = true;
        void this.refresh(id)
          .catch(() => {})
          .finally(() => {
            polling = false;
          });
      }
    }, 2000);
    try {
      const result = await this.transport.chat(
        input,
        (this.state.health?.agent_timeout_ms ?? 60000) + 15000,
      );
      // Invalidate any older in-flight poll before applying a completed result.
      this.loads.set(id, (this.loads.get(id) ?? 0) + 1);
      this.applyResult(id, input, result);
      this.setPending(id, {
        input,
        sending: false,
        error:
          result.analysis.status === 'failed'
            ? result.analysis.review_items.map((i) => i.message).join(' ')
            : null,
        terminal: result.analysis.status === 'failed' && !!result.execution,
      });
    } catch (error) {
      this.setPending(id, {
        input,
        sending: false,
        error: this.error(error),
        terminal:
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![401, 409, 429].includes(error.status),
      });
    } finally {
      clearInterval(poll);
      try {
        await this.refresh(id);
        const rooms = await this.transport.rooms();
        this.patch({ rooms });
      } catch {
        /* Keep the last known result when reconnection fails. */
      }
    }
  }
  private applyResult(id: string, input: ChatRequest, result: ChatResult) {
    const prior = this.state.details[id];
    if (!prior) return;
    this.patch({
      details: {
        ...this.state.details,
        [id]: {
          ...prior,
          extraction_sources: [],
          latest: {
            request_id: input.request_id!,
            text: input.text,
            status:
              result.analysis.status === 'failed' ? 'failed' : 'succeeded',
            expires_at: null,
            http_status: result.analysis.status === 'failed' ? 503 : 200,
            analysis: result.analysis,
            execution: result.execution ?? null,
          },
        },
      },
    });
  }
}
export const workspace = new Workspace();
