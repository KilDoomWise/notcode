import { z } from "zod";
import { defineTool } from "@/tools/types";
import { audit } from "@/utils/audit";
import { byteLength, writeFileAtomic } from "@/utils/fs-atomic";
import { formatBytes } from "@/utils/output";
import { fail, fromError, okJson } from "@/utils/result";
import { resolveSandboxed } from "@/utils/sandbox";
import { createSnapshot } from "@/utils/snapshot";

interface Edit {
    oldStr: string;
    newStr: string;
    replaceAll?: boolean;
}

/** Патч держит в памяти и оригинал, и результат — на огромном файле это гарантированный OOM. */
const MAX_PATCH_BYTES = 16 * 1024 * 1024;

function countOccurrences(haystack: string, needle: string): number {
    if (needle.length === 0) return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count++;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}

/**
 * Замена без интерпретации спецсимволов замены.
 *
 * String.replace(str, str) трактует $&, $1, $` в ЗАМЕНЕ как шаблоны. Для патча кода это баг:
 * новый код вроде `price = "$&"` или regex-замены `"$1"` молча превращались в мусор.
 * Функция-замена отключает эту магию полностью.
 */
function replaceOnce(haystack: string, needle: string, replacement: string): string {
    return haystack.replace(needle, () => replacement);
}

export const patchFileTool = defineTool({
    name: "fs_patch_file",
    description:
        "Surgically edit a file by replacing exact strings (oldStr -> newStr), applied in order. Safer than rewriting: no risk of losing unrelated code, works on huge files. oldStr must be unique unless replaceAll is true. Use dryRun to preview.",
    annotations: { title: "Patch file", readOnlyHint: false, destructiveHint: true },
    schema: {
        path: z.string().describe("Path to the file to patch"),
        edits: z
            .array(
                z.object({
                    oldStr: z.string().describe("Exact existing text to find (copy it verbatim from the file)"),
                    newStr: z.string().describe("Replacement text (empty string deletes the match)"),
                    replaceAll: z
                        .boolean()
                        .optional()
                        .describe("Replace every occurrence instead of requiring uniqueness")
                })
            )
            .min(1)
            .describe("Ordered list of edits to apply"),
        dryRun: z.boolean().optional().describe("Validate and report without writing to disk")
    },
    handler: async (args: { path: string; edits: Edit[]; dryRun?: boolean }) => {
        try {
            const target = await resolveSandboxed(args.path);
            const file = Bun.file(target.path);

            if (!(await file.exists())) {
                return fail(`Файл не найден: ${target.path}. Создай его через fs_write_file.`);
            }

            if (file.size > MAX_PATCH_BYTES) {
                return fail(
                    `Файл слишком большой для fs_patch_file: ${formatBytes(file.size)} > ${formatBytes(MAX_PATCH_BYTES)}. ` +
                        `Обработай его потоково через terminal_exec (sed / PowerShell) или работай с нужным фрагментом отдельно.`
                );
            }

            const original = await file.text();
            const fileHasCrlf = original.includes("\r\n");

            let updated = original;
            const applied: Array<{ index: number; replacements: number; chars: number; eolFixed?: boolean }> = [];

            for (let i = 0; i < args.edits.length; i++) {
                const edit = args.edits[i];
                if (!edit) continue;

                if (edit.oldStr.length === 0) {
                    return fail(`Правка #${i + 1}: oldStr пустой. Для полной перезаписи используй fs_write_file.`);
                }

                let oldStr = edit.oldStr;
                let newStr = edit.newStr;
                let eolFixed = false;
                let occurrences = countOccurrences(updated, oldStr);

                /**
                 * CRLF-толерантность. На Windows файлы часто с \r\n, а модель присылает многострочный
                 * oldStr с обычными \n. Раньше это давало вечное "oldStr не найден" на визуально идентичном тексте.
                 */
                if (occurrences === 0 && fileHasCrlf && oldStr.includes("\n") && !oldStr.includes("\r\n")) {
                    const crlfOld = oldStr.replace(/\n/g, "\r\n");
                    const crlfCount = countOccurrences(updated, crlfOld);
                    if (crlfCount > 0) {
                        oldStr = crlfOld;
                        newStr = newStr.includes("\r\n") ? newStr : newStr.replace(/\n/g, "\r\n");
                        occurrences = crlfCount;
                        eolFixed = true;
                    }
                }

                if (occurrences === 0) {
                    return fail(
                        `Правка #${i + 1}: oldStr не найден в файле. Скопируй фрагмент точно (включая отступы и переводы строк).\n` +
                            `Файл: ${target.path}` +
                            (i > 0 ? `\nВнимание: предыдущие правки не применены — файл не изменён.` : "")
                    );
                }
                if (occurrences > 1 && !edit.replaceAll) {
                    return fail(
                        `Правка #${i + 1}: найдено ${occurrences} совпадений. Расширь oldStr до уникального фрагмента или поставь replaceAll=true.`
                    );
                }

                updated = edit.replaceAll ? updated.split(oldStr).join(newStr) : replaceOnce(updated, oldStr, newStr);

                applied.push({
                    index: i + 1,
                    replacements: edit.replaceAll ? occurrences : 1,
                    chars: newStr.length - oldStr.length,
                    ...(eolFixed ? { eolFixed: true } : {})
                });
            }

            if (updated === original) {
                return okJson(
                    { path: target.path, changed: false },
                    "Изменений нет: результат совпадает с текущим содержимым."
                );
            }

            if (args.dryRun) {
                return okJson(
                    {
                        path: target.path,
                        dryRun: true,
                        edits: applied,
                        charsBefore: original.length,
                        charsAfter: updated.length
                    },
                    "Dry run: все правки применимы, файл не изменён."
                );
            }

            const snapshot = await createSnapshot(target.path, "fs_patch_file");
            await writeFileAtomic(target.path, updated);

            await audit({
                tool: "fs_patch_file",
                action: "patch",
                target: target.path,
                ok: true,
                detail: { edits: applied, snapshotId: snapshot.meta?.id ?? null, snapshotSkipped: snapshot.skipped }
            });

            return okJson(
                {
                    path: target.path,
                    changed: true,
                    edits: applied,
                    charsBefore: original.length,
                    charsAfter: updated.length,
                    bytes: byteLength(updated),
                    snapshotId: snapshot.meta?.id ?? null,
                    snapshotSkipped: snapshot.skipped
                },
                snapshot.note ? `Правки применены. ${snapshot.note}` : "Правки применены."
            );
        } catch (error) {
            await audit({ tool: "fs_patch_file", action: "patch", target: args.path, ok: false });
            return fromError("Error patching file", error);
        }
    }
});
