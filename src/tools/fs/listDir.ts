import { z } from "zod";
import { stat } from "node:fs/promises";
import { defineTool } from "@/tools/types";
import { formatBytes } from "@/utils/output";
import { fail, fromError, ok } from "@/utils/result";
import { resolveSandboxed } from "@/utils/sandbox";
import { collectEntries } from "@/utils/walk";

export const listDirTool = defineTool({
    name: "fs_list_dir",
    description:
        "List files and directories. Supports recursive tree output with depth control, hidden files, and file sizes. Heavy folders like node_modules/.git are skipped unless includeIgnored is set.",
    schema: {
        path: z.string().optional().describe("Directory path (defaults to the workspace root)"),
        depth: z.number().int().min(1).max(10).optional().describe("How many levels deep to list (default 1)"),
        includeHidden: z.boolean().optional().describe("Include dotfiles (default false)"),
        includeIgnored: z.boolean().optional().describe("Include node_modules, .git, dist, etc. (default false)"),
        withSizes: z.boolean().optional().describe("Show file sizes (slower, extra stat per file)"),
        maxEntries: z.number().int().min(1).max(5000).optional().describe("Max entries to return (default 500)")
    },
    handler: async (args: {
        path?: string;
        depth?: number;
        includeHidden?: boolean;
        includeIgnored?: boolean;
        withSizes?: boolean;
        maxEntries?: number;
    }) => {
        try {
            const target = await resolveSandboxed(args.path);

            let info;
            try {
                info = await stat(target.path);
            } catch {
                return fail(`Папка не найдена: ${target.path}`);
            }
            if (!info.isDirectory()) {
                return fail(`${target.path} — это файл. Используй fs_read_file.`);
            }

            const { entries, truncated } = await collectEntries({
                root: target.path,
                maxDepth: args.depth ?? 1,
                includeHidden: args.includeHidden,
                includeIgnored: args.includeIgnored,
                maxEntries: args.maxEntries ?? 500
            });

            if (entries.length === 0) {
                return ok(`${target.path}\n(пусто)`);
            }

            entries.sort((a, b) => {
                if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                return a.relPath.localeCompare(b.relPath);
            });

            const lines: string[] = [`${target.path}${args.depth && args.depth > 1 ? `  (depth=${args.depth})` : ""}`];

            for (const entry of entries) {
                const indent = "  ".repeat(entry.depth - 1);
                const label = entry.isDirectory ? "[DIR] " : "[FILE]";
                let size = "";
                if (args.withSizes && !entry.isDirectory) {
                    try {
                        size = `  (${formatBytes((await stat(entry.absPath)).size)})`;
                    } catch {
                        size = "";
                    }
                }
                lines.push(`${indent}${label} ${entry.name}${size}`);
            }

            lines.push("", `Всего: ${entries.length}${truncated ? " (список усечён лимитом maxEntries)" : ""}`);

            return ok(lines.join("\n"));
        } catch (error) {
            return fromError("Error listing directory", error);
        }
    }
});
