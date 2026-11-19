# AGENTS.md

Persistent project context for AI coding agents (Claude Code, Codex, …). Read this at the
start of every session. `CLAUDE.md` imports this file — there is deliberately only one
copy.

---

## What this project is

**ensemble** — a multi-agent collaboration engine. It spawns AI agent CLIs (the five in
`agents.json`: `claude`, `codex`, `aider`, `gemini`, `opencode`) into terminal sessions,
lets teams of 2 to 8 of them message each other over a structured bus, and shows the
collaboration live in a browser GUI. An HTTP API + CLI drive everything.

This repo is a **native-Windows-only fork** of [michelhelsdingen/ensemble](https://github.com/michelhelsdingen/ensemble),
which is macOS/Linux/WSL2-only because its runtime is tmux-backed. Everything Unix-specific
has been removed rather than gated.

- **Stack:** TypeScript (run via `tsx`, no build step), Node.js 18+. No Python, no bash.
- **Server:** HTTP API on port **23000** (`src/server/index.ts`), which also serves the GUI from `web/` at `/`.
- **Adapters:** everything specific to one agent CLI is data in `agents.json`, validated at
  load (`src/adapters/agent-config.ts`). No `.ts` file under `src/` names a program outside
  comments. See *Adding a CLI* below.
- **Runtime layer:** agent sessions live behind the `AgentRuntime` interface in
  `src/runtime/agent-runtime.ts`: `create`/`kill` (async) and `exists`, `list`, `write`, `sendKeys`,
  `paste`, `resize`, `screen`, `replay`, `onData`, `onExit` (synchronous). `PtyRuntime`
  (node-pty + ConPTY) is the only implementation and is installed unconditionally with
  `setRuntime(new PtyRuntime())`.
- **Push, not poll:** the server pushes team, message and log events and each agent's raw
  terminal output to browsers over Server-Sent Events (`src/server/sse.ts`); keystrokes come back as
  POSTs. Every request passes a Host/Origin guard first (`src/server/guard.ts`).
- **State:** the server process owns all team and message state **in memory**
  (`src/core/store.ts`). `teams.json` (temp file + rename, debounced 100 ms, flushed
  on exit) and one `feed.jsonl` per team are only a persistence log: they are read once and
  never polled. Messages carry a per-team `seq`; `src/core/bus.ts` announces `team`, `message`
  and `log` events. The CLI is a pure HTTP client — there is no second process per team.

For a step-by-step manual (start, use, configure, troubleshoot) see
[docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md).

## Current state

The port is functionally complete: teams spawn, agents exchange messages, the GUI renders
live PTY panes, teardown kills the full process tree. `npm run typecheck`, `npm run lint`
and `npm test` (380 tests / 29 files) are green. What remains is repeated real-world use.

---

## Project layout

```
src/
  repo-root.ts            REPO_ROOT: the one place a path is computed from a file's location
  load-env.ts             loads <repo>/.env; imported first by the server and the CLI
  types.ts                teams and messages
  server/                 the HTTP process
    index.ts              boot file: config, runtime, listen (port 23000)
    routes.ts             every HTTP route (and the GUI at /), behind the guard
    guard.ts              Host + Origin checks, 1 MB body cap, CORS headers, sendJson/readJsonBody
    sse.ts                GET /events and GET /sessions/:name/stream (bounded SSE streams)
    static.ts             serves web/ and the three fixed /vendor xterm files, nothing else
    log-buffer.ts         tees console.* into a ring buffer for GET /api/ensemble/logs
  core/                   business logic; runtime-agnostic, talks to terminals via getRuntime()
    team-lifecycle.ts     team validation, start and disband
    store.ts              in-memory store: teams, per-team feed (seq, 5,000-message cap) + persistence log
    bus.ts                typed event bus: `team`, `message`, `log`
    messaging.ts          sendTeamMessage: into the feed, then delivered in the background
    delivery.ts           deliver(): the one way text reaches a terminal (queue, paste, submit)
    paste-submit.ts       ensureSubmitted() — a paste alone never submits; Enter does
    readiness.ts          waitForReady(): abort / exit / gates / ready markers / quiescence; wakes on PTY output
    pane-readiness.ts     marker match / shell-prompt guard / quiescent-screen fallback (pure predicates)
    agent-spawner.ts      spawnLocalAgent / killLocalAgent (PowerShell command line)
    watchdog.ts           liveness (nudge → stall via exists)
    team-supervisor.ts    done sentinel, idle auto-disband, watchdog (told to disband by the lifecycle)
    prompts.ts            collab templates, the startup prompt, the <<COLLAB_DONE>> sentinel
    staged-workflow.ts    staged prompt delivery
    summary.ts            summary.txt on disband
    worktrees.ts          per-agent git worktree isolation
    session-name.ts       the runtime session name of an agent (shared by spawner and store)
    collab-paths.ts       %TEMP%\ensemble\<team-id>\… layout
    data-paths.ts         ~/.ensemble data layout
  runtime/                the only door to a terminal
    agent-runtime.ts      AgentRuntime interface + getRuntime/setRuntime
    pty-runtime.ts        the only runtime: node-pty sessions, scrollback, listeners, tree-kill
    win-process.ts        killProcessTree / killProcessTreeSync / PowerShell quoting / findOnPath
  adapters/               everything per agent CLI
    agent-config.ts       agents.json loader + validation, resolveAgentProgram (aliases, no fallback),
                          resolveReadyMarkers, isValidModel, buildAgentCommandParts(program, model?)
    programs.ts           describePrograms() behind GET /api/ensemble/programs (PATH lookup, cached 30 s)
    types.ts              the agents.json schema types
  cli/
    ensemble.ts           CLI entrypoint (status, run, steer, team-say, team-read) — pure HTTP client
web/                      monitoring GUI, served at `/`: index.html, app.css and ES modules in js/
                          (api, events, store, teams, terminals, transcript, new-team, log, main);
                          vanilla JS, no build step; xterm.js comes from /vendor/xterm/*
bin/                      ensemble.cjs (CLI shim) + postinstall.cjs (node-pty check)
agents.json               one adapter per agent CLI: command, flags, cwdFlag/addDirFlag, readyMarkers,
                          inputMethod, pasteMarker, gates, usagePatterns, modelFlag/models, stripEnv,
                          color, icon
collab-templates.json     collaboration presets
skill/SKILL.md            the /collab skill that drives ensemble from Claude Code
tests/                    vitest; live-captured terminal screens (tests/fixtures/screens.ts) used as
                          fixtures; tests/fixtures/agents.json is a small adapter set for server tests;
                          tests/helpers/boot-server.ts boots the real server on a free port
.env.example              every environment variable the server and CLI read
```

---

## HTTP API

All of it on port 23000, JSON unless noted. A request whose `Host` is not a loopback name
(or `ENSEMBLE_HOST`) is a 403, as is any request naming an Origin the CORS rule does not
allow; no Origin (CLI, curl) is fine. Bodies over 1 MB are a 413.

| Route | |
|---|---|
| `GET /api/v1/health` | liveness |
| `GET /api/ensemble/programs` | the adapter catalog (name, icon, color, models, installed) |
| `GET /api/ensemble/teams`, `GET …/teams/:id`, `GET …/teams/:id/feed?since=<seq>` | state, served from memory |
| `POST /api/ensemble/teams` | create a team; **202** at once |
| `POST …/teams/:id` (message), `POST …/teams/:id/disband`, `DELETE …/teams/:id` | talk to / end a team |
| `GET /api/ensemble/events[?team=<id>]` | SSE: `team`, `message`, `log` (JSON); `?team` limits `message` |
| `GET /api/ensemble/sessions/:name/stream` | SSE: `replay` once (base64 scrollback), then `data` (base64 PTY chunks), then `exit` |
| `POST /api/ensemble/sessions/:name/input` | `{ data }`: raw bytes (max 64 KB) typed into an agent's terminal |
| `POST /api/ensemble/sessions/:name/resize` | `{ cols, rows }` (20–400, 5–200) |
| `GET /api/ensemble/sessions/:name/pane?lines=N`, `GET /api/ensemble/logs?since=<seq>` | text snapshots for the CLI and `skill/SKILL.md` |

Input and resize answer 404 unless the name is an agent terminal of a team that is not
disbanded. SSE is bounded: 32 streams in all (429 beyond), a client more than 1 MB behind is
dropped, 16 listeners per terminal.

---

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install deps. **Needs VS C++ Build Tools** — node-pty compiles native code. |
| `npm run dev` | Start the server (`tsx src/server/index.ts`) on port 23000. Keep running. |
| `npm start` | Production server. Requires `cross-env` (inline `NODE_ENV=` fails on Windows). |
| `npm run typecheck` | `tsc --noEmit` — must pass before any commit. |
| `npm run build` | Same as typecheck (no emit). |
| `npm run lint` | `eslint . --ext .ts`. |
| `npm run cli -- <args>` | Run the CLI (e.g. `npm run cli -- status`). |

**Monitoring GUI:** with the server running, open <http://localhost:23000/> — create a
team, plus teams list, transcript, live agent PTY panes, and the server log on one page
(`web/index.html`, vanilla JS ES modules, no build step). It replaces having several terminals
open; `npm run cli -- run` is still available and posts the identical payload.

Health check (server running): `curl http://localhost:23000/api/v1/health`
→ `{"status":"healthy",...}`. (`curl.exe` ships with Windows 10+; or use
`Invoke-WebRequest`.)

CLI examples: `npx ensemble status`, `npx ensemble steer <team-id> "focus on the auth module"`,
`npx ensemble run "task" --agents <program>[:<model>],<program>[:<model>],...` (without
`--agents`: the first two installed programs of `GET /api/ensemble/programs`).

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `ENSEMBLE_PORT` | `23000` | Server port |
| `ENSEMBLE_HOST` | `127.0.0.1` | Bind address. Loopback by design — the API has no auth. A non-loopback value is also accepted in the `Host` header; a wildcard bind (`0.0.0.0`) is only reachable through the loopback names. |
| `ENSEMBLE_URL` | `http://localhost:<ENSEMBLE_PORT>` | CLI target, and where agents' `team-say` posts. The server exports it to the agent terminals it spawns, so set it only for a CLI on another host. |
| `ENSEMBLE_DATA_DIR` | `~/.ensemble` | Data dir: `ensemble/teams.json` and `ensemble/messages/<team-id>/feed.jsonl` (the transcript) |
| `ENSEMBLE_AGENTS_CONFIG` | `./agents.json` | Alternative path to the agent program config. Validated at server start: a bad file makes the server exit with a message naming the program and key. |
| `ENSEMBLE_CREATED_BY` | — | Cosmetic label stamped on created teams |
| `ENSEMBLE_CORS_ORIGIN` | localhost only | Allowed CORS origins |
| `ENSEMBLE_SHELL` | `pwsh.exe` (else `powershell.exe`) | Override the shell PTY binary. Never use `cmd.exe`. |
| `ENSEMBLE_RUNTIME_DIR` | `%TEMP%\ensemble` | Per-team collab artifacts: `summary.txt`, `.finished`, `prompts/` (a debugging record of what each agent was told) (and a legacy `messages.jsonl` from before the store moved in-memory, merged into the feed on load) |
| `ENSEMBLE_WATCHDOG_NUDGE_MS` | 90s | Idle time before the watchdog nudges an agent |
| `ENSEMBLE_WATCHDOG_STALL_MS` | 180s | Time after a nudge before an agent is marked stalled |
| `ENSEMBLE_AGENT_FLAGS` | — | Extra flags appended to spawned agent CLIs. Outranks the adapter's default flags and a chosen model (`--model` here wins over the picker). |
| `ENSEMBLE_READY_TIMEOUT_MS` | `150000` | How long to wait for a spawned agent CLI to reach its input prompt. 60s is too short for a Claude Code with a heavy MCP/hook stack. |
| `ENSEMBLE_IDLE_DISBAND_MS` | `3600000` (1h) | Silence before a team auto-disbands. Only the explicit `<<COLLAB_DONE>>` sentinel ends a run sooner — wording like "done" no longer does. |
| `ENSEMBLE_CODEX_TRUST_HOOKS` | unset | (the `trustEnv` of codex's hooks gate in `agents.json`, read when the gate is answered). `1` answers Codex's "Hooks need review" gate with *Trust all*. Default answers *Continue without trusting* — ensemble must not authorize unreviewed hook code unattended. |

Copy `.env.example` to `.env` before running. The server and CLI load it at start
(`src/load-env.ts`, Node 20.12+); a variable already set in the shell wins.

---

## Conventions & rules (always follow)

- **Target native Windows only.** PowerShell (`pwsh` preferred) + Windows Terminal.
  Do not add bash, git-bash, WSL, or `osascript` dependencies. Where existing code needs
  them, **delete that path** — don't gate it behind a platform check.
- **No program names in code.** Anything that differs per agent CLI (flags, ready markers,
  startup gates, usage scraping, models, colours, env to strip) is an `agents.json` entry.
  An unknown program is a 400, never a fallback to another CLI.
- **`AgentRuntime` is the only door to a terminal**, and `src/core/` stays runtime-agnostic.
  New session behaviour goes into `PtyRuntime`, never into business logic. Text reaches an
  agent only through `src/core/delivery.ts`.
- **Never call tmux/bash/osascript** from anywhere — all session operations go through
  `getRuntime()` / the `AgentRuntime` interface.
- **Stability first.** Every spawned process must be tracked and killable. Kill the full
  **process tree** on teardown (agent CLIs spawn children → orphans otherwise) and add
  `exit`/`SIGINT`/`SIGTERM` cleanup handlers. Bound all in-memory buffers.
- **Path/encoding hygiene:** use `path.join`, `os.homedir()`, `os.tmpdir()`; force UTF-8
  in PTYs (`chcp 65001`); no inline `VAR=val` in npm scripts (use `cross-env`).
- **TypeScript:** `async/await`, no new `any`, keep `tsc --noEmit` green.
- **Commit discipline:** small, single-purpose commits. Run `npm run typecheck`,
  `npm run lint` and `npm test` before committing.
- **Ask before destructive or remote actions** (push, force-reset, deletes). See
  `.claude/settings.json`.

## Known gotchas — each one cost a live run to find

- **Orphaned processes are the #1 Windows stability risk.** `pty.kill()` alone leaves the
  agent's children running and holding port 23000. Kill the tree (`taskkill /T /F`) and
  keep the `exit`/`SIGINT`/`SIGTERM` handlers.
- **PTY sessions live in a module-level Map inside the server process.** Any other process
  that calls `setRuntime(new PtyRuntime())` gets a second, permanently empty registry whose
  `exists`/`screen` quietly answer "no such session". Anything outside the
  server must be an HTTP client. Terminal output is only reachable over HTTP: the text
  snapshot `GET /api/ensemble/sessions/:name/pane`, or the raw stream `…/stream`.
- **State lives in the server's memory; files are a log.** Nothing in the server reads
  `teams.json` or a feed file to learn state — it loads them once and keeps going. A second
  process writing those files is invisible to the server. Everything goes through the HTTP
  API. `team-say` is a POST (`from`, `to`, `content`); it prints `Sent to <recipient>` and
  exits non-zero if the server is unreachable or answers non-2xx, so an agent sees a lost
  message. It returns as soon as the message is in the feed; pasting it into the recipient's
  terminal continues in the background through a per-session queue (bounded at 50 waiting
  deliveries; a failed delivery is an `ensemble` message in the feed).
- **`POST /api/ensemble/teams` answers 202** with the team record straight away; spawning,
  the readiness wait and prompt injection run in the background. Progress is the team
  `status` and `ensemble` messages in the feed. A client that needs the agents ready must
  watch those, not the response. Invalid bodies are a 400.
- **On boot every `active`/`forming` team is marked `disbanded`** (`disbandLiveTeamsOnBoot`,
  called from `src/server/index.ts` only): PTY sessions die with the server, so such a team has no agents.
- **A paste alone never submits.** `PtyRuntime.paste` writes the text, then a lone CR as a separate write;
  agent CLIs treat that CR as part of the paste burst and park it in the composer
  (`[Pasted Content 1929 chars]`). Only a *standalone* Enter submits. Every delivery path —
  startup prompts, teammate messages, watchdog nudges, staged-workflow prompts — goes through
  `deliver()` in `src/core/delivery.ts`, which pastes (or types, for `inputMethod: sendKeys`),
  then runs `ensureSubmitted()` with the adapter's `pasteMarker`, one delivery at a time per
  session. Never write to a terminal from anywhere else; a path that skips it produces a
  silent agent (the staged workflow did, once).
- **A readiness marker can also be a modal's selection cursor.** Codex's `›` was its own
  hooks-gate cursor; claude's `❯` is the folder-trust dialog's cursor. Auto-confirm gates
  (the `gates` of each adapter, run by `src/core/readiness.ts`) are therefore always evaluated
  **before** the marker check. Never reverse that order. A gate is debounced to once per
  3 s and abandoned after 5 answers. The readiness wait re-checks 250 ms after PTY output and
  at least once a second; the timer is what drives the quiescence clock and the timeout.
- **Agent CLIs resolve through npm shims** — `powershell → node.exe → codex.exe`. Checking
  only a PTY's direct children will tell you a live agent is dead. Walk the full ancestry.
- **Do not infer completion from prose.** "done"/"completed" appear constantly in normal
  chatter; a heuristic on them killed a healthy run mid-conversation. A run ends on the
  `<<COLLAB_DONE>>` sentinel, a manual disband, or `ENSEMBLE_IDLE_DISBAND_MS`. The sentinel
  is checked on the bus `message` event: the run ends the moment the last agent still active
  has sent it (every one of them, whatever the team size).
- **The HTTP API can type into terminals and has no login.** That is why the Host check
  exists (a DNS-rebinding page reaches 127.0.0.1 under its own hostname) and why input and
  resize only reach agent terminals of live teams. Do not loosen either, and do not bind
  beyond loopback without knowing who can reach the port.
- **Model ids are an allowlist per program** (`models` in `agents.json`). A model not listed
  is a 400 before anything is spawned: a bad id makes the CLI exit at once and the readiness
  wait burns its whole window. Do not add ids that no live run has confirmed.
- node-pty is a native module — `npm install` fails without a C++ toolchain.
- `setRawMode` throws when stdin isn't a TTY — check `process.stdin.isTTY` first.
- `pty.spawn` needs a real Windows path: a `cwd` with forward slashes fails with
  `error code: 267`.

---

## Adding a CLI

A JSON entry in `agents.json`, no code. Required: `command`, `readyMarkers` (non-blank
strings that appear when it is at its input prompt), `inputMethod` (`sendKeys` or
`pasteFromFile`), `color` (`#rrggbb`) and `icon`. Optional:

| Key | Meaning |
|---|---|
| `flags` | default flags (auto-accept flags belong here) |
| `cwdFlag`, `cwdFlagAliases` | flag that takes the working directory, added when the command line lacks it |
| `addDirFlag` | flag that takes the ensemble repo root, so the agent can run the `team-say` CLI |
| `pasteMarker` | regex source of the composer text of an unsubmitted paste (default `\[Pasted (?:text\|Content)`) |
| `gates` | startup screens to answer: `{ name, pattern, keys, literal?, enter?, trustKeys?, trustEnv? }`; keys are named keys or literal text |
| `usagePatterns` | `{ pattern, format }`; one capture group, `$1` in `format` |
| `modelFlag`, `models` | the model allowlist `[{ id, label }]`; needs `modelFlag` |
| `stripEnv` | regex sources of environment variables withheld from agent shells (the union over all programs applies to every shell) |

Check it with `npm test` (the loader validates every entry), then run it live: unit tests
stop at argv construction and screen fixtures. `tests/adapters.test.ts` shows a fake CLI
that exists only as a config entry.

---

## Permissions

These instructions are **context, not enforcement** — the actual allow/deny rules live in
`.claude/settings.json` (provided alongside this file). That config is intentionally
permissive: all `npm`/`tsx`/`node`/`git` read & local ops, PowerShell file/process tools,
file read/write/edit across the repo, and localhost health-check requests run without
prompting. It still **denies** pushing to the remote and reading secrets, and **asks**
before deletes / hard reset. Rules evaluate deny → ask → allow. Adjust to taste; if you
don't want the rules committed to git, rename it `.claude/settings.local.json`.
