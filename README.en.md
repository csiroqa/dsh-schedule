# dsh-schedule

A **scheduled tasks + status monitoring** plugin for DeepSeek Harness (DSH): run agents automatically on a cron schedule (daily digests, periodic checks, automated reports), and inspect combined system/harness status via the `/status` command and a settings dashboard.

中文: [README.md](README.md)

## Features

### Scheduled tasks

- **Cron schedule** (5 fields: minute hour day month weekday; `0 9 * * *` = daily at 09:00): a ticker checks every `tickSeconds`, minute precision, no concurrent runs per task
- **Automatic execution**: spawns a one-shot agent (working directory attached to its workspace, model follows the settings selection or config), runs the prompt, persists the session log (visible in the sidebar), and records the outcome back to the task
- **Task management**: `/schedule list / add / remove / pause / resume / run`, plus the "Schedule" tab under Settings > Plugins
- **Timeout guard**: a run is force-stopped after `maxRunMs` (default 30 min)
- **Persistence**: tasks live in `$DSH_HOME/schedule.json` (atomic writes, startup-safe)

### Status monitoring

- `/status`: uptime / CPU / memory / disk / active sessions / agents / plugins / model
- "Status" tab under Settings > Plugins: live dashboard (auto-refresh every 5 s, pausable)

## Configuration

Optional config on the plugin row (`cordis.patch.yml`):

| Key | Default | Description |
| --- | --- | --- |
| `defaultCwd` | DSH process startup dir | Default working directory for tasks |
| `defaultProvider` / `defaultModel` | model selection in settings | Default provider/model for tasks |
| `tickSeconds` | `30` | Ticker interval in seconds |
| `maxRunMs` | `1800000` (30 min) | Per-run timeout in ms; `0` = no limit |

## Install

Requirements: Node.js >= 22, pnpm, a local checkout of `deepseek-harness` (dependencies use `link:` to `../deepseek-harness`).

```sh
git clone https://github.com/csiroqa/dsh-schedule.git
cd dsh-schedule
pnpm install
pnpm build

dsh plugin --profile web add link:$(pwd)   # POSIX
# Windows: dsh plugin --profile web add link:E:\path\to\dsh-schedule
```

Restart `dsh web` and hard-refresh the browser (**Ctrl+F5**).

## Usage

1. Run `/schedule list`; add a task with `/schedule add 0 9 * * * summarize yesterday's progress every day at 9:00`
2. Settings > Plugins > **Schedule**: add / run now / pause / resume / remove
3. Settings > Plugins > **Status**: live dashboard
4. `/status`: combined report in the chat

## Compatibility

- Developed against a DSH `0.1.0-rc.5` source checkout
- The client half depends only on platform modules (react, etc.)
- Build: `tsdown` (host `lib/index.js` + browser `lib/client.js`, standard `window.__ModuleLoader__.load` closure-factory format)

## Security notes

- **Scheduled tasks run unattended with the current DSH account's permissions** (file read/write, command execution) — only add content you trust
- `/dsh-schedule/*` endpoints are loopback-only (DSH binds to 127.0.0.1 by default); do not expose the DSH port to the public internet

## License

**MIT License** (see [LICENSE](LICENSE)). Use, modify, reference, or include it in your own plugin collections — just keep the license notice and credit this repository.

## Related

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- Plugin form reference: [dsh-archive-viewer](https://github.com/csiroqa/dsh-archive-viewer) (`dsh.bundle.patch` + `dsh.client` declaration + slot registration + tsdown dual-half build)
