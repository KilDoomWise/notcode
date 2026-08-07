/**
 * Смок-тест тулов без поднятия MCP-сервера: дёргаем handler'ы напрямую.
 * Живой SSE-транспорт проверяет отдельный scripts/e2e.ts.
 *
 * Запуск: bun run smoke
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspaceRoot, loadConfig } from "@/config";
import { allTools } from "@/tools/index";
import { listDirTool } from "@/tools/fs/listDir";
import { patchFileTool } from "@/tools/fs/patchFile";
import { readFileTool } from "@/tools/fs/readFile";
import { findFilesTool, searchContentTool } from "@/tools/fs/search";
import { snapshotsTool } from "@/tools/fs/snapshots";
import { writeFileTool } from "@/tools/fs/writeFile";
import { watchListTool, watchPollTool, watchStartTool, watchStopTool } from "@/tools/fs/watch";
import { statusTool } from "@/tools/meta/notcode";
import { execTool } from "@/tools/terminal/exec";
import {
    terminalCloseTool,
    terminalListTool,
    terminalOpenTool,
    terminalReadTool,
    terminalRunTool
} from "@/tools/terminal/session";
import type { ToolResult } from "@/utils/result";

const SMOKE_DIR = ".notcode-smoke";
const isWindows = process.platform === "win32";

let passed = 0;
let failed = 0;

function textOf(result: ToolResult): string {
    return result.content.map(item => item.text).join("\n");
}

function check(name: string, condition: boolean, info = ""): void {
    if (condition) {
        passed++;
        console.log(`\u2705 ${name}`);
    } else {
        failed++;
        console.log(`\u274c ${name}${info ? `\n   ${info.slice(0, 600)}` : ""}`);
    }
}

/** okJson отдаёт текстовую пометку + JSON: вытаскиваем JSON устойчиво, а не по номеру строки. */
function jsonOf<T>(result: ToolResult): T | null {
    const text = textOf(result);
    const end = text.lastIndexOf("}");
    if (end === -1) return null;

    // Текстовая пометка сверху сама может содержать фигурные скобки (пример вызова тула),
    // поэтому перебираем все кандидаты-начала, а не берём слепо первую скобку.
    for (let start = text.indexOf("{"); start !== -1 && start < end; start = text.indexOf("{", start + 1)) {
        try {
            return JSON.parse(text.slice(start, end + 1)) as T;
        } catch {
            // не JSON — пробуем следующую скобку
        }
    }
    return null;
}

async function main(): Promise<void> {
    const config = await loadConfig();
    const root = getWorkspaceRoot(config);
    const smokePath = join(SMOKE_DIR, "demo.txt");
    const crlfPath = join(SMOKE_DIR, "crlf.txt");
    const nestedPath = join(SMOKE_DIR, "sub", "nested.ts");

    console.log(`\n\u2500\u2500 NotCode smoke test \u2500\u2500\nroot: ${root}\nmode: ${config.mode}\nтулов: ${allTools.length}\n`);

    // ── реестр тулов ──
    check("все имена тулов уникальны", new Set(allTools.map(tool => tool.name)).size === allTools.length);
    check(
        "у всех тулов есть описание",
        allTools.every(tool => tool.description.length > 20),
        allTools
            .filter(tool => tool.description.length <= 20)
            .map(tool => tool.name)
            .join(", ")
    );
    check(
        "у всех тулов есть annotations",
        allTools.every(tool => tool.annotations !== undefined),
        allTools
            .filter(tool => tool.annotations === undefined)
            .map(tool => tool.name)
            .join(", ")
    );

    // ── fs ──
    const write = await writeFileTool.handler({ path: smokePath, content: "hello notcode\nline two\n" });
    check("fs_write_file создаёт файл", !write.isError, textOf(write));

    const read = await readFileTool.handler({ path: smokePath });
    check("fs_read_file читает содержимое", textOf(read).includes("hello notcode"), textOf(read));

    const partial = await readFileTool.handler({ path: smokePath, lineStart: 2, lineCount: 1 });
    check(
        "fs_read_file читает срез строк",
        textOf(partial).includes("line two") && !textOf(partial).includes("hello notcode"),
        textOf(partial)
    );

    const outOfRange = await readFileTool.handler({ path: smokePath, lineStart: 9999 });
    check("fs_read_file честно говорит о выходе за пределы файла", outOfRange.isError, textOf(outOfRange));

    const patch = await patchFileTool.handler({
        path: smokePath,
        edits: [{ oldStr: "hello notcode", newStr: "hello patched world" }]
    });
    check("fs_patch_file меняет фрагмент", !patch.isError, textOf(patch));

    const afterPatch = await readFileTool.handler({ path: smokePath });
    check("патч действительно применён", textOf(afterPatch).includes("hello patched world"), textOf(afterPatch));

    // Регресс на реальный баг: $& в newStr раньше подставлял найденный текст и тихо портил код.
    await patchFileTool.handler({ path: smokePath, edits: [{ oldStr: "line two", newStr: 'const price = "$&";' }] });
    const dollarRead = await readFileTool.handler({ path: smokePath });
    check(
        "fs_patch_file не интерпретирует $& в замене",
        textOf(dollarRead).includes('const price = "$&";'),
        textOf(dollarRead)
    );

    // Регресс: CRLF-файл + oldStr с обычными \n.
    await writeFileTool.handler({ path: crlfPath, content: "alpha\r\nbeta\r\ngamma\r\n" });
    const crlfPatch = await patchFileTool.handler({
        path: crlfPath,
        edits: [{ oldStr: "alpha\nbeta", newStr: "alpha\nBETA" }]
    });
    check("fs_patch_file терпим к CRLF", !crlfPatch.isError, textOf(crlfPatch));

    const dryRun = await patchFileTool.handler({
        path: smokePath,
        edits: [{ oldStr: "hello patched world", newStr: "dry" }],
        dryRun: true
    });
    const afterDryRun = await readFileTool.handler({ path: smokePath });
    check(
        "dryRun не трогает файл",
        !dryRun.isError && textOf(afterDryRun).includes("hello patched world"),
        textOf(dryRun)
    );

    const missingPatch = await patchFileTool.handler({
        path: smokePath,
        edits: [{ oldStr: "этого текста точно нет", newStr: "x" }]
    });
    check("fs_patch_file ругается на ненайденный oldStr", missingPatch.isError);

    const escape = await readFileTool.handler({ path: join("..", "..", "..", "Windows", "win.ini") });
    check(
        "песочница или разрешает путь осознанно, или блокирует его внятно",
        config.mode === "bypass" || escape.isError,
        textOf(escape)
    );

    await writeFileTool.handler({ path: nestedPath, content: "export const nested = true;\n" });

    const list = await listDirTool.handler({ path: SMOKE_DIR, depth: 2, withSizes: true });
    check("fs_list_dir видит файл", textOf(list).includes("demo.txt"), textOf(list));
    check("fs_list_dir строит дерево", textOf(list).includes("nested.ts"), textOf(list));

    const search = await searchContentTool.handler({ query: "hello patched", path: SMOKE_DIR });
    check("fs_search_content находит строку", textOf(search).includes("demo.txt"), textOf(search));

    const badRegex = await searchContentTool.handler({ query: "([unclosed", path: SMOKE_DIR, isRegex: true });
    check("fs_search_content объясняет кривую регулярку", badRegex.isError, textOf(badRegex));

    const find = await findFilesTool.handler({ pattern: "*.ts", path: SMOKE_DIR });
    check("fs_find_files находит по glob", textOf(find).includes("nested.ts"), textOf(find));

    const snapshots = await snapshotsTool.handler({ path: smokePath });
    check("fs_snapshots видит сохранённую версию", !snapshots.isError, textOf(snapshots));

    // ── watchers ──
    const watchStart = await watchStartTool.handler({ path: SMOKE_DIR });
    const watcherId = jsonOf<{ id: string }>(watchStart)?.id ?? "";
    check("fs_watch_start отдаёт id", Boolean(watcherId), textOf(watchStart));

    if (watcherId) {
        await writeFileTool.handler({ path: join(SMOKE_DIR, "touched.txt"), content: "touch\n" });
        await Bun.sleep(400);
        const poll = await watchPollTool.handler({ watcherId });
        check("fs_watch_poll отдаёт события", !poll.isError, textOf(poll));

        const watchList = await watchListTool.handler({});
        check("fs_watch_list видит наблюдателя", textOf(watchList).includes(watcherId), textOf(watchList));

        const watchStop = await watchStopTool.handler({ watcherId });
        check("fs_watch_stop останавливает наблюдателя", !watchStop.isError, textOf(watchStop));
    }

    // ── terminal (одноразовый) ──
    const exec = await execTool.handler({ command: "echo one-shot-ok" });
    check("terminal_exec работает", textOf(exec).includes("one-shot-ok"), textOf(exec));

    const execFail = await execTool.handler({ command: "exit 3" });
    check("terminal_exec показывает ненулевой exit code", textOf(execFail).includes("3"), textOf(execFail));

    // ── terminal (сессии) ──
    const open = await terminalOpenTool.handler({ name: "smoke" });
    check("terminal_open открывает сессию", !open.isError, textOf(open));

    const sessionId = jsonOf<{ id: string }>(open)?.id ?? "";
    check("у сессии есть id", Boolean(sessionId), textOf(open));

    if (sessionId) {
        try {
            const run = await terminalRunTool.handler({ sessionId, command: "echo session-ok", waitMs: 8000 });
            check("terminal_run выполняет команду", textOf(run).includes("session-ok"), textOf(run));
            check("terminal_run видит exit code", textOf(run).includes("exit=0"), textOf(run));

            // cwd проверяем на своей папке, а не на захардкоженном src/ — тест должен работать в любом воркспейсе.
            await terminalRunTool.handler({ sessionId, command: `cd ${SMOKE_DIR}`, waitMs: 8000 });
            await terminalRunTool.handler({ sessionId, command: "cd sub", waitMs: 8000 });
            const pwd = await terminalRunTool.handler({
                sessionId,
                command: isWindows ? "cd" : "pwd",
                waitMs: 8000
            });
            check("cwd сохраняется между командами сессии", textOf(pwd).toLowerCase().includes("sub"), textOf(pwd));

            const background = await terminalRunTool.handler({
                sessionId,
                command: isWindows ? "ping -n 4 127.0.0.1 > nul" : "sleep 3",
                waitMs: 300
            });
            check("долгая команда остаётся в фоне", textOf(background).includes("ВЫПОЛНЯЕТСЯ"), textOf(background));

            const listSessions = await terminalListTool.handler({});
            check(
                "terminal_list видит сессию в статусе running",
                textOf(listSessions).includes("running"),
                textOf(listSessions)
            );

            await Bun.sleep(4000);
            const readAfter = await terminalReadTool.handler({ sessionId });
            check(
                "terminal_read видит завершение фоновой задачи",
                textOf(readAfter).includes("status=idle"),
                textOf(readAfter)
            );
        } finally {
            const close = await terminalCloseTool.handler({ sessionId, force: true });
            check("terminal_close закрывает сессию", !close.isError, textOf(close));
        }
    }

    const closeWithoutArgs = await terminalCloseTool.handler({});
    check("terminal_close без аргументов не убивает всё молча", closeWithoutArgs.isError, textOf(closeWithoutArgs));

    // ── meta ──
    const status = await statusTool.handler({});
    check("notcode_status отдаёт состояние", textOf(status).includes("workspaceRoot"), textOf(status));
    check("notcode_status показывает настройки безопасности", textOf(status).includes("security"), textOf(status));
}

async function cleanup(): Promise<void> {
    try {
        const config = await loadConfig();
        await rm(join(getWorkspaceRoot(config), SMOKE_DIR), { recursive: true, force: true });
    } catch {
        // уборка — best effort
    }
}

try {
    await main();
} catch (error) {
    failed++;
    console.log(`\u274c Смок упал с исключением: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
    // Убираем всегда: раньше падение теста оставляло .notcode-smoke в репо.
    await cleanup();
}

console.log(`\n\u2500\u2500 Итог: ${passed} прошло, ${failed} упало \u2500\u2500\n`);
process.exit(failed > 0 ? 1 : 0);
