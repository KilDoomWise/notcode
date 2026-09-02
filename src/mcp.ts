import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allTools } from "@/tools/index";
import type { NotCodeConfig } from "@/config";

export const SERVER_NAME = "reccode2";
export const SERVER_VERSION = "2.7.1";

/**
 * Собирает MCP-сервер из декларативного списка тулов.
 *
 * config.toolAliases позволяет выставить наружу другое имя тула без изменения
 * его кода — это нужно когда MCP-клиент (Notion AI и др.) заблокировал тул
 * из-за смены аннотаций и не показывает кнопку повторного одобрения.
 *
 * Команда сброса всех алиасов: bun run src/index.ts fix
 */
 export function createServer(config: NotCodeConfig): McpServer {
     const server = new McpServer({
         name: SERVER_NAME,
         version: SERVER_VERSION
     });

     for (const tool of allTools) {
         const publicName = config.toolAliases[tool.name] ?? tool.name;

         server.registerTool(
             publicName,
             {
                 description: tool.description,
                 inputSchema: tool.schema
                 // аннотации убрали намеренно
             },
             tool.handler as Parameters<typeof server.registerTool>[2]
         );
     }

     return server;
 }

export function toolCount(): number {
    return allTools.length;
}
