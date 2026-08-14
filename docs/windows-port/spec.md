# Ensemble — Native Windows Port (Claude Code Implementation Guide)

This document is an implementation spec for making **ensemble**
(`michelhelsdingen/ensemble`) run **stably on native Windows** — no WSL2, no git-bash,
no tmux. **macOS/Linux support is explicitly out of scope.** You may delete or ignore
any tmux / bash / AppleScript code that only exists to serve those platforms. The goal
is a clean, reliable Windows-only build, not a cross-platform one.

Follow it phase by phase. Each phase has concrete tasks, exact signatures, gotchas, and
verification steps.

---

## 0. Context & Goal

**What ensemble is:** a multi-agent collaboration engine. It spawns AI agent CLIs
(`claude`, `codex`, `aider`, `gemini`) into sessions, lets them message each other, and
shows a live TUI monitor of the collaboration.

**Why it's *nix/WSL2-only today:** the runtime is built on **tmux** (no native Windows
build) plus **bash scripts** and **AppleScript** for window control. The codebase is
already 79% TypeScript / Node.js — the language is NOT the blocker. The runtime layer is.

**Goal:** make it run **stably on native Windows** (PowerShell + Windows Terminal).
Stability is the priority over feature completeness — no orphaned processes, clean
teardown, predictable behavior on agent crashes.

### The architectural lever

`lib/agent-runtime.ts` already isolates **every** tmux operation behind one interface,
`AgentRuntime`, implemented by `TmuxRuntime`. Business logic (`lib/agent-spawner.ts`,
`services/ensemble-service.ts`, `cli/monitor.ts`) calls `getRuntime()` and never touches
tmux directly. There's a `setRuntime()` factory.

> **Keep the interface, replace the implementation.** Write `lib/pty-runtime.ts`
> implementing `AgentRuntime` on top of [`node-pty`](https://github.com/microsoft/node-pty),
> make it the **only** runtime, and wire `setRuntime(new PtyRuntime())` unconditionally.
> Keeping the interface means you do NOT have to touch `services/ensemble-service.ts` —
> it stays runtime-agnostic. `TmuxRuntime` can be deleted (recommended, to avoid
> confusion) or left as dead code; either way it is never selected.

---

## 1. Hard Rules

1. **Target native Windows only.** PowerShell (`pwsh` preferred, else `powershell.exe`),
   Windows Terminal. Do not add bash, git-bash, WSL, or `osascript` dependencies.
   Where existing code needs those, **delete that path** — don't gate it.
2. **Keep the `AgentRuntime` interface shape unchanged** so `services/` and other callers
   keep working untouched. Only the implementation behind it changes.
3. **Stability first.** Every spawned process must be tracked and killable. No orphaned
   PTYs or child processes after teardown or crash. Bound all in-memory buffers.
4. **Cross-platform path hygiene still applies** (it's just good practice): use
   `path.join`, `os.homedir()`, `os.tmpdir()`. Don't hardcode `C:\...` literals where a
   Node API exists.
5. **Type-check must pass:** `npm run typecheck` (`tsc --noEmit`).
6. Work in small commits, one phase at a time. Run each phase's verification before moving on.

---

## 2. The Contract You Must Implement

`PtyRuntime` must implement this interface (in `lib/agent-runtime.ts`). Match it exactly:

```ts
export interface AgentRuntime {
  readonly type: 'tmux' | 'happy' | 'docker' | 'api' | 'direct'

  listSessions(): Promise<DiscoveredSession[]>

  sessionExists(name: string): Promise<boolean>
  getWorkingDirectory(name: string): Promise<string>
  isInCopyMode(name: string): Promise<boolean>      // tmux concept; return false
  cancelCopyMode(name: string): Promise<void>        // tmux concept; no-op

  createSession(name: string, cwd: string): Promise<void>
  killSession(name: string): Promise<void>
  renameSession(oldName: string, newName: string): Promise<void>

  sendKeys(name: string, keys: string, opts?: { literal?: boolean; enter?: boolean }): Promise<void>
  pasteFromFile(name: string, filePath: string): Promise<void>
  capturePane(name: string, lines?: number): Promise<string>

  setEnvironment(name: string, key: string, value: string): Promise<void>
  unsetEnvironment(name: string, key: string): Promise<void>

  getAttachCommand(name: string, socketPath?: string): { command: string; args: string[] }
}

export interface DiscoveredSession {
  name: string
  windows: number
  createdAt: string
  workingDirectory: string
}
```

Use `PtyRuntime.type = 'direct'` (the union already allows it).

---

## 3. Phase 0 — Prerequisites & Dependencies

**Tasks**

1. Add `node-pty` to `dependencies` in `package.json`.
2. Add `cross-env` to `devDependencies` (npm scripts — Phase 5).
3. Add `tree-kill` (or equivalent) to `dependencies` — needed to kill the **full process
   tree** on Windows (agent CLIs spawn children; killing only the PTY leaves orphans).
4. Document Windows prerequisites in the README:
   - Node.js 18+ LTS (prefer a version with prebuilt `node-pty` binaries).
   - **Visual Studio Build Tools** with "Desktop development with C++", or
     `npm install --global windows-build-tools`. `node-pty` compiles native code via
     `node-gyp`; without a toolchain `npm install` fails.
   - **Windows Terminal** (much better ANSI/VT support than legacy conhost).
   - PowerShell 7 (`pwsh`) recommended over Windows PowerShell 5.

**Gotcha:** `node-pty` is native. Make `bin/postinstall.cjs` detect a failed
`require('node-pty')` and print a clear error linking to the prereqs.

**Verify:** `npm install` succeeds and `node -e "require('node-pty')"` throws nothing.

---

## 4. Phase 1 — `PtyRuntime` (the core)

Create `lib/pty-runtime.ts`. ~80% of the work and the stability burden live here.

### 4.1 Session model

You own session state in memory (tmux owned it out-of-process; node-pty does not):

```ts
import * as pty from 'node-pty'

interface PtySession {
  name: string
  pty: pty.IPty
  pid: number
  cwd: string
  createdAt: string
  scrollback: string   // ring buffer; your tmux-scrollback replacement
  exited: boolean
}

const sessions = new Map<string, PtySession>()
```

### 4.2 Shell selection

```ts
import { existsSync } from 'fs'

function pickShell(): string {
  // Prefer PowerShell 7 if present, else Windows PowerShell.
  const pwsh = 'pwsh.exe'
  // Resolve via PATH at runtime; fall back to powershell.exe.
  return process.env.ENSEMBLE_SHELL || pwsh || 'powershell.exe'
}
```

Avoid `cmd.exe` (weak VT support, painful quoting).

### 4.3 createSession — spawn + capture + lifecycle

```ts
async createSession(name: string, cwd: string): Promise<void> {
  const p = pty.spawn(pickShell(), [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd,
    env: process.env as Record<string, string>,
  })

  const session: PtySession = {
    name, pty: p, pid: p.pid, cwd,
    createdAt: new Date().toISOString(), scrollback: '', exited: false,
  }

  const MAX_SCROLLBACK = 200_000 // chars; tune
  p.onData(chunk => {
    session.scrollback += chunk
    if (session.scrollback.length > MAX_SCROLLBACK) {
      session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK)
    }
  })
  p.onExit(() => { session.exited = true; sessions.delete(name) })

  sessions.set(name, session)

  // Force UTF-8 so non-ASCII agent output doesn't turn to mojibake.
  p.write('chcp 65001 > $null\r')
}
```

> **Critical:** `capturePane` exists because tmux kept scrollback for free. node-pty does
> not. The `scrollback` buffer IS your replacement. The monitor live feed AND agent-ready
> detection (`readyMarker` in `agents.json` / `types/agent-program.ts`, polled by
> `lib/agent-watchdog.ts`) both read it via `capturePane`. If this is wrong, the monitor
> and the watchdog silently break.

### 4.4 Method-by-method mapping

| Method | Implementation |
|---|---|
| `createSession` | as above |
| `killSession` | **tree-kill the PID**, then `pty.kill()`, then delete from map (see 4.6) |
| `renameSession` | re-key the Map entry, update `session.name`, preserve `scrollback` |
| `sessionExists` | `sessions.has(name) && !session.exited` |
| `listSessions` | map `sessions` → `DiscoveredSession[]` (`windows: 1`) |
| `getWorkingDirectory` | return stored `session.cwd` |
| `sendKeys` | translate keys → bytes, `session.pty.write(bytes)` (see 4.5) |
| `pasteFromFile` | `pty.write(fs.readFileSync(path,'utf8'))` then write `\r` |
| `capturePane` | return last `lines` lines of `session.scrollback` |
| `setEnvironment` | `pty.write(\`$env:${key}="${val}"\r\`)` (or rely on spawn env) |
| `unsetEnvironment` | `pty.write(\`Remove-Item Env:\\${key} -ErrorAction SilentlyContinue\r\`)` |
| `isInCopyMode` | `return false` |
| `cancelCopyMode` | no-op |
| `getAttachCommand` | return `{ command: '', args: [] }` — there is no external attach on Windows; the monitor uses the in-process feed (Phase 4) |

### 4.5 Key translation (sendKeys non-literal mode)

```ts
const KEYMAP: Record<string, string> = {
  'Enter': '\r', 'C-m': '\r', 'C-c': '\x03', 'C-d': '\x04',
  'C-z': '\x1a', 'Escape': '\x1b', 'Tab': '\t', 'Space': ' ',
  'Up': '\x1b[A', 'Down': '\x1b[B', 'Right': '\x1b[C', 'Left': '\x1b[D',
}
```

- **Literal** (`opts.literal === true`): write `keys` verbatim, then `\r` if `opts.enter`.
- **Non-literal:** split on spaces, map each token via `KEYMAP` (fall through to raw),
  concat, write; append `\r` if `opts.enter`.

### 4.6 Process-tree cleanup (the #1 Windows stability issue)

On Windows, an agent CLI launched inside the shell PTY spawns its own children. Calling
only `pty.kill()` can leave those children running → orphaned `node`/`claude`/`codex`
processes that hold ports and CPU. Always kill the **tree**:

```ts
import treeKill from 'tree-kill'

async killSession(name: string): Promise<void> {
  const s = sessions.get(name)
  if (!s) return
  await new Promise<void>(resolve => {
    treeKill(s.pid, 'SIGKILL', () => resolve()) // taskkill /T /F under the hood on Win
  })
  try { s.pty.kill() } catch { /* already gone */ }
  sessions.delete(name)
}
```

Also register a **process-exit cleanup** so a server crash/Ctrl-C doesn't strand agents:

```ts
function killAll() { for (const s of sessions.values()) { try { treeKill(s.pid) } catch {} } }
process.on('exit', killAll)
process.on('SIGINT', () => { killAll(); process.exit(0) })
process.on('SIGTERM', () => { killAll(); process.exit(0) })
```

### 4.7 Sync helpers

`lib/agent-runtime.ts` exports `sessionExistsSync`, `killSessionSync`,
`renameSessionSync`. Reimplement them against the in-memory `sessions` map (these are
naturally synchronous — no child process needed). Make sure callers use these versions,
not the tmux ones.

**Verify (Phase 1):** script that does `setRuntime(new PtyRuntime())`, `createSession`,
`sendKeys('echo hello',{literal:true,enter:true})`, wait, `capturePane` → "hello"
appears. Then `killSession` and confirm via Task Manager that no child process survives.

---

## 5. Phase 2 — Runtime Selection (trivial now)

No platform branching needed — PtyRuntime is the only runtime.

```ts
import { setRuntime } from './lib/agent-runtime'
import { PtyRuntime } from './lib/pty-runtime'
setRuntime(new PtyRuntime())
```

Put this in the startup path of `server.ts` and `cli/ensemble.ts` (and `cli/monitor.ts`
if it bootstraps independently). Optionally keep an `ENSEMBLE_SHELL` env var (Phase 4.2)
to override the shell binary. Delete `TmuxRuntime` once nothing references it.

**Verify:** `getRuntime().type` logs `direct` at startup.

---

## 6. Phase 3 — Rewrite the Spawner for PowerShell

`lib/agent-spawner.ts > spawnLocalAgent()` bakes in zsh/bash syntax that fails in
PowerShell. **Rewrite it for PowerShell — no POSIX branch needed.**

Current (POSIX-only):
```ts
const envForward = entries.map(([k,v]) => `export ${k}="${v}"`).join('; ')
await runtime.sendKeys(sessionName,
  ` nocorrect unset CLAUDECODE; ${envPrefix}${startCommand}`,
  { literal: true, enter: true })
```

**Tasks**

1. Forward env vars via the PTY spawn `env` option inside `PtyRuntime.createSession`
   instead of typing `export` lines. Cleanest — then the spawner only sends the start
   command.
2. If you must set env at the prompt, use PowerShell: `$env:KEY="VALUE"`.
3. Delete the `nocorrect`, `unset CLAUDECODE` (use `Remove-Item Env:\CLAUDECODE
   -ErrorAction SilentlyContinue` only if actually needed), and the leading-space
   "tmux swallows first char" hack — all tmux/zsh-specific.
4. `killLocalAgent()` sends `C-c` then `"exit"` then `killSession`. `exit` works in
   PowerShell; `C-c`→`\x03` via keymap. But since `killSession` now tree-kills (4.6),
   the graceful step is best-effort — keep it short and let tree-kill guarantee cleanup.

**Verify:** spawn a real agent (or `node -e "process.stdin.resume()"`); confirm it
launches and inherits env vars; kill it; confirm no orphan.

---

## 7. Phase 4 — The Monitor (delete the macOS paths)

`cli/monitor.ts` is a 34KB self-rendered TUI. It shells out to **bash + AppleScript
(`osascript`)** to open/close iTerm windows, and assumes tmux `attach-session`.

**Strategy:** the monitor already renders panes by reading session output. On Windows it
renders the live feed **in-process** by polling `runtime.capturePane(name)` on a refresh
interval. So you mostly **delete** the external-terminal machinery.

**Tasks**

1. **Delete** every `osascript` / bash `spawnSync` block (don't gate — remove).
2. Remove the `getAttachCommand()`-based external-terminal launch; the runtime returns an
   empty command. Drive the view purely from `capturePane` on a timer.
3. Confirm rendering in **Windows Terminal** (cursor positioning, clears, colors). If
   legacy conhost mangles it, document "Windows Terminal required."
4. Guard `process.stdin.setRawMode(true)` — it throws when stdin isn't a TTY. Check
   `process.stdin.isTTY` first.
5. Ensure the refresh loop is cleared on exit and doesn't leak timers.

**Verify:** `npm run monitor` shows the live feed updating, no crash, no `osascript`/bash
invocation, keybindings work, clean exit on `q`/Ctrl-C.

---

## 8. Phase 5 — npm Scripts

`package.json` uses inline POSIX env assignment that breaks on Windows
(`"start": "NODE_ENV=production tsx server.ts"`).

**Tasks**

1. Wrap with `cross-env`: `"start": "cross-env NODE_ENV=production tsx server.ts"`.
2. Audit `dev`, `start`, `monitor`, `cli`, `postinstall` for any other shell-isms.
   `tsx` itself is cross-platform.
3. Verify `bin/ensemble.cjs` and `bin/postinstall.cjs` don't shell out to bash.

**Verify:** `npm run dev`, `npm start`, `npm run cli -- status`, `npm run monitor` all
launch on Windows without env-parse or "command not found" errors.

---

## 9. Phase 6 — Replace the Bash Scripts

`scripts/*.sh` are bash orchestration wrappers around the CLI/HTTP API. On Windows-only
you can stop shipping them entirely.

**Tasks (prioritized — don't port all 16)**

1. **Must-haves first:** `team-say` / `team-read` (the agent message bus) and
   `collab-launch` (main entrypoint).
2. **Reimplement them as Node CLI subcommands** in `cli/ensemble.ts`
   (e.g. `ensemble team-say`, `ensemble launch`) using the existing API client. This
   removes the bash dependency rather than relocating it.
3. **Delete** macOS-only scripts (`open-iterm-monitor.sh`) and any `.sh` you've replaced.
4. Keep the Python tools (`generate-replay.py`, `parse-messages.py`) but invoke the
   interpreter explicitly as `python` (Windows doesn't honor shebangs).

**Verify:** launch a team and exchange a message end-to-end using only Node/CLI — no bash.

---

## 10. Phase 7 — Stability Hardening (do not skip)

"Stable on Windows" is the actual goal. After the functional port works:

1. **No orphans:** repeatedly create/kill teams and watch Task Manager — process count
   must return to baseline every time. Tree-kill + exit handlers (4.6) are the safety net.
2. **Crash resilience:** kill an agent process externally; the watchdog
   (`lib/agent-watchdog.ts`) should detect via `capturePane` and mark it dead without
   crashing the server.
3. **Buffer bounds:** confirm `scrollback` never grows unbounded over a long session.
4. **Encoding:** run an agent that emits non-ASCII; confirm no mojibake (chcp 65001 in 4.3).
5. **Port already in use / stale state:** server restart after a hard crash should not be
   blocked by leftover sessions or a held port 23000.
6. **PTY resize:** if the monitor or terminal resizes, call `pty.resize(cols, rows)` so
   agent output doesn't wrap badly. Wire a resize handler.
7. **Concurrency:** spawning several agents at once must not race the `sessions` map
   (it's single-threaded JS, but watch async ordering in create/kill).

---

## 11. End-to-End Acceptance Criteria

On a clean native-Windows machine (no WSL, no git-bash):

1. `npm install` succeeds (node-pty compiles or uses a prebuilt binary).
2. `npm run dev` starts the server; `curl http://localhost:23000/api/v1/health` →
   healthy.
3. Creating a 2-agent team spawns both agents in PTY sessions.
4. Agents exchange at least one message (bus works without bash).
5. `npm run monitor` shows the live feed updating; no osascript/bash; clean exit.
6. Tearing down the team kills the **full process tree** — zero orphans (verify in Task
   Manager).
7. Killing an agent externally is handled gracefully by the watchdog.
8. `npm run typecheck` passes.
9. Create/kill 10 teams in a row → process count returns to baseline each time.

---

## 12. Gotchas Quick Reference

- **node-pty is native** → Windows needs VS C++ Build Tools; fail loudly in postinstall.
- **capturePane = your own scrollback buffer.** No buffer → broken monitor + watchdog.
- **Orphaned processes are the main stability risk** → tree-kill the PID + exit handlers.
- **Spawner used POSIX shell syntax** → rewrite for PowerShell (no branch).
- **Monitor used AppleScript** → delete those blocks.
- **npm scripts** use inline `NODE_ENV=` → `cross-env`.
- **`getAttachCommand` has no Windows analog** → empty sentinel + in-process feed.
- **`setRawMode` throws on non-TTY** → check `process.stdin.isTTY`.
- **PowerShell encoding** → `chcp 65001` on session start.
- **Use `pwsh`/`powershell.exe`, never `cmd.exe`.**
- **PTY resize** → call `pty.resize()` on terminal resize.

---

## 13. Files Map

**Create:**
- `lib/pty-runtime.ts` — the runtime (Phase 1)

**Modify:**
- `package.json` — add node-pty, tree-kill, cross-env; fix scripts (Phases 0, 5)
- `server.ts` / `cli/ensemble.ts` — `setRuntime(new PtyRuntime())` + exit handlers (Phases 2, 4.6)
- `lib/agent-spawner.ts` — PowerShell spawn command (Phase 3)
- `cli/monitor.ts` — delete AppleScript/bash, in-process feed, TTY guard (Phase 4)
- `lib/agent-runtime.ts` — sync helpers against the map; delete `TmuxRuntime` (Phases 1.7, 2)
- `cli/ensemble.ts` — team-say/team-read/launch subcommands (Phase 6)
- `.env.example`, `README.md` — Windows prereqs, `ENSEMBLE_SHELL`

**Delete (Windows-only cleanup):**
- `TmuxRuntime` class, `scripts/*.sh` you've replaced, `scripts/open-iterm-monitor.sh`

---

## 14. Suggested Commit Order

1. `chore: add node-pty + tree-kill + cross-env, document Windows prereqs` (Phase 0)
2. `feat: PtyRuntime over node-pty with process-tree cleanup` (Phase 1)
3. `feat: make PtyRuntime the runtime; remove TmuxRuntime` (Phase 2)
4. `fix: PowerShell spawn command in agent-spawner` (Phase 3)
5. `fix: Windows monitor (remove AppleScript, in-process feed)` (Phase 4)
6. `fix: cross-platform npm scripts` (Phase 5)
7. `feat: port team-say/team-read/launch to Node CLI subcommands` (Phase 6)
8. `chore: stability hardening pass` (Phase 7)

Tackle one commit at a time. Run its verification step before the next.
