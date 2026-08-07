import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allTools } from "@/tools/index";

export const SERVER_NAME = "notcode";
export const SERVER_VERSION = "2.0.0";

/**
 * Собирает MCP-сервер из декларативного списка тулов.
 * Новый тул = новый файл в src/tools + строка в src/tools/index.ts. Больше нигде править не надо.
 */
export function createServer(): McpServer {
    const server = new McpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION
    });

    for (const tool of allTools) {
        server.registerTool(
            tool.name,
            {
                description: tool.description,
                inputSchema: tool.schema,
                ...(tool.annotations ? { annotations: tool.annotations } : {})
            },
            // Тип коллбэка в SDK выводится из конкретной Zod-схемы, а наш реестр гетерогенен.
            // Это единственная точка, где приведение неизбежно — и оно локализовано здесь.
            tool.handler as Parameters<typeof server.registerTool>[2]
        );
    }

    return server;
}

export function toolCount(): number {
    return allTools.length;
}
