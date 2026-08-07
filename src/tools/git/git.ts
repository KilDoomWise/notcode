import { z } from "zod";
import { defineTool } from "@/tools/types";
import { audit } from "@/utils/audit";
import { fail, fromError, ok } from "@/utils/result";
import { resolveSandboxed } from "@/utils/sandbox";
import { formatRunResult, runOnce, type RunOnceResult } from "@/utils/shell";

/**
 * Все git-команды запускаются МАССИВОМ аргументов, без shell.
 *
 * Раньше команда склеивалась в строку через shellQuote(), который на Windows экранировал
 * кавычки как \" (cmd.exe так не умеет) и не трогал & | ^ %. Сообщение коммита
 * вида  x" & rmdir /s /q C:\proj & echo "  выходило за пределы аргумента и выполнялось.
 * argv убирает класс этих ошибок целиком: shell в цепочке просто нет.
 *
 * core.quotepath=false — чтобы кириллица в именах файлов не приезжала в виде "\320\244...".
 */
async function git(args: string[], cwd?: string, timeoutMs = 60_000): Promise<RunOnceResult> {
    const target = cwd ? (await resolveSandboxed(cwd)).path : undefined;
    return runOnce({ argv: ["git", "-c", "core.quotepath=false", ...args], cwd: target, timeoutMs });
}

/** Добавляет предупреждения о неполноте вывода: без них агент считает обрезанный дифф полным. */
function withWarnings(result: RunOnceResult, body: string): string {
    const warnings: string[] = [];
    if (result.timedOut) warnings.push("⚠️ Команда прервана по таймауту — вывод неполный.");
    if (result.truncated) warnings.push("⚠️ Вывод усечён лимитом maxOutputChars — сузь запрос (path / statOnly).");
    return warnings.length > 0 ? `${warnings.join("\n")}\n\n${body}` : body;
}

/** Проверяет, что каталог вообще является репозиторием — иначе агент получает сырую ошибку git. */
async function repoProblem(cwd?: string): Promise<string | null> {
    const check = await git(["rev-parse", "--is-inside-work-tree"], cwd, 15_000);
    if (check.exitCode === 0 && check.stdout.trim() === "true") return null;

    if (check.exitCode === null) {
        return `Не удалось запустить git (установлен ли он и есть ли в PATH?).\n${formatRunResult(check)}`;
    }

    return `Это не git-репозиторий: ${check.cwd}\nСоздать: terminal_exec с командой "git init".`;
}

export const gitStatusTool = defineTool({
    name: "git_status",
    description:
        "Show git branch, ahead/behind info and the list of staged, modified and untracked files in a structured way.",
    annotations: { title: "Git status", readOnlyHint: true, idempotentHint: true },
    schema: {
        cwd: z.string().optional().describe("Repository directory (defaults to workspace root)")
    },
    handler: async (args: { cwd?: string }) => {
        try {
            const problem = await repoProblem(args.cwd);
            if (problem) return fail(problem);

            const result = await git(["status", "--porcelain=v1", "-b"], args.cwd);
            if (result.exitCode !== 0) return fail(formatRunResult(result));

            const lines = result.stdout.split("\n").filter(line => line.trim().length > 0);
            const branchLine = lines.find(line => line.startsWith("##")) ?? "## (unknown)";
            const files = lines.filter(line => !line.startsWith("##"));

            const staged = files.filter(line => line[0] !== " " && line[0] !== "?");
            const unstaged = files.filter(line => line[1] !== " " && line[0] !== "?");
            const untracked = files.filter(line => line.startsWith("??"));
            const renamed = files.filter(line => line.startsWith("R"));

            const section = (title: string, items: string[]): string =>
                items.length > 0
                    ? `${title} (${items.length}):\n${items.map(item => `  ${item}`).join("\n")}`
                    : `${title}: —`;

            return ok(
                withWarnings(
                    result,
                    [
                        branchLine.replace("## ", "Ветка: "),
                        "",
                        section("В индексе", staged),
                        section("Изменено без индекса", unstaged),
                        section("Не отслеживается", untracked),
                        renamed.length > 0 ? section("Переименовано", renamed) : "",
                        "",
                        files.length === 0 ? "Рабочее дерево чистое." : `Всего изменённых файлов: ${files.length}`
                    ]
                        .filter(line => line !== "")
                        .join("\n")
                )
            );
        } catch (error) {
            return fromError("Error running git status", error);
        }
    }
});

export const gitDiffTool = defineTool({
    name: "git_diff",
    description:
        "Show a git diff of working tree or staged changes, optionally limited to a path. Use statOnly for a quick overview of what changed.",
    annotations: { title: "Git diff", readOnlyHint: true, idempotentHint: true },
    schema: {
        path: z.string().optional().describe("Limit the diff to this file or directory"),
        staged: z.boolean().optional().describe("Diff staged changes instead of the working tree"),
        statOnly: z.boolean().optional().describe("Only show the summary of changed files (--stat)"),
        cwd: z.string().optional().describe("Repository directory")
    },
    handler: async (args: { path?: string; staged?: boolean; statOnly?: boolean; cwd?: string }) => {
        try {
            const problem = await repoProblem(args.cwd);
            if (problem) return fail(problem);

            const parts = ["diff"];
            if (args.staged) parts.push("--staged");
            if (args.statOnly) parts.push("--stat");
            if (args.path) parts.push("--", args.path);

            const result = await git(parts, args.cwd);
            if (result.exitCode !== 0) return fail(formatRunResult(result));

            return ok(withWarnings(result, result.stdout.trim().length > 0 ? result.stdout : "Изменений нет."));
        } catch (error) {
            return fromError("Error running git diff", error);
        }
    }
});

export const gitCommitTool = defineTool({
    name: "git_commit",
    description:
        "Create a git commit. Can stage everything (addAll) or specific paths first. Returns the resulting commit hash and summary.",
    annotations: { title: "Git commit", readOnlyHint: false, destructiveHint: false },
    schema: {
        message: z.string().min(1).describe("Commit message"),
        addAll: z.boolean().optional().describe("Run 'git add -A' before committing"),
        paths: z.array(z.string()).optional().describe("Specific paths to stage before committing"),
        cwd: z.string().optional().describe("Repository directory")
    },
    handler: async (args: { message: string; addAll?: boolean; paths?: string[]; cwd?: string }) => {
        try {
            const problem = await repoProblem(args.cwd);
            if (problem) return fail(problem);

            if (args.addAll) {
                const add = await git(["add", "-A"], args.cwd);
                if (add.exitCode !== 0) return fail(formatRunResult(add));
            } else if (args.paths && args.paths.length > 0) {
                const add = await git(["add", "--", ...args.paths], args.cwd);
                if (add.exitCode !== 0) return fail(formatRunResult(add));
            }

            const result = await git(["commit", "-m", args.message], args.cwd);
            await audit({
                tool: "git_commit",
                action: "commit",
                target: args.message,
                ok: result.exitCode === 0,
                detail: { cwd: result.cwd }
            });

            if (result.exitCode !== 0) return fail(formatRunResult(result));

            const hash = await git(["rev-parse", "--short", "HEAD"], args.cwd);
            return ok(`Коммит создан: ${hash.stdout.trim()}\n\n${result.stdout}`);
        } catch (error) {
            await audit({ tool: "git_commit", action: "commit", target: args.message, ok: false });
            return fromError("Error creating commit", error);
        }
    }
});

export const gitLogTool = defineTool({
    name: "git_log",
    description: "Show recent git commits in compact one-line format, optionally filtered by path.",
    annotations: { title: "Git log", readOnlyHint: true, idempotentHint: true },
    schema: {
        limit: z.number().int().min(1).max(200).optional().describe("How many commits to show (default 20)"),
        path: z.string().optional().describe("Only commits touching this path"),
        cwd: z.string().optional().describe("Repository directory")
    },
    handler: async (args: { limit?: number; path?: string; cwd?: string }) => {
        try {
            const problem = await repoProblem(args.cwd);
            if (problem) return fail(problem);

            const parts = ["log", "--oneline", "--decorate", "-n", String(args.limit ?? 20)];
            if (args.path) parts.push("--", args.path);

            const result = await git(parts, args.cwd);
            if (result.exitCode !== 0) return fail(formatRunResult(result));

            return ok(withWarnings(result, result.stdout.trim().length > 0 ? result.stdout : "Коммитов нет."));
        } catch (error) {
            return fromError("Error running git log", error);
        }
    }
});

export const gitBranchTool = defineTool({
    name: "git_branch",
    description: "List branches, create a new branch, or switch to an existing one.",
    annotations: { title: "Git branch", readOnlyHint: false },
    schema: {
        create: z.string().optional().describe("Name of a new branch to create and switch to"),
        checkout: z.string().optional().describe("Existing branch to switch to"),
        cwd: z.string().optional().describe("Repository directory")
    },
    handler: async (args: { create?: string; checkout?: string; cwd?: string }) => {
        try {
            const problem = await repoProblem(args.cwd);
            if (problem) return fail(problem);

            if (args.create) {
                const result = await git(["checkout", "-b", args.create], args.cwd);
                await audit({ tool: "git_branch", action: "create", target: args.create, ok: result.exitCode === 0 });
                return result.exitCode === 0 ? ok(formatRunResult(result)) : fail(formatRunResult(result));
            }

            if (args.checkout) {
                const result = await git(["checkout", args.checkout], args.cwd);
                await audit({ tool: "git_branch", action: "checkout", target: args.checkout, ok: result.exitCode === 0 });
                return result.exitCode === 0 ? ok(formatRunResult(result)) : fail(formatRunResult(result));
            }

            const result = await git(["branch", "-vv", "--all"], args.cwd);
            return result.exitCode === 0 ? ok(result.stdout || "Веток нет.") : fail(formatRunResult(result));
        } catch (error) {
            return fromError("Error running git branch", error);
        }
    }
});
