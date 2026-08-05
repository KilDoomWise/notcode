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

    console.log(
        box([
            isFirstRun ? "\u2705 NotCode настроен — конфиг создан" : "\u2705 NotCode уже настроен — конфиг на месте",
            "-",
            `Режим:        ${config.mode.toUpperCase()}`,
            `Воркспейс:    ${config.activeProfile} \u2192 ${getWorkspaceRoot(config)}`,
            `Тулов:        ${allTools.length}`,
            `Адрес:        http://${config.host}:${config.port}/sse`,
            `Токен:        ${config.token}`,
            `Конфиг:       ${CONFIG_FILE}`,
            `Данные:       ${CONFIG_DIR} (аудит + снапшоты)`,
            "-",
            "Дальше:",
            "  1. bun run start            — поднять сервер",
            "  2. bun run smoke            — проверить, что всё работает",
            "  3. bun run status           — текущие настройки",
            "  4. bun run src/index.ts mode bypass   — полная автономия агента"
        ])
    );

    console.log("\nНастройки для MCP-клиента (Notion AI, Claude Desktop, Cursor):\n");
    console.log(
        JSON.stringify(
            {
                url: `http://localhost:${config.port}/sse`,
                transport: "sse",
                authentication: "Bearer token",
                token: config.token
            },
            null,
            2
        )
    );
    console.log(
        "\nСовет: наружу выставляй только через HTTPS-реверс-прокси и никогда не коммить токен.\n"
    );
}

void main();
