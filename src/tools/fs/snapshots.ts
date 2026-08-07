import { z } from "zod";
import { defineTool } from "@/tools/types";
import { audit } from "@/utils/audit";
import { formatBytes } from "@/utils/output";
import { fail, fromError, ok, okJson } from "@/utils/result";
import { resolveSandboxed } from "@/utils/sandbox";
import { findSnapshot, listSnapshots, restoreSnapshot } from "@/utils/snapshot";

export const snapshotsTool = defineTool({
    name: "fs_snapshots",
    description:
        "List automatic file snapshots taken before writes and patches. Use it to find a version to roll back to after an unwanted change.",
    annotations: { title: "List snapshots", readOnlyHint: true, idempotentHint: true },
    schema: {
        path: z.string().optional().describe("Only show snapshots for this file"),
        limit: z.number().int().min(1).max(200).optional().describe("How many snapshots to list (default 30)")
    },
    handler: async (args: { path?: string; limit?: number }) => {
        try {
            const absPath = args.path ? (await resolveSandboxed(args.path)).path : undefined;
            const snapshots = await listSnapshots({ path: absPath, limit: args.limit });

            if (snapshots.length === 0) {
                return ok(
                    args.path
                        ? `Снапшотов для этого файла нет: ${absPath ?? args.path}`
                        : "Снапшотов нет."
                );
            }

            const lines = snapshots.map(
                snapshot =>
                    `${snapshot.id}  ${snapshot.ts}  ${formatBytes(snapshot.bytes).padStart(9)}  ${snapshot.reason.padEnd(
                        18
                    )}  ${snapshot.originalPath}`
            );

            return ok(["id / время / размер / причина / файл", ...lines, "", "Откат: fs_restore { snapshotId }"].join("\n"));
        } catch (error) {
            return fromError("Error listing snapshots", error);
        }
    }
});

export const restoreTool = defineTool({
    name: "fs_restore",
    description:
        "Restore a file from a snapshot created before a write/patch. This is the undo button for autonomous edits. The current content is snapshotted first, so a restore can itself be undone.",
    annotations: { title: "Restore from snapshot", readOnlyHint: false, destructiveHint: true },
    schema: {
        snapshotId: z.string().describe("Snapshot id from fs_snapshots"),
        toPath: z.string().optional().describe("Restore to a different path instead of the original one")
    },
    handler: async (args: { snapshotId: string; toPath?: string }) => {
        try {
            const meta = await findSnapshot(args.snapshotId);
            if (!meta) {
                return fail(`Снапшот '${args.snapshotId}' не найден. Список доступных: fs_snapshots.`);
            }

            // Прогоняем ЦЕЛЬ через сандбокс — включая originalPath.
            // Раньше снапшот, снятый в bypass-режиме где-то вне проекта, можно было восстановить
            // уже после возврата в paranoic — запись мимо песочницы.
            const destination = args.toPath
                ? (await resolveSandboxed(args.toPath)).path
                : (await resolveSandboxed(meta.originalPath)).path;

            const result = await restoreSnapshot(args.snapshotId, destination);

            await audit({
                tool: "fs_restore",
                action: "restore",
                target: result.restoredTo,
                ok: true,
                detail: { snapshotId: args.snapshotId, bytes: result.bytes, backupId: result.backupId }
            });

            return okJson(
                {
                    snapshotId: result.meta.id,
                    restoredTo: result.restoredTo,
                    bytes: result.bytes,
                    snapshotTakenAt: result.meta.ts,
                    undoSnapshotId: result.backupId
                },
                result.backupId
                    ? `Файл восстановлен. Предыдущее содержимое сохранено как ${result.backupId} — откат отката возможен.`
                    : "Файл восстановлен из снапшота."
            );
        } catch (error) {
            await audit({ tool: "fs_restore", action: "restore", target: args.snapshotId, ok: false });
            return fromError("Error restoring snapshot", error);
        }
    }
});
