import { z } from "zod";
import { defineTool } from "@/tools/types";
import { audit } from "@/utils/audit";
import { fail, fromError, okJson } from "@/utils/result";
import { resolveSandboxed } from "@/utils/sandbox";
import { createSnapshot } from "@/utils/snapshot";

interface Edit {
    oldStr: string;
    newStr: string;
    replaceAll?: boolean;
}

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

export const patchFileTool = defineTool({
    name: "fs_patch_file",
    description:
        "Surgically edit a file by replacing exact strings (oldStr -> newStr), applied in order. Safer than rewriting: no risk of losing unrelated code, works on huge files. oldStr must be unique unless replaceAll is true. Use dryRun to preview.",
    schema: {
        path: z.string().describe("Path to the file to patch"),
        edits: z
            .array(
                z.object({
                    oldStr: z.string().describe("Exact existing text to find (copy it verbatim from the file)"),
                    newStr: z.string().describe("Replacement text (empty string deletes the match)"),
                    replaceAll: z.boolean().optional().describe("Replace every occurrence instead of requiring uniqueness")
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

            const original = await file.text();
            let updated = original;
            const applied: Array<{ index: number; replacements: number; chars: number }> = [];

            for (let i = 0; i < args.edits.length; i++) {
                const edit = args.edits[i] as Edit;

                if (edit.oldStr.length === 0) {
                    return fail(`Правка #${i + 1}: oldStr пустой. Для полной перезаписи используй fs_write_file.`);
                }

                const occurrences = countOccurrences(updated, edit.oldStr);
                if (occurrences === 0) {
                    return fail(
                        `Правка #${i + 1}: oldStr не найден в файле. Скопируй фрагмент точно (включая отступы и переводы строк).\n` +
                            `Файл: ${target.path}`
                    );
                }
                if (occurrences > 1 && !edit.replaceAll) {
                    return fail(
                        `Правка #${i + 1}: найдено ${occurrences} совпадений. Расширь oldStr до уникального фрагмента или поставь replaceAll=true.`
                    );
                }

                updated = edit.replaceAll
                    ? updated.split(edit.oldStr).join(edit.newStr)
                    : updated.replace(edit.oldStr, edit.newStr);

                applied.push({
                    index: i + 1,
                    replacements: edit.replaceAll ? occurrences : 1,
                    chars: edit.newStr.length - edit.oldStr.length
                });
            }

            if (updated === original) {
                return okJson({ path: target.path, changed: false }, "Изменений нет: результат совпадает с текущим содержимым.");
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
            await Bun.write(target.path, updated);

            await audit({
                tool: "fs_patch_file",
                action: "patch",
                target: target.path,
                ok: true,
                detail: { edits: applied, snapshotId: snapshot?.id ?? null }
            });

            return okJson(
                {
                    path: target.path,
                    changed: true,
                    edits: applied,
                    charsBefore: original.length,
                    charsAfter: updated.length,
                    snapshotId: snapshot?.id ?? null
                },
                "Правки применены."
            );
        } catch (error) {
            await audit({ tool: "fs_patch_file", action: "patch", target: args.path, ok: false });
            return fromError("Error patching file", error);
        }
    }
});
