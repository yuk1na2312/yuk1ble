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
- **Server:** HTTP API on port **23000** (`server.ts`), which also serves the GUI at `/`.
- **Adapters:** everything specific to one agent CLI is data in `agents.json`, validated at
  load (`lib/agent-config.ts`). No `.ts` file under `lib/`, `services/`, `cli/` or
  `server.ts` names a program outside comments. See *Adding a CLI* below.
- **Runtime layer:** agent sessions live behind the `AgentRuntime` interface in
  `lib/agent-runtime.ts`. `PtyRuntime` (node-pty + ConPTY) is the only implementation and
  is installed unconditionally with `setRuntime(new PtyRuntime())`.
- **State:** the server process owns all team and message state **in memory**
  (`lib/ensemble-registry.ts`). `teams.json` (temp file + rename, debounced 100 ms, flushed
  on exit) and one `feed.jsonl` per team are only a persistence log: they are read once and
  never polled. Messages carry a per-team `seq`; `lib/bus.ts` announces `team`, `message`
  and `log` events. The CLI is a pure HTTP client — there is no second process per team.

## Current state

The port is functionally complete: teams spawn, agents exchange messages, the GUI renders
live PTY panes, teardown kills the full process tree. `npm run typecheck`, `npm run lint`
and `npm test` (233 tests / 20 files) are green. What remains is repeated real-world use.

---

## Project layout

```
server.ts                 HTTP API entrypoint (port 23000) + serves the GUI at /
public/index.html         monitoring GUI (teams, transcript, live panes, server log)
cli/
  ensemble.ts             CLI entrypoint (status, run, steer, team-say, team-read) — pure HTTP client
lib/
  agent-runtime.ts        AgentRuntime interface + getRuntime/setRuntime + sync helpers
  pty-runtime.ts          the only runtime: node-pty sessions, scrollback, tree-kill
  pane-readiness.ts       marker match / shell-prompt guard / quiescent-screen fallback (pure predicates)
  paste-submit.ts         ensureSubmitted() — a paste alone never submits; Enter does
  agent-spawner.ts        spawnLocalAgent / killLocalAgent (PowerShell command line)
  agent-watchdog.ts       liveness (nudge → stall via sessionExists)
  agent-config.ts         agents.json loader + validation, resolveAgentProgram (aliases, no fallback),
                          resolveReadyMarkers, isValidModel, buildAgentCommandParts(program, model?)
  readiness.ts            waitForReady(): abort / exit / gates / ready markers / quiescence, deps injected
  programs.ts             describePrograms() behind GET /api/ensemble/programs (PATH lookup, cached 30 s)
  ensemble-registry.ts    in-memory store: teams, per-team feed (seq, 5,000-message cap) + persistence log
  bus.ts                  typed event bus: `team`, `message`, `log`
  log-buffer.ts           tees console.* into a ring buffer for GET /api/ensemble/logs
  win-process.ts          killProcessTree / killProcessTreeSync / PowerShell quoting / findOnPath
  collab-paths.ts, ensemble-paths.ts, staged-workflow.ts, worktree-manager.ts
services/
  ensemble-service.ts     main business logic — runtime-agnostic; keep it that way
types/                    ensemble.ts (teams/messages) + agent-program.ts (agents.json)
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

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install deps. **Needs VS C++ Build Tools** — node-pty compiles native code. |
| `npm run dev` | Start the server (`tsx server.ts`) on port 23000. Keep running. |
| `npm start` | Production server. Requires `cross-env` (inline `NODE_ENV=` fails on Windows). |
| `npm run typecheck` | `tsc --noEmit` — must pass before any commit. |
| `npm run build` | Same as typecheck (no emit). |
| `npm run lint` | `eslint . --ext .ts`. |
| `npm run cli -- <args>` | Run the CLI (e.g. `npm run cli -- status`). |

**Monitoring GUI:** with the server running, open <http://localhost:23000/> — create a
team, plus teams list, transcript, live agent PTY panes, and the server log on one page
(`public/index.html`, vanilla JS, no build step). It replaces having several terminals
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
| `ENSEMBLE_HOST` | `127.0.0.1` | Bind address. Loopback by design — the API has no auth. |
| `ENSEMBLE_URL` | `http://localhost:<ENSEMBLE_PORT>` | CLI target, and where agents' `team-say` posts. The server exports it to the agent terminals it spawns, so set it only for a CLI on another host. |
| `ENSEMBLE_DATA_DIR` | `~/.ensemble` | Data dir: `ensemble/teams.json` and `ensemble/messages/<team-id>/feed.jsonl` (the transcript) |
| `ENSEMBLE_AGENTS_CONFIG` | `./agents.json` | Alternative path to the agent program config. Validated at server start: a bad file makes the server exit with a message naming the program and key. |
| `ENSEMBLE_CREATED_BY` | — | Cosmetic label stamped on created teams |
| `ENSEMBLE_CORS_ORIGIN` | localhost only | Allowed CORS origins |
| `ENSEMBLE_SHELL` | `pwsh.exe` (else `powershell.exe`) | Override the shell PTY binary. Never use `cmd.exe`. |
| `ENSEMBLE_RUNTIME_DIR` | `%TEMP%\ensemble` | Per-team collab artifacts: `summary.txt`, `.finished`, `prompts/`, `delivery/` (and a legacy `messages.jsonl` from before the store moved in-memory, merged into the feed on load) |
| `ENSEMBLE_WATCHDOG_NUDGE_MS` | 90s | Idle time before the watchdog nudges an agent |
| `ENSEMBLE_WATCHDOG_STALL_MS` | 180s | Time after a nudge before an agent is marked stalled |
| `ENSEMBLE_AGENT_FLAGS` | — | Extra flags appended to spawned agent CLIs. Outranks the adapter's default flags and a chosen model (`--model` here wins over the picker). |
| `ENSEMBLE_READY_TIMEOUT_MS` | `150000` | How long to wait for a spawned agent CLI to reach its input prompt. 60s is too short for a Claude Code with a heavy MCP/hook stack. |
| `ENSEMBLE_IDLE_DISBAND_MS` | `3600000` (1h) | Silence before a team auto-disbands. Only the explicit `<<COLLAB_DONE>>` sentinel ends a run sooner — wording like "done" no longer does. |
| `ENSEMBLE_CODEX_TRUST_HOOKS` | unset | (the `trustEnv` of codex's hooks gate in `agents.json`, read when the gate is answered). `1` answers Codex's "Hooks need review" gate with *Trust all*. Default answers *Continue without trusting* — ensemble must not authorize unreviewed hook code unattended. |

Copy `.env.example` to `.env` before running.

---

## Conventions & rules (always follow)

- **Target native Windows only.** PowerShell (`pwsh` preferred) + Windows Terminal.
  Do not add bash, git-bash, WSL, or `osascript` dependencies. Where existing code needs
  them, **delete that path** — don't gate it behind a platform check.
- **No program names in code.** Anything that differs per agent CLI (flags, ready markers,
  startup gates, usage scraping, models, colours, env to strip) is an `agents.json` entry.
  An unknown program is a 400, never a fallback to another CLI.
- **Keep the `AgentRuntime` interface shape unchanged** so `services/` and other callers
  keep working untouched. Only the implementation behind it changes. New session behavior
  goes into `PtyRuntime`, never into business logic.
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
  `sessionExists`/`capturePane` quietly answer "no such session". Anything outside the
  server must be an HTTP client. Terminal output is only reachable over HTTP, via
  `GET /api/ensemble/sessions/:name/pane`.
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
  called from `server.ts` only): PTY sessions die with the server, so such a team has no agents.
- **A paste alone never submits.** `pasteFromFile` writes the text and `\r` back to back;
  agent CLIs treat that CR as part of the paste burst and park it in the composer
  (`[Pasted Content 1929 chars]`). Only a *standalone* Enter submits. Every delivery path —
  prompt injection, teammate messages, watchdog nudges — must go through
  `ensureSubmitted()`, passing the adapter's `pasteMarker`. Missing it on one path produces
  a silent agent.
- **A readiness marker can also be a modal's selection cursor.** Codex's `›` was its own
  hooks-gate cursor; claude's `❯` is the folder-trust dialog's cursor. Auto-confirm gates
  (the `gates` of each adapter, run by `lib/readiness.ts`) are therefore always evaluated
  **before** the marker check. Never reverse that order. A gate is debounced to once per
  3 s and abandoned after 5 answers.
- **Agent CLIs resolve through npm shims** — `powershell → node.exe → codex.exe`. Checking
  only a PTY's direct children will tell you a live agent is dead. Walk the full ancestry.
- **Do not infer completion from prose.** "done"/"completed" appear constantly in normal
  chatter; a heuristic on them killed a healthy run mid-conversation. A run ends on the
  `<<COLLAB_DONE>>` sentinel, a manual disband, or `ENSEMBLE_IDLE_DISBAND_MS`. The sentinel
  is checked on the bus `message` event: the run ends the moment the last agent still active
  has sent it (every one of them, whatever the team size).
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
