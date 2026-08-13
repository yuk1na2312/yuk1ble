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
├─ server.ts                    HTTP API on 23000; also serves the GUI at /
├─ agents.json                  per-agent command/flags/readyMarker(s)/inputMethod/icon
├─ collab-templates.json        collaboration presets
├─ package.json  tsconfig.json  .eslintrc.json  .gitignore  .env.example
│
├─ cli/
│  ├─ ensemble.ts               CLI: status, run, steer, team-say, team-read, bridge
│  └─ monitor.ts                live TUI monitor — a pure HTTP client (see note below)
│
├─ lib/                         14 modules, all reachable from server.ts
│  ├─ agent-runtime.ts          AgentRuntime interface, getRuntime/setRuntime, sync helpers
│  ├─ pty-runtime.ts            the only runtime: node-pty sessions, scrollback, tree-kill
│  ├─ pane-readiness.ts         marker match · shell-prompt guard · quiescent-screen fallback
│  ├─ paste-submit.ts           ensureSubmitted() — a paste alone never submits
│  ├─ agent-spawner.ts          spawnLocalAgent / killLocalAgent, PowerShell command line
│  ├─ agent-watchdog.ts         liveness: nudge → stall via sessionExists
│  ├─ agent-config.ts           agents.json loader + program/marker resolution
│  ├─ ensemble-registry.ts      team + message persistence
│  ├─ log-buffer.ts             tees console.* into a ring buffer for the GUI log pane
│  ├─ collab-paths.ts           %TEMP%\ensemble\<team-id>\… layout
│  ├─ ensemble-paths.ts         ~/.ensemble data layout
│  ├─ hosts-config.ts           local/remote host identity
│  ├─ staged-workflow.ts        staged prompt delivery
│  └─ worktree-manager.ts       per-agent git worktree isolation
│
├─ services/ensemble-service.ts main business logic — runtime-agnostic on purpose
├─ types/                       ensemble.ts (teams/messages) · agent-program.ts (agents.json)
├─ public/index.html            monitoring GUI: teams, transcript, live PTY panes, server log
├─ bin/                         ensemble.cjs (CLI shim) · postinstall.cjs (node-pty check)
├─ tests/                       9 vitest files, 96 tests
├─ skill/SKILL.md               the /collab skill that drives ensemble from Claude Code
│
├─ AGENTS.md                    canonical project context (Codex reads this name)
├─ CLAUDE.md                    one line: @AGENTS.md (Claude Code reads this name)
├─ .claude/settings.json        permission rules: deny push/secrets, ask before deletes
├─ README.md  TESTING.md  REPO-STRUCTURE.md  LICENSE
└─ docs/windows-port/
   ├─ spec.md                   the original port specification
   ├─ plan.md                   the phased plan
   └─ status.md                 what each live run exposed, and how it was fixed
```

Layout is deliberately **flat** — `server.ts` at the root, no `src/`. Moving it would mean
rewriting ~40 relative imports, `tsconfig`, and `bin/ensemble.cjs`'s path to
`cli/ensemble.ts`, for no runtime benefit.

## Verified after the copy

The copied tree is self-sufficient — checked in this folder, not inherited from the old one:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx eslint . --ext .ts` | clean |
| `npx vitest run` | 96 passed / 9 files |
| `npx tsx server.ts` (on 23100) | `{"status":"healthy"}`, GUI served at `/` |

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
| `ARCHITECTURE-PLUGIN-MIGRATION.md`, `CHANGELOG-2026-03-19.md`, `COLLAB-IMPROVEMENT-QUEUE.md`, `COLLAB-RETROSPECTIVE.md`, `TODO.md` | Upstream's history and release checklist. `docs/windows-port/status.md` is this fork's history. |
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
| `docs/windows-port/*.md` | `WINDOWS-PORT.md`, `-PLAN.md`, `-HANDOFF.md` renamed to `spec.md`, `plan.md`, `status.md` and moved out of the root. |

## Two constraints worth not rediscovering

**`cli/monitor.ts` must stay a pure HTTP client.** PTY sessions live in a module-level
`Map` *inside the server process*. Any other process that calls
`setRuntime(new PtyRuntime())` gets a second, permanently empty registry whose
`sessionExists`/`capturePane` quietly answer "no such session". Terminal output is reachable
only over HTTP, via `GET /api/ensemble/sessions/:name/pane`.

**`services/ensemble-service.ts` stays runtime-agnostic.** Session behaviour belongs in
`PtyRuntime` behind the unchanged `AgentRuntime` interface. That seam is the only reason
this port was a rewrite of one file rather than of the whole codebase.

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
