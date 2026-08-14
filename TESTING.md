# Testing ensemble-win

Two kinds of test live here, and they cost very different things:

- **Offline checks** — typecheck, lint, 96 unit/integration tests. Seconds, free, run them
  before every commit.
- **A live run** — spawns real `claude` and `codex` sessions and spends your subscription
  quota. This is the only thing that proves the port, because every defect found so far was
  invisible to the offline checks.

Run the offline checks first. A live run on code that fails `tsc` tells you nothing.

---

## Part 1 — Offline (always)

```powershell
cd E:\projects\ensemble-win\yuk1naaa
npm install          # first time only; needs VS Build Tools "Desktop development with C++"
npm run typecheck
npm run lint
npm test
```

Expect `96 passed (96)` across 9 files. If `npm install` fails on `node-pty`, that is the
C++ toolchain — `postinstall` prints the prerequisites.

**What the tests do and do not cover.** They pin behaviour against **verbatim terminal
screens captured from real sessions** — Codex's hooks-review gate, Claude's folder-trust
modal, a parked `[Pasted Content …]` composer. So they catch a regression in *how a known
screen is handled*. They cannot catch a new screen, an upstream CLI redesign, a timing
problem under real load, or an orphaned process. That is what Part 2 is for.

---

## Part 2 — A live two-agent run

You need **two Windows Terminal windows** and a browser.

### 0 · Start the server, freshly

A server started before your latest edit is still running the old code in memory. This has
already caused one wasted run — do not skip it.

```powershell
# Ctrl-C any running server, then confirm the port is free:
Get-NetTCPConnection -LocalPort 23000 -State Listen -ErrorAction SilentlyContinue
```

That must print nothing. Then, in **terminal 1**:

```powershell
cd E:\projects\ensemble-win\yuk1naaa
npm run dev
```

Expect `[Ensemble] Server running on http://127.0.0.1:23000`. Leave it running.

### 1 · Open the GUI

Browser → **<http://localhost:23000/>**

The header dot goes green (`server up`). You get a Teams column, a transcript, live agent
panes, and a Server-log panel mirroring terminal 1. A 404 here means the server is an old
build — go back to step 0.

### 2 · Launch a team

Either click **+ new** in the GUI and fill in the task, or in **terminal 2**:

```powershell
cd E:\projects\ensemble-win\yuk1naaa
npm run cli -- run "Write a short hello.txt in a scratch folder, then discuss and agree on a one-line improvement to it."
```

Both post an identical payload. Click the team in the Teams column; the right-hand column
shows **one live PTY pane per agent**.

> Give it a working directory you don't mind agents writing to. Blank means the server's
> own directory.

### 3 · Startup — watch the panes, not just the log

**codex-1** should go: `Hooks need review` menu appears → clears itself within ~1s
(terminal 1 logs `Auto-confirmed codex hooks review … (attempt 1/5)`) → the
`>_ OpenAI Codex (v…)` banner renders → `codex-1 is ready (Ns, matched "OpenAI Codex")`.

**claude-2** may take 60–120s with a heavy MCP/hook stack. That is normal; the window is
150s (`ENSEMBLE_READY_TIMEOUT_MS`). In a directory claude has not seen before, it first
shows a **folder-trust** dialog, which is auto-answered.

| Symptom | Meaning |
|---|---|
| `ready` in ~1s while the pane still shows a menu | A ready marker is matching a modal's selection cursor. This has happened to both CLIs (`›`, `❯`) — the gate must be evaluated before the marker. |
| `assumed ready (…screen has been idle for 20s)` | Normal fallback, not an error: the CLI is at a prompt we don't have a marker for. Worth reporting so a marker can be added. |
| `did not become ready within 150s` | The log now prints **the last 12 lines of that agent's screen** right after. Copy those lines — they are the whole diagnosis. |

### 4 · The prompt must actually submit

Keep watching **codex-1**:

```
› [Pasted Content 1929 chars]      ← appears
                                    ← and disappears within a few seconds
```

That disappearance *is* `ensureSubmitted()` sending a standalone Enter. A paste alone never
submits; the CLI treats the trailing CR as part of the paste burst.

❌ If `[Pasted Content N chars]` (or claude's `[Pasted text #1 …]`) sits there and the agent
never speaks, `ensureSubmitted` is not firing. Capture that pane.

### 5 · Two-way conversation

In the transcript, the pass condition is **alternation**: codex-1 replies to claude-2
without being polled. Each speaker has its own colour and icon — **◆ codex blue**,
**● claude green**, **⚙ ensemble amber** — so one-sidedness is visible at a glance.

❌ Every message from one name only is the classic failure. Cross-check the bridge
(team id from the GUI or `npm run cli -- status`):

```powershell
$RD = "$env:TEMP\ensemble\<TEAM_ID>"
Get-Content "$RD\bridge.pid"
Get-Content "$RD\bridge.log" -Tail 20
```

### 6 · Steer them

Type in the composer under the transcript, choose `→ team` or a single agent, send. The
text must land in that agent's **pane** — not just the transcript — and be acted on. This
exercises the same submit path as step 4 for teammate delivery.

### 7 · Auth stays on your subscription

No login prompt in either pane. The run should show up in Claude/Codex **subscription**
usage, not API billing. `PtyRuntime` strips `ANTHROPIC_*` / `OPENAI_*` / `GEMINI_API_KEY` /
`CLAUDECODE*` from the session environment for exactly this reason. To switch accounts:
`codex logout` then `codex login` — never `codex login --with-api-key`.

### 8 · Kill an agent from outside

End one agent's process in Task Manager. Expect: the server stays up; that pane's header
flips to **no session**; **exactly one** watchdog "stalled: session is gone" message, not
one every 30s; and `stalledAt` set on that agent in `GET /api/ensemble/teams`.

### 9 · Teardown leaves nothing behind

Click **disband**, then:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*bridge*' }
Get-Process claude,codex -ErrorAction SilentlyContinue
```

Both must come back empty. Two traps: agent CLIs you started yourself also appear here, so
match on start time before calling something an orphan; and **codex runs as
`powershell → node.exe → codex.exe`**, so a check of direct children will tell you a live
agent is dead.

Repeat steps 2→9 a few times. Process count must return to baseline every single time —
orphaned processes are the main Windows stability risk, and they accumulate silently.

---

## How a run ends

Only three things end a run. Nothing is inferred from what the agents *say*:

1. **Both** agents send exactly `<<COLLAB_DONE>>` — immediate. This is the documented
   protocol and the only fast path.
2. You click **disband**.
3. **One hour** of silence — `ENSEMBLE_IDLE_DISBAND_MS`, floor 60s.

If you are testing the idle path, set `ENSEMBLE_IDLE_DISBAND_MS=60000` rather than waiting
an hour. An earlier build guessed completion from words like "done" and killed a healthy
run five seconds after the lead proposed closure, mid-reply — if you ever see a run end
without one of the three reasons above, that heuristic is back.

---

## When something fails, capture this

In order of usefulness:

1. **The failing agent's pane text**, from the GUI. This was unobservable for two entire
   runs and is why they were misdiagnosed twice.
2. Terminal 1's output — also in the GUI's Server-log panel, so you can copy it there.
3. `%TEMP%\ensemble\<TEAM_ID>\` → `bridge.log`, `messages.jsonl`, `summary.txt`.
4. The team record: `npm run cli -- status`, or `GET /api/ensemble/teams`.

Two diagnostic habits, both learned the hard way:

- **Read the captured screen. Do not trust a heuristic over it.** A probe once reported
  "submitted: true" because its regex matched a startup spinner, while the screen plainly
  showed the paste still parked.
- **Walk the full process ancestry**, never just direct children — see the npm-shim trap in
  step 9.

---

## Probing a CLI without spending quota

Starting an agent CLI costs nothing; only submitting a prompt does. To see what a real
startup screen looks like — to add a ready marker, or to check a new gate — drive it
through `PtyRuntime` from a throwaway script and snapshot `capturePane` on a timer:

```ts
const { setRuntime, getRuntime } = await import('./lib/agent-runtime.ts')
const { PtyRuntime } = await import('./lib/pty-runtime.ts')
const { resolveStartCommand } = await import('./lib/agent-spawner.ts')

setRuntime(new PtyRuntime())
const runtime = getRuntime()
const cwd = 'E:\\projects\\ensemble-win\\yuk1naaa'   // backslashes: a forward-slash cwd
                                                     // fails with pty error code 267
await runtime.createSession('probe', cwd)
await new Promise(r => setTimeout(r, 300))
await runtime.sendKeys('probe', resolveStartCommand('claude code', cwd), { literal: true, enter: true })

for (let i = 0; i < 6; i++) {
  await new Promise(r => setTimeout(r, 10_000))
  console.log(`--- t+${(i + 1) * 10}s ---\n` + await runtime.capturePane('probe', 50))
}
await runtime.killSession('probe')
```

Run it with `npx tsx <file>`. Paste the captured screen into a test as a fixture — every
readiness test in `tests/readiness-gates.test.ts` was built exactly this way.
