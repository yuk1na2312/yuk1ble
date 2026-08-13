# AGENTS.md

Persistent project context for AI coding agents (Claude Code, Codex, …). Read this at the
start of every session. `CLAUDE.md` imports this file — there is deliberately only one
copy. Port history and the acceptance criteria live in `docs/windows-port/`.

---

## What this project is

**ensemble** — a multi-agent collaboration engine. It spawns AI agent CLIs (`claude`,
`codex`, `aider`, `gemini`) into terminal sessions, lets them message each other over a
structured bus, and shows the collaboration live in a browser GUI and a TUI monitor.
An HTTP API + CLI drive everything.

This repo is a **native-Windows-only fork** of [michelhelsdingen/ensemble](https://github.com/michelhelsdingen/ensemble),
which is macOS/Linux/WSL2-only because its runtime is tmux-backed. Everything Unix-specific
has been removed rather than gated.

- **Stack:** TypeScript (run via `tsx`, no build step), Node.js 18+. No Python, no bash.
- **Server:** HTTP API on port **23000** (`server.ts`), which also serves the GUI at `/`.
- **Runtime layer:** agent sessions live behind the `AgentRuntime` interface in
  `lib/agent-runtime.ts`. `PtyRuntime` (node-pty + ConPTY) is the only implementation and
  is installed unconditionally with `setRuntime(new PtyRuntime())`.

## Current state

The port is functionally complete: teams spawn, agents exchange messages, the GUI renders
live PTY panes, teardown kills the full process tree. `npm run typecheck`, `npm run lint`
and `npm test` (96 tests / 9 files) are green. What remains is repeated real-world use —
see `TESTING.md` for the run-through and `docs/windows-port/status.md` for what each past
live run exposed.

---

## Project layout

```
server.ts                 HTTP API entrypoint (port 23000) + serves the GUI at /
public/index.html         monitoring GUI (teams, transcript, live panes, server log)
cli/
  ensemble.ts             CLI entrypoint (status, run, steer, team-say, team-read)
  monitor.ts              live TUI monitor — a pure HTTP client, never a runtime owner
lib/
  agent-runtime.ts        AgentRuntime interface + getRuntime/setRuntime + sync helpers
  pty-runtime.ts          the only runtime: node-pty sessions, scrollback, tree-kill
  pane-readiness.ts       marker match / shell-prompt guard / quiescent-screen fallback
  paste-submit.ts         ensureSubmitted() — a paste alone never submits; Enter does
  agent-spawner.ts        spawnLocalAgent / killLocalAgent (PowerShell command line)
  agent-watchdog.ts       liveness (nudge → stall via sessionExists)
  agent-config.ts         agents.json loader, resolveAgentProgram/resolveReadyMarkers
  ensemble-registry.ts    team/agent state + message feed persistence
  log-buffer.ts           tees console.* into a ring buffer for GET /api/ensemble/logs
  *-paths.ts, hosts-config.ts, staged-workflow.ts, worktree-manager.ts
services/
  ensemble-service.ts     main business logic — runtime-agnostic; keep it that way
types/                    ensemble.ts (teams/messages) + agent-program.ts (agents.json)
agents.json               per-agent command/flags/readyMarker(s)/inputMethod/icon
collab-templates.json     collaboration presets
skill/SKILL.md            the /collab skill that drives ensemble from Claude Code
tests/                    vitest; live-captured terminal screens used as fixtures
docs/windows-port/        spec.md (original port spec), plan.md, status.md (history)
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
| `npm run monitor` | Live TUI monitor (`tsx cli/monitor.ts --latest`). **Use Windows Terminal.** |
| `npm run cli -- <args>` | Run the CLI (e.g. `npm run cli -- status`). |

**Monitoring GUI:** with the server running, open <http://localhost:23000/> — create a
team, plus teams list, transcript, live agent PTY panes, and the server log on one page
(`public/index.html`, vanilla JS, no build step). It replaces having several terminals
open; `npm run cli -- run` is still available and posts the identical payload.

Health check (server running): `curl http://localhost:23000/api/v1/health`
→ `{"status":"healthy",...}`. (`curl.exe` ships with Windows 10+; or use
`Invoke-WebRequest`.)

CLI examples: `npx ensemble status`, `npx ensemble monitor --latest`,
`npx ensemble steer <team-id> "focus on the auth module"`.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `ENSEMBLE_PORT` | `23000` | Server port |
| `ENSEMBLE_HOST` | `127.0.0.1` | Bind address. Loopback by design — the API has no auth. |
| `ENSEMBLE_URL` | `http://localhost:23000` | CLI target |
| `ENSEMBLE_DATA_DIR` | `~/.ensemble` | Data dir |
| `ENSEMBLE_AGENTS_CONFIG` | `./agents.json` | Alternative path to the agent program config |
| `ENSEMBLE_CREATED_BY` / `ENSEMBLE_PROJECT` | — | Cosmetic labels stamped on created teams |
| `ENSEMBLE_CORS_ORIGIN` | localhost only | Allowed CORS origins |
| `ENSEMBLE_SHELL` | `pwsh.exe` (else `powershell.exe`) | Override the shell PTY binary. Never use `cmd.exe`. |
| `ENSEMBLE_RUNTIME_DIR` | `%TEMP%\ensemble` | Per-team collab artifacts (`messages.jsonl`, `bridge.pid`, `prompts/`, `delivery/`) |
| `ENSEMBLE_BRIDGE_STOP_GRACE_MS` | `1500` | Grace window before the collab bridge is tree-killed on disband |
| `ENSEMBLE_WATCHDOG_NUDGE_MS` | 90s | Idle time before the watchdog nudges an agent |
| `ENSEMBLE_WATCHDOG_STALL_MS` | 180s | Time after a nudge before an agent is marked stalled |
| `ENSEMBLE_AGENT_FLAGS` | — | Extra flags appended to spawned agent CLIs |
| `ENSEMBLE_READY_TIMEOUT_MS` | `150000` | How long to wait for a spawned agent CLI to reach its input prompt. 60s is too short for a Claude Code with a heavy MCP/hook stack. |
| `ENSEMBLE_IDLE_DISBAND_MS` | `3600000` (1h) | Silence before a team auto-disbands. Only the explicit `<<COLLAB_DONE>>` sentinel ends a run sooner — wording like "done" no longer does. |
| `ENSEMBLE_CODEX_TRUST_HOOKS` | unset | `1` answers Codex's "Hooks need review" gate with *Trust all*. Default answers *Continue without trusting* — ensemble must not authorize unreviewed hook code unattended. |

Copy `.env.example` to `.env` before running.

---

## Conventions & rules (always follow)

- **Target native Windows only.** PowerShell (`pwsh` preferred) + Windows Terminal.
  Do not add bash, git-bash, WSL, or `osascript` dependencies. Where existing code needs
  them, **delete that path** — don't gate it behind a platform check.
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
  `sessionExists`/`capturePane` quietly answer "no such session". That is why
  `cli/monitor.ts` is a pure HTTP client. Terminal output is only reachable over HTTP,
  via `GET /api/ensemble/sessions/:name/pane`.
- **A paste alone never submits.** `pasteFromFile` writes the text and `\r` back to back;
  agent CLIs treat that CR as part of the paste burst and park it in the composer
  (`[Pasted Content 1929 chars]`). Only a *standalone* Enter submits. Every delivery path —
  prompt injection, teammate messages, watchdog nudges — must go through
  `ensureSubmitted()`. Missing it on one path produces a silent agent.
- **A readiness marker can also be a modal's selection cursor.** Codex's `›` was its own
  hooks-gate cursor; claude's `❯` is the folder-trust dialog's cursor. Auto-confirm gates
  are therefore always evaluated **before** the marker check. Never reverse that order.
- **Agent CLIs resolve through npm shims** — `powershell → node.exe → codex.exe`. Checking
  only a PTY's direct children will tell you a live agent is dead. Walk the full ancestry.
- **Do not infer completion from prose.** "done"/"completed" appear constantly in normal
  chatter; a heuristic on them killed a healthy run mid-conversation. A run ends on the
  `<<COLLAB_DONE>>` sentinel, a manual disband, or `ENSEMBLE_IDLE_DISBAND_MS`.
- node-pty is a native module — `npm install` fails without a C++ toolchain.
- `setRawMode` throws when stdin isn't a TTY — check `process.stdin.isTTY` first.
- `pty.spawn` needs a real Windows path: a `cwd` with forward slashes fails with
  `error code: 267`.

---

## Permissions

These instructions are **context, not enforcement** — the actual allow/deny rules live in
`.claude/settings.json` (provided alongside this file). That config is intentionally
permissive: all `npm`/`tsx`/`node`/`git` read & local ops, PowerShell file/process tools,
file read/write/edit across the repo, and localhost health-check requests run without
prompting. It still **denies** pushing to the remote and reading secrets, and **asks**
before deletes / hard reset. Rules evaluate deny → ask → allow. Adjust to taste; if you
don't want the rules committed to git, rename it `.claude/settings.local.json`.
