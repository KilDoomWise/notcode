# NotCode 🛠️

> **Локальный MCP-сервер для Notion AI и других MCP-клиентов**, который даёт агенту полноценные руки на твоём ПК: работу с файлами, точечные патчи, живые персистентные терминалы и Git.

![Bun](https://img.shields.io/badge/Bun-1.1%2B-black?logo=bun)
![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue?logo=typescript)
![License](https://img.shields.io/badge/License-MIT-green)

---

by Claude & KilDoom

## ✨ Ключевые фичи

* **💻 Изолированные персистентные терминалы** — агент параллельно держит dev-сервер, сборку и тесты в разных сессиях, сохраняя `cwd` и состояние.
* **🛡️ Снапшоты и аудит** — перед каждым изменением файла создаётся бэкап, каждое действие пишется в журнал.
* **📁 Файлы и Grep** — чтение срезами, безопасные патчи (`oldStr → newStr`), поиск по содержимому и glob-поиск файлов.
* **🔀 Управление Git** — структурированные `status`, `diff`, `commit`, `log`, `branch` без парсинга сырого вывода моделью.
* **📂 Профили воркспейсов** — переключение между проектами «на лету» без перезапуска сервера.
* **💓 Живой SSE-канал** — heartbeat каждые 15 с и корректные таймауты: соединение не отваливается после пары минут тишины.

---

## 🚀 Быстрый старт

Требуется [Bun](https://bun.sh) v1.1+.

```bash
# 1. Клонируем и устанавливаем зависимости
git clone <адрес-репозитория> notcode
cd notcode
bun install

# 2. Первичная настройка (сгенерит токен и выведет конфиг клиента)
bun run setup

# 3. Запуск сервера
bun run start
```

> 💡 `bun run setup` выдаст готовый **URL** и **Bearer-токен** — вставь их в настройки MCP-клиента.

Проверить, что всё работает:

```bash
bun run check   # typecheck + smoke (тулы) + e2e (живой SSE-коннект)
```

---

## ⚙️ Режимы безопасности

| Режим | Описание |
| --- | --- |
| `paranoic` | Доступ строго в пределах корня воркспейса. |
| `auto` *(по умолчанию)* | Корень + явно разрешённые папки (`workspace_allow`). |
| `bypass` | Полная автономность агента без подтверждений. |

В любом режиме ты защищён постфактум:

* **Снапшоты** — автосохранение файла перед записью (`fs_restore` для отката; сам откат тоже делает бэкап).
* **Аудит-лог** — история всех действий в `~/.notcode/audit.jsonl`, включая отклонённые попытки.

### Почему агент не может сам снять с себя ограничения

Раньше модель могла одним вызовом `notcode_set_mode` перевести себя в `bypass`, а `workspace_allow` — разрешить любую папку на диске. Теперь эти тулы закрыты флагами и по умолчанию отключены. Управляет только человек из CLI:

```bash
bun run src/index.ts mode bypass                  # сменить режим
bun run src/index.ts security                     # посмотреть флаги
bun run src/index.ts security runtime-mode on     # разрешить агенту менять режим
bun run src/index.ts security runtime-workspace on # разрешить агенту расширять доступ
```

---

## 🛠 Набор инструментов (31 tool)

**Файлы**

* `fs_read_file` — чтение со срезами строк, UTF-8/UTF-16, защита от бинарников.
* `fs_write_file` — атомарная запись со снапшотом.
* `fs_patch_file` — точечный патч (`oldStr` → `newStr`) с dry-run и терпимостью к CRLF.
* `fs_list_dir` — дерево каталога с размерами.
* `fs_search_content` — grep по коду с контекстными строками.
* `fs_find_files` — поиск файлов по glob.
* `fs_snapshots` / `fs_restore` — список бэкапов и откат.
* `fs_watch_start` / `fs_watch_poll` / `fs_watch_list` / `fs_watch_stop` — отслеживание внешних изменений.

**Терминал**

* `terminal_exec` — быстрая одноразовая команда.
* `terminal_open` / `terminal_run` / `terminal_read` / `terminal_write` / `terminal_list` / `terminal_close` — персистентные сессии с сохранённым `cwd`, фоновыми процессами и вводом в stdin.

**Git:** `git_status`, `git_diff`, `git_commit`, `git_log`, `git_branch`.

**Система:** `notcode_status`, `notcode_audit`, `notcode_set_mode`.

**Воркспейсы:** `workspace_list`, `workspace_use`, `workspace_add`, `workspace_allow`.

У каждого тула есть MCP-аннотации (`readOnlyHint`, `destructiveHint`, `idempotentHint`), чтобы клиент мог спрашивать подтверждение только на опасных операциях.

---

## 📜 Команды CLI

| Команда | Описание |
| --- | --- |
| `bun run setup` | Первичная настройка и параметры подключения |
| `bun run start` | Запуск MCP-сервера (SSE + Bearer) |
| `bun run dev` | Запуск в режиме разработки (watch) |
| `bun run status` | Статус, текущий режим и лимиты |
| `bun run token` | Посмотреть или пересоздать токен (`--reset`) |
| `bun run audit 30` | Последние 30 записей журнала |
| `bun run typecheck` | Строгая проверка типов |
| `bun run smoke` | Проверка всех тулов без сервера |
| `bun run e2e` | Живой SSE-коннект: handshake, tools/list, heartbeat |
| `bun run check` | Всё вышеперечисленное одной командой |

### Переменные окружения

| Переменная | Назначение |
| --- | --- |
| `NOTCODE_PORT` | Порт сервера (перекрывает конфиг) |
| `NOTCODE_HOST` | Адрес прослушивания, по умолчанию `127.0.0.1` |
| `NOTCODE_LOG_LEVEL` | `debug` / `info` / `warn` / `error` / `silent` |
| `WORKSPACE_ROOT` | Корень воркспейса при первом `setup` |
| `E2E_PORT` | Порт для `bun run e2e` (по умолчанию 3999) |

---

## 🏗 Архитектура

```text
src/
├─ index.ts              # HTTP/SSE-транспорт, авторизация, heartbeat, CLI
├─ mcp.ts                # регистрация тулов в MCP-сервере
├─ config.ts             # конфиг, профили, токен, флаги безопасности
├─ tools/                # сами тулы (fs / terminal / git / meta)
└─ utils/
   ├─ sandbox.ts         # проверка путей по режиму безопасности
   ├─ fs-atomic.ts       # атомарная запись (tmp + rename)
   ├─ snapshot.ts        # бэкапы и откаты
   ├─ audit.ts           # журнал действий
   ├─ terminal-manager.ts# сессии терминала
   ├─ watch-manager.ts   # наблюдатели ФС
   ├─ proc.ts            # корректное убийство дерева процессов
   ├─ lock.ts            # Mutex для гонок по файлам
   └─ logger.ts          # логи только в stderr
```

Важное правило: **stdout никогда не используется под логи** — он зарезервирован под протокол.

---

## 🩺 Если клиент пишет «Failed to connect to MCP server»

1. Проверь, что сервер жив: `curl http://127.0.0.1:3000/health` → `{"ok":true}`.
2. Проверь токен: `bun run token` и сравни с настройками клиента.
3. Прогони `bun run e2e` — он воспроизводит полный handshake и ждёт heartbeat.
4. Если между клиентом и сервером есть nginx/Cloudflare — выключи буферизацию и подними `proxy_read_timeout` выше интервала heartbeat.
5. Логи: `NOTCODE_LOG_LEVEL=debug bun run start`.

---

## 📂 Структура данных

```text
~/.notcode/
├── config.json       # Настройки, токены и профили
├── audit.jsonl       # Журнал выполненных действий
└── snapshots/        # Автоматические бэкапы файлов
```

Если `config.json` окажется битым, сервер не молча создаст новый токен, а отложит файл в `config.json.broken-<время>` и скажет об этом явно.

---

## 📄 Лицензия

[MIT](LICENSE)
