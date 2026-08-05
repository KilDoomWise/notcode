import { isAbsolute, relative, resolve } from "node:path";
import {
    allowedPathsFor,
    getWorkspaceRoot,
    loadConfig,
    type NotCodeConfig,
    type SecurityMode
} from "@/config";

export class SecurityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SecurityError";
    }
}

export interface SandboxedPath {
    /** Абсолютный, нормализованный путь. */
    path: string;
    /** Корень активного воркспейса. */
    root: string;
    mode: SecurityMode;
    /** true, если путь вне корня (возможно только в bypass/auto+allow). */
    outsideRoot: boolean;
}

function pathKey(value: string): string {
    return process.platform === "win32" ? value.toLowerCase() : value;
}

/** target находится внутри base (или равен ему)? */
export function isInside(base: string, target: string): boolean {
    const rel = relative(pathKey(resolve(base)), pathKey(resolve(target)));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Главный защитный слой для файловых операций.
 * bypass — пропускает всё (автономный агент), auto — корень + allowedPaths, paranoic — только корень.
 */
export async function resolveSandboxed(
    requestedPath: string | undefined,
    config?: NotCodeConfig
): Promise<SandboxedPath> {
    const cfg = config ?? (await loadConfig());
    const root = getWorkspaceRoot(cfg);
    const raw = requestedPath && requestedPath.trim().length > 0 ? requestedPath.trim() : ".";
    const target = resolve(root, raw);
    const outsideRoot = !isInside(root, target);

    if (cfg.mode === "bypass" || !outsideRoot) {
        return { path: target, root, mode: cfg.mode, outsideRoot };
    }

    if (cfg.mode === "auto") {
        const allowed = allowedPathsFor(cfg);
        if (allowed.some(allowedPath => isInside(allowedPath, target))) {
            return { path: target, root, mode: cfg.mode, outsideRoot };
        }
        throw new SecurityError(
            [
                `Security Exception: путь '${target}' вне разрешённых воркспейсов (mode=auto, root=${root}).`,
                `Разрешить папку:  bun run src/index.ts allow "${target}"`,
                `Или снять лимиты: bun run src/index.ts mode bypass`,
                `Разрешено сейчас: ${allowed.length > 0 ? allowed.join(", ") : "— (только корень)"}`
            ].join("\n")
        );
    }

    throw new SecurityError(
        [
            `Security Exception: доступ запрещён в режиме paranoic — путь вне корня воркспейса.`,
            `Путь: ${target}`,
            `Корень: ${root}`,
            `Сменить режим: bun run src/index.ts mode auto | bypass`
        ].join("\n")
    );
}

/** Совместимая с прошлой версией обёртка: отдаёт только путь. */
export async function enforceSandbox(requestedPath: string, config?: NotCodeConfig): Promise<string> {
    return (await resolveSandboxed(requestedPath, config)).path;
}
