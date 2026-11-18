# yuk1ble

**Multi-agent collaboration engine** — AI agents that work as one.

Ensemble orchestrates AI agents into collaborative teams. Out of the box it pairs **Claude Code + Codex** (teams of 2 to 8 agents are supported) — they communicate, share findings, and solve problems together in real time. Agent processes run in native Windows ConPTY sessions, and a browser GUI shows the collaboration live.

> **Status:** Experimental developer tool. Native Windows only.

## Features

- **Team orchestration** — Spawn multi-agent teams with a single command
- **Real-time messaging** — Agents communicate via a structured message bus
- **Monitoring GUI** — Teams, transcript, live agent panes and the server log at <http://localhost:23000/>
- **Explicit completion** — Agents end a run with a `<<COLLAB_DONE>>` sentinel; otherwise it stands until you disband it or it goes idle for an hour
- **CLI & HTTP API** — Full control via command line or REST endpoints

Project context and rules live in [AGENTS.md](AGENTS.md).

## Quick Start

### Windows prerequisites

- Node.js 18+ LTS. Prefer a release supported by the prebuilt `node-pty` binaries.
- Visual Studio Build Tools with the **Desktop development with C++** workload. `node-pty` uses `node-gyp`; installation fails when its native ConPTY binding cannot be built or loaded.
- Windows Terminal is recommended for running the server and CLI.
- PowerShell 7 (`pwsh.exe`) is recommended. Windows PowerShell 5 (`powershell.exe`) is the fallback.
- The agent CLIs you plan to run — [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex](https://github.com/openai/codex) — each already signed in. No Python or bash is needed.

If the Visual Studio installer is unavailable, `npm install --global windows-build-tools` may provide the required compiler toolchain on supported Node.js/npm versions.

### Install & Run

```powershell
git clone https://github.com/yuk1na2312/yuk1ble ensemble-win
cd ensemble-win
npm install

# Start the server (keep this running)
npm run dev
```

### Verify (in a second terminal)

```powershell
curl.exe http://localhost:23000/api/v1/health
# → {"status":"healthy","version":"1.0.0"}
```

### Create your first team

```powershell
# Via CLI (run inside the ensemble checkout)
npm run cli -- status

# Or, once ensemble is installed globally / linked:
npx ensemble status

# Via API — create a team of two agents
$body = @{
  name             = "review-team"
  description      = "Review the authentication module"
  agents           = @(
    @{ program = "claude"; role = "lead" },
    @{ program = "codex"; role = "worker" }
  )
  workingDirectory = (Get-Location).Path
} | ConvertTo-Json -Depth 5

$team = Invoke-RestMethod -Uri "http://localhost:23000/api/ensemble/teams" -Method Post -ContentType "application/json" -Body $body

# The call answers 202 at once; the agents are spawned and prompted in the background
# (their CLIs can take a couple of minutes to start). A bad request is a 400 with the reason.

# Watch the collaboration live: open http://localhost:23000/ in a browser,
# or read the feed (use the last `seq` you saw as ?since= to get only new messages)
Invoke-RestMethod "http://localhost:23000/api/ensemble/teams/$($team.team.id)/feed?since=0"

# Steer the team
npm run cli -- steer <team-id> "focus on the auth module"
```

Or use the headless all-in-one runner, which starts the server if needed, creates the
team, and tails the conversation until the agents finish or a timeout is hit:

```powershell
npm run cli -- run "Review the authentication module" --agents codex,claude --timeout 600
```

## Claude Code: `/collab` command

Ensemble ships with a skill for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Once installed, just type:

```
/collab "Review the auth module for security issues"
```

Claude spawns a Codex + Claude team, shows their conversation live in your terminal, and presents a summary when done.

To install the skill manually, copy `skill/SKILL.md` into `~/.claude/skills/collab/SKILL.md`
and replace the `__ENSEMBLE_DIR__` placeholder inside it with the absolute path to this
checkout. See [AGENTS.md](AGENTS.md) for the full variable reference.

## Supported Agents

The default team is **Claude Code (lead) + Codex (worker)**. This is the tested, production-ready combination.

| Agent | Status | How to use |
|---|---|---|
| **Claude Code + Codex** | Fully tested | Default — just run `/collab` or `npm run cli -- run "..."` |
| **Gemini CLI** | Experimental | Add explicitly (see below) |
| **Aider** | Untested | Add explicitly (see below) |
| **Any CLI tool** | Via `agents.json` | Add an entry with `command`, `readyMarkers`, `inputMethod`, `color`, `icon` (and optionally flags, startup gates, models); no code change. See *Adding a CLI* in [AGENTS.md](AGENTS.md) |

### Using a different team composition

Three ways to change which agents are on your team:

**1. Name them in your `/collab` prompt:**
```
/collab "Review the auth module with gemini and claude"
```

**2. Use the `--agents` flag with `ensemble run`:**
```powershell
# First agent = lead, rest = workers; 2 to 8 agents
npm run cli -- run "Security audit" --agents codex,claude,gemini

# Pick a model per agent with program:model (it must be in that program's catalog)
npm run cli -- run "Security audit" --agents codex:gpt-5.6-sol,claude:sonnet
```

An unknown program or model is a 400 and nothing is started. `GET /api/ensemble/programs`
lists each program with its icon, colour, models and whether its CLI is installed.

**3. Specify agents in the API call:**
```powershell
$body = @{
  name             = "my-team"
  description      = "Security audit"
  agents           = @(
    @{ program = "codex"; role = "lead" },
    @{ program = "claude"; role = "worker" },
    @{ program = "gemini"; role = "worker" }
  )
  workingDirectory = (Get-Location).Path
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri "http://localhost:23000/api/ensemble/teams" -Method Post -ContentType "application/json" -Body $body
```

> **Note on Gemini:** Gemini CLI can join teams and send messages, but is experimental. It may stop responding due to free-tier rate limits or internal agent delegation issues in Gemini's TUI. For best results, configure a paid API key via `gemini /auth`.

## How It Works

1. **Create a team** — Define agents and their task via API or CLI
2. **Agents spawn** — The API answers 202 immediately and the rest happens in the background. Each agent is started in its own native Windows PTY session (`PtyRuntime`, via `node-pty`) with the task prompt
3. **Communication** — Agents run `team-say`/`team-read` (Node CLI subcommands in `src/cli/ensemble.ts`). `team-say` POSTs to the server, which records the message and answers at once, then pastes it into the recipient's terminal in the background (`team` as recipient reaches everyone); `team-read` reads the feed. If the server is down, `team-say` prints an error and exits non-zero
4. **Monitor** — Watch the collaboration unfold in real time in the browser GUI at <http://localhost:23000/>
5. **Disband** — On the `<<COLLAB_DONE>>` sentinel, a manual disband, or an hour of silence, the run is summarized, persisted, and every agent's process tree is killed

## HTTP API

Everything the CLI and the page do goes through these routes on port 23000. A request whose
`Host` is not a loopback name is refused (403), so is one naming a foreign `Origin`.

| Route | What it does |
|---|---|
| `GET /api/v1/health` | Liveness |
| `GET /api/ensemble/programs` | The agent CLIs from `agents.json`: icon, colour, models, installed |
| `GET /api/ensemble/teams`, `GET /api/ensemble/teams/:id` | Teams (and one team's messages) |
| `GET /api/ensemble/teams/:id/feed?since=<seq>` | Messages after `seq` |
| `POST /api/ensemble/teams` | Create a team; answers 202, startup continues in the background |
| `POST /api/ensemble/teams/:id` | Send a message `{ from, to, content }` (`to`: a name or `team`) |
| `POST /api/ensemble/teams/:id/disband`, `DELETE /api/ensemble/teams/:id` | End a team |
| `GET /api/ensemble/events[?team=<id>]` | Server-Sent Events: `team`, `message` and `log` as JSON |
| `GET /api/ensemble/sessions/:name/stream` | Server-Sent Events of one terminal: `replay`, then `data` (base64 raw output), then `exit` |
| `POST /api/ensemble/sessions/:name/input` | Type into an agent's terminal: `{ "data": "..." }`, at most 64 KB |
| `POST /api/ensemble/sessions/:name/resize` | `{ "cols": 120, "rows": 40 }` |
| `GET /api/ensemble/sessions/:name/pane?lines=N` | A text snapshot of a terminal |
| `GET /api/ensemble/logs?since=<seq>` | The server's console output |

Watch a team from a shell: `curl.exe -N http://localhost:23000/api/ensemble/events`.

## Configuration

Copy `.env.example` to `.env` and adjust as needed. Key variables:

| Variable | Default | Description |
|---|---|---|
| `ENSEMBLE_PORT` | `23000` | Server port |
| `ENSEMBLE_URL` | `http://localhost:<ENSEMBLE_PORT>` | CLI target URL (the server passes it on to its agents) |
| `ENSEMBLE_DATA_DIR` | `~/.ensemble` | Data directory (team list and one transcript file per team) |
| `ENSEMBLE_CORS_ORIGIN` | localhost only | Allowed CORS origins |
| `ENSEMBLE_SHELL` | `pwsh.exe`, then `powershell.exe` | Override the PowerShell executable used for PTY sessions |

See [`.env.example`](.env.example) and [AGENTS.md](AGENTS.md) for every variable, including readiness timeouts, the idle-disband window and watchdog timings.

## Documentation

- [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) — how to start, use, configure and
  debug ensemble, step by step, with a troubleshooting list.
- [AGENTS.md](AGENTS.md) — project context, commands, every environment variable, and the
  gotchas each live run exposed. `CLAUDE.md` imports it, so Claude Code and Codex read the
  same file.
- [REPO-STRUCTURE.md](REPO-STRUCTURE.md) — what this fork keeps, what it dropped, and why.

Upstream's documentation site describes the tmux build and does not apply here.

## Credits

Fork of [michelhelsdingen/ensemble](https://github.com/michelhelsdingen/ensemble), rebuilt
for native Windows: the tmux runtime replaced by a node-pty/ConPTY one, and the bash /
AppleScript / iTerm paths removed rather than gated. MIT, same as upstream.

## License

[MIT](LICENSE)
