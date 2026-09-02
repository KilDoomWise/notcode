/**
 * Первый запуск: создаёт ~/.notcode, генерит токен, привязывает текущую папку
 * как воркспейс и печатает готовые к вставке настройки клиента.
 *
 * Запуск: bun run setup
 */
import { resolve } from "node:path";
import {
    CONFIG_DIR,
    CONFIG_FILE,
    ConfigError,
    DEFAULT_PROFILE,
    ensureConfigDirs,
    getWorkspaceRoot,
    updateConfig
} from "@/config";
import { allTools } from "@/tools/index";

function box(lines: string[]): string {
    const width = Math.max(...lines.map(line => line.length), 62);
    const border = (left: string, right: string): string => `${left}${"\u2500".repeat(width + 2)}${right}`;
    const body = lines.map(line => (line === "-" ? border("\u251c", "\u2524") : `\u2502 ${line.padEnd(width)} \u2502`));
    return [border("\u250c", "\u2510"), ...body, border("\u2514", "\u2518")].join("\n");
}

async function main(): Promise<void> {
    const projectRoot = resolve(process.env.WORKSPACE_ROOT ?? process.cwd());
    const isFirstRun = !(await Bun.file(CONFIG_FILE).exists());

    await ensureConfigDirs();

    const config = await updateConfig(current => {
        const profile = current.profiles.find(item => item.name === DEFAULT_PROFILE);
        if (profile) {
            if (isFirstRun) profile.root = projectRoot;
        } else {
            current.profiles.unshift({ name: DEFAULT_PROFILE, root: projectRoot, allowedPaths: [] });
        }
    });

    // По умолчанию слушаем 127.0.0.1 — в адресе для клиента показываем localhost.
    const displayHost = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host;
    const baseUrl = `http://${displayHost}:${config.port}`;

    console.log(
        box([
            isFirstRun ? "\u2705 NotCode настроен — конфиг создан" : "\u2705 NotCode уже настроен — конфиг на месте",
            "-",
            `Режим:        ${config.mode.toUpperCase()}`,
            `Воркспейс:    ${config.activeProfile} \u2192 ${getWorkspaceRoot(config)}`,
            `Тулов:        ${allTools.length}`,
            `MCP-адрес:    ${baseUrl}${config.sse.mcpPath}`,
            `Legacy SSE:   ${baseUrl}${config.sse.ssePath}`,
            `Токен:        ${config.token}`,
            `Heartbeat:    каждые ${Math.round(config.sse.heartbeatMs / 1000)} с (только для legacy SSE)`,
            `Конфиг:       ${CONFIG_FILE}`,
            `Данные:       ${CONFIG_DIR} (аудит + снапшоты)`,
            "-",
            "Дальше:",
            "  1. bun run start            — поднять сервер",
            "  2. bun run smoke            — проверить тулы без сервера",
            "  3. bun run e2e              — проверить живой коннект (/mcp + legacy)",
            "  4. bun run status           — текущие настройки",
            "  5. bun run src/index.ts mode bypass   — полная автономия агента"
        ])
    );

    console.log("\nНастройки для MCP-клиента (Notion AI, Claude Desktop, Cursor):\n");
    console.log(
        JSON.stringify(
            {
                url: `${baseUrl}${config.sse.mcpPath}`,
                transport: "streamable-http",
                authentication: "Bearer token",
                token: config.token
            },
            null,
            2
        )
    );

    if (!config.security.allowRuntimeModeChange || !config.security.allowRuntimeWorkspaceChange) {
        console.log(
            "\nЗаметка по безопасности: агент не может сам менять режим безопасности и список разрешённых папок." +
                "\nРазрешить явно: bun run src/index.ts security runtime-mode on | runtime-workspace on"
        );
    }

    console.log("\nСовет: наружу выставляй только через HTTPS-реверс-прокси и никогда не коммить токен.\n");
}

main().catch((error: unknown) => {
    if (error instanceof ConfigError) {
        console.error(`\n❌ Конфиг сломан: ${error.message}\n`);
        process.exit(1);
    }
    console.error(`\n❌ Не удалось настроить NotCode: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
