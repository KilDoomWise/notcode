import { z } from "zod";
import { stat } from "node:fs/promises";
import { defineTool } from "@/tools/types";
import { looksBinary } from "@/utils/output";
import { fromError, ok } from "@/utils/result";
import { resolveSandboxed } from "@/utils/sandbox";
import { collectEntries, matchesAnyGlob } from "@/utils/walk";

const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;

export const searchContentTool = defineTool({
    name: "fs_search_content",
    description:
        "Grep across the codebase: find a string or regex inside files and get file:line matches with optional context. Use this instead of reading files one by one when locating code.",
    schema: {
        query: z.string().describe("Text or regular expression to search for"),
        path: z.string().optional().describe("Directory to search in (defaults to workspace root)"),
        isRegex: z.boolean().optional().describe("Treat query as a regular expression"),
        caseSensitive: z.boolean().optional().describe("Case-sensitive match (default false)"),
        mode: z
            .enum(["line", "multiline"])
            .optional()
            .describe(
                "'line' (default): fast per-line grep, one reported match per line, cannot match patterns spanning multiple lines. " +
                    "'multiline': scans whole file content so isRegex patterns containing \\n (or matching across line breaks) are found too; slower, use it only when 'line' mode returns 0 matches for a pattern that should span lines."
            ),
        include: z.array(z.string()).optional().describe("Only search files matching these globs, e.g. [\"*.ts\", \"src/**/*.tsx\"]"),
        exclude: z.array(z.string()).optional().describe("Skip files matching these globs"),
        contextLines: z.number().int().min(0).max(5).optional().describe("Lines of context around each match"),
        maxResults: z.number().int().min(1).max(500).optional().describe("Max matches to return (default 100)"),
        includeIgnored: z.boolean().optional().describe("Also search node_modules, dist, .git, etc.")
    },
    handler: async (args: {
        query: string;
        path?: string;
        isRegex?: boolean;
        caseSensitive?: boolean;
        mode?: "line" | "multiline";
        include?: string[];
        exclude?: string[];
        contextLines?: number;
        maxResults?: number;
        includeIgnored?: boolean;
    }) => {
        try {
            const target = await resolveSandboxed(args.path);
            const maxResults = args.maxResults ?? 100;
            const contextLines = args.contextLines ?? 0;
            const mode = args.mode ?? "line";

            const flags = args.caseSensitive ? "g" : "gi";
            const pattern = args.isRegex
                ? new RegExp(args.query, flags)
                : new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

            const { entries } = await collectEntries({
                root: target.path,
                maxDepth: 25,
                includeHidden: false,
                includeIgnored: args.includeIgnored,
                maxEntries: 20_000
            });

            const lines: string[] = [];
            let matches = 0;
            let scannedFiles = 0;
            let currentFile = "";

            for (const entry of entries) {
                if (matches >= maxResults) break;
                if (entry.isDirectory) continue;
                if (args.include && !matchesAnyGlob(entry.relPath, args.include)) continue;
                if (args.exclude && matchesAnyGlob(entry.relPath, args.exclude)) continue;

                let size = 0;
                try {
                    size = (await stat(entry.absPath)).size;
                } catch {
                    continue;
                }
                if (size > MAX_SCANNED_FILE_BYTES) continue;

                let content: string;
                try {
                    const bytes = new Uint8Array(await Bun.file(entry.absPath).arrayBuffer());
                    if (looksBinary(bytes)) continue;
                    content = new TextDecoder().decode(bytes);
                } catch {
                    continue;
                }

                scannedFiles++;
                pattern.lastIndex = 0;
                if (!pattern.test(content)) continue;

                const fileLines = content.split(/\r?\n/);

                if (mode === "multiline") {
                    pattern.lastIndex = 0;
                    let match: RegExpExecArray | null;
                    while (matches < maxResults && (match = pattern.exec(content))) {
                        const startLine = content.slice(0, match.index).split(/\r?\n/).length;
                        const endLine = startLine + match[0].split(/\r?\n/).length - 1;

                        if (currentFile !== entry.relPath) {
                            if (currentFile) lines.push("");
                            lines.push(`--- ${entry.relPath}`);
                            currentFile = entry.relPath;
                        }

                        for (let ctx = Math.max(1, startLine - contextLines); ctx < startLine; ctx++) {
                            lines.push(`  ${ctx}│ ${fileLines[ctx - 1]}`);
                        }
                        const matchedText = match[0].length > 500 ? `${match[0].slice(0, 500)}…` : match[0];
                        lines.push(`> ${startLine}-${endLine}│ ${matchedText.replace(/\r?\n/g, "\\n")}`);
                        for (let ctx = endLine + 1; ctx <= Math.min(fileLines.length, endLine + contextLines); ctx++) {
                            lines.push(`  ${ctx}│ ${fileLines[ctx - 1]}`);
                        }

                        matches++;
                        // Совпадение нулевой длины не двигает lastIndex само — иначе бесконечный цикл.
                        if (match[0].length === 0) pattern.lastIndex++;
                    }
                    continue;
                }

                for (let i = 0; i < fileLines.length && matches < maxResults; i++) {
                    const line = fileLines[i] as string;
                    pattern.lastIndex = 0;
                    if (!pattern.test(line)) continue;

                    if (currentFile !== entry.relPath) {
                        if (currentFile) lines.push("");
                        lines.push(`--- ${entry.relPath}`);
                        currentFile = entry.relPath;
                    }

                    for (let ctx = Math.max(0, i - contextLines); ctx < i; ctx++) {
                        lines.push(`  ${ctx + 1}│ ${fileLines[ctx]}`);
                    }
                    lines.push(`> ${i + 1}│ ${line.trim()}`);
                    for (let ctx = i + 1; ctx <= Math.min(fileLines.length - 1, i + contextLines); ctx++) {
                        lines.push(`  ${ctx + 1}│ ${fileLines[ctx]}`);
                    }

                    matches++;
                }
            }

            const header = `Поиск '${args.query}' (mode: ${mode}) в ${target.path} — найдено ${matches} совпадений (просмотрено файлов: ${scannedFiles})${matches >= maxResults ? ", лимит достигнут" : ""}`;
            const multilineHint =
                mode === "line" && args.isRegex
                    ? ' Если паттерн должен матчить несколько строк (содержит "\\n" или использует dotAll/(?s)), повтори поиск с mode: "multiline".'
                    : "";

            return ok(matches === 0 ? `${header}\nНичего не найдено.${multilineHint}` : `${header}\n\n${lines.join("\n")}`);
        } catch (error) {
            return fromError("Error searching content", error);
        }
    }
});

export const findFilesTool = defineTool({
    name: "fs_find_files",
    description:
        "Find files and folders by name pattern (glob), e.g. '*.test.ts' or 'src/**/index.ts'. Fast way to locate a file when you only remember part of its name.",
    schema: {
        pattern: z.string().describe("Glob pattern to match against paths, e.g. '*.json' or 'src/**/*.ts'"),
        path: z.string().optional().describe("Directory to search in (defaults to workspace root)"),
        maxResults: z.number().int().min(1).max(1000).optional().describe("Max results (default 200)"),
        includeHidden: z.boolean().optional().describe("Include dotfiles"),
        includeIgnored: z.boolean().optional().describe("Also look inside node_modules, dist, .git, etc.")
    },
    handler: async (args: {
        pattern: string;
        path?: string;
        maxResults?: number;
        includeHidden?: boolean;
        includeIgnored?: boolean;
    }) => {
        try {
            const target = await resolveSandboxed(args.path);
            const maxResults = args.maxResults ?? 200;

            const { entries } = await collectEntries({
                root: target.path,
                maxDepth: 25,
                includeHidden: args.includeHidden,
                includeIgnored: args.includeIgnored,
                maxEntries: 30_000
            });

            const found = entries
                .filter(entry => matchesAnyGlob(entry.relPath, [args.pattern]))
                .slice(0, maxResults);

            if (found.length === 0) {
                return ok(`Ничего не найдено по шаблону '${args.pattern}' в ${target.path}`);
            }

            const lines = found.map(entry => `${entry.isDirectory ? "[DIR] " : "[FILE]"} ${entry.relPath}`);
            return ok(`Найдено ${found.length} совпадений в ${target.path}:\n${lines.join("\n")}`);
        } catch (error) {
            return fromError("Error finding files", error);
        }
    }
});
