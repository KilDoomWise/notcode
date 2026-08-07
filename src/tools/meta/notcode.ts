import { z } from "zod";
import { resolve } from "node:path";
import {
    CONFIG_FILE,
    allowedPathsFor,
    getProfile,
    getWorkspaceRoot,
    loadConfig,
    updateConfig,
    type SecurityMode
} from "@/config";
import { defineTool } from "@/tools/types";
import { audit, readAudit } from "@/utils/audit";
import { fail, fromError, ok, okJson } from "@/utils/result";
import { terminals } from "@/utils/terminal-manager";
import { watchers } from "@/utils/watch-manager";

const modeEnum = z.enum(["paranoic", "auto", "bypass"]);

/**
 * Расширение собственных прав агентом — привилегированная операция.
 *
 * Раньше любой, кто мог вызвать тулы, мог сказать notcode_set_mode { mode: "bypass" }
 * и мгновенно получить доступ ко всему диску — то есть режимы paranoic/auto ничего не значили.
 * Теперь это возможно только если человек явно разрешил это в конфиге.
 */
function lockedMessage(what: string, cliCommand: string): string {
    return (
        `Заблокировано: ${what} нельзя менять из MCP-тулов.\n\n` +
        `Это защита от саморасширения прав: иначе режимы безопасности не имеют смысла.\n` +
        `Сделай это в терминале вручную:\n  ${cliCommand}\n\n` +
        `Или разреши runtime-изменения один раз:\n` +
        `  bun run src/index.ts security runtime-mode on\n` +
        `  bun run src/index.ts security runtime-workspace on`
    );
}

export const statusTool = defineTool({
    name: "notcode_status",
    description:
        "Show the server's current state: security mode, active workspace profile and root, allowed paths, limits, open terminal sessions and watchers. Call this first when you are unsure what you are allowed to do.",
    annotations: { title: "NotCode status", readOnlyHint: true, idempotentHint: true },
    schema: {},
    handler: async () => {
        try {
            const config = await loadConfig();
            return okJson({
                mode: config.mode,
                workspaceRoot: getWorkspaceRoot(config),
                activeProfile: config.activeProfile,
                profiles: config.profiles.map(profile => profile.name),
                allowedPaths: allowedPathsFor(config),
                limits: config.limits,
                security: config.security,
                audit: config.audit,
                snapshots: config.snapshots,
                server: {
                    host: config.host,
                    port: config.port,
                    heartbeatMs: config.sse.heartbeatMs,
                    configFile: CONFIG_FILE
                },
                terminals: terminals.list(),
                watchers: watchers.list()
            });
        } catch (error) {
            return fromError("Error reading status", error);
        }
    }
});

export const auditTool = defineTool({
    name: "notcode_audit",
    description:
        "Read the audit log of every write, patch, restore, exec and commit performed through this server. Useful to review what an autonomous agent did in bypass mode.",
    annotations: { title: "NotCode audit log", readOnlyHint: true, idempotentHint: true },
    schema: {
        limit: z
            .number()
            .int()
            .min(1)
            .max(500)
            .optional()
            .describe("How many entries to return (default 50, newest first)"),
        tool: z.string().optional().describe("Filter by tool name, e.g. 'fs_write_file'"),
        onlyErrors: z.boolean().optional().describe("Only failed operations")
    },
    handler: async (args: { limit?: number; tool?: string; onlyErrors?: boolean }) => {
        try {
            const entries = await readAudit(args);
            if (entries.length === 0) return ok("Аудит-лог пуст.");

            const lines = entries.map(entry => {
                const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : "";
                return `${entry.ts}  ${entry.ok ? "OK  " : "FAIL"}  ${entry.tool.padEnd(16)} ${entry.action.padEnd(11)} ${
                    entry.target ?? ""
                }${detail}`;
            });

            return ok(lines.join("\n"));
        } catch (error) {
            return fromError("Error reading audit log", error);
        }
    }
});

export const setModeTool = defineTool({
    name: "notcode_set_mode",
    description:
        "Change the security mode: paranoic (workspace root only), auto (root + allowed paths), bypass (no path restrictions). Disabled by default: the owner must enable runtime mode changes explicitly.",
    annotations: { title: "Change security mode", readOnlyHint: false, destructiveHint: true },
    schema: {
        mode: modeEnum.describe("New security mode")
    },
    handler: async (args: { mode: SecurityMode }) => {
        try {
            const current = await loadConfig();

            if (!current.security.allowRuntimeModeChange) {
                await audit({
                    tool: "notcode_set_mode",
                    action: "set_mode",
                    target: args.mode,
                    ok: false,
                    detail: { denied: "allowRuntimeModeChange=false" }
                });
                return fail(lockedMessage("режим безопасности", `bun run src/index.ts mode ${args.mode}`));
            }

            const config = await updateConfig(draft => {
                draft.mode = args.mode;
            });
            await audit({ tool: "notcode_set_mode", action: "set_mode", target: args.mode, ok: true });

            return ok(`Режим безопасности: ${config.mode.toUpperCase()} (root: ${getWorkspaceRoot(config)})`);
        } catch (error) {
            return fromError("Error changing mode", error);
        }
    }
});

export const workspaceListTool = defineTool({
    name: "workspace_list",
    description: "List workspace profiles (each has its own root and allowed paths) and show which one is active.",
    annotations: { title: "List workspaces", readOnlyHint: true, idempotentHint: true },
    schema: {},
    handler: async () => {
        try {
            const config = await loadConfig();
            return okJson(
                config.profiles.map(profile => ({
                    name: profile.name,
                    root: profile.root,
                    allowedPaths: profile.allowedPaths,
                    active: profile.name === config.activeProfile
                }))
            );
        } catch (error) {
            return fromError("Error listing workspaces", error);
        }
    }
});

export const workspaceUseTool = defineTool({
    name: "workspace_use",
    description:
        "Switch the active workspace profile, i.e. change the project root all relative paths resolve against, without restarting the server. Only profiles registered by the owner are available.",
    annotations: { title: "Switch workspace", readOnlyHint: false },
    schema: {
        name: z.string().describe("Profile name from workspace_list")
    },
    handler: async (args: { name: string }) => {
        try {
            const config = await loadConfig();
            if (!config.profiles.some(profile => profile.name === args.name)) {
                return fail(
                    `Профиль '${args.name}' не найден. Есть: ${config.profiles
                        .map(profile => profile.name)
                        .join(", ")}. Создать: workspace_add.`
                );
            }

            const updated = await updateConfig(draft => {
                draft.activeProfile = args.name;
            });
            await audit({ tool: "workspace_use", action: "switch", target: args.name, ok: true });

            return ok(`Активный воркспейс: ${args.name} → ${getProfile(updated).root}`);
        } catch (error) {
            return fromError("Error switching workspace", error);
        }
    }
});

export const workspaceAddTool = defineTool({
    name: "workspace_add",
    description:
        "Register a new workspace profile pointing at another project directory. Disabled by default: registering a new root is a privilege change, so the owner must enable it explicitly.",
    annotations: { title: "Add workspace", readOnlyHint: false, destructiveHint: true },
    schema: {
        name: z.string().describe("Profile name"),
        root: z.string().describe("Absolute path to the project root"),
        allowedPaths: z.array(z.string()).optional().describe("Extra directories allowed in auto mode"),
        use: z.boolean().optional().describe("Switch to this profile immediately")
    },
    handler: async (args: { name: string; root: string; allowedPaths?: string[]; use?: boolean }) => {
        try {
            const root = resolve(args.root);
            const current = await loadConfig();

            if (!current.security.allowRuntimeWorkspaceChange) {
                await audit({
                    tool: "workspace_add",
                    action: "add",
                    target: args.name,
                    ok: false,
                    detail: { denied: "allowRuntimeWorkspaceChange=false", root }
                });
                return fail(lockedMessage("список воркспейсов", `bun run src/index.ts workspace add ${args.name} "${root}"`));
            }

            const config = await updateConfig(draft => {
                const existing = draft.profiles.find(profile => profile.name === args.name);
                if (existing) {
                    existing.root = root;
                    existing.allowedPaths = (args.allowedPaths ?? existing.allowedPaths).map(item => resolve(item));
                } else {
                    draft.profiles.push({
                        name: args.name,
                        root,
                        allowedPaths: (args.allowedPaths ?? []).map(item => resolve(item))
                    });
                }
                if (args.use) draft.activeProfile = args.name;
            });

            await audit({ tool: "workspace_add", action: "add", target: args.name, ok: true, detail: { root } });

            return ok(`Профиль '${args.name}' сохранён (root: ${root}). Активный сейчас: ${config.activeProfile}`);
        } catch (error) {
            return fromError("Error adding workspace", error);
        }
    }
});

export const workspaceAllowTool = defineTool({
    name: "workspace_allow",
    description:
        "Allow access to a directory outside the workspace root while staying in auto mode. Disabled by default: widening the sandbox is a privilege change and must be enabled by the owner.",
    annotations: { title: "Allow directory", readOnlyHint: false, destructiveHint: true },
    schema: {
        path: z.string().describe("Directory to allow")
    },
    handler: async (args: { path: string }) => {
        try {
            const absPath = resolve(args.path);
            const current = await loadConfig();

            if (!current.security.allowRuntimeWorkspaceChange) {
                await audit({
                    tool: "workspace_allow",
                    action: "allow",
                    target: absPath,
                    ok: false,
                    detail: { denied: "allowRuntimeWorkspaceChange=false" }
                });
                return fail(lockedMessage("список разрешённых папок", `bun run src/index.ts allow "${absPath}"`));
            }

            await updateConfig(draft => {
                const profile = getProfile(draft);
                if (!profile.allowedPaths.includes(absPath)) profile.allowedPaths.push(absPath);
            });
            await audit({ tool: "workspace_allow", action: "allow", target: absPath, ok: true });

            return ok(`Папка разрешена: ${absPath}`);
        } catch (error) {
            return fromError("Error allowing path", error);
        }
    }
});
