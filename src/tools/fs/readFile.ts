import { z } from "zod";
import { stat } from "node:fs/promises";
import { loadConfig } from "@/config";
import { defineTool } from "@/tools/types";
import { formatBytes, looksBinary, sliceLines, truncate } from "@/utils/output";
import { fail, fromError, ok } from "@/utils/result";
import { resolveSandboxed } from "@/utils/sandbox";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const readFileTool = defineTool({
    name: "fs_read_file",
    description:
        "Read a text file. Supports partial reads via lineStart/lineCount so huge files and logs never flood the context. Binary files are rejected with a clear message.",
    schema: {
        path: z.string().describe("Relative or absolute path to the file to read"),
        lineStart: z.number().int().min(1).optional().describe("1-based first line to return"),
        lineCount: z.number().int().min(1).optional().describe("How many lines to return starting at lineStart"),
        maxChars: z.number().int().min(200).optional().describe("Hard cap on returned characters")
    },
    handler: async (args: { path: string; lineStart?: number; lineCount?: number; maxChars?: number }) => {
        try {
            const config = await loadConfig();
            const target = await resolveSandboxed(args.path, config);

            let info;
            try {
                info = await stat(target.path);
            } catch {
                return fail(`Файл не найден: ${target.path}`);
            }

            if (info.isDirectory()) {
                return fail(`${target.path} — это папка. Используй fs_list_dir.`);
            }
            if (info.size > MAX_FILE_BYTES) {
                return fail(
                    `Файл слишком большой (${formatBytes(info.size)}). Читай частями через lineStart/lineCount или грепом fs_search_content.`
                );
            }

            const bytes = new Uint8Array(await Bun.file(target.path).arrayBuffer());
            if (looksBinary(bytes)) {
                return fail(`Бинарный файл (${formatBytes(info.size)}), текстом отдать нельзя: ${target.path}`);
            }

            const content = new TextDecoder().decode(bytes);
            const slice = sliceLines(content, { lineStart: args.lineStart, lineCount: args.lineCount });
            const capped = truncate(slice.text, args.maxChars ?? config.limits.maxReadChars);

            const header =
                slice.partial || capped.truncated
                    ? `// notcode: ${target.path} | строки ${slice.startLine}-${slice.endLine} из ${slice.totalLines} | ${formatBytes(info.size)}${capped.truncated ? " | вывод усечён" : ""}\n`
                    : "";

            return ok(`${header}${capped.text}`);
        } catch (error) {
            return fromError("Error reading file", error);
        }
    }
});
