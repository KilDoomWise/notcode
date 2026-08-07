import { z } from "zod";
import { stat } from "node:fs/promises";
import { defineTool } from "@/tools/types";
import { audit } from "@/utils/audit";
import { byteLength, writeFileAtomic } from "@/utils/fs-atomic";
import { formatBytes } from "@/utils/output";
import { fail, fromError, okJson } from "@/utils/result";
import { resolveSandboxed } from "@/utils/sandbox";
import { createSnapshot } from "@/utils/snapshot";

export const writeFileTool = defineTool({
    name: "fs_write_file",
    description:
        "Create or fully overwrite a file. Takes an automatic snapshot of the previous version first (restore via fs_restore) and writes atomically. For edits inside an existing file prefer fs_patch_file.",
    annotations: { title: "Write file", readOnlyHint: false, destructiveHint: true },
    schema: {
        path: z.string().describe("Relative or absolute path of the file to write"),
        content: z.string().describe("Full text content to write"),
        createDirs: z.boolean().optional().describe("Create missing parent directories (default true)"),
        overwrite: z.boolean().optional().describe("Allow overwriting an existing file (default true)")
    },
    handler: async (args: { path: string; content: string; createDirs?: boolean; overwrite?: boolean }) => {
        try {
            const target = await resolveSandboxed(args.path);

            let existed = false;
            let previousBytes = 0;
            try {
                const info = await stat(target.path);
                if (info.isDirectory()) return fail(`${target.path} — это папка, записать файл нельзя.`);
                existed = true;
                previousBytes = info.size;
            } catch {
                existed = false;
            }

            if (existed && args.overwrite === false) {
                return fail(`Файл уже существует, а overwrite=false: ${target.path}`);
            }

            const snapshot = existed ? await createSnapshot(target.path, "fs_write_file") : null;

            // Атомарно: падение посреди записи больше не оставляет обрезанный файл.
            await writeFileAtomic(target.path, args.content, { createDirs: args.createDirs !== false });
            const bytes = byteLength(args.content);

            await audit({
                tool: "fs_write_file",
                action: existed ? "overwrite" : "create",
                target: target.path,
                ok: true,
                detail: {
                    bytes,
                    previousBytes,
                    snapshotId: snapshot?.meta?.id ?? null,
                    snapshotSkipped: snapshot?.skipped ?? null
                }
            });

            return okJson(
                {
                    path: target.path,
                    action: existed ? "overwritten" : "created",
                    bytes,
                    size: formatBytes(bytes),
                    snapshotId: snapshot?.meta?.id ?? null,
                    snapshotSkipped: snapshot?.skipped ?? null
                },
                snapshot?.note ? `Файл перезаписан. ${snapshot.note}` : existed ? "Файл перезаписан." : "Файл создан."
            );
        } catch (error) {
            await audit({ tool: "fs_write_file", action: "write", target: args.path, ok: false });
            return fromError("Error writing file", error);
        }
    }
});
