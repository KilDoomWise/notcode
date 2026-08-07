import { z } from "zod";
import { defineTool } from "@/tools/types";
import { audit } from "@/utils/audit";
import { fail, fromError, ok } from "@/utils/result";
import { resolveSandboxed } from "@/utils/sandbox";
import { formatRunResult, runOnce } from "@/utils/shell";

export const execTool = defineTool({
    name: "terminal_exec",
    description:
        "Run a one-shot shell command and wait for it to finish. Has a timeout and output cap. For long tasks (builds, dev servers, watchers) use terminal_open + terminal_run instead so the command keeps running in the background.",
    annotations: { title: "Run shell command", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    schema: {
        command: z.string().min(1).describe("Command to execute, e.g. 'git status' or 'bun run build'"),
        cwd: z.string().optional().describe("Working directory (defaults to workspace root)"),
        timeoutMs: z.number().int().min(1000).max(600_000).optional().describe("Kill the command after this many ms"),
        maxOutputChars: z.number().int().min(500).max(200_000).optional().describe("Cap on returned output characters")
    },
    handler: async (args: { command: string; cwd?: string; timeoutMs?: number; maxOutputChars?: number }) => {
        try {
            const cwd = args.cwd ? (await resolveSandboxed(args.cwd)).path : undefined;
            const result = await runOnce({
                command: args.command,
                cwd,
                timeoutMs: args.timeoutMs,
                maxOutputChars: args.maxOutputChars
            });

            const succeeded = result.exitCode === 0 && !result.timedOut;

            await audit({
                tool: "terminal_exec",
                action: "exec",
                target: args.command,
                ok: succeeded,
                detail: {
                    cwd: result.cwd,
                    exitCode: result.exitCode,
                    durationMs: result.durationMs,
                    timedOut: result.timedOut,
                    truncated: result.truncated
                }
            });

            const rendered = formatRunResult(result);
            return succeeded ? ok(rendered) : fail(rendered);
        } catch (error) {
            await audit({ tool: "terminal_exec", action: "exec", target: args.command, ok: false });
            return fromError("Execution error", error);
        }
    }
});
