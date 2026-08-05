import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allTools } from "@/tools/index";

/**
 * Собирает MCP-сервер из декларативного списка тулов.
 * Новый тул = новый файл в src/tools + строка в src/tools/index.ts. Больше нигде править не надо.
 */
export function createServer(): McpServer {
    const server = new McpServer({
        name: "notcode",
        version: "2.0.0"
    });

    for (const tool of allTools) {
        server.tool(tool.name, tool.description, tool.schema, tool.handler as never);
    }

    return server;
}

export function toolCount(): number {
    return allTools.length;
}
