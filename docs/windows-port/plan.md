# Ensemble — Native Windows Port: Audit & Execution Plan

**Branch:** `windows-port` · **Audited:** 2026-07-27 · **Supersedes the phase ordering in `WINDOWS-PORT.md`**

> **Fork status.** This is a private fork. Upstream's `CLAUDE.md` conventions are **advisory, not
> binding** — in particular the "do NOT touch `services/ensemble-service.ts`" rule is void. Any file
> may be modified. The only hard constraints are the ones in §0 below.

## 0. Hard constraints (this fork)

1. **Native Windows only.** PowerShell (`pwsh` preferred, else `powershell.exe`) + Windows Terminal.
   No bash, git-bash, WSL, tmux, or `osascript` anywhere. Delete such paths, don't gate them.
2. **Subscription auth only — never API keys.** Agents must authenticate via the user's existing
   Claude Code / Codex CLI subscription login. See §4.0; this is a first-class requirement, not a
   nice-to-have.
3. **Stability over features.** Every spawned process tracked and killable; full process-tree
   teardown; bounded buffers.
4. `npm run typecheck` and `npm run lint` green before every commit.

This document is the result of a full read of the codebase plus **live runtime probes on this
machine**. It records what is already done, what is actually broken, three defects the original
spec did not anticipate, and a corrected phase-by-phase plan.

Where this document contradicts `WINDOWS-PORT.md`, **this document wins** — the contradictions are
listed explicitly in §3 with the evidence behind them.

---

## 1. Executive summary

The port is **~35% done, but the remaining 65% contains all the load-bearing work.**

Commits `a639f0d → ce46e4c` landed Phases 0–2 cleanly: `node-pty` + `tree-kill` + `cross-env` are
installed, `lib/pty-runtime.ts` exists and implements `AgentRuntime`, `TmuxRuntime` is gone, and
`setRuntime(new PtyRuntime())` is wired into `server.ts`, `cli/ensemble.ts`, and `cli/monitor.ts`.

Verified live on this machine:

| Check | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | **passes**, exit 0 |
| `require('node-pty')` | **loads**, v1.1.0, prebuilt `lib/` present |
| PTY create → sendKeys → capturePane → killSession | **works** end-to-end |
| Process-tree cleanup (grandchild `node` process) | **no orphans**, 8 → 9 → 8 |

So the headline risk from the original spec — orphaned processes — is **already mitigated**.
`tree-kill` does its job. That frees the budget for the three problems that actually block shipping:

1. **The message bus is dead on Windows.** Agents are literally instructed, in their spawn prompt,
   to run `scripts/team-say.sh` — bash + `python3` + `fcntl.flock`. There is no bash, and `fcntl` is
   POSIX-only. Agents cannot talk to each other. This is the product's entire purpose.
2. **`capturePane` returns a raw ANSI byte stream, not a rendered screen.** tmux returned a
   rendered screen as plain text. Five separate consumers assume that. Confirmed by probe below.
3. **The spawner still emits zsh/bash syntax** into a PowerShell prompt. Phase 3 was never started.

Nothing here requires re-architecture. The `AgentRuntime` seam held up well. It is a focused
6-phase cleanup, and the phase order in `WINDOWS-PORT.md` needs to be inverted — the message bus is
listed last (Phase 6) and must be first.

---

## 2. Evidence from live probes

Two throwaway probes were run against the real `PtyRuntime` on this machine.

### 2.1 `capturePane` returns an un-rendered ANSI stream

Probe: create a session, `echo HELLO_MARKER_123`, capture 60 lines.

```
RAW LENGTH: 547        CONTAINS MARKER: true        ESC BYTE COUNT: 26
```

Raw captured content (JSON-escaped, abridged):

```
"\u001b[?25l\u001b[2J\u001b[m\u001b[HWindows PowerShell\nCopyright (C) Microsoft ...
 \u001b[4;1HInstall the latest PowerShell ... \u001b[6;1H
 \u001b]0;C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\u0007
 \u001b[?25hPS E:\\projects\\...> \u001b[?25l\u001b[6;37H> \u001b[93mchcp \u001b[97m65001 ...
 PS E:\\...> \u001b[93mec\u001b[?25l\u001b[m\u001b[93m\u001b[7;39Hecho \u001b[m
 HELLO_MARKER_12\u001b[93m\u001b[7;39Hecho \u001b[mHELLO_MARKER_123\n
 \u001b[?25hHELLO_MARKER_123\nPS E:\\...> "
```

Three things to notice, all of which break downstream consumers:

- **Absolute cursor addressing** (`\u001b[7;39H`, `\u001b[4;1H`). The stream is a set of *drawing
  instructions*, not screen content. Line order in the buffer ≠ line order on screen.
- **PSReadLine incremental redraw**: the typed command appears **three times** — `ec`, then
  `echo HELLO_MARKER_12`, then `echo HELLO_MARKER_123` — each preceded by a cursor jump back to
  column 39. Any `.includes()` or regex over this buffer sees phantom duplicates.
- **OSC title sequences** (`\u001b]0;...\u0007`) inject the full shell path into the buffer.

Real agent CLIs (Claude Code, Codex, Gemini) are full-screen alternate-buffer TUIs that repaint via
cursor addressing every frame. Against those, the accumulated stream bears almost no resemblance to
what is on screen.

**Five consumers depend on `capturePane` returning rendered plain text:**

| Consumer | Location | What it does |
|---|---|---|
| Ready detection | `services/ensemble-service.ts:563` | `output.includes(readyMarker)` — `❯` / `›` |
| Trust-prompt auto-confirm | `services/ensemble-service.ts:547` | regex on "Do you trust the contents…" |
| Bypass-warning auto-confirm | `services/ensemble-service.ts:71` | regex on "WARNING: Claude Code running in Bypass…" |
| Paste re-submit loop | `services/ensemble-service.ts:687` | `/\[Pasted text/i` |
| Token scraping | `lib/agent-spawner.ts:241-249` | `/(\d+(?:\.\d+)?k)\s*tokens/i` etc. |

`WINDOWS-PORT.md` §4.3 calls the scrollback string "your tmux-scrollback replacement." It is not
equivalent, and this is the single largest gap in the port.

### 2.2 `killSession` crashes a node-pty helper on every call

Probe: create session → start `node -e "setInterval(...)"` inside it → `killSession`.

```
node processes BEFORE: 8
node processes DURING: 9        ← grandchild alive
node processes AFTER:  8        ← RESULT: NO ORPHANS ✓

E:\...\node_modules\node-pty\src\conpty_console_list_agent.ts:13
const consoleProcessList = getConsoleProcessList(shellPid);
                           ^
Error: AttachConsole failed
```

Cleanup **works**. But every `killSession()` also spawns a node-pty ConPTY helper process that dies
with an uncaught `AttachConsole failed` and prints a stack trace.

Cause is the ordering in `lib/pty-runtime.ts:179-191` (which follows `WINDOWS-PORT.md` §4.6):

```ts
await killProcessTree(session.pid, 'SIGKILL')   // shell is now dead
try { session.pty.kill() } catch { }            // node-pty attaches to a dead console → throws
```

The `try/catch` does not help — the throw happens in a **separate spawned helper process**, so it
surfaces as unhandled stderr noise, not a catchable exception. On a server disbanding a 4-agent
team this fires 4× per teardown.

**Fix:** `pty.kill()` first (lets node-pty tear its own ConPTY down cleanly), then `treeKill` as the
guarantee for surviving grandchildren.

### 2.3 Environment facts

- `pwsh.exe` is **not** on PATH here → `pickShell()` fell back to **Windows PowerShell 5.1**. The
  weaker shell (worse VT support, no UTF-8 by default) is the live default, not the exception.
- Node v24.15.0, npm 11.12.1. node-pty 1.1.0 with prebuilt `lib/` — no compile needed on this box.

---

## 3. Corrections to `WINDOWS-PORT.md`

| # | `WINDOWS-PORT.md` says | Reality | Impact |
|---|---|---|---|
| C1 | §7: "the monitor already renders panes by reading session output… drive the view purely from `capturePane` on a timer" | **False.** `cli/monitor.ts` polls the **HTTP feed** (`/api/ensemble/teams/:id/feed`) every 2s and never calls `capturePane`. | Phase 4 is ~30 lines of deletion, not a rewrite. Big scope reduction. |
| C2 | §9: message-bus port is **Phase 6 of 8** | It is the **hard blocker**. Agents cannot exchange a single message without it. | Must move to **Phase 1**. |
| C3 | §4.3: scrollback string is the "tmux-scrollback replacement" | It is a raw ANSI stream; tmux returned a rendered screen. Confirmed §2.1. | Needs a headless terminal emulator. Not mentioned anywhere in the spec. |
| C4 | §4.6: `treeKill` **then** `pty.kill()` | That exact order causes `AttachConsole failed`. Confirmed §2.2. | Reverse it. |
| C5 | §10.1: "orphaned processes are the #1 risk" | Already solved by `tree-kill`. Probe shows clean teardown. | De-prioritise; spend budget on §2.1 instead. |
| C6 | `CLAUDE.md`: "`services/ensemble-service.ts` — do NOT touch" | It hardcodes `${scriptsDir}/team-say.sh` in `buildPromptPreview` (line 369-370) — the string handed to every agent. | Rule must be relaxed for that function. Runtime-agnostic ≠ shell-agnostic. |
| C7 | §12: "PTY resize → call `pty.resize()`" | `AgentRuntime` has **no resize method**, so it is unreachable through the seam. | Needs an explicit decision (§5.6). |

---

## 4. Complete defect register

Severity: **P0** blocks the product working at all · **P1** correctness/stability · **P2** cleanup · **P3** tooling.

### P0 — Subscription authentication *(new requirement)*

Verified on this machine: `claude`, `codex`, `gemini` are all on PATH (npm shims in
`%APPDATA%\npm\`, with `.cmd` + `.ps1` variants; ExecutionPolicy `CurrentUser=RemoteSigned`, which
does not block them). Subscription credential stores **already exist**:
`~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.claude.json`, `~/.codex/config.toml`.
**No `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` is set.** So subscription auth is the current, working
state — the job is to *avoid breaking it*.

**D25 · The spawner actively forwards API-key vars, defeating subscription auth.**
```ts
// lib/agent-spawner.ts:86
.filter(([k]) => k.startsWith('ENSEMBLE_') || k.startsWith('NVIDIA_')
              || k.startsWith('OPENAI_')   || k.startsWith('ANTHROPIC_'))
```
`OPENAI_*` and `ANTHROPIC_*` are explicitly forwarded into the agent session. If either key is ever
present in the parent environment, Claude Code and Codex switch to **API-key billing** and silently
bypass the subscription. This filter must be **inverted into a deny-list**.

**D26 · `createSession` passes the entire parent environment.**
`pty-runtime.ts:148` — `env: process.env as Record<string,string>`. Everything leaks in, including
API keys and Claude Code's own session vars.

**D27 · Claude Code's nested-session vars leak into spawned agents.** *Confirmed live:* this very
environment has `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT=cli`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_EXECPATH`, `CLAUDE_PID`, `CLAUDE_EFFORT` set. With `env: process.env` these are
inherited by every spawned `claude` agent, which then believes it is a nested invocation. This is
precisely what upstream's `nocorrect unset CLAUDECODE` (`agent-spawner.ts:93`) existed to prevent —
and that line is zsh-only, so the protection is currently **gone on Windows**.

**D28 · Credential-discovery vars must be preserved.** The CLIs locate their subscription tokens via
the home directory. `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA` must survive
any env filtering, or login state is invisible to the agent and it will prompt for auth.

**Required env policy for `createSession`** — deny-list, not allow-list:

```ts
const DENY = [
  /^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)$/i,
  /^OPENAI_(API_KEY|BASE_URL|ORGANIZATION)$/i,
  /^(GEMINI|GOOGLE)_API_KEY$/i,
  /^CLAUDE_CODE_/i, /^CLAUDECODE$/i, /^CLAUDE_(PID|EFFORT)$/i,
  /^CLAUDE_CODE_USE_(BEDROCK|VERTEX)$/i,
]
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !DENY.some(re => re.test(k)))
) as Record<string, string>
```

**D29 · ~~`agents.json` flag for claude is likely invalid.~~ — WITHDRAWN, this was wrong.**
Verified against the installed CLI (Claude Code 2.1.220): `--permission-mode` accepts
`acceptEdits | auto | bypassPermissions | manual | dontAsk | plan`. **`auto` is valid.**
`agents.json` is correct as written; leave it alone.

**D30 · Agent CLIs resolve to `.ps1` scripts, so ExecutionPolicy is load-bearing.** Verified:
`Get-Command claude` → `%APPDATA%\npm\claude.ps1`, CommandType `ExternalScript`. It executes fine
here (`CurrentUser=RemoteSigned`, npm-extracted files carry no mark-of-the-web), and
`claude --version` / `codex --version` both succeed under `powershell -NoProfile`. But on a machine
with `Restricted` or `AllSigned` policy every agent spawn would fail with an opaque error.

**Hardening (cheap, do it):** spawn the PTY shell with an explicit process-scoped bypass —
`pty.spawn(shell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'])`. Process-scoped, so it
changes nothing system-wide, and it makes agent spawning independent of machine policy.
`-NoProfile` additionally stops a user's PowerShell profile from writing banner text into the
scrollback that `capturePane` consumers would have to parse around.

### P0 — Functional blockers

**D1 · Message bus is bash + python3 + `fcntl`.**
`scripts/team-say.sh` uses `#!/usr/bin/env bash`, `readlink -f`, `source`, and a `python3` heredoc
calling **`fcntl.flock`** (POSIX-only — fails even if Python is installed).
`scripts/team-read.sh` uses `curl` + `python3`. `scripts/ensemble-bridge.sh` is a bash polling loop
using `python3`, `kill -0`, `wc -l`, `tr`, `tail`.
`services/ensemble-service.ts:369-370` bakes the `.sh` paths into every agent's prompt.

The bridge is **load-bearing, not redundant**: `getMessages()` (`lib/ensemble-registry.ts:142-175`)
does read `messages.jsonl` directly, so `team-read` via API would see messages — but only the bridge
POSTs to `/api/ensemble/teams/:id`, which is what triggers `sendTeamMessage()` to **paste the message
into the recipient's PTY**. Without it, agents never receive each other's messages.

**D2 · `lib/collab-paths.ts:10` hardcodes `/tmp/ensemble`.**
`path.join('/tmp/ensemble', teamId)` on Windows → `\tmp\ensemble\<id>`, resolved against the
**current drive** — `E:\tmp\ensemble` when run from `E:`. It "works" by accident, but the location is
wrong, drive-dependent, and diverges the moment the server and CLI run from different drives. All
runtime state lives here: `messages.jsonl`, `prompts/`, `delivery/`, `summary.txt`, `.finished`.

Duplicated hardcodes elsewhere:
- `cli/ensemble.ts:201` — `` `/tmp/ensemble/${teamId}/messages.jsonl` ``
- `cli/monitor.ts:414` — `` `/tmp/collab-summary-${this.teamId}.txt` ``
- `cli/monitor.ts:478` — `` `/tmp/ensemble/${this.teamId}/iterm-session-id` ``
- Scrub regexes `/\/tmp\/ensemble[-\w]*/g` at `ensemble-service.ts:827` and `monitor.ts:417,418,652,783,788`

**D3 · `lib/agent-spawner.ts` emits POSIX shell syntax.** (Phase 3 never started.)
- `:38 shellEscape()` → POSIX `'…'\''…'`. PowerShell escapes a quote by **doubling** it (`''`).
- `:88` → `export ${k}="${v}"` — invalid in PowerShell (`$env:K="V"`).
- `:93` → `` ` nocorrect unset CLAUDECODE; …` `` — `nocorrect` is a zsh builtin; leading space is a
  tmux-swallows-first-char hack.
- `:116` → sends `'"exit"'`. In PowerShell that is a quoted string literal; it **echoes** `exit`
  rather than exiting.
- `lib/agent-config.ts:60 shellEscape()` — same POSIX bug, used by `buildAgentCommand()`.

### P1 — Correctness & stability

**D4 · `capturePane` needs terminal emulation.** See §2.1. Affects 5 consumers.

**D5 · `killSession` ordering crashes a node-pty helper.** See §2.2. `lib/pty-runtime.ts:179-191`.

**D6 · `process.on('exit')` handler is async → never runs.**
```ts
// lib/pty-runtime.ts:97
process.once('exit', () => { void killAll() })   // killAll is async
```
Node's `exit` event runs **synchronous work only**. `killAll()` awaits `treeKill` callbacks, so on a
hard exit the promise is abandoned and agent trees are stranded. Needs a synchronous path
(`execFileSync('taskkill', ['/T','/F','/PID', String(pid)])`).

**D7 · `sendKeys` non-literal mode destroys spaces.**
```ts
// lib/pty-runtime.ts:205
keys.split(' ').map(key => KEYMAP[key] ?? key).join('')
```
Unmapped tokens fall through to themselves and the separator is dropped:
`sendKeys(s, 'hello world')` → `helloworld`. Currently masked because every non-literal call site
passes a single token (`'Enter'`, `'Down'`, `'C-c'`), but it is a live trap.

**D8 · UTF-8 is not actually enforced.** `pty-runtime.ts:176` writes `chcp 65001 > $null`. That sets
the console codepage but **not** `[Console]::OutputEncoding` / `$OutputEncoding`, so PowerShell 5.1
(the live default here — §2.3) still mangles non-ASCII. It is also typed at the prompt, so it
pollutes the scrollback (visible in the §2.1 dump).

**D9 · `pickShell()` under-detects `pwsh`.** `pty-runtime.ts:35-55` probes bare `pwsh.exe` against
`PATH` entries only. It ignores `PATHEXT` and the standard install location
`C:\Program Files\PowerShell\7\pwsh.exe` when not on PATH — which is why this machine silently fell
back to PowerShell 5.1.

**D10 · No PTY resize path.** `AgentRuntime` (`lib/agent-runtime.ts:21-49`) exposes no `resize`.
Sessions are pinned at 120×40 (`pty-runtime.ts:145-146`). Agent TUIs wrap badly in any other size.

**D11 · Double env forwarding.** `createSession` already passes `env: process.env`
(`pty-runtime.ts:148`), *and* the spawner types `export` lines (`agent-spawner.ts:88`). Once D3 is
fixed the typed path should be deleted entirely, not translated.

### P2 — macOS / dead code

**D12** · `cli/monitor.ts:476-507 closeITermSessionIfAny()` — AppleScript + `bash -c` + `sleep` +
`osascript`. Called from `cleanup()` at `:469`. Delete both.
**D13** · `scripts/open-iterm-monitor.sh` — delete.
**D14** · 16 `.sh` scripts; 14 depend on `python3`/`curl`/`tmux`/`osascript`/`mktemp`/`flock`.
**D15** · `bin/postinstall.cjs:33-40` chmods `.sh`/`.py` to 0755 — meaningless on NTFS.
**D16** · `package.json` keywords list `tmux`; `files[]` still ships `scripts/`.
**D17** · `types/agent-program.ts:13` — comment says "appears in tmux pane".
**D18** · `lib/agent-spawner.ts` — 6 stale tmux comments/log lines (`:4,33,66,75,84,95,229`).

### P3 — Build & tooling

**D19** · `package.json:11` — `"start": "NODE_ENV=production tsx server.ts"`. **`cross-env` is
installed but unused.** Phase 5 not done. Fails on Windows.
**D20** · **No `test` script** despite `vitest ^3.0.0` in devDependencies. Tests are unrunnable via npm.
**D21** · `tests/ensemble.test.ts:8` `execFileSync`s `scripts/team-say.sh` in 7 tests — all fail on Windows.
**D22** · `.github/workflows/ci.yml:12` — `runs-on: ubuntu-latest` for a Windows-only project.
**D23** · `lib/ensemble-registry.ts:18` — `process.env.USER || process.env.LOGNAME`; Windows uses
`USERNAME`. Cosmetic (falls back to hostname).
**D24** · `services/ensemble-service.ts:279,308` spawn `curl` for Telegram/alert-hub. `curl.exe` ships
with Win10+ so it works, but Node 18+ `fetch` is already used at `:984` — inconsistent.

---

## 5. Execution plan

Ordered by **unblock-first**. Each phase is one commit with its own verification gate.
Run `npm run typecheck` and `npm run lint` before every commit.

### Phase 1 — Windows runtime paths *(fixes D2)*
**Why first:** every later phase writes to these paths.

- `lib/collab-paths.ts`: replace `const RUNTIME_ROOT = '/tmp/ensemble'` with
  `process.env.ENSEMBLE_RUNTIME_DIR || path.join(os.tmpdir(), 'ensemble')`.
- Extend `ensureCollabDirs()` to create the base dir too, not just `prompts/` + `delivery/`.
- Replace the hardcodes in `cli/ensemble.ts:201`, `cli/monitor.ts:414`.
- Replace the `/\/tmp\/ensemble[-\w]*/g` scrub regexes with one exported helper built from the
  resolved root (escape it for regex use).
- Delete `scripts/collab-paths.sh` (the shell mirror) — nothing will source it after Phase 2.

**Verify:** `node -e` printing `collabRuntimeDir('x')` → a path under `%TEMP%`. Create a team; confirm
`prompts/` and `delivery/` appear there.

### Phase 2 — Node message bus *(fixes D1)* ← **the unblocker**

Add subcommands to `cli/ensemble.ts`:

| Command | Replaces | Behaviour |
|---|---|---|
| `ensemble team-say <teamId> <from> <to> <msg…>` | `team-say.sh` | Append one JSONL line to `collabMessagesFile(teamId)`. Use the existing `mkdir`-based mutex from `ensemble-registry.ts:42-73` (`acquireTeamsLock`) — it is already atomic and cross-platform. **Do not** use `fcntl`. |
| `ensemble team-read <teamId>` | `team-read.sh` | `GET /api/ensemble/teams/:id/feed`, print `from -> to: content`. Node `fetch`, no curl. |
| `ensemble bridge <teamId>` | `ensemble-bridge.sh` | `fs.watchFile` (not `fs.watch` — unreliable on Windows) on `messages.jsonl`; POST unposted lines to `/api/ensemble/teams/:id`; honour `.finished`; keep the existing exponential-backoff + skip-4xx semantics. |

Then update `services/ensemble-service.ts buildPromptPreview()` (lines 368-370) to emit invocable
commands — this is the string agents actually execute:

```ts
const cli = `node "${path.join(REPO_ROOT, 'bin', 'ensemble.cjs')}"`
const teamSayCmd  = `${cli} team-say ${teamId} ${agentName} ${to}`
const teamReadCmd = `${cli} team-read ${teamId}`
```

> Note the `CLAUDE.md` "do not touch `services/`" rule is explicitly relaxed **for this function
> only** (see C6). The rest of the file stays untouched.

Delete `scripts/team-say.sh`, `team-read.sh`, `ensemble-bridge.sh`.

**Verify:** two shells. `ensemble team-say <id> a b "hello"` in one; `ensemble team-read <id>` in the
other shows it. Then with the bridge running, confirm the message is **pasted into the recipient's
PTY** (that is the part `getMessages()` alone does not do).

### Phase 3 — PowerShell spawner + subscription auth *(fixes D3, D11, D18, D25–D29)*

- Rewrite `shellEscape()` in **both** `lib/agent-spawner.ts:38` and `lib/agent-config.ts:60`:
  ```ts
  function psQuote(v: string): string { return `'${v.replace(/'/g, "''")}'` }
  ```
- **Delete** the env-forwarding block (`agent-spawner.ts:85-90`) entirely. Do **not** translate it to
  `$env:` — it is the D25 bug. Env now flows solely through `createSession`'s filtered `env`.
- Apply the **D25–D28 deny-list** in `pty-runtime.ts createSession()` (code in §4). Assert the
  credential-discovery vars from D28 survive it.
- Replace the send at `:93` with just the start command — no `nocorrect`, no `unset CLAUDECODE`
  (the deny-list handles it), no leading space.
- `killLocalAgent`: send `C-c`, short pause, then `exit` **unquoted**, then `killSession`. Keep the
  graceful step under ~600ms; `killSession` is the guarantee.
- ~~Verify and fix the `--permission-mode` value in `agents.json` (D29).~~ Done — `auto` is valid,
  no change needed.
- Clear the 6 stale tmux comments.

**Status: Phases 1–3 landed** in `4f45549`, `ef953e2`, `0f2ee0b`. Typecheck and lint verified green
independently. Outstanding from this phase: the D30 `-NoProfile -ExecutionPolicy Bypass` hardening,
and end-to-end auth verification (steps 1-4 below) has **not** yet been run against live agents.

**Verify (auth is the point of this phase):**
1. Spawn a `claude` agent; `capturePane` must show a normal ready prompt — **not** a login/auth
   prompt and **not** an "API key" banner.
2. Same for `codex`.
3. In the spawned session run `Get-ChildItem Env: | Where-Object Name -match 'ANTHROPIC|OPENAI|CLAUDECODE'`
   → must return **nothing**.
4. Run with `ANTHROPIC_API_KEY=sk-fake` set in the *parent* shell; the spawned agent must still use
   the subscription and must not see the key.
5. A value containing a quote and a space survives `psQuote`.

### Phase 4 — Terminal emulation for `capturePane` *(fixes D4)* ← **highest technical risk**

Add `@xterm/headless` and keep a real screen buffer per session:

```ts
import { Terminal } from '@xterm/headless'

interface PtySession { /* … */ term: Terminal }

const term = new Terminal({ cols: 120, rows: 40, scrollback: 5000, allowProposedApi: true })
p.onData(chunk => { term.write(chunk); session.scrollback += chunk /* keep raw for debug */ })
```

`capturePane(name, lines)` then serialises the **rendered buffer**:

```ts
const buf = session.term.buffer.active
const end = buf.baseY + buf.cursorY
const start = Math.max(0, end - lines + 1)
const out: string[] = []
for (let i = start; i <= end; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '')
return out.join('\n')
```

`translateToString(true)` right-trims and yields **plain text with no escape sequences** — the exact
contract tmux `capture-pane` provided. Cap `scrollback` (the raw string) or drop it once the
emulator is trusted, to satisfy the bounded-buffer rule.

Also in this phase:
- **D8**: replace the `chcp` write with spawn-time `[Console]::OutputEncoding` setup, or pass
  `-NoLogo -NoProfile` and set encoding via the profile-free command line, so nothing is typed at
  the prompt.
- **D9**: extend `pickShell()` to check `%ProgramFiles%\PowerShell\7\pwsh.exe` and honour `PATHEXT`.

**Verify:** the §2.1 probe, re-run, must return **0 ESC bytes** and show `echo HELLO_MARKER_123`
exactly **once**. Then spawn a real Claude Code session and confirm `readyMarker` (`❯`) is detected
and the trust-prompt regex fires.

### Phase 5 — Runtime hardening *(fixes D5, D6, D7, D10)*

- **D5**: reverse the order in `killSession` — `pty.kill()` first, then `treeKill`.
- **D6**: give `exit` a synchronous path:
  ```ts
  process.once('exit', () => {
    for (const s of sessions.values()) {
      try { execFileSync('taskkill', ['/T','/F','/PID', String(s.pid)], { stdio: 'ignore' }) } catch {}
    }
  })
  ```
  Keep the async `killAll()` for `SIGINT`/`SIGTERM`.
- **D7**: in non-literal mode, join mapped tokens with `''` **only** when every token is a known
  KEYMAP key; otherwise treat the input as literal. Safer default than silently eating spaces.
- **D10**: add `resize(name, cols, rows)` to `PtyRuntime` as a **class method only** — do not change
  the `AgentRuntime` interface (hard rule #2). Callers that need it narrow via `instanceof`.

**Verify:** `killSession` produces **no** `AttachConsole failed` on stderr. Kill the server with
`taskkill /F` mid-run → no orphaned agent processes.

### Phase 6 — Monitor & dead code *(fixes D12, D13, D14, D15, D16, D17)*

Much smaller than `WINDOWS-PORT.md` §7 implies (see C1) — the monitor already renders from the HTTP
feed and never touches `capturePane`.

- Delete `closeITermSessionIfAny()` (`monitor.ts:476-507`) and its call at `:469`; drop the now-unused
  `spawnSync` import at `:15`.
- Guard raw mode: `if (process.stdin.isTTY) process.stdin.setRawMode(true)` — `:202` and `:468`.
- Delete `scripts/open-iterm-monitor.sh` and the 13 remaining `.sh` files superseded or macOS-only.
  Keep `generate-replay.py` / `parse-messages.py`, invoked explicitly as `python`.
- Strip the `.sh` chmod loop from `bin/postinstall.cjs`; drop `scripts/` from `package.json` `files[]`;
  drop the `tmux` keyword; fix the `types/agent-program.ts` comment.

**Verify:** `npm run monitor` renders in Windows Terminal, keybindings work, `q` exits cleanly, and
Process Monitor shows zero `bash`/`osascript` spawns.

### Phase 7 — Build, tests, CI *(fixes D19–D24)*

- `"start": "cross-env NODE_ENV=production tsx server.ts"` (D19).
- Add `"test": "vitest run"` (D20).
- Rewrite the 7 `team-say.sh` tests in `tests/ensemble.test.ts` against the Phase-2 subcommand (D21).
- CI → `runs-on: windows-latest`, add `npm test` (D22).
- `getCreatedBy()`: add `process.env.USERNAME` (D23).
- Optional: swap the two `curl` spawns for `fetch` (D24).

**Verify:** `npm run typecheck && npm run lint && npm test` all green on Windows; CI green.

### Phase 8 — Acceptance

Run the full §11 criteria from `WINDOWS-PORT.md`, plus:

9. Create/kill 10 teams in a row → `Get-Process node` returns to baseline every time.
10. `capturePane` on a live agent returns plain text, zero ESC bytes.
11. An agent emitting non-ASCII (e.g. `héllo ✓ 日本語`) shows no mojibake.
12. Kill an agent externally → watchdog marks it dead, server survives.
13. **Auth:** a 2-agent `claude` + `codex` team starts with **zero** login prompts, consuming
    subscription quota — verified by the absence of any API-key env var inside both sessions, and
    by the run appearing in normal subscription usage rather than API billing.

---

## 6. Effort & risk

| Phase | Scope | Risk | Est. |
|---|---|---|---|
| 1 · Paths | 6 files, mechanical | Low | 1–2h |
| 2 · Message bus | ~350 new LOC in `cli/ensemble.ts` | **Med** — concurrency on the JSONL append | 4–6h |
| 3 · Spawner | 2 files, ~60 LOC | Low | 1–2h |
| 4 · Terminal emulation | New dep + `capturePane` rewrite | **High** — must validate against real agent TUIs | 4–8h |
| 5 · Hardening | 4 targeted fixes | Low | 2–3h |
| 6 · Monitor + deletions | Mostly `rm` | Low | 1–2h |
| 7 · Build/tests/CI | Config + test rewrite | Low | 2–3h |

**~15–26h.** Phases 2 and 4 carry essentially all the risk.

**Sequencing constraint:** 1 → 2 → 3 can proceed independently of 4. Phase 4 can be developed in
parallel but must land before acceptance, because ready-detection and the auto-confirm gates
(currently the flakiest part of team startup) depend on it.

**Biggest unknown:** whether `@xterm/headless` faithfully reproduces what Claude Code and Codex paint
via ConPTY. Mitigation: build the §2.1 probe into a committed integration test before touching
`capturePane`, so the before/after is measurable rather than assumed.

---

## 7. Quick reference — file → defects

```
lib/pty-runtime.ts        D4 D5 D6 D7 D8 D9 D10
lib/agent-spawner.ts      D3 D11 D18
lib/agent-config.ts       D3
lib/collab-paths.ts       D2
lib/ensemble-registry.ts  D23
services/ensemble-service.ts  D1(prompt) D2(scrub) D24     ← relaxed "do not touch"
cli/ensemble.ts           D1(new subcommands) D2
cli/monitor.ts            D2 D12
scripts/*.sh              D1 D13 D14
bin/postinstall.cjs       D15
package.json              D16 D19 D20
tests/ensemble.test.ts    D21
.github/workflows/ci.yml  D22
types/agent-program.ts    D17
```
