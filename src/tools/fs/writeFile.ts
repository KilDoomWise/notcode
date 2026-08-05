import { z } from "zod";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool } from "@/tools/types";
import { audit } from "@/utils/audit";
import { formatBytes } from "@/utils/output";
import { fail, fromError, okJson } from "@/utils/result";
import { resolveSandboxed } from "@/utils/sandbox";
import { createSnapshot } from "@/utils/snapshot";

export const writeFileTool = defineTool({
    name: "fs_write_file",
    description:
        "Create or fully overwrite a file. Takes an automatic snapshot of the previous version first (restore via fs_restore). For edits inside an existing file prefer fs_patch_file.",
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

            if (args.createDirs !== false) {
                await mkdir(dirname(target.path), { recursive: true });
            }
            const bytes = await Bun.write(target.path, args.content);

            await audit({
                tool: "fs_write_file",
                action: existed ? "overwrite" : "create",
                target: target.path,
                ok: true,
                detail: { bytes, previousBytes, snapshotId: snapshot?.id ?? null }
            });

            return okJson(
                {
                    path: target.path,
                    action: existed ? "overwritten" : "created",
                    bytes,
                    size: formatBytes(bytes),
                    snapshotId: snapshot?.id ?? null
                },
                existed ? "Файл перезаписан." : "Файл создан."
            );
        } catch (error) {
            await audit({ tool: "fs_write_file", action: "write", target: args.path, ok: false });
            return fromError("Error writing file", error);
        }
    }
});
