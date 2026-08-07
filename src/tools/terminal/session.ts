import { z } from "zod";
import { defineTool } from "@/tools/types";
import { audit } from "@/utils/audit";
import { formatDuration } from "@/utils/output";
import { fail, fromError, ok, okJson } from "@/utils/result";
import { resolveSandboxed } from "@/utils/sandbox";
import { terminals, type ShellKind, AVAILABLE_SHELLS } from "@/utils/terminal-manager";

// Список ограничен под текущую ОС сервера — раньше схема всегда показывала все 4 варианта,
// и модель могла попросить cmd на Linux или bash на Windows без WSL, получая на выходе
// малопонятную ошибку ENOENT при спавне вместо явного списка того, что реально доступно.
const shellEnum = z.enum(AVAILABLE_SHELLS as [ShellKind, ...ShellKind[]]);

export const terminalOpenTool = defineTool({
    name: "terminal_open",
    description:
        "Open a persistent, isolated terminal session and get its id. State (cwd, env, shell history) survives between commands, and long-running commands keep running in the background while you work in other sessions.",
    annotations: { title: "Open terminal", readOnlyHint: false },
    schema: {
        name: z.string().optional().describe("Human-friendly label, e.g. 'build' or 'tests'"),
        cwd: z.string().optional().describe("Starting directory (defaults to workspace root)"),
        shell: shellEnum.optional().describe(`Shell to use (default: cmd on Windows, bash elsewhere). Available on this server: ${AVAILABLE_SHELLS.join(", ")}`)
    },
    handler: async (args: { name?: string; cwd?: string; shell?: ShellKind }) => {
        try {
            const cwd = args.cwd ? (await resolveSandboxed(args.cwd)).path : undefined;
            const info = await terminals.open({ name: args.name, cwd, shell: args.shell });

            await audit({
                tool: "terminal_open",
                action: "open",
                target: info.id,
                ok: true,
                detail: { cwd: info.cwd, shell: info.shell }
            });

            return okJson(
                info,
                `Терминал открыт. Запускай команды: terminal_run { sessionId: "${info.id}", command: "..." }`
            );
        } catch (error) {
            return fromError("Error opening terminal", error);
        }
    }
});

export const terminalRunTool = defineTool({
    name: "terminal_run",
    description:
        "Run a command inside an existing terminal session. Waits up to waitMs for completion; if it is still running, returns the output so far and keeps it running in the background (check later with terminal_read). Exit code and cwd are tracked per session, so 'cd' persists.",
    annotations: { title: "Run in terminal", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    schema: {
        sessionId: z.string().describe("Session id from terminal_open"),
        command: z.string().describe("Command to run in the session"),
        waitMs: z
            .number()
            .int()
            .min(0)
            .max(600_000)
            .optional()
            .describe("How long to wait for completion before returning (default 5000). Use 0 to fire and forget.")
    },
    handler: async (args: { sessionId: string; command: string; waitMs?: number }) => {
        try {
            const session = terminals.get(args.sessionId);
            const result = await session.run(args.command, args.waitMs ?? 5000);

            await audit({
                tool: "terminal_run",
                action: "run",
                target: args.command,
                ok: result.completed ? result.exitCode === 0 : true,
                detail: {
                    sessionId: args.sessionId,
                    exitCode: result.exitCode,
                    completed: result.completed,
                    cwd: result.cwd
                }
            });

            const status = result.completed
                ? `завершено за ${formatDuration(result.elapsedMs)}, exit=${result.exitCode}`
                : `ВСЁ ЕЩЁ ВЫПОЛНЯЕТСЯ (${formatDuration(result.elapsedMs)}) — читай дальше через terminal_read { sessionId: "${
                      args.sessionId
                  }", since: ${result.cursor} }`;

            const header = `[${args.sessionId}] $ ${args.command}\ncwd: ${result.cwd}  |  ${status}  |  cursor: ${result.cursor}`;
            const body = result.output.trim().length > 0 ? result.output : "(пока нет вывода)";

            // Упавшая команда должна быть видна как ошибка, а не как обычный текст.
            const text = `${header}\n\n${body}`;
            return result.completed && result.exitCode !== 0 ? fail(text) : ok(text);
        } catch (error) {
            return fromError("Error running command in terminal", error);
        }
    }
});

export const terminalReadTool = defineTool({
    name: "terminal_read",
    description:
        "Read buffered output of a terminal session, optionally only what is new since a cursor value. Use it to check on a build/test run started earlier and to see whether it failed.",
    annotations: { title: "Read terminal output", readOnlyHint: true },
    schema: {
        sessionId: z.string().describe("Session id"),
        since: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Cursor from a previous terminal_run/terminal_read call: returns only newer output"),
        tail: z.number().int().min(100).max(200_000).optional().describe("Return only the last N characters"),
        maxChars: z.number().int().min(100).max(200_000).optional().describe("Hard cap on returned characters")
    },
    handler: async (args: { sessionId: string; since?: number; tail?: number; maxChars?: number }) => {
        try {
            const session = terminals.get(args.sessionId);
            const result = session.read({ since: args.since, tail: args.tail, maxChars: args.maxChars });
            const info = session.info();

            const header =
                `[${info.id}] status=${info.status}` +
                (info.status === "running"
                    ? ` (${info.lastCommand} — ${formatDuration(info.runningForMs ?? 0)})`
                    : ` lastExit=${info.lastExitCode}`) +
                `  |  cwd: ${info.cwd}  |  cursor: ${result.cursor}` +
                (result.droppedChars > 0 ? `  |  потеряно из-за размера буфера: ${result.droppedChars} симв.` : "");

            return ok(`${header}\n\n${result.text.trim().length > 0 ? result.text : "(нет нового вывода)"}`);
        } catch (error) {
            return fromError("Error reading terminal", error);
        }
    }
});

export const terminalWriteTool = defineTool({
    name: "terminal_write",
    description:
        "Send raw input to a terminal session's stdin. Use it to answer interactive prompts (y/n, package names, confirmations) of a command that is currently running.",
    annotations: { title: "Write to terminal stdin", readOnlyHint: false, destructiveHint: true },
    schema: {
        sessionId: z.string().describe("Session id"),
        input: z.string().describe("Text to send to stdin"),
        appendNewline: z.boolean().optional().describe("Append a newline, i.e. press Enter (default true)")
    },
    handler: async (args: { sessionId: string; input: string; appendNewline?: boolean }) => {
        try {
            const session = terminals.get(args.sessionId);
            await session.write(args.input, args.appendNewline ?? true);

            // stdin — такой же канал выполнения команд, как terminal_run. Раньше он не логировался вообще:
            // в аудите была дыра размером в любую команду, отправленную в живой shell.
            await audit({
                tool: "terminal_write",
                action: "stdin",
                target: args.input,
                ok: true,
                detail: { sessionId: args.sessionId }
            });

            await Bun.sleep(300);

            const info = session.info();
            return ok(`Ввод отправлен в ${info.id} (status=${info.status}). Смотри реакцию через terminal_read.`);
        } catch (error) {
            await audit({
                tool: "terminal_write",
                action: "stdin",
                target: args.input,
                ok: false,
                detail: { sessionId: args.sessionId }
            });
            return fromError("Error writing to terminal", error);
        }
    }
});

export const terminalListTool = defineTool({
    name: "terminal_list",
    description:
        "List all terminal sessions with status (idle/running/exited), current directory, last command, exit code and how long the current command has been running.",
    annotations: { title: "List terminals", readOnlyHint: true, idempotentHint: true },
    schema: {},
    handler: async () => {
        try {
            const sessions = terminals.list();
            if (sessions.length === 0) {
                return ok("Активных терминалов нет. Открой новый: terminal_open.");
            }
            return okJson(sessions, `Терминалов: ${sessions.length}`);
        } catch (error) {
            return fromError("Error listing terminals", error);
        }
    }
});

export const terminalCloseTool = defineTool({
    name: "terminal_close",
    description: "Close a terminal session (kills whatever is running in it, including child processes) or all sessions at once.",
    annotations: { title: "Close terminal", readOnlyHint: false, destructiveHint: true },
    schema: {
        sessionId: z.string().optional().describe("Session id to close"),
        all: z.boolean().optional().describe("Close every session instead of a single one"),
        force: z.boolean().optional().describe("Kill immediately instead of asking the shell to exit")
    },
    handler: async (args: { sessionId?: string; all?: boolean; force?: boolean }) => {
        try {
            if (args.all) {
                const closed = await terminals.closeAll();
                await audit({ tool: "terminal_close", action: "close_all", ok: true, detail: { closed } });
                return ok(`Закрыто терминалов: ${closed}`);
            }

            if (!args.sessionId) {
                return fail("Нужен sessionId или all=true. Список сессий: terminal_list.");
            }

            const info = await terminals.close(args.sessionId, args.force ?? false);
            await audit({ tool: "terminal_close", action: "close", target: info.id, ok: true });

            return okJson(info, "Терминал закрыт.");
        } catch (error) {
            return fromError("Error closing terminal", error);
        }
    }
});
