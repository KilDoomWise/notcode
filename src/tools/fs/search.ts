import { z } from "zod";
import { stat } from "node:fs/promises";
import { defineTool } from "@/tools/types";
import { looksBinary } from "@/utils/output";
import { fail, fromError, ok } from "@/utils/result";
import { resolveSandboxed } from "@/utils/sandbox";
import { collectEntries, compileGlobs, matchesCompiled } from "@/utils/walk";

const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;
/** Общий дедлайн поиска: лучше честный частичный результат, чем висящий тул. */
const SEARCH_BUDGET_MS = 20_000;

export const searchContentTool = defineTool({
    name: "fs_search_content",
    description:
        "Grep across the codebase: find a string or regex inside files and get file:line matches with optional context. Use this instead of reading files one by one when locating code.",
    annotations: { title: "Search in files", readOnlyHint: true, idempotentHint: true },
    schema: {
        query: z.string().min(1).describe("Text or regular expression to search for"),
        path: z.string().optional().describe("Directory to search in (defaults to workspace root)"),
        isRegex: z.boolean().optional().describe("Treat query as a regular expression"),
        caseSensitive: z.boolean().optional().describe("Case-sensitive match (default false)"),
        include: z
            .array(z.string())
            .optional()
            .describe('Only search files matching these globs, e.g. ["*.ts", "src/**/*.tsx"]'),
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
            const deadline = Date.now() + SEARCH_BUDGET_MS;

            const flags = args.caseSensitive ? "g" : "gi";

            // Кривой регуляркой легко уронить тул — отвечаем понятным текстом, а не стектрейсом.
            let pattern: RegExp;
            try {
                pattern = args.isRegex
                    ? new RegExp(args.query, flags)
                    : new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
            } catch (error) {
                return fail(
                    `Некорректное регулярное выражение: ${error instanceof Error ? error.message : String(error)}\n` +
                        `Если искался просто текст — убери isRegex=true.`
                );
            }

            const walk = await collectEntries({
                root: target.path,
                maxDepth: 25,
                includeHidden: false,
                includeIgnored: args.includeIgnored,
                maxEntries: 20_000,
                timeBudgetMs: 10_000
            });

            const includeGlobs = args.include ? compileGlobs(args.include) : null;
            const excludeGlobs = args.exclude ? compileGlobs(args.exclude) : null;

            const lines: string[] = [];
            let matches = 0;
            let scannedFiles = 0;
            let skippedBinary = 0;
            let skippedLarge = 0;
            let currentFile = "";
            let hitLimit = false;
            let timedOut = false;

            for (const entry of walk.entries) {
                if (matches >= maxResults) {
                    hitLimit = true;
                    break;
                }
                if (Date.now() > deadline) {
                    timedOut = true;
                    break;
                }
                if (entry.isDirectory) continue;
                if (includeGlobs && !matchesCompiled(entry.relPath, includeGlobs)) continue;
                if (excludeGlobs && matchesCompiled(entry.relPath, excludeGlobs)) continue;

                let size = 0;
                try {
                    size = (await stat(entry.absPath)).size;
                } catch {
                    continue;
                }
                if (size > MAX_SCANNED_FILE_BYTES) {
                    skippedLarge++;
                    continue;
                }

                let content: string;
                try {
                    const bytes = new Uint8Array(await Bun.file(entry.absPath).arrayBuffer());
                    if (looksBinary(bytes)) {
                        skippedBinary++;
                        continue;
                    }
                    content = new TextDecoder().decode(bytes);
                } catch {
                    continue;
                }

                scannedFiles++;
                pattern.lastIndex = 0;
                if (!pattern.test(content)) continue;

                const fileLines = content.split(/\r?\n/);
                for (let i = 0; i < fileLines.length; i++) {
                    if (matches >= maxResults) {
                        hitLimit = true;
                        break;
                    }

                    const line = fileLines[i] ?? "";
                    pattern.lastIndex = 0;
                    if (!pattern.test(line)) continue;

                    if (currentFile !== entry.relPath) {
                        if (currentFile) lines.push("");
                        lines.push(`--- ${entry.relPath}`);
                        currentFile = entry.relPath;
                    }

                    for (let ctx = Math.max(0, i - contextLines); ctx < i; ctx++) {
                        lines.push(`  ${ctx + 1}│ ${fileLines[ctx] ?? ""}`);
                    }
                    // Отступ сохраняем: раньше был trim(), и агент не видел вложенность строки в коде,
                    // а потом пытался использовать эту строку как oldStr в fs_patch_file — и промахивался.
                    lines.push(`> ${i + 1}│ ${line.replace(/\s+$/, "")}`);
                    for (let ctx = i + 1; ctx <= Math.min(fileLines.length - 1, i + contextLines); ctx++) {
                        lines.push(`  ${ctx + 1}│ ${fileLines[ctx] ?? ""}`);
                    }

                    matches++;
                }
            }

            const notes: string[] = [];
            if (hitLimit) notes.push(`достигнут лимит maxResults=${maxResults}`);
            if (timedOut) notes.push("поиск остановлен по времени");
            if (walk.truncated) notes.push("обойдены не все файлы (слишком большое дерево)");
            if (walk.timedOut) notes.push("обход дерева остановлен по времени");
            if (skippedBinary > 0) notes.push(`пропущено бинарных: ${skippedBinary}`);
            if (skippedLarge > 0) notes.push(`пропущено слишком больших: ${skippedLarge}`);

            const header =
                `Поиск '${args.query}' в ${target.path} — найдено ${matches} совпадений ` +
                `(просмотрено файлов: ${scannedFiles})` +
                (notes.length > 0 ? `\n⚠️ ${notes.join("; ")}` : "");

            return ok(matches === 0 ? `${header}\nНичего не найдено.` : `${header}\n\n${lines.join("\n")}`);
        } catch (error) {
            return fromError("Error searching content", error);
        }
    }
});

export const findFilesTool = defineTool({
    name: "fs_find_files",
    description:
        "Find files and folders by name pattern (glob), e.g. '*.test.ts' or 'src/**/index.ts'. Fast way to locate a file when you only remember part of its name.",
    annotations: { title: "Find files", readOnlyHint: true, idempotentHint: true },
    schema: {
        pattern: z.string().min(1).describe("Glob pattern to match against paths, e.g. '*.json' or 'src/**/*.ts'"),
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

            const walk = await collectEntries({
                root: target.path,
                maxDepth: 25,
                includeHidden: args.includeHidden,
                includeIgnored: args.includeIgnored,
                maxEntries: 30_000,
                timeBudgetMs: 15_000
            });

            const globs = compileGlobs([args.pattern]);
            const found = walk.entries.filter(entry => matchesCompiled(entry.relPath, globs)).slice(0, maxResults);

            const notes: string[] = [];
            if (found.length >= maxResults) notes.push(`показаны первые ${maxResults}`);
            if (walk.truncated) notes.push("обойдены не все файлы");
            if (walk.timedOut) notes.push("обход остановлен по времени");

            if (found.length === 0) {
                return ok(
                    `Ничего не найдено по шаблону '${args.pattern}' в ${target.path}` +
                        (notes.length > 0 ? `\n⚠️ ${notes.join("; ")}` : "") +
                        (args.includeIgnored ? "" : "\nПодсказка: node_modules и dist пропускаются, включи includeIgnored=true.")
                );
            }

            const lines = found.map(entry => `${entry.isDirectory ? "[DIR] " : "[FILE]"} ${entry.relPath}`);

            return ok(
                `Найдено ${found.length} совпадений в ${target.path}` +
                    (notes.length > 0 ? ` (⚠️ ${notes.join("; ")})` : "") +
                    `:\n${lines.join("\n")}`
            );
        } catch (error) {
            return fromError("Error finding files", error);
        }
    }
});
