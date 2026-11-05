import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { toolSchemas, toolCatalog, type ToolName, Tools } from './registry.js';
import type { Store } from '../storage/store.js';
import type { Config } from '../config.js';
import { AppError } from '../domain/errors.js';
export function createMcpServer(store: Store, config: Config) {
  const server = new McpServer({
    name: 'inbyeol-data-tools',
    version: '0.1.0',
  });
  const room = config.conversationId
    ? store.conversation(config.sellerId, config.conversationId)
    : undefined;
  const tools = new Tools(
    store,
    config.sellerId,
    config.root,
    () => new Date(),
    room?.customer_handle,
  );
  for (const entry of toolCatalog()) {
    server.registerTool(
      entry.name,
      {
        description: entry.description,
        inputSchema: toolSchemas[entry.name as ToolName].shape,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          if (entry.name === 'search_orders' && !room)
            throw new AppError(
              'CONVERSATION_REQUIRED',
              '주문 조회에는 AGENT_CONVERSATION_ID 설정이 필요합니다.',
              403,
            );
          const result = tools.call(entry.name, args);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: {
                    code:
                      error instanceof AppError ? error.code : 'TOOL_FAILED',
                    message:
                      error instanceof AppError
                        ? error.message
                        : '도구 조회에 실패했습니다.',
                  },
                }),
              },
            ],
          };
        }
      },
    );
  }
  return server;
}
export async function serveMcp(store: Store, config: Config) {
  const server = createMcpServer(store, config);
  await server.connect(new StdioServerTransport());
  return server;
}
