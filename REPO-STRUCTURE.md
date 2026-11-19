# Repo structure — what this Windows fork keeps, and what it dropped

Upstream [michelhelsdingen/ensemble](https://github.com/michelhelsdingen/ensemble) is
macOS/Linux/WSL2-only: its agent runtime is tmux, its orchestration is bash, and its
window control is AppleScript. This fork targets **native Windows only**, so those paths
were **deleted rather than gated** — a platform check would leave dead code that lies
about what is supported.

This file records the cut, so nobody has to re-derive it.

---

## The tree

```
ensemble-win/
├─ agents.json                  one adapter per agent CLI: flags, gates, markers, models, colour…
├─ collab-templates.json        collaboration presets
├─ package.json  tsconfig.json  .eslintrc.json  .gitignore  .env.example
│
├─ src/
│  ├─ repo-root.ts              REPO_ROOT: the one place a path is computed from a file's location
│  ├─ load-env.ts               loads <repo>/.env; imported first by the server and the CLI
│  ├─ types.ts                  teams and messages
│  ├─ server/                   the HTTP process
│  │  ├─ index.ts               boot file: config, runtime, listen on 23000
│  │  ├─ routes.ts              every HTTP route and the GUI at /, behind the guard
│  │  ├─ guard.ts               Host + Origin checks, body cap, CORS headers, JSON helpers
│  │  ├─ sse.ts                 SSE: team/team-removed/message/log events, per-session terminal stream
│  │  ├─ static.ts              serves web/ and the fixed /vendor xterm files
│  │  └─ log-buffer.ts          tees console.* into a ring buffer for the GUI log pane
│  ├─ core/                     business logic, runtime-agnostic on purpose
│  │  ├─ team-lifecycle.ts      team validation, start, disband, archive and purge
│  │  ├─ store.ts               in-memory team + message store; files are a persistence log
│  │  ├─ bus.ts                 typed event bus: team, team-removed, message, log
│  │  ├─ messaging.ts           sendTeamMessage: feed first, terminal delivery in the background
│  │  ├─ delivery.ts            deliver(): queue, paste, submit — the one way text reaches an agent
│  │  ├─ paste-submit.ts        ensureSubmitted() — a paste alone never submits
│  │  ├─ readiness.ts           waitForReady(): the readiness wait, dependencies injected
│  │  ├─ pane-readiness.ts      marker match · shell-prompt guard · quiescent-screen fallback
│  │  ├─ agent-spawner.ts       spawnLocalAgent / killLocalAgent, PowerShell command line
│  │  ├─ watchdog.ts            liveness: nudge → stall via exists
│  │  ├─ team-supervisor.ts     done sentinel, idle auto-disband, watchdog
│  │  ├─ prompts.ts             collab templates, startup prompt, the done sentinel
│  │  ├─ staged-workflow.ts     staged prompt delivery
│  │  ├─ summary.ts             summary.txt on disband
│  │  ├─ worktrees.ts           per-agent git worktree isolation
│  │  ├─ session-name.ts        the runtime session name of an agent
│  │  ├─ collab-paths.ts        %TEMP%\ensemble\<team-id>\… layout
│  │  └─ data-paths.ts          ~/.ensemble data layout
│  ├─ runtime/                  the only door to a terminal
│  │  ├─ agent-runtime.ts       AgentRuntime interface, getRuntime/setRuntime
│  │  ├─ pty-runtime.ts         the only runtime: node-pty sessions, scrollback, listeners, tree-kill
│  │  └─ win-process.ts         tree-kill, PowerShell quoting and PATH lookup, one copy
│  ├─ adapters/                 everything per agent CLI
│  │  ├─ agent-config.ts        agents.json loader + validation, program/model resolution
│  │  ├─ programs.ts            program catalog for GET /api/ensemble/programs
│  │  ├─ accounts.ts            read-only account probe for GET /api/ensemble/accounts
│  │  └─ types.ts               the agents.json schema types
│  └─ cli/ensemble.ts           CLI (pure HTTP client): status, run, steer, disband, team-say, team-read
├─ web/                         monitoring GUI: index.html, app.css, ES modules in js/ (teams, transcript, live PTY panes, server log)
├─ bin/                         ensemble.cjs (CLI shim) · postinstall.cjs (node-pty check)
├─ tests/                       456 tests / 33 files (+ helpers/, fixtures/)
├─ skill/SKILL.md               the /collab skill that drives ensemble from Claude Code
│
├─ AGENTS.md                    canonical project context (Codex reads this name)
├─ CLAUDE.md                    one line: @AGENTS.md (Claude Code reads this name)
├─ .claude/settings.json        permission rules: deny push/secrets, ask before deletes
└─ README.md  REPO-STRUCTURE.md  LICENSE
```

All TypeScript lives under `src/`, one folder per layer: `server` (HTTP), `core` (logic),
`runtime` (the terminal), `adapters` (per-CLI data), `cli`. Anything that locates a file by
its own position (the default `agents.json`, `web/`, the `bin/ensemble.cjs` path agents are
told to run) goes through `REPO_ROOT` in `src/repo-root.ts`, never a `..` chain.

## Verified after the copy

The copied tree is self-sufficient — checked in this folder, not inherited from the old one:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx eslint . --ext .ts` | clean |
| `npx vitest run` | 456 passed / 33 files |
| `npx tsx src/server/index.ts` (on 23100) | `{"status":"healthy"}`, GUI served at `/` |

---

## What was dropped, and why

| Dropped | Why |
|---|---|
| `demo/` (9.9 MB) | Recorded gifs/mp4 of the macOS build plus two `.sh` recorder scripts and a `.tape` file. Nothing imports it. |
| `docs/*.md` (9 files) | 100 references to tmux / iTerm / bash between them. `collab-scripts.md` documents the 16 shell scripts this port already deleted; `iterm-split-fix.md` is pure macOS. Keeping them would mean shipping instructions that cannot work. |
| `docs/_config.yml`, `docs/index.md`, `.github/workflows/pages.yml` | Upstream's GitHub Pages site. |
| `docs/replay-security-audit.html` | Artifact of the Python replay tooling, which is also gone. |
| `TESTING-ITERM.md` | macOS terminal testing. |
| `scripts/generate-replay.py`, `scripts/parse-messages.py` | Referenced by **no code at all** — standalone transcript tooling, and the only reason Python appeared in the prerequisites. |
| `ARCHITECTURE-PLUGIN-MIGRATION.md`, `CHANGELOG-2026-03-19.md`, `COLLAB-IMPROVEMENT-QUEUE.md`, `COLLAB-RETROSPECTIVE.md`, `TODO.md` | Upstream's history and release checklist. Git history is this fork's history. |
| `CONTRIBUTING.md` | Upstream's contribution flow; this is a personal fork. |
| `.npmignore` | Only matters when publishing to npm. `package.json` is now `private`. |
| `.github/workflows/ci.yml` | Windows CI existed, but this fork is personal-use and not on GitHub Actions. Re-add it later if that changes — the commands are just `npm ci`, `tsc --noEmit`, `npm run lint`, `npm test`. |
| `agents/` (AGENTS.md, WINDOWS-PORT.md, settings.json) | A duplicate of root files — see below. |

### The duplicate that had already rotted

The old repo carried `agents/` alongside the root context files. `agents/settings.json` and
`agents/WINDOWS-PORT.md` were byte-identical to their root copies, but `agents/AGENTS.md`
had **drifted** from `CLAUDE.md`: it was missing the monitoring-GUI section and eight
environment variables, and still described watchdog behaviour that had been changed.

Two copies of the same context is a guarantee that one of them lies. This repo keeps
**one** file, `AGENTS.md`, and `CLAUDE.md` is a single `@AGENTS.md` import — Codex reads
one name, Claude Code reads the other, both get the same text.

---

## Files that changed during the copy

| File | Change |
|---|---|
| `package.json` | Renamed `@ensemble-ai/cli` → `ensemble-win`; added `private: true` and `"os": ["win32"]`; dropped upstream `repository`/`homepage`/`bugs`/`author` and the npm `files` allowlist. Scripts and dependencies are untouched. |
| `bin/ensemble.cjs` | It finds the package root by matching `pkg.name`. That string had to follow the rename, or the CLI silently falls back to a guessed root. |
| `bin/postinstall.cjs` | The node-pty failure message pointed at upstream's README anchor; now points at this repo's. |
| `README.md` | Upstream Pages links replaced with local documents; the Python prerequisite removed; the "intelligent completion detection" feature line corrected to the sentinel/idle rule that actually ships; a Credits section added. |
| `AGENTS.md` | Rewritten from "port in progress" to describe the finished state, with the layout, the current commands, the full env table, and a *Known gotchas* section listing what each live run cost to discover. |
| `.gitignore` | Slimmed to what this repo produces; added `.playwright-mcp/` and stray `*.png` (browser-automation scratch that kept landing in the tree). |
| `.env.example` | Rewritten from the current env table. It documents the Windows-era variables the old one predated. |

## Two constraints worth not rediscovering

**Anything outside the server must be a pure HTTP client.** PTY sessions live in a
module-level `Map` *inside the server process*. Any other process that calls
`setRuntime(new PtyRuntime())` gets a second, permanently empty registry whose
`exists`/`screen` quietly answer "no such session". Terminal output is reachable
only over HTTP: `GET /api/ensemble/sessions/:name/pane` (a text snapshot) or the raw SSE
stream `…/stream`. The same goes for state: team
and message data live in the server's memory and the files are only its log, so `team-say`
is a POST, not a file append, and there is no per-team bridge process.

**`src/core/` stays runtime-agnostic** (`team-lifecycle.ts` above all). Session behaviour belongs in
`PtyRuntime` behind the `AgentRuntime` interface, and text reaches a terminal only through
`src/core/delivery.ts`. That seam is the only reason this port was a rewrite of one file rather
than of the whole codebase.

---

## Setting up the repo

```powershell
cd E:\projects\ensemble-win\yuk1naaa
npm install                 # needs VS Build Tools "Desktop development with C++"
npm run typecheck; npm run lint; npm test

git init
git add .
git commit -m "feat: native Windows fork of ensemble (node-pty runtime, no tmux/bash)"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

`node_modules/` is git-ignored; a fresh clone runs `npm install`, and `postinstall` fails
loudly with the prerequisite list if the native `node-pty` binding cannot load.
