# Developer guide

How to start ensemble, how to use it, what to do when it breaks, and how to change it.
Written for a developer on Windows who has not seen the project before.

Commands are PowerShell unless a block says otherwise. They work in Windows PowerShell 5.1
and in PowerShell 7 (`pwsh`). Run them from the repository root unless noted.

Contents: [1 What it is](#1-what-it-is) | [2 Getting started](#2-getting-started) |
[3 Using it](#3-using-it) | [4 Configuring agent CLIs](#4-configuring-agent-clis) |
[5 Developing on it](#5-developing-on-it) | [6 Troubleshooting](#6-troubleshooting) |
[7 Reference](#7-reference)

---

## 1. What it is

Ensemble starts several AI coding CLIs (Claude Code, Codex, Aider, Gemini CLI, opencode, or
any CLI you describe in `agents.json`) in terminal sessions and lets them work as a team.
A team has 2 to 8 agents. The agents send each other messages through a small message bus,
and you watch and steer the whole thing from a browser page or the command line.

It is a Windows-only fork of an upstream tool that needed tmux. Here every agent runs in a
native Windows pseudo-terminal (ConPTY, through `node-pty`). There is no tmux, bash or WSL.

```
   browser (GUI)            CLI (npm run cli / team-say)
        |                          |
        |   HTTP + Server-Sent Events (port 23000)
        v                          v
   +------------------------------------------------+
   |  server   src/server/   routes, guard, SSE     |
   |  core     src/core/     teams, messages, queue |   state lives in memory;
   |  adapters src/adapters/ agents.json            |   teams.json + feed.jsonl
   |  runtime  src/runtime/  AgentRuntime interface |   are only a log
   +------------------------+-----------------------+
                            | PtyRuntime (node-pty, ConPTY)
                            v
              one PowerShell PTY per agent
                            |
                            v
              the agent CLI (claude, codex, ...)
                            |
                            |  runs  node bin\ensemble.cjs team-say ...
                            +----------> back to the server over HTTP
```

Three facts explain most of the behaviour:

- **The server owns everything.** Terminals and team state exist only inside the server
  process. The CLI and the GUI are plain HTTP clients. If the server stops, every agent
  terminal dies, and on the next start every team that was running is marked `disbanded`.
- **Agents talk with `team-say` and `team-read`.** The startup prompt tells each agent the
  exact command. `team-say` POSTs a message to the server; the server records it and pastes
  it into the recipient's terminal in the background.
- **Everything specific to one agent CLI is data** in `agents.json`. No code names a program.

---

## 2. Getting started

### 2.1 Prerequisites

| Need | Why |
|---|---|
| Windows 10 or 11 | The project is native-Windows only (`package.json` has `"os": ["win32"]`). |
| Node.js 18 or newer (LTS) | The server and CLI run through `tsx`. There is no build step. |
| Visual Studio Build Tools, workload **Desktop development with C++** | `node-pty` compiles a native binding on install. |
| PowerShell 7 (`pwsh`), recommended | Agent terminals use `pwsh.exe` if it is found, otherwise `powershell.exe`. |
| Windows Terminal, recommended | A good place to run the server and the CLI. |
| The agent CLIs you want, installed, **on PATH** and signed in | Ensemble starts them; it does not log in for you. |

Check what you have:

```powershell
node -v
npm -v
Get-Command pwsh, claude, codex -ErrorAction SilentlyContinue | Select-Object Name, Source
```

### 2.2 Install

```powershell
git clone https://github.com/yuk1na2312/yuk1ble ensemble-win
cd ensemble-win
npm install
```

`npm install` runs `bin/postinstall.cjs`, which loads `node-pty`. If that fails, you get the
prerequisite list and a non-zero exit. See [6.3](#63-npm-install-fails-building-node-pty).

### 2.3 Configuration (environment variables)

Every setting is an environment variable. The full list is in [section 7.2](#72-environment-variables).
`.env.example` in the repository root lists them with comments.

The server does **not read a `.env` file by itself**: nothing in `src/` or `package.json`
loads one, and `npm run dev` does not either. Pick one of these:

```powershell
# A) Set variables in the shell that starts the server. They last for that shell only.
$env:ENSEMBLE_PORT = "23001"
$env:ENSEMBLE_READY_TIMEOUT_MS = "240000"
npm run dev

# B) Keep them in a file and load it explicitly (Node 20.6 or newer).
#    Copy .env.example to .env, edit it, then:
npx tsx --env-file=.env src/server/index.ts
```

`.env` is git-ignored. Do not commit it.

The settings you are most likely to change:

| Variable | Default | When you touch it |
|---|---|---|
| `ENSEMBLE_PORT` | `23000` | Port 23000 is taken. Set the same value for the CLI shell too. |
| `ENSEMBLE_DATA_DIR` | `%USERPROFILE%\.ensemble` | You want transcripts and `teams.json` somewhere else (or a throwaway folder). |
| `ENSEMBLE_RUNTIME_DIR` | `%TEMP%\ensemble` | You want `summary.txt` and the prompt records somewhere else. |
| `ENSEMBLE_AGENTS_CONFIG` | `.\agents.json` | You want a different set of agent CLIs, for example the fake agents. |
| `ENSEMBLE_READY_TIMEOUT_MS` | `150000` | An agent CLI is slow to start (heavy plugin or hook setup). |
| `ENSEMBLE_IDLE_DISBAND_MS` | `3600000` | You want idle teams to end sooner or later. |
| `ENSEMBLE_SHELL` | `pwsh.exe`, else `powershell.exe` | You want a specific PowerShell. `cmd.exe` is refused. |
| `ENSEMBLE_AGENT_FLAGS` | none | You want extra flags on every spawned agent CLI. |

### 2.4 Start the server

```powershell
npm run dev
```

Leave it running. A healthy start prints:

```
[Ensemble] Agent programs: codex, claude, aider, gemini, opencode
[Ensemble] Server running on http://127.0.0.1:23000
[Ensemble] Health: http://localhost:23000/api/v1/health
```

If it prints an error and exits instead, go to [section 6](#6-troubleshooting).

### 2.5 Check it is alive

In a second terminal:

```powershell
curl.exe http://localhost:23000/api/v1/health
# {"status":"healthy","version":"1.0.0"}

npm run cli -- status
```

See which agent CLIs the server found on PATH (`installed` is the field to look at):

```powershell
curl.exe http://localhost:23000/api/ensemble/programs
```

### 2.6 Open the GUI and start the first team

```powershell
Start-Process http://localhost:23000/
```

Click **New team**, write a task, leave the two default agents, click **Start team**.
Agent terminals appear on the stage and start to fill. Starting an agent CLI takes anywhere
from a few seconds to two minutes; the page tells you what is happening.

Or from the command line:

```powershell
npm run cli -- run "Review the authentication module" --agents claude,codex --timeout 600
```

The first agent in the list is the lead.

---

## 3. Using it

### 3.1 The GUI

The page at `http://localhost:23000/` has three areas: the team list on the left, the agent
terminals in the middle, the conversation on the right. The **Server log** drawer is at the
bottom.

**Connection pill** (top left): `Live` means the event stream is open. `Connecting` or
`Reconnecting` means it is not; the page retries by itself. See
[6.12](#612-the-gui-says-reconnecting).

**New team** opens a dialog:

| Field | Meaning |
|---|---|
| Task | What the team should do. Every agent receives it. Required. |
| Team name | At most 64 characters. Terminal sessions are named after it with every character other than letters, digits, `-`, `_` and `.` removed (so `my team` becomes `myteam`), and a name with none of those is refused. Blank uses `run-<timestamp>`. A running team cannot reuse a session name. |
| Template | Optional preset of roles (Code Review, Implementation, Research, Debug). Picking one fills in a task prefix if the task is empty. |
| Working directory | Where the agents start. Blank means the folder the server was started in. |
| Agents | 2 to 8 rows of program and model. Programs that are not on PATH are greyed out. A program with no `models` list can only use its own default model. The first row is the lead. |
| Staged | Plan, then build, then verify, in phases (see 3.3). |
| Give each agent its own git worktree | Each agent works on its own branch (see 3.3). The working directory must be a git repository. |

**Terminal panes.** Each agent has a real terminal (xterm.js) fed by its PTY. Click inside
one and type: your keystrokes go to that agent's terminal. Typing into a pane is the way to
answer a prompt the agent is stuck on. Each pane header shows the program, model and role,
a state badge (`connecting`, `live`, `exited`, `no session`) and **Maximize**. `Ctrl+Shift+Up`
moves the keyboard focus from a terminal to its Maximize button. A red `stalled` badge means
the watchdog gave up on the agent (see 3.5); it disappears when the team ends.

**Conversation and steering.** The right column is the team transcript: agent messages,
your messages, and `ensemble` system notes (agent joined, watchdog nudged, errors). The box
at the bottom sends a message: pick **Whole team** or one agent, type, press `Enter`
(`Shift+Enter` adds a line). The message appears in the transcript and is pasted into the
recipient's terminal.

**Disband.** The **Disband** button above the transcript asks for a second click to confirm.
Disbanding writes the summary, kills every agent's whole process tree and marks the team
`ended`.

**Server log** shows what the server prints to its console. Open it first when something
looks wrong.

### 3.2 The CLI

The CLI is a thin HTTP client. It talks to `http://localhost:23000` unless `ENSEMBLE_URL`
(or `ENSEMBLE_PORT`) says otherwise.

```powershell
npm run cli -- <command>            # from the repository root
npx ensemble <command>              # same thing
node bin\ensemble.cjs <command>     # what agents run; also works from any folder
```

| Command | What it does |
|---|---|
| `status` | Server health and number of teams. |
| `teams` (or `ls`) | List teams with status, agents, start time and the **first 8 characters** of the id. |
| `run "task" [--agents p[:model],p[:model]] [--timeout 600]` | Create a team in the current folder and follow its feed. Starts the server if it is not running. |
| `steer <team-id> <message>` | Send a message to the whole team as `user`. |
| `team-say <team-id> <from> <to> <message>` | Send a message. `to` is an agent name or `team`. Prints `Sent to <to>`. |
| `team-read <team-id>` | Print the whole feed as `from -> to: text`. |
| `start` | Start the server in this terminal. |

Examples:

```powershell
npm run cli -- run "Find the bug in the login flow" --agents claude,codex
npm run cli -- run "Security audit" --agents codex:gpt-5.6-sol,claude:sonnet --timeout 900
npm run cli -- steer 6f1c2a9e-0000-0000-0000-000000000000 "focus on the auth module"
node bin\ensemble.cjs team-say 6f1c2a9e-0000-0000-0000-000000000000 claude-1 codex-2 "please review my plan"
node bin\ensemble.cjs team-read 6f1c2a9e-0000-0000-0000-000000000000
```

Things to know:

- **`steer`, `team-say` and `team-read` need the full team id** (a UUID). The short id that
  `teams` and `run` print gives `404 Team not found`. Get the full id from the GUI address bar
  (`#team=<id>`) or from the API: `(Invoke-RestMethod http://localhost:23000/api/ensemble/teams).teams | Select-Object name, id, status`.
- Without `--agents`, `run` takes the first two installed programs in `agents.json` order.
  `--agents` needs at least two entries. `program:model` must name a model from that program's
  list, otherwise the answer is a 400 and nothing starts.
- Agent names are `<program>-<position>` (`claude-1`, `codex-2`). The terminal session of an
  agent is `<team name>-<agent name>`.
- `run` ends when the team is disbanded (exit code 0) or the timeout passes (exit code 124).
  **A timeout does not disband the team.** It keeps running; disband it yourself (3.4).
- `team-say` exits non-zero and prints the reason when the server is down or answers an
  error, so an agent notices a lost message.
- There is no `disband` command. Use the GUI or the API (3.4).

### 3.3 Templates, staged workflow, worktrees

- **Templates** live in `collab-templates.json`: `review`, `implement`, `research`, `debug`.
  A template gives the agents roles and a focus in their startup prompt. Select one in the
  GUI, or send `"templateName": "review"` in the API call. `GET /api/ensemble/templates`
  lists them.
- **Staged workflow** (`"staged": true`): instead of the normal startup prompt, the agents
  are walked through three phases: plan, execute, verify. A phase moves on when the agents'
  messages look like it is finished, or when its timeout runs out (defaults: 2 min, 5 min,
  2 min). You can change them with `"stagedConfig": { "planTimeoutMs": 120000, "execTimeoutMs": 300000, "verifyTimeoutMs": 120000, "pollIntervalMs": 5000 }`.
- **Worktrees** (`"useWorktrees": true`): before the agents start, each gets its own git
  worktree in `<working directory>\.worktrees\<team-id>-<agent>` on a new branch
  `collab/<team-id>/<agent>`, and starts there. On disband, each branch is merged back into
  the branch that was checked out in the working directory (`--no-ff`) and the worktree is
  removed. A conflict is reported in the transcript and the work stays on its branch.
  If a worktree cannot be created the agent falls back to the shared folder and the
  transcript says so. Add `.worktrees/` to that repository's `.gitignore`.

### 3.4 Ending a team

A team ends in one of four ways:

1. **Sentinel.** The startup prompt tells agents to agree they are done and then each send a
   message that is exactly `<<COLLAB_DONE>>`. When **every agent still active** has sent it,
   the team disbands at once. Wording such as "done" never ends a team.
2. **Manual disband.** The GUI button, or:

   ```powershell
   Invoke-RestMethod -Method Post http://localhost:23000/api/ensemble/teams/<team-id>/disband
   # or: Invoke-RestMethod -Method Delete http://localhost:23000/api/ensemble/teams/<team-id>
   ```
3. **Idle.** After `ENSEMBLE_IDLE_DISBAND_MS` (default 1 hour, minimum 1 minute) with no
   agent message. This only applies once at least 10 non-system messages have been exchanged,
   so a team that never got going is never auto-disbanded: disband it yourself.
4. **Server restart.** Agents die with the server; on the next start, teams that were
   `active` or `forming` are marked `disbanded`.

What happens on disband: a summary is written (only if some agent said something), each active
agent gets a graceful exit and then its whole process tree is killed, worktrees are merged and
removed, the team is marked `disbanded`, and `.finished` is written last.

Where things go:

| What | Where |
|---|---|
| Team list (all teams, one JSON file) | `%USERPROFILE%\.ensemble\ensemble\teams.json` |
| Transcript of one team (one JSON message per line) | `%USERPROFILE%\.ensemble\ensemble\messages\<team-id>\feed.jsonl` |
| Summary of a finished team | `%TEMP%\ensemble\<team-id>\summary.txt` (its `Full transcript:` line names the feed file) |
| What each agent was told at startup | `%TEMP%\ensemble\<team-id>\prompts\<agent>.txt` |
| "Summary is safe to read" marker | `%TEMP%\ensemble\<team-id>\.finished` |
| Server console, live | the Server log drawer, or `GET /api/ensemble/logs` |

`ENSEMBLE_DATA_DIR` moves the first two rows; `ENSEMBLE_RUNTIME_DIR` moves the rest. The
files are a log: the running server never re-reads them, so editing them while it runs has no
effect.

### 3.5 The watchdog

Every 30 seconds the server checks each active agent. If an agent has sent no message for
90 seconds (`ENSEMBLE_WATCHDOG_NUDGE_MS`), it pastes "Are you still working? Share your
progress with team-say." into its terminal. If the agent is still silent 180 seconds after
the nudge (`ENSEMBLE_WATCHDOG_STALL_MS`), the agent is marked stalled: a note in the
transcript and the red badge. A stalled agent still receives messages. The stalled mark is not
cleared if the agent recovers; it is a hint to look at the pane, not a verdict. The GUI hides
the badge once the team has ended.

---

## 4. Configuring agent CLIs

### 4.1 `agents.json`

One key per program. The loader (`src/adapters/agent-config.ts`) validates the file once at
server start and the server exits with a message naming the program and the key if
something is wrong. `ENSEMBLE_AGENTS_CONFIG` points the server at another file.

Required keys:

| Key | Meaning |
|---|---|
| `command` | The executable. Must be on PATH (a `.cmd` or `.exe` shim is fine). |
| `readyMarkers` | Plain, case-sensitive text strings (not regexes) that appear on screen when the CLI is at its input prompt. At least one, none blank. |
| `inputMethod` | `sendKeys`: type the text and press Enter. `pasteFromFile`: paste the text (despite the name, no file is involved), then press Enter. Messages and nudges are always pasted. |
| `color` | `#rrggbb`, used by the GUI and CLI. |
| `icon` | One character shown in the GUI. |

Optional keys:

| Key | Meaning |
|---|---|
| `flags` | Default flags (put auto-accept flags here). |
| `cwdFlag`, `cwdFlagAliases` | The flag that takes the working directory. Added to the command line unless it already has the flag or an alias. |
| `addDirFlag` | The flag that grants access to the ensemble repo folder, so the agent may run `bin\ensemble.cjs`. Added when the working directory is not the repo. |
| `pasteMarker` | Regex source for what the composer shows when a paste was not submitted. Default: `\[Pasted (?:text\|Content)`. |
| `gates` | Startup screens to answer automatically (4.3). |
| `usagePatterns` | `{ "pattern": "...", "format": "...$1..." }`. One capture group; `$1` goes into `format`. Used for the token count in `summary.txt`. |
| `modelFlag`, `models` | Model allowlist `[{ "id", "label" }]`. `models` needs `modelFlag`. 4.2. |
| `stripEnv` | Regex sources of environment variables withheld from every agent shell (for example API keys that would override the CLI's own login). The union over all programs applies to every shell. |

An entry from the repository, trimmed:

```json
"codex": {
  "command": "codex",
  "flags": ["--dangerously-bypass-approvals-and-sandbox"],
  "cwdFlag": "--cd",
  "readyMarkers": ["OpenAI Codex"],
  "inputMethod": "pasteFromFile",
  "modelFlag": "--model",
  "models": [{ "id": "gpt-5.6-sol", "label": "Sol" }],
  "color": "#6aa9ff",
  "icon": "◆"
}
```

The program name in a request is matched case-insensitively against the keys, also as a
leading word (`claude code` and `claude-code` resolve to `claude`). There is no fallback: an
unknown name is a 400.

### 4.2 Models

`models` is an allowlist. A model that is not listed is rejected with a 400 before anything
starts, because a bad model id makes the CLI exit at once and the readiness wait would burn
its whole window. Only add ids that a real run has confirmed. A program without `models` has no
model picker and always uses the CLI's own default. `ENSEMBLE_AGENT_FLAGS` outranks both the
adapter's `flags` and the chosen model.

### 4.3 Gates and ready markers

When an agent CLI starts, the server watches its screen. On every pass it checks, in this order:

1. the team was disbanded: stop;
2. the session exited: stop;
3. a **gate** matches the screen: send its keys and look again;
4. a **ready marker** is on the screen: the agent is ready;
5. the screen has not changed for 20 seconds and does not end at a `PS ...>` prompt: treat it as ready.

The order matters: some CLIs use the same glyph for their input prompt and for a menu cursor,
so gates are always checked before markers. Do not reverse it.

A gate is `{ "name", "pattern", "keys", "literal"?, "enter"?, "trustKeys"?, "trustEnv"? }`.
`pattern` is a case-insensitive regex. `keys` are named keys (`Enter`, `Escape`, `Tab`, `Space`, `Up`, `Down`,
`Left`, `Right`, `C-c`, `C-d`, `C-z`; the full list is `KEYMAP` in `src/runtime/pty-runtime.ts`) or, with `"literal": true`, text typed as is. `"enter": true`
presses Enter after each key. `trustKeys` with `trustEnv` names a different answer used when
that environment variable is `1` (for example, the `codex` hooks review gate is answered
"continue without trusting" unless `ENSEMBLE_CODEX_TRUST_HOOKS=1`). A gate is answered at most
once every 3 seconds and abandoned after 5 answers.

If the ready wait runs out (`ENSEMBLE_READY_TIMEOUT_MS`), the server says so in the
transcript and sends the startup prompt anyway, best effort, unless the session is gone.

### 4.4 Adding a new CLI, step by step

1. Install the CLI, log in, and run it once by hand in a PowerShell window. Note its exact
   command name and what text appears when it is waiting for input.
2. Add an entry to `agents.json` with the five required keys. Use a distinctive piece of the
   idle screen as `readyMarkers`. Add its auto-accept flag to `flags` if it has one.
3. Restart the server. A bad entry stops the boot with a message such as
   `program "x": "color" must be a hex colour like "#6aa9ff"`.
4. Check that the server sees it:

   ```powershell
   curl.exe http://localhost:23000/api/ensemble/programs
   ```

   `installed: true` means the command was found on the server's PATH.
5. Start a two-agent team with it (one agent of the new program, one other) and watch the pane.
   If the agent does not become ready, read its screen and adjust:

   ```powershell
   (Invoke-RestMethod "http://localhost:23000/api/ensemble/sessions/<session-name>/pane?lines=60").pane
   ```

   - A startup dialog on screen: add a `gate`.
   - Idle screen shown but no ready: fix `readyMarkers` (remember: exact, case-sensitive).
   - A `PS C:\...>` prompt: the command did not start (not on PATH, bad flag, a relative path that does not exist in the working directory).
   - Text sits in the input box unsent: set `pasteMarker` to what the composer shows.
6. Run `npm test`. The loader tests validate every entry. `tests/adapters.test.ts` has an example
   of a fake CLI that exists only as an `agents.json` entry.
7. Do one real run. Unit tests stop at the command line and recorded screens; only a live run
   proves the markers and gates.

### 4.5 Testing an adapter with the fake agent

`tests/fixtures/fake-agent.mjs` is a stand-in CLI: it prints `FAKE AGENT READY >`, then
echoes every submitted line as `got: <line>`. `tests/fixtures/fake-agents.json` defines two
programs for it, `fakea` and `fakeb` (`fakeb` has models `m1` and `m2`). Use them to test the
whole stack without starting a real, billable agent. See 5.4.

---

## 5. Developing on it

### 5.1 Layout and layer rules

```
src/
  server/    HTTP only: routes.ts, guard.ts, sse.ts, static.ts, log-buffer.ts, index.ts (boot)
  core/      team logic: team-lifecycle, store, bus, messaging, delivery, readiness,
             watchdog, team-supervisor, prompts, staged-workflow, worktrees, summary, paths
  runtime/   the only door to a terminal: agent-runtime.ts (interface), pty-runtime.ts, win-process.ts
  adapters/  agents.json loader and types, program catalog
  cli/       ensemble.ts, a pure HTTP client
  types.ts, repo-root.ts
web/         the GUI: index.html, app.css, js/*.js (vanilla ES modules, no build step)
bin/         ensemble.cjs (CLI shim that agents run), postinstall.cjs
tests/       vitest; helpers/, fixtures/
skill/       SKILL.md for the /collab skill in Claude Code
```

The rules:

- `server` may use `core`, `runtime` and `adapters`. `core` never imports from `server`.
- **`AgentRuntime` is the only door to a terminal.** Code in `core` gets it from
  `getRuntime()`. New terminal behaviour goes into `PtyRuntime`, not into business logic.
- **Text reaches a terminal only through `deliver()` in `src/core/delivery.ts`.** It queues
  (one delivery at a time per session, at most 50 waiting), pastes or types, then makes sure
  the text was submitted. A path that skips it produces a silent agent.
- **The CLI imports neither the runtime nor the store.** PTY sessions exist only in the
  server process; a second `PtyRuntime` elsewhere has a permanently empty registry. A test
  enforces this.
- **No program names in code.** Anything that differs per agent CLI is an `agents.json` entry.
- Paths that depend on where a file lives go through `REPO_ROOT` (`src/repo-root.ts`), never `..` chains.
- GUI: plain JavaScript modules served as they are. `/vendor/xterm/*` serves the xterm.js files from `node_modules`.

### 5.2 The check loop

Before every commit:

```powershell
npm run typecheck
npm run lint
npm test
```

All three must pass. `npm test` takes about 20 seconds and starts real PowerShell sessions and a
fake agent in a few tests; run it with nothing else listening on odd ports and expect a rare
timing flake under heavy load (run it again).

### 5.3 The tests

| Where | What |
|---|---|
| `tests/helpers/boot-server.ts` | `bootServer()` starts the real server on a free port with a temp data dir, real store and routes, and a mocked spawner and runtime. Returns `baseUrl`, mock `runtime`, `pty.emit(session, chunk)` to push terminal output, and `restore()`/`cleanup()`. |
| `tests/fixtures/fake-agent.mjs`, `fake-agents.json` | The fake agent and its adapter config. `tests/e2e-fake-agent.test.ts` runs the whole stack against it: real server, real ConPTY, real readiness, real SSE, process-tree checks. |
| `tests/fixtures/agents.json` | A small adapter set for server tests (a stub screen of `>`). |
| `tests/fixtures/screens.ts` | Terminal screens captured live from real CLIs. Readiness tests use them as fixtures. When a CLI's UI changes, capture the new screen from `GET .../pane` and add it here. |
| the rest | One file per module: `readiness-*.test.ts`, `delivery.test.ts`, `team-api.test.ts`, `sse.test.ts`, `http-guard.test.ts`, `store.test.ts`, and so on. |

Run one file, or filter by test name:

```powershell
npx vitest run tests/delivery.test.ts
npx vitest run -t "sentinel"
```

Rules for tests: never start a real agent CLI, and never bind port 23000.

### 5.4 Running the GUI against fake agents

Use this for any GUI or lifecycle work. It uses its own port and folders, so it does not touch
your real data.

```powershell
$scratch = Join-Path $env:TEMP "ensemble-dev"
New-Item -ItemType Directory -Force $scratch | Out-Null
$env:ENSEMBLE_PORT = "23100"
$env:ENSEMBLE_AGENTS_CONFIG = "$PWD\tests\fixtures\fake-agents.json"
$env:ENSEMBLE_DATA_DIR = "$scratch\data"
$env:ENSEMBLE_RUNTIME_DIR = "$scratch\runtime"
npm run dev
```

In a second shell:

```powershell
$env:ENSEMBLE_URL = "http://localhost:23100"
npm run cli -- run "ui check" --agents fakea,fakeb,fakea --timeout 5
Start-Process http://localhost:23100/
```

To exercise the watchdog quickly, also set `ENSEMBLE_WATCHDOG_NUDGE_MS=3000` and
`ENSEMBLE_WATCHDOG_STALL_MS=3000` before starting (the check itself runs every 30 seconds).
The fake agent runs `node tests\fixtures\fake-agent.mjs` relative to the team's working
directory, so start teams from the repo root; with `useWorktrees` the agents start in the
worktree, where that relative path does not exist.

Stop the server with `Ctrl+C`. If it was started from another process, kill its tree (6.2).

### 5.5 Conventions that must not regress

These each came from a live failure. The full list is in `AGENTS.md`.

- Native Windows only: no bash, WSL, or `osascript`. Delete such paths instead of gating them.
- Kill the whole process tree on teardown (`taskkill /T /F`). Agent CLIs start children, and
  `pty.kill()` alone leaves them running and holding the port.
- Bound every in-memory buffer.
- A paste alone never submits; a separate Enter does. Always use `deliver()`.
- Gates run before ready markers.
- Do not decide a run is over from wording. Only the sentinel, a manual disband or the idle timeout end it.
- Model ids are an allowlist. An unknown program is a 400, not a fallback.
- Do not loosen the Host/Origin guard and do not bind beyond loopback. The API can type into terminals and has no login.
- Use `path.join`, `os.homedir()`, `os.tmpdir()`. No inline `VAR=value` in npm scripts (use `cross-env`). No new `any`.

### 5.6 Commit discipline

Small, single-purpose commits with a plain-English subject (72 characters or less) and a body that
says why. Run the check loop first. Do not push, force-reset or delete without asking.

---

## 6. Troubleshooting

Start with these three looks: the **Server log** drawer in the GUI (or `GET /api/ensemble/logs`),
the **transcript** (the `ensemble` system messages say what failed), and the **pane snapshot** of
the agent that misbehaves:

```powershell
(Invoke-RestMethod "http://localhost:23000/api/ensemble/sessions/<session-name>/pane?lines=80").pane
```

The session name is the `sessionName` field of the agent in `GET /api/ensemble/teams`
(`<team name>-<agent name>`).

### 6.1 Port 23000 is already in use / the server will not start

Symptom: `[Ensemble] Port 23000 is already in use on 127.0.0.1. Stop the other process or set ENSEMBLE_PORT to a different port.`, exit code 1.

Cause: another ensemble server (often one that was left running or an orphan after a crash), or any other program, holds the port.

Fix: find the holder.

```powershell
Get-NetTCPConnection -LocalPort 23000 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId=<OwningProcess>" | Select-Object ProcessId, Name, CommandLine | Format-List
# or: netstat -ano | findstr :23000 | findstr LISTENING
```

If it is an old ensemble server, kill it with its whole tree:

```powershell
taskkill /T /F /PID <OwningProcess>
```

Or choose another port: `$env:ENSEMBLE_PORT = "23001"` (and the same in the shell where you run the CLI).

### 6.2 Orphaned agent processes after a crash

Symptom: after the server died hard, `node`, `claude`, `codex` or `pwsh` processes keep running,
sometimes holding port 23000.

Cause: the server kills agent trees on exit and on `Ctrl+C`, but a hard kill (task manager,
power loss, `taskkill` without `/T`) skips that.

Fix: list candidates, then kill by tree.

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'ensemble|fake-agent' -and $_.Name -match 'node|pwsh|powershell' } |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine
taskkill /T /F /PID <ProcessId>
```

Check the list first: agent CLIs you started yourself in other windows look the same.

### 6.3 `npm install` fails building node-pty

Symptom: `gyp ERR!`, "Could not find any Visual Studio installation", or the postinstall message
`node-pty could not be loaded`.

Cause: no C++ toolchain, or a Node version without a prebuilt `node-pty` binary.

Fix: install Visual Studio Build Tools with the **Desktop development with C++** workload (or the
Visual Studio Installer's equivalent), open a new terminal, then:

```powershell
Remove-Item -Recurse -Force node_modules
npm install
```

If it still fails, try the current Node LTS. Python is not needed.

### 6.4 The server exits at boot and names a program and a key

Symptom: `[Ensemble] <path>\agents.json: program "x": "readyMarkers" is required (at least one marker)`, or
`cannot read agents config (ENOENT ...)`.

Cause: `agents.json` (or the file `ENSEMBLE_AGENTS_CONFIG` points to) is invalid JSON, missing, or has a bad entry.

Fix: open the file named in the message and fix the program and key it names. Common ones: `color` not
`#rrggbb`, no `readyMarkers`, `inputMethod` not `sendKeys` or `pasteFromFile`, `models` without
`modelFlag`, a regex that does not compile, a `gates` entry with only one of `trustKeys` and `trustEnv`.

### 6.5 `400 unknown program` or `model ... is not available`

Symptom: creating a team answers `400 {"error":"Bad Request: unknown program \"x\"; available: ..."}` or
`agents[0].model "x" is not available for claude; available: fable, opus, sonnet`.

Cause: the program is not a key (or leading word) in `agents.json`, or the model is not in that program's `models` list.

Fix: use a name from `GET /api/ensemble/programs`, a model id from its `models`, or no model. Other
400 causes: fewer than 2 or more than 8 agents, a team name with no letter, digit, `-`, `_` or `.`, or longer than 64
characters, and `a running team already uses the terminal name ...` (pick another team name or
disband the old team).

### 6.6 An agent never becomes ready

Symptom: the transcript shows `did not signal ready in time — injecting prompt anyway (best-effort)`, or the
pane stays on a startup screen, or `exited before it could be prompted`.

Causes and fixes, in the order to check them:

1. Look at the pane snapshot.
   - A `PS C:\...>` prompt, or "is not recognized as the name of a cmdlet": the command did not start.
     Check that `command` is on PATH in the shell that started the **server**; a PATH change needs a new terminal and a server restart. Check flags and relative paths.
   - A dialog (trust this folder, hooks review, login): add a `gate`, or type the answer into the
     pane in the GUI. A login prompt means the CLI is not signed in: sign in by hand first.
   - The normal idle screen: `readyMarkers` does not match. Markers are exact, case-sensitive text.
2. The CLI is just slow (many plugins or hooks): raise `ENSEMBLE_READY_TIMEOUT_MS` (default 150000).
3. A screen that is unchanged for 20 seconds and not at a PowerShell prompt is treated as ready, so a
   late start is not fatal; the prompt is injected and the CLI buffers it.

### 6.7 Text is pasted but not submitted

Symptom: the agent's input box shows `[Pasted text #1 +40 lines]` (or similar) and nothing happens.

Cause: a CLI parks a paste in its composer; only a separate Enter submits it. The server sends that
Enter after 1.5 s, then again after 3 s and 6 s while the screen still matches the adapter's
`pasteMarker`. If the composer shows something else, the server cannot tell.

Fix: set `pasteMarker` in `agents.json` to a regex for what the composer shows (default
`\[Pasted (?:text|Content)`). For this one time, click into the pane and press Enter.

### 6.8 An agent says nothing, or the watchdog marks it stalled

Symptom: a `Watchdog nudged ...` note, then `Watchdog marked ... as stalled`, and a red badge.

Cause: the agent sent no `team-say` for a long time. It may be working (a long build or test run),
waiting for approval, stuck on a dialog, rate-limited, or unable to run `team-say`.

Fix: look at its pane. If it is waiting for a keypress, type into the pane. If `team-say` fails in
its terminal (`cannot reach the ensemble server`), check that the server is up and `ENSEMBLE_URL` was
not changed; for a Claude-style CLI also check that the `addDirFlag` is present so it may run the
repo's `bin\ensemble.cjs`. A stalled agent keeps receiving messages, so steering it from the box
below the transcript can wake it. To make the watchdog more patient, raise
`ENSEMBLE_WATCHDOG_NUDGE_MS` and `ENSEMBLE_WATCHDOG_STALL_MS`.

### 6.9 The team never ends

Symptom: the work is clearly finished and the team stays `active`.

Cause: a team ends only on the sentinel from **every active agent**, a manual disband, or the idle
timeout (1 hour of silence, and only after 10 messages). One agent that never sent `<<COLLAB_DONE>>`
(or whose message had extra text) blocks the first rule.

Fix: disband it (GUI button, or `Invoke-RestMethod -Method Post http://localhost:23000/api/ensemble/teams/<team-id>/disband`).
To end it from the transcript side, steer: `npm run cli -- steer <team-id> "If you agree we are done, send exactly <<COLLAB_DONE>>"`.
Note that `ensemble run` timing out does not disband the team.

### 6.10 403, 413, 429 from the API

| Status | Meaning | Fix |
|---|---|---|
| 403 `Host not allowed: this API answers to loopback names only` | The `Host` header is not `localhost`, `127.0.0.1`, `[::1]` or `ENSEMBLE_HOST`. Reaching the server through a machine name, a tunnel or a reverse proxy does this. | Use `http://localhost:23000`. If you really need another name, set `ENSEMBLE_HOST` to it, knowing the API has no login. |
| 403 `CORS origin forbidden` | A browser page from another origin called the API. | Only pages from localhost are allowed. `ENSEMBLE_CORS_ORIGIN` replaces that list with the origins you give (comma separated). The CLI and curl send no Origin and are fine. |
| 413 | Request body over 1 MB (`/input` is limited to 64 KB of text per request). | Send less. |
| 404 on `/sessions/<name>/input` or `/resize` | The name is not an agent terminal of a team that is still running. | Take the name from `GET /api/ensemble/teams`; a disbanded team's terminals are closed. |
| 429 on an event stream | 32 streams are open in total (browser tabs and `curl -N`), or 16 listeners on one terminal. | Close tabs and stray `curl.exe -N` windows. |

### 6.11 `Cannot connect to http://localhost:23000` from the CLI

Symptom: `ensemble status` prints that it cannot connect; `team-say failed: cannot reach the ensemble server`.

Cause: the server is not running, or it runs on another port than the CLI is aiming at.

Fix: start it (`npm run dev`), or set `$env:ENSEMBLE_URL = "http://localhost:<port>"` (or `ENSEMBLE_PORT`) in the shell running the CLI. Agents get `ENSEMBLE_URL` from the server automatically.

### 6.12 The GUI says "Reconnecting"

Symptom: the pill at the top left says `Reconnecting`, or a pane says `Connection lost. Reconnecting.`

Cause: the event stream to the server broke: the server stopped or restarted, or the laptop slept.

Fix: wait a few seconds; the page retries and resyncs on its own. If it stays, check that the server
is up (6.11). A server restart ended its terminals: panes then show `no session` and the old teams are `ended`.
If the page keeps failing right after it opened, you may be over the 32-stream limit (6.10).

### 6.13 `pty.spawn` fails with `error code: 267`

Cause: the working directory is not a valid Windows path (typically forward slashes, or a folder that does not exist).

Fix: give `workingDirectory` as an existing folder with backslashes, for example `C:\Users\me\project`.

### 6.14 `setRawMode` error

Cause: code asked for raw mode on a stdin that is not a TTY (a piped or redirected process).

Fix: in your own code, check `process.stdin.isTTY` first. The server and CLI do not need raw mode; if you
see this from a script you wrote, run it from a real terminal or drop the raw-mode call.

### 6.15 Garbled characters in a pane or in the CLI output

Cause: a console code page that is not UTF-8.

Fix: agent terminals are started with UTF-8 input and output encoding already. For your own PowerShell window
(for example the one running the CLI):

```powershell
chcp 65001
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
```

Windows PowerShell 5.1 with a raster font may still show boxes: use Windows Terminal with a Unicode font such as Cascadia Mono.

### 6.16 An agent CLI is greyed out as "not installed"

Cause: the server did not find `command` on PATH. It scans the PATH of the process that started the server,
using `PATHEXT`, and caches the answer for 30 seconds.

Fix: make the command work in a fresh terminal (`Get-Command claude`), start the server from that terminal, wait 30 s or restart it.

### 6.17 Where the data is, and how to reset it safely

See the table in 3.4. To reset everything: stop the server first (so it cannot rewrite files), then
delete the two folders. This destroys all transcripts and summaries.

```powershell
# 1. stop the server (Ctrl+C in its window)
# 2. then:
Remove-Item -Recurse -Force "$env:USERPROFILE\.ensemble"
Remove-Item -Recurse -Force "$env:TEMP\ensemble"
```

If you set `ENSEMBLE_DATA_DIR` or `ENSEMBLE_RUNTIME_DIR`, delete those folders instead. To keep history but
clear a stuck state, it is enough to restart the server: running teams become `disbanded` and their agent
terminals are gone. A leftover `.worktrees\` folder and `collab/*` branches in a project come from
`useWorktrees` runs that were interrupted: remove them with `git worktree remove` and `git branch -D`.

---

## 7. Reference

### 7.1 HTTP API

Port 23000, JSON unless noted. Every request passes the Host/Origin guard first (6.10). The full
table is also in `AGENTS.md`.

| Route | What it does |
|---|---|
| `GET /api/v1/health` | Liveness: `{"status":"healthy","version":"1.0.0"}` |
| `GET /api/ensemble/programs` | Agent CLIs from `agents.json`: name, icon, color, models, installed |
| `GET /api/ensemble/templates` | Collaboration presets |
| `GET /api/ensemble/teams` | All teams |
| `GET /api/ensemble/teams/:id` | One team and its messages |
| `GET /api/ensemble/teams/:id/feed?since=<seq>` | Messages after `seq` |
| `POST /api/ensemble/teams` | Create a team. Answers **202** at once; agents start in the background |
| `POST /api/ensemble/teams/:id` | Send a message `{ "from", "to", "content" }`. `to` is an agent name or `team`; `from` defaults to `user` |
| `POST /api/ensemble/teams/:id/disband`, `DELETE /api/ensemble/teams/:id` | End a team |
| `GET /api/ensemble/events[?team=<id>]` | SSE: `team`, `message`, `log` events (JSON) |
| `GET /api/ensemble/sessions/:name/stream` | SSE of one terminal: `replay`, then `data` (base64), then `exit` |
| `POST /api/ensemble/sessions/:name/input` | `{ "data": "..." }` raw keystrokes, at most 64 KB |
| `POST /api/ensemble/sessions/:name/resize` | `{ "cols": 120, "rows": 40 }` (cols 20-400, rows 5-200) |
| `GET /api/ensemble/sessions/:name/pane?lines=N` | Text snapshot of a terminal (`lines` up to 500, default 60) |
| `GET /api/ensemble/logs?since=<seq>` | The server's console output |

Create a team (body of `POST /api/ensemble/teams`):

```powershell
$body = @{
  name             = "review-team"                 # required, <= 64 chars, letters, digits, - _ .
  description      = "Review the auth module"      # required: the task
  agents           = @(                            # required: 2 to 8
    @{ program = "claude"; role = "lead" },
    @{ program = "codex"; model = "gpt-5.6-sol"; role = "worker" }
  )
  workingDirectory = (Get-Location).Path           # optional
  templateName     = "review"                      # optional
  useWorktrees     = $false                        # optional
  staged           = $false                        # optional
} | ConvertTo-Json -Depth 5

$team = Invoke-RestMethod -Uri "http://localhost:23000/api/ensemble/teams" -Method Post -ContentType "application/json" -Body $body
$team.team.id
```

Follow the feed from a shell (use the last `seq` you saw as `since`):

```powershell
(Invoke-RestMethod "http://localhost:23000/api/ensemble/teams/$($team.team.id)/feed?since=0").messages |
  ForEach-Object { "$($_.seq) $($_.from) -> $($_.to): $($_.content)" }

curl.exe -N http://localhost:23000/api/ensemble/events
```

To read the text of an error body (for example the reason for a 400), use PowerShell 7's
`Invoke-RestMethod -SkipHttpErrorCheck`, or `curl.exe -s`, which prints the body whatever the status.

### 7.2 Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ENSEMBLE_PORT` | `23000` | Server port |
| `ENSEMBLE_HOST` | `127.0.0.1` | Bind address, also accepted in the `Host` header. Loopback by design; a wildcard bind is only reachable through loopback names |
| `ENSEMBLE_URL` | `http://localhost:<ENSEMBLE_PORT>` | CLI target, and where agents' `team-say` posts. The server exports it to the terminals it spawns |
| `ENSEMBLE_DATA_DIR` | `%USERPROFILE%\.ensemble` | `ensemble\teams.json` and `ensemble\messages\<team-id>\feed.jsonl` |
| `ENSEMBLE_RUNTIME_DIR` | `%TEMP%\ensemble` | `<team-id>\summary.txt`, `.finished`, `prompts\` |
| `ENSEMBLE_AGENTS_CONFIG` | `.\agents.json` | Alternative adapter file; validated at server start |
| `ENSEMBLE_AGENT_FLAGS` | none | Extra flags for spawned agent CLIs; they win over adapter flags and a chosen model |
| `ENSEMBLE_SHELL` | `pwsh.exe`, else `powershell.exe` | Shell for agent terminals; `cmd.exe` is refused |
| `ENSEMBLE_READY_TIMEOUT_MS` | `150000` | How long to wait for an agent CLI to reach its prompt (minimum 5000) |
| `ENSEMBLE_IDLE_DISBAND_MS` | `3600000` | Silence before a team auto-disbands (minimum 60000, after 10 messages) |
| `ENSEMBLE_WATCHDOG_NUDGE_MS` | `90000` | Silence before an agent is nudged |
| `ENSEMBLE_WATCHDOG_STALL_MS` | `180000` | Time after a nudge before an agent is marked stalled |
| `ENSEMBLE_CORS_ORIGIN` | localhost only | Comma-separated allowed origins; replaces the default list |
| `ENSEMBLE_CREATED_BY` | none | Label stamped on created teams |
| `ENSEMBLE_CODEX_TRUST_HOOKS` | unset | `1` answers codex's "hooks need review" gate with *Trust all*; otherwise *Continue without trusting* |

### 7.3 Further reading

- `AGENTS.md`: the project contract, conventions, and the list of gotchas with their history.
- `README.md`: the short quick start.
- `REPO-STRUCTURE.md`: what this fork kept and dropped from upstream.
- `skill/SKILL.md`: the `/collab` skill that drives ensemble from Claude Code.
