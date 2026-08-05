import { z } from "zod";
import { defineTool } from "@/tools/types";
import { fromError, ok, okJson } from "@/utils/result";
import { resolveSandboxed } from "@/utils/sandbox";
import { watchers } from "@/utils/watch-manager";

export const watchStartTool = defineTool({
    name: "fs_watch_start",
    description:
        "Start watching a directory for file changes. Events are buffered on the server; collect them later with fs_watch_poll. Useful to detect external edits, rebuilds, or generated files.",
    schema: {
        path: z.string().optional().describe("Directory to watch (defaults to workspace root)"),
        recursive: z.boolean().optional().describe("Watch subdirectories too (default true)"),
        maxEvents: z.number().int().min(10).max(5000).optional().describe("Buffer size for events (default 500)")
    },
    handler: async (args: { path?: string; recursive?: boolean; maxEvents?: number }) => {
        try {
            const target = await resolveSandboxed(args.path);
            const info = watchers.start({
                path: target.path,
                recursive: args.recursive,
                maxEvents: args.maxEvents
            });
            return okJson(info, "Наблюдение запущено. События забирай через fs_watch_poll.");
        } catch (error) {
            return fromError("Error starting watcher", error);
        }
    }
});

export const watchPollTool = defineTool({
    name: "fs_watch_poll",
    description: "Collect buffered file-change events from a watcher created with fs_watch_start.",
    schema: {
        watcherId: z.string().describe("Watcher id returned by fs_watch_start"),
        clear: z.boolean().optional().describe("Clear the buffer after reading (default true)"),
        limit: z.number().int().min(1).max(1000).optional().describe("Max events to return (default 200)")
    },
    handler: async (args: { watcherId: string; clear?: boolean; limit?: number }) => {
        try {
            const { info, events } = watchers.poll(args.watcherId, { clear: args.clear, limit: args.limit });
            if (events.length === 0) {
                return ok(`Изменений нет (watcher ${info.id}, всего за сессию: ${info.totalEvents}).`);
            }
            const lines = events.map(event => `${event.ts}  ${event.type.padEnd(8)}  ${event.path}`);
            return ok(`Watcher ${info.id}: ${events.length} событий${info.dropped > 0 ? ` (потеряно из-за буфера: ${info.dropped})` : ""}\n${lines.join("\n")}`);
        } catch (error) {
            return fromError("Error polling watcher", error);
        }
    }
});

export const watchListTool = defineTool({
    name: "fs_watch_list",
    description: "List active file watchers with their pending event counts.",
    schema: {},
    handler: async () => {
        try {
            const list = watchers.list();
            if (list.length === 0) return ok("Активных watcher'ов нет.");
            return okJson(list);
        } catch (error) {
            return fromError("Error listing watchers", error);
        }
    }
});

export const watchStopTool = defineTool({
    name: "fs_watch_stop",
    description: "Stop a file watcher and release its resources.",
    schema: {
        watcherId: z.string().describe("Watcher id to stop")
    },
    handler: async (args: { watcherId: string }) => {
        try {
            const info = watchers.stop(args.watcherId);
            return okJson(info, "Наблюдение остановлено.");
        } catch (error) {
            return fromError("Error stopping watcher", error);
        }
    }
});
