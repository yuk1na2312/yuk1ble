# yuk1ble

**A multi-agent collaboration engine for native Windows.** Spawn Claude Code, Codex and
other agent CLIs into real terminal sessions, let them talk to each other over a structured
message bus, and watch the whole conversation unfold in your browser.

Teams hold 2 to 8 agents. Out of the box the pairing is **Claude Code + Codex**; any CLI
described in `agents.json` can join.

> **Status — experimental developer tool, native Windows only.** The port is functionally
> complete and the offline suite is green. Multi-agent runs work end to end; what it still
> needs is mileage. See [TESTING.md](TESTING.md).

---

## Why this fork exists

Upstream [ensemble](https://github.com/michelhelsdingen/ensemble) is macOS/Linux only: its
whole runtime is built on tmux, with bash and AppleScript glue around it. None of that
exists on Windows, and WSL2 defeats the point — the agent CLIs you already have signed in
live on the Windows side.

So this fork replaces the runtime rather than wrapping it:

| Upstream | Here |
|---|---|
| tmux sessions | **node-pty + ConPTY** (`PtyRuntime`) |
| bash / AppleScript / iTerm glue | **PowerShell** (`pwsh` preferred) |
| `tmux kill-session` | full **process-tree kill** (`taskkill /T /F`) |
| tmux `attach` to watch an agent | **live terminals in the browser** (xterm.js over Server-Sent Events) |

Unix-specific code paths were **deleted, not gated** behind a platform check. A check
would leave the code claiming support it doesn't have; deleting it keeps the repo honest
about being a Windows program.

---

## Requirements

| | |
|---|---|
| **OS** | Windows 10/11. [Windows Terminal](https://aka.ms/terminal) recommended for the server and CLI. |
| **Node.js** | 18+ LTS (20.12+ to load `.env`). Prefer a release with prebuilt `node-pty` binaries. |
| **C++ toolchain** | Visual Studio Build Tools with **Desktop development with C++**. `node-pty` is a native module — `npm install` fails without it. |
| **Shell** | PowerShell 7 (`pwsh.exe`) recommended; Windows PowerShell 5.1 (`powershell.exe`) is the fallback. `cmd.exe` is not supported. |
| **Agent CLIs** | Whichever you plan to run — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex) — **already signed in**. |

No Python, no bash, no WSL.

---

## Install

```powershell
git clone https://github.com/yuk1na2312/yuk1ble.git
cd yuk1ble
npm install
Copy-Item .env.example .env

npm run dev          # starts the server on :23000 — keep this running
```

Verify from a second terminal:

```powershell
curl.exe http://localhost:23000/api/v1/health
# → {"status":"healthy","version":"1.0.0"}
```

There is no build step. TypeScript runs directly through `tsx`.

---

## Quick start

### Option A — the browser GUI (easiest)

Open <http://localhost:23000/> and press **New team**. Give the team a task, pick a program
(and optionally a model) for each agent, and press **Start team**.

The same page then shows everything: the team list, the live agent-to-agent transcript, a
real terminal per agent (you can type into it to answer a prompt), and the server log. Steer
the team or one agent from the box under the transcript, and disband from the team header.

**Clearing out old runs.** An ended run can be archived: it moves behind a **Show N archived**
toggle under the team list, nothing is deleted, and **Restore** brings it straight back (disband a
run first; a running one cannot be archived). **Purge**, offered only on an archived run, erases it
for good: the team record, its messages and the files of its run. Its confirmation names the run
and counts the messages it is about to destroy.

**Accounts.** The **Accounts** button in the left column reports which account each agent CLI
is signed in as. It asks the CLI itself (the `account` entry of its `agents.json` adapter, for
example a `status` subcommand); a CLI with no such command says so rather than guessing. It is
strictly read-only: ensemble never touches credential files and offers no sign-in or sign-out.
Only a state, an account label and a plan label ever leave the server; raw CLI output is
discarded, so a token in it cannot reach the browser. Answers are cached for a minute.

### Option B — headless, one command

Starts the server if it isn't up, creates the team, and tails the conversation until the
agents finish or the timeout hits (then it disbands the team):

```powershell
npm run cli -- run "Review the auth module for security issues" --agents codex,claude --timeout 600
```

### Option C — the HTTP API

```powershell
$body = @{
  name             = "review-team"
  description      = "Review the authentication module"
  agents           = @(
    @{ program = "claude"; role = "lead" },
    @{ program = "codex";  role = "worker" }
  )
  workingDirectory = (Get-Location).Path
} | ConvertTo-Json -Depth 5

$team = Invoke-RestMethod -Uri "http://localhost:23000/api/ensemble/teams" -Method Post -ContentType "application/json" -Body $body

# The call answers 202 at once; the agents are spawned and prompted in the background
# (their CLIs can take a couple of minutes to start). A bad request is a 400 with the reason.

# Read the feed (pass the last `seq` you saw as ?since= to get only new messages)
Invoke-RestMethod "http://localhost:23000/api/ensemble/teams/$($team.team.id)/feed?since=0"
```

---

## Claude Code: the `/collab` command

The repo ships a Claude Code skill. Once installed, from any project:

```
/collab "Review the auth module for security issues"
```

Claude spawns a Codex + Claude team, streams their conversation into your terminal, and
summarises when they're done.

To install it, copy `skill/SKILL.md` to `~/.claude/skills/collab/SKILL.md` and replace the
`__ENSEMBLE_DIR__` placeholder inside with the absolute path to this checkout.

---

## How it works

1. **Create a team.** Agents and their task arrive via the GUI, CLI, or `POST /api/ensemble/teams`,
   which answers 202 at once; the rest happens in the background.
2. **Agents spawn.** Each gets its own Windows PTY session through `PtyRuntime`, launched
   under PowerShell with UTF-8 forced (`chcp 65001`).
3. **Readiness.** Ensemble waits for the agent CLI to reach its input prompt — answering
   startup gates (folder-trust, hook-review modals) *before* matching the ready marker,
   because on more than one CLI the marker and a modal's selection cursor are the same
   glyph.
4. **The prompt lands.** Text is pasted, then a **standalone Enter** is sent. A paste alone
   never submits — agent CLIs treat a trailing CR as part of the paste burst and park it in
   the composer.
5. **They talk.** Agents run `team-say` / `team-read`. `team-say` POSTs to the server, which
   records the message and pastes it into the recipient's terminal in the background
   (`team` as recipient reaches everyone). If the server is down, `team-say` exits non-zero.
6. **A watchdog** nudges an idle agent after 90s, and marks it stalled if it's still
   silent 180s after that nudge. The mark clears when the agent speaks again.
7. **The run ends** on exactly three conditions — the `<<COLLAB_DONE>>` sentinel from every
   active agent, a manual disband, or `ENSEMBLE_IDLE_DISBAND_MS` of silence (1h). Then the
   run is summarised, persisted, and every agent's **process tree** is killed.

> **On completion detection:** ensemble deliberately does *not* infer "done" from prose.
> Words like "done" and "completed" show up constantly in normal agent chatter, and a
> heuristic on them once killed a healthy run mid-conversation. Only the explicit sentinel
> counts.

---

## Supported agents

Agents are declared in [`agents.json`](agents.json) — command, flags, ready markers, input
method, startup gates, models, colour, icon. Adding a new CLI means adding an entry, not
writing code; see *Adding a CLI* in [AGENTS.md](AGENTS.md).

| Agent | State | Notes |
|---|---|---|
| **Claude Code** | Tested | Default lead. `--permission-mode auto` |
| **Codex** | Tested | Default worker. See `ENSEMBLE_CODEX_TRUST_HOOKS` below |
| **Gemini CLI** | Experimental | Joins and messages, but free-tier rate limits and its TUI's internal delegation can stall it. Configure a paid key via `gemini /auth` |
| **Aider** | Untested | Config present, no live run |
| **opencode** | Untested | Config present, no live run |
| *anything else* | Add to `agents.json` | Needs a stable ready marker and a working input method |

Pick a different lineup three ways — name them in the `/collab` prompt
(`"…with gemini and claude"`), pass `--agents codex,claude,gemini` to `ensemble run`
(first = lead), or list them in the API call. Pick a model per agent with `program:model`
(`--agents codex:gpt-5.6-sol,claude:sonnet`); it must be in that program's `models` list.
An unknown program or model is a 400 and nothing is started. `GET /api/ensemble/programs`
lists each program with its icon, colour, models and whether its CLI is installed.

---

## CLI reference

Run as `npm run cli -- <command>` inside the checkout, or `npx ensemble <command>` once linked.

| Command | What it does |
|---|---|
| `start` | Start the ensemble server |
| `run "task" [--agents a,b] [--timeout s]` | Headless run; auto-starts the server, disbands on timeout |
| `teams` | List all teams with their full ids |
| `status` | Server health and overview |
| `steer <id> <message>` | Send a steering message to a team |
| `disband <id>` | End a team and kill its agents' process trees |
| `team-say <id> <from> <to> <msg>` | Post one message onto the bus |
| `team-read <id>` | Read the team message feed |

---

## HTTP API

Base: `http://127.0.0.1:23000`. Bound to loopback by design — **there is no
authentication**. Don't expose it. A request whose `Host` is not a loopback name is refused
(403), so is one naming a foreign `Origin`.

| Route | What it does |
|---|---|
| `GET /api/v1/health` | Liveness |
| `GET /api/ensemble/programs` | The agent CLIs from `agents.json`: icon, colour, models, installed |
| `GET /api/ensemble/accounts` | Read-only account status per program: `state` (`signed-in`, `signed-out`, `unsupported`, `error`), `account`, `plan`, `detail`. GET only, there is no sign-in or sign-out route |
| `GET /api/ensemble/teams`, `GET /api/ensemble/teams/:id` | Teams (and one team's messages) |
| `GET /api/ensemble/teams/:id/feed?since=<seq>` | Messages after `seq` |
| `POST /api/ensemble/teams` | Create a team; answers 202, startup continues in the background |
| `POST /api/ensemble/teams/:id` | Send a message `{ from, to, content }` (`to`: a name or `team`) |
| `POST /api/ensemble/teams/:id/disband`, `DELETE /api/ensemble/teams/:id` | End a team |
| `POST /api/ensemble/teams/:id/archive` | `{ "archived": true|false }`: hide or restore an ended team; nothing is deleted. 409 on a running team |
| `POST /api/ensemble/teams/:id/purge` | Erase an archived team for good (record, messages, run files): `{ ok, warnings }`. 409 unless archived and ended |
| `GET /api/ensemble/events[?team=<id>]` | Server-Sent Events: `team`, `team-removed`, `message` and `log` as JSON |
| `GET /api/ensemble/sessions/:name/stream` | Server-Sent Events of one terminal: `replay`, then `data` (base64 raw output), then `exit` |
| `POST /api/ensemble/sessions/:name/input` | Type into an agent's terminal: `{ "data": "..." }`, at most 64 KB |
| `POST /api/ensemble/sessions/:name/resize` | `{ "cols": 120, "rows": 40 }` |
| `GET /api/ensemble/sessions/:name/pane?lines=N` | A text snapshot of a terminal |
| `GET /api/ensemble/logs?since=<seq>` | The server's console output |
| `GET /` | The monitoring GUI |

Watch a team from a shell: `curl.exe -N http://localhost:23000/api/ensemble/events`.

> **Why terminals are only reachable over HTTP:** PTY sessions live in a module-level map
> *inside the server process*. Any other process that constructs its own `PtyRuntime` gets a
> second, permanently empty registry that quietly answers "no such session". That is why the
> CLI is a pure HTTP client and owns no runtime.

---

## Configuration

Copy `.env.example` to `.env`; the server and CLI load it at start, and a variable already
set in the shell wins. The ones you're most likely to touch:

| Variable | Default | Purpose |
|---|---|---|
| `ENSEMBLE_PORT` | `23000` | Server port |
| `ENSEMBLE_HOST` | `127.0.0.1` | Bind address. Loopback by design — the API has no auth |
| `ENSEMBLE_URL` | `http://localhost:<ENSEMBLE_PORT>` | CLI target URL (the server passes it on to its agents) |
| `ENSEMBLE_DATA_DIR` | `~/.ensemble` | Persisted teams and one transcript file per team |
| `ENSEMBLE_SHELL` | `pwsh.exe`, else `powershell.exe` | PTY shell binary. Never `cmd.exe` |
| `ENSEMBLE_READY_TIMEOUT_MS` | `150000` | Wait for an agent CLI to reach its prompt. 60s is too short for a Claude Code with a heavy MCP/hook stack |
| `ENSEMBLE_IDLE_DISBAND_MS` | `3600000` (1h) | Silence before a team auto-disbands |
| `ENSEMBLE_AGENT_FLAGS` | — | Extra flags appended to every spawned agent CLI |
| `ENSEMBLE_CODEX_TRUST_HOOKS` | unset | `1` answers Codex's "Hooks need review" gate with *Trust all*. Default answers *Continue without trusting* — ensemble should not authorise unreviewed hook code unattended |

[AGENTS.md](AGENTS.md) documents the rest: watchdog timings, runtime and agent-config
paths, CORS origins, and the cosmetic team label.

---

## Testing

```powershell
npm run typecheck    # tsc --noEmit
npm run lint         # eslint . --ext .ts
npm test             # vitest
```

These are free and fast; run them before every commit. They do **not** prove the port —
most defects found so far were invisible to them, because they can't spawn a real agent.
That takes a live run, which spends real subscription quota.
[TESTING.md](TESTING.md) has the procedure, the symptoms to look for in each pane, and a
quota-free probe technique for the runtime layer.

---

## Project layout

```
src/
  server/      HTTP process: routes, Host/Origin guard, SSE, static files, log buffer
  core/        business logic: store, bus, team lifecycle, delivery, readiness, watchdog
  runtime/     AgentRuntime interface + PtyRuntime (node-pty, scrollback, tree-kill)
  adapters/    agents.json loader + validation, program catalog
  cli/         ensemble.ts — the CLI, a pure HTTP client
web/           the monitoring GUI: vanilla ES modules, no build step
bin/           ensemble.cjs (CLI shim that agents run), postinstall.cjs
agents.json    one adapter per agent CLI
skill/SKILL.md the /collab skill
tests/         vitest; live-captured terminal screens as fixtures, a fake agent CLI
docs/          developer guide; the port spec, plan, and a log of every live run
```

Two architectural rules hold this together: **`src/core/` never learns what a PTY is** —
session behaviour goes in `PtyRuntime`, behind the `AgentRuntime` interface — and
**nothing outside the server process owns a runtime.** [REPO-STRUCTURE.md](REPO-STRUCTURE.md)
has the file-by-file map.

---

## Troubleshooting

Each of these cost a live run to find. [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md)
has the full list.

| Symptom | Cause |
|---|---|
| `npm install` fails on `node-pty` | No C++ toolchain. Install VS Build Tools → *Desktop development with C++* |
| Port 23000 still held after a crash | Orphaned agent children. `pty.kill()` alone doesn't kill the tree — this is the #1 Windows stability risk |
| An agent sits silent; its pane shows `[Pasted Content NNNN chars]` | The prompt was pasted but never submitted. Every delivery path must go through `deliver()` in `src/core/delivery.ts` |
| An agent is "ready" in ~1s, then never speaks | The ready marker matched a startup modal's selection cursor, not the input prompt |
| A live agent is reported dead | Agent CLIs resolve through npm shims (`powershell → node.exe → codex.exe`). Checking only the PTY's direct children lies — walk the full ancestry |
| `error code: 267` on spawn | `pty.spawn` needs a real Windows path; a `cwd` with forward slashes fails |
| `setRawMode` throws | stdin isn't a TTY — guard on `process.stdin.isTTY` |

---

## Documentation

- **[docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md)** — how to start, use, configure and
  debug ensemble, step by step, with a troubleshooting list.
- **[AGENTS.md](AGENTS.md)** — project context, every environment variable, conventions,
  and the gotchas each live run exposed. `CLAUDE.md` imports it, so Claude Code and Codex
  read the same file.
- **[TESTING.md](TESTING.md)** — offline checks vs. live runs, and the end-to-end
  two-agent procedure.
- **[REPO-STRUCTURE.md](REPO-STRUCTURE.md)** — what this fork keeps, what it dropped, why.
- **[docs/windows-port/](docs/windows-port/)** — the port spec, the plan, and a status log
  of every live run and the defect it found.

Upstream's documentation site describes the tmux build and does not apply here.

---

## Credits

A native-Windows fork of [michelhelsdingen/ensemble](https://github.com/michelhelsdingen/ensemble)
— tmux runtime replaced with node-pty/ConPTY, and the bash / AppleScript / iTerm paths
removed rather than gated.

## License

[MIT](LICENSE), same as upstream.
