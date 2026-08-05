/**
 * Смок-тест тулов без поднятия MCP-сервера: дёргаем handler'ы напрямую.
 * Запуск: bun run scripts/smoke.ts
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspaceRoot, loadConfig } from "@/config";
import { listDirTool } from "@/tools/fs/listDir";
import { patchFileTool } from "@/tools/fs/patchFile";
import { readFileTool } from "@/tools/fs/readFile";
import { searchContentTool } from "@/tools/fs/search";
import { snapshotsTool } from "@/tools/fs/snapshots";
import { writeFileTool } from "@/tools/fs/writeFile";
import { execTool } from "@/tools/terminal/exec";
import {
    terminalCloseTool,
    terminalListTool,
    terminalOpenTool,
    terminalReadTool,
    terminalRunTool
} from "@/tools/terminal/session";
import { statusTool } from "@/tools/meta/notcode";
import { allTools } from "@/tools/index";
import type { ToolResult } from "@/utils/result";

let passed = 0;
let failed = 0;

function textOf(result: ToolResult): string {
    return result.content.map(item => item.text).join("\n");
}

function check(name: string, condition: boolean, info = ""): void {
    if (condition) {
        passed++;
        console.log(`✅ ${name}`);
    } else {
        failed++;
        console.log(`❌ ${name}${info ? `\n   ${info.slice(0, 500)}` : ""}`);
    }
}

const SMOKE_DIR = ".notcode-smoke";

async function main(): Promise<void> {
    const config = await loadConfig();
    const root = getWorkspaceRoot(config);
    const smokePath = join(SMOKE_DIR, "demo.txt");

    console.log(`\n── NotCode smoke test ──\nroot: ${root}\nmode: ${config.mode}\nтулов: ${allTools.length}\n`);

    check("все имена тулов уникальны", new Set(allTools.map(tool => tool.name)).size === allTools.length);

    // ── fs ──
    const write = await writeFileTool.handler({ path: smokePath, content: "hello notcode\nline two\n" });
    check("fs_write_file создаёт файл", !write.isError, textOf(write));

    const read = await readFileTool.handler({ path: smokePath });
    check("fs_read_file читает содержимое", textOf(read).includes("hello notcode"), textOf(read));

    const partial = await readFileTool.handler({ path: smokePath, lineStart: 2, lineCount: 1 });
    check("fs_read_file читает срез строк", textOf(partial).includes("line two") && !textOf(partial).includes("hello notcode"), textOf(partial));

    const patch = await patchFileTool.handler({
        path: smokePath,
        edits: [{ oldStr: "hello notcode", newStr: "hello patched world" }]
    });
    check("fs_patch_file меняет фрагмент", !patch.isError, textOf(patch));

    const afterPatch = await readFileTool.handler({ path: smokePath });
    check("патч действительно применён", textOf(afterPatch).includes("hello patched world"), textOf(afterPatch));

    const missingPatch = await patchFileTool.handler({
        path: smokePath,
        edits: [{ oldStr: "этого текста точно нет", newStr: "x" }]
    });
    check("fs_patch_file ругается на ненайденный oldStr", missingPatch.isError);

    const list = await listDirTool.handler({ path: SMOKE_DIR });
    check("fs_list_dir видит файл", textOf(list).includes("demo.txt"), textOf(list));

    const search = await searchContentTool.handler({ query: "hello patched", path: SMOKE_DIR });
    check("fs_search_content находит строку", textOf(search).includes("demo.txt"), textOf(search));

    const snapshots = await snapshotsTool.handler({ path: smokePath });
    check("fs_snapshots видит сохранённую версию", !snapshots.isError, textOf(snapshots));

    // ── terminal (одноразовый) ──
    const exec = await execTool.handler({ command: process.platform === "win32" ? "echo one-shot-ok" : "echo one-shot-ok" });
    check("terminal_exec работает (раньше падал на $.raw)", textOf(exec).includes("one-shot-ok"), textOf(exec));

    // ── terminal (сессии) ──
    const open = await terminalOpenTool.handler({ name: "smoke" });
    check("terminal_open открывает сессию", !open.isError, textOf(open));

    const sessionId = (JSON.parse(textOf(open).split("\n").slice(1).join("\n")) as { id: string }).id;
    check("у сессии есть id", Boolean(sessionId), sessionId);

    const run = await terminalRunTool.handler({ sessionId, command: "echo session-ok", waitMs: 8000 });
    check("terminal_run выполняет команду", textOf(run).includes("session-ok"), textOf(run));
    check("terminal_run видит exit code", textOf(run).includes("exit=0"), textOf(run));

    const cdCommand = process.platform === "win32" ? "cd src" : "cd src";
    await terminalRunTool.handler({ sessionId, command: cdCommand, waitMs: 8000 });
    const pwd = await terminalRunTool.handler({ sessionId, command: process.platform === "win32" ? "cd" : "pwd", waitMs: 8000 });
    check("cwd сохраняется между командами сессии", textOf(pwd).toLowerCase().includes("src"), textOf(pwd));

    const background = await terminalRunTool.handler({
        sessionId,
        command: process.platform === "win32" ? "ping -n 4 127.0.0.1 > nul" : "sleep 3",
        waitMs: 300
    });
    check("долгая команда остаётся в фоне", textOf(background).includes("ВЫПОЛНЯЕТСЯ"), textOf(background));

    const listSessions = await terminalListTool.handler({});
    check("terminal_list видит сессию в статусе running", textOf(listSessions).includes("running"), textOf(listSessions));

    await Bun.sleep(4000);
    const readAfter = await terminalReadTool.handler({ sessionId });
    check("terminal_read видит завершение фоновой задачи", textOf(readAfter).includes("status=idle"), textOf(readAfter));

    const close = await terminalCloseTool.handler({ sessionId, force: true });
    check("terminal_close закрывает сессию", !close.isError, textOf(close));

    // ── meta ──
    const status = await statusTool.handler({});
    check("notcode_status отдаёт состояние", textOf(status).includes("workspaceRoot"), textOf(status));

    // ── уборка ──
    await rm(join(root, SMOKE_DIR), { recursive: true, force: true });

    console.log(`\n── Итог: ${passed} прошло, ${failed} упало ──\n`);
    process.exit(failed > 0 ? 1 : 0);
}

void main();
