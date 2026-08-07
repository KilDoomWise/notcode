import { z } from "zod";
import { stat } from "node:fs/promises";
import { defineTool } from "@/tools/types";
import { formatBytes } from "@/utils/output";
import { fail, fromError, ok } from "@/utils/result";
import { resolveSandboxed } from "@/utils/sandbox";
import { collectEntries, type WalkEntry } from "@/utils/walk";

/**
 * Сравнение для древовидного вывода: сегмент за сегментом, папки выше файлов НА КАЖДОМ уровне.
 *
 * Старая сортировка (все папки глобально, потом все файлы) при depth>1 разрывала дерево:
 * файлы src/a.ts печатались с отступом второго уровня где-то под чужими папками, и читать его было нельзя.
 */
function compareTree(a: WalkEntry, b: WalkEntry): number {
    const left = a.relPath.split("/");
    const right = b.relPath.split("/");
    const shared = Math.min(left.length, right.length);

    for (let i = 0; i < shared; i++) {
        const leftSegment = left[i] ?? "";
        const rightSegment = right[i] ?? "";
        if (leftSegment === rightSegment) continue;

        // Сегмент — папка, если у пути есть продолжение или сама запись — каталог.
        const leftIsDir = i < left.length - 1 || a.isDirectory;
        const rightIsDir = i < right.length - 1 || b.isDirectory;
        if (leftIsDir !== rightIsDir) return leftIsDir ? -1 : 1;

        return leftSegment.localeCompare(rightSegment, "en");
    }

    return left.length - right.length;
}

export const listDirTool = defineTool({
    name: "fs_list_dir",
    description:
        "List files and directories. Supports recursive tree output with depth control, hidden files, and file sizes. Heavy folders like node_modules/.git are skipped unless includeIgnored is set.",
    annotations: { title: "List directory", readOnlyHint: true, idempotentHint: true },
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

            const walk = await collectEntries({
                root: target.path,
                maxDepth: args.depth ?? 1,
                includeHidden: args.includeHidden,
                includeIgnored: args.includeIgnored,
                maxEntries: args.maxEntries ?? 500
            });

            if (walk.entries.length === 0) {
                return ok(`${target.path}\n(пусто)`);
            }

            const entries = [...walk.entries].sort(compareTree);

            // Параллельный stat: последовательный внутри цикла давал секунды на 500 файлах.
            const sizes = new Map<string, string>();
            if (args.withSizes) {
                const files = entries.filter(entry => !entry.isDirectory);
                const results = await Promise.all(
                    files.map(async entry => {
                        try {
                            return [entry.absPath, formatBytes((await stat(entry.absPath)).size)] as const;
                        } catch {
                            return [entry.absPath, ""] as const;
                        }
                    })
                );
                for (const [absPath, size] of results) {
                    if (size) sizes.set(absPath, size);
                }
            }

            const lines: string[] = [`${target.path}${args.depth && args.depth > 1 ? `  (depth=${args.depth})` : ""}`];

            for (const entry of entries) {
                const indent = "  ".repeat(entry.depth - 1);
                const label = entry.isDirectory ? "[DIR] " : "[FILE]";
                const size = sizes.get(entry.absPath);
                lines.push(`${indent}${label} ${entry.name}${size ? `  (${size})` : ""}`);
            }

            const notes: string[] = [];
            if (walk.truncated) notes.push("список усечён лимитом maxEntries");
            if (walk.timedOut) notes.push("обход остановлен по времени");
            if (walk.unreadableDirs > 0) notes.push(`недоступных папок: ${walk.unreadableDirs}`);

            lines.push("", `Всего: ${entries.length}${notes.length > 0 ? ` (⚠️ ${notes.join("; ")})` : ""}`);

            return ok(lines.join("\n"));
        } catch (error) {
            return fromError("Error listing directory", error);
        }
    }
});
