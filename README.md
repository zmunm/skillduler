# skillduler

YAML-declared AI cron scheduler. Define jobs, run LLM prompts or shell commands on a schedule, deliver results to Telegram.

## Why skillduler?

Most AI schedulers are tied to a specific LLM, require MCP servers, or come as heavy desktop apps. skillduler is different:

- **LLM-agnostic** — `prompt_template` takes any CLI: `claude -p`, `ollama run`, `codex`, a custom wrapper — swap one line and switch providers
- **Single-file config** — one `jobs.yaml` declares everything: schedule, prompts, commands, notification targets. No database, no UI, no framework
- **Zero lock-in** — plain Node.js + cron. No MCP protocol, no plugin system, no proprietary runtime. You own the 200 lines of code
- **Mix AI and shell** — prompt-mode jobs call your LLM; command-mode jobs run any shell command. Same scheduler, same notification pipeline
- **Self-hosted** — runs on your machine, your server, your CI. Prompts and data never leave your environment

## Quick Start

```bash
git clone https://github.com/zmunm/skillduler.git
cd skillduler
pnpm install
```

Create `jobs.yaml` with your config and jobs — or open your AI agent in this directory and ask it to set everything up for you.

```bash
pnpm start
```

## How It Works

```
jobs.yaml → cron → command or prompt_template → stdout → Telegram
```

Each job is either a **command** (any shell command) or a **prompt** (an LLM CLI call built from `PROMPT_TEMPLATE`).

## jobs.yaml

```yaml
config:
  prompt_template: "cat {prompt} | claude -p - --output-format text --dangerously-skip-permissions"
  timezone: Asia/Seoul
  telegram_bot_token: your-bot-token
  telegram_chat_id: your-chat-id

jobs:
  # Prompt mode: invokes LLM via prompt_template
  - name: morning-news
    description: "Daily news summary"
    cron: "0 8 * * *"
    prompt: .skills/news/morning.md
    notify: telegram
    enabled: true

  # Command mode: runs a shell command as-is
  - name: disk-check
    description: "Check disk usage"
    cron: "0 6 * * *"
    command: "df -h / | tail -1"
    notify: telegram
    enabled: true

  # Override Telegram destination per job
  - name: error-scan
    description: "Scan error logs"
    cron: "30 23 * * *"
    prompt: .skills/ops/error-scan.md
    notify: telegram
    telegram_chat_id: "ops-chat-id"
    enabled: true
```

## Config

| Field | Description |
|-------|-------------|
| `prompt_template` | LLM CLI template. `{prompt}` is replaced with the file path. Required for prompt-mode jobs. |
| `timezone` | Timezone for cron schedules. Default: `UTC` |
| `telegram_bot_token` | Default Telegram bot token |
| `telegram_chat_id` | Default Telegram chat ID |

## Run a Job Manually

```bash
pnpm run:job morning-news           # run once and exit
pnpm run:job morning-news -- --daemon  # run once, keep scheduler alive
```

## File Layout

```
skillduler/
  src/index.ts       # scheduler source
  jobs.yaml          # config + jobs (gitignored)
  .skills/           # your prompt files (gitignored)
```

## Running as a System Service (macOS)

To keep skillduler running in the background and auto-start on boot, register it with launchd:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.skillduler</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>/path/to/skillduler/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/skillduler</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/skillduler/console.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/skillduler/error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
```

Save as `~/Library/LaunchAgents/com.skillduler.plist`, then:

```bash
# Build first
pnpm build

# Create log directory
mkdir -p /tmp/skillduler

# Load the service
launchctl load ~/Library/LaunchAgents/com.skillduler.plist

# Verify it's running
launchctl list | grep skillduler
```

**Important:** launchd has a minimal environment. Make sure the `PATH` in the plist includes directories for both `node` and your LLM CLI (e.g. `claude`). Run `which node` and `which claude` to find the correct paths.

## Requirements

- Node.js >= 18
- pnpm
- An LLM CLI in PATH (e.g. `claude`, `codex`)

## License

MIT
