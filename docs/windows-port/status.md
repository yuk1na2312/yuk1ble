# Windows Port — Status (updated 2026-08-13)

Companion to `WINDOWS-PORT-PLAN.md` (the plan) and `WINDOWS-PORT.md` (the original spec).

Branch `windows-port`, base HEAD `fb1dd31`. **All work is uncommitted in the working tree.**
Personal-use fork — GitHub/PR/CI workflow deliberately skipped.

---

## TL;DR

Four live runs happened. Runs 1, 2 and 3 each exposed real defects; all are fixed.
`typecheck`, `lint`, and **96 tests / 9 files** are green. (Test count fell from 101
because 14 assertions covering the deleted "someone said *done*" heuristic went with it,
replaced by 9 covering readiness and the new idle rule.)

**Run 3 (`run-1786633999449`) succeeded end to end** — both agents talked, produced the
requested file, and reviewed it — but surfaced three problems, all now fixed:

| # | Problem | Fix |
|---|---|---|
| 1 | `claude-2 did not become ready within 150s (looking for "❯")`, then was prompted best-effort anyway | Multiple ready markers per program, a quiescent-screen fallback, and the failing screen is now dumped to the log |
| 2 | Both agents rendered identically in the transcript | Per-speaker colour + icon in the GUI (codex ◆ blue, claude ● green, ensemble ⚙ amber) |
| 3 | Team auto-disbanded ~5s after a closing remark, mid-conversation | Wording heuristics deleted; a run now ends on the `<<COLLAB_DONE>>` sentinel, a manual disband, or **1 hour** of silence (`ENSEMBLE_IDLE_DISBAND_MS`) |

The headline fix from run 2: **codex never submitted its prompt** — `pasteFromFile` parks
a large paste in the CLI's composer, and only a *standalone* Enter submits it. That single
defect explains every "codex-1 spawned but never spoke" symptom across both runs. It hit
three call sites (prompt injection, teammate delivery, watchdog nudge).

There is now a **monitoring GUI at <http://localhost:23000/>** so you no longer need
several terminals — and, more importantly, so an agent's screen is observable at all.

**What's left is run 3 — yours to do**, because it launches real `claude`/`codex` sessions
against your subscription. Step-by-step below.

---

## Fixed before the first live run (2026-08-12)

| Item | What was wrong | Fix |
|---|---|---|
| **P0-1** agent launch | `'claude' '--permission-mode' 'auto'` — PowerShell parses a leading quoted string in *expression* mode, so no agent could ever start | `&` call operator via `toPowerShellCommandLine()` |
| **P0-1b** path corruption | trailing `\` on a whitespace path escapes PowerShell's closing quote — `C:\My Projects\` → `C:\My Projects"` | `normalizeDirArg()` strips the redundant separator, preserves roots |
| **P0-2** push delivery | `cmdBridge` was complete but nothing spawned it (`collab-launch.sh` deleted in `d24743d`) | `startCollabBridge()` spawns it detached from `createEnsembleTeam`; tree-kill on disband |
| **P1** watchdog spam | catch path never set `nudgedAt` → re-failed and re-posted every 30s forever, never reached `stalled` | `handleNudgeFailure()` distinguishes gone (via `sessionExists`) from transient; one message per transition |
| **P1** `skill/SKILL.md` | corrupted with pasted transcript, plus fully pre-port (`/tmp`, `$TMUX`, `osascript`, `team-say.sh`) | de-corrupted and rewritten for native Windows |
| **P2** `README.md` | pointed at two deleted `.sh` entrypoints; documented iTerm2/tmux modes and env vars that no longer exist | rewritten against actual `package.json` + `cli/ensemble.ts` |
| **P2** vacuous test | `capturePane` marker matched the *echoed command*, not output | marker built by concatenation; rendered vs echoed counted separately |
| dead code | `buildAgentCommand()` carried the same P0-1 bug, zero callers | deleted |

Two P3s were also closed: the stale "breaks in zsh" comment, and an explicit timeout on
`onboarding-smoke.test.ts` (it does a real team create, ran ~4.5s against a 5s default).

## Fixed after the first live run (2026-08-13)

The first real 2-agent run surfaced four defects that only a live launch could expose.
All were diagnosed against verbatim `capturePane` output from real CLI sessions.

| Item | What was wrong | Fix |
|---|---|---|
| **P0-3** codex never started | Codex ≥0.147 opens on a **"Hooks need review"** modal. Its `›` selection cursor **is** codex's old `readyMarker`, so ensemble declared "codex-1 is ready (3s)" against a screen that was blocking startup, then pasted the prompt into a CLI with no input prompt. | `readyMarker` → `"OpenAI Codex"` (its banner, which only renders past the gate) + a new auto-confirm gate that answers the modal |
| **P0-4** false "not ready" | 60s readiness window; a Claude Code with a large MCP/hook stack routinely needs longer on a cold start. It was reported as failed while it went on to do all the work. | `READY_TIMEOUT_MS` default 150s, `ENSEMBLE_READY_TIMEOUT_MS` to override |
| **P1** misleading failures | `waitForReady` swallowed every error, so a **dead** session was indistinguishable from a slow one — it burned the full window and blamed a timeout. Injection then pasted into it and raised "PTY session not found". | early `sessionExists` bail-out; last error surfaced in the timeout log; dead sessions excluded from injection with an explicit message |
| **P1** disband during startup | Disbanding mid-startup left `createEnsembleTeam` marching on, reporting "PTY session not found" for sessions it had killed itself. | `teamWasDisbanded()` checked in the readiness loop and before injection |

Also hardened: a gate that never clears is abandoned after `MAX_GATE_ATTEMPTS` (5) so a
permanently-matching screen can't starve the readiness check — the old code `continue`d
past readiness forever while a gate matched.

**Not a defect:** subscription auth. `codex login status` → *Logged in using ChatGPT*,
`auth_mode: chatgpt`, no API key. The env deny-list is doing its job.

## Second live run (2026-08-13, `run-1786600171648`) — all items now resolved

> Kept as written at the time, because the reasoning matters. **O-1's stated cause turned
> out to be wrong** — see "Resolution" below. Everything else held up.

Second 2-agent run (codex-1 lead, claude-2 worker). Diagnosed from inside the run by
claude-2, so **without** `capturePane` — see O-2 for why that was impossible. Evidence
level is stated per item; nothing here is verified against terminal output.

**What the run proved works** — spawn, PowerShell invocation, flag passing, PTY
parentage, the message bus (`team-say` → `messages.jsonl` → `team-read` round-tripped
from a spawned agent), watchdog nudge, and watchdog stall detection. The full process
tree was confirmed live:

```
server (13188)
├─ powershell (29180) → node codex.js --dangerously-bypass-approvals-and-sandbox (30132) → codex.exe (30184)
└─ powershell (29488) → claude.exe --permission-mode auto (30520)
```

| Item | What is wrong | Evidence |
|---|---|---|
| **O-1** readiness detection is wrong in **both** directions | codex-1 was injected via the **normal** readyMarker path (`2 agents received their task (1 via best-effort fallback)` — the fallback was claude-2's), then never emitted a single message and was marked stalled at 180s. claude-2 was reported as *"did not signal ready in time"* while demonstrably running, and only got its task via best-effort fallback. So: false **positive** for codex, false **negative** for claude. The P0-3 fix (banner `readyMarker`) did not resolve the codex case. | Strong for the symptom; the *cause* (banner rendering under the gate) is a hypothesis, unverified |
| **O-2** PTY output is unobservable outside the server | `capturePane` reads a module-level `Map` inside the server process. The server exposes only `/api/v1/health` and `/api/ensemble/teams` — no capture endpoint. **No external tool can ever see an agent's terminal.** | Verified by grep |
| **O-3** `cli/monitor.ts:21` builds a second, empty session registry | The monitor calls `setRuntime(new PtyRuntime())` in its **own process**, creating a permanently empty `sessions` map. Any `sessionExists`/`capturePane` call from the monitor returns "no such session" *silently*. Worse than dead code — it reads like working wiring. | Verified by grep |
| **O-4** the monitor never calls `capturePane` | It drives entirely off HTTP (`monitor.ts:262,268`). Its "live feed" is the **message bus**, not terminal output. Phase 4 specified "drive the view purely from `capturePane` on a timer"; that was not implemented. Acceptance criterion 5 passes only under the weaker reading of "live feed". | Verified by grep |
| **O-5** watchdog stall never reaches the registry | After codex-1 was marked stalled, `GET /api/ensemble/teams` still reported `status: 'active'`. The watchdog records `stalledAt` only in its own in-memory state map (`agent-watchdog.ts:145`). Every API consumer sees a healthy lead that is dead. | Verified |

Circumstantial only, recorded so it isn't re-derived: codex-1 took its thread writer lock
at the spawn moment (`~/.codex/thread-writer-locks/019ff9ab-…lock`, 12:49) but wrote **no**
rollout `.jsonl` and left `state_5.sqlite-wal` untouched for the following ~20 min. That
fits a session that never received a user turn. Do **not** use the `threads.has_user_event`
column to argue this — it reads `0` even on old threads that provably contain user
messages.

**Suggested order for the next session:** fix O-2/O-3 first (one read-only
`GET …/agents/:name/pane` endpoint + delete `monitor.ts:21`). Until an agent's screen is
observable, O-1 can only ever be diagnosed circumstantially — which is exactly where this
run ended.

### Resolution of O-1 … O-5 (2026-08-13, later the same day)

That advice was right, and following it immediately produced the real cause of O-1.

**O-1 was misdiagnosed — it is not a readiness bug at all.** Codex *did* start, *was*
ready, and *did* receive the paste. The defect is that **codex never submits a pasted
prompt**. Captured live from a real session:

```
› [Pasted Content 1929 chars]        ← still there at +6s and +8s. Never submitted.
```

`pasteFromFile` writes the file contents and `"\r"` back-to-back; codex treats that CR as
part of the paste burst and parks the text in its composer. A **standalone** Enter sent a
moment later submits it — verified: the agent then replied `PONG`. `ensemble-service.ts`
already did this dance, but gated on `program.includes('claude')`, so codex never got it.

The same unconfirmed paste was used by **teammate message delivery** and by the
**watchdog nudge**, so even a correctly prompted codex would have swallowed every
incoming message and every nudge in silence — which is exactly the "one-sided
conversation" this run produced.

| Item | Resolution |
|---|---|
| **O-1** | Root cause was the parked paste, not readiness. `lib/paste-submit.ts` — `ensureSubmitted()` retries Enter (bounded, 3 attempts) until the composer clears. Wired into prompt injection, message delivery, and the watchdog nudge. |
| **O-2** | `GET /api/ensemble/sessions/:name/pane?lines=N` returns rendered terminal output. Agent screens are now observable from outside the server. |
| **O-3** | `setRuntime(new PtyRuntime())` deleted from `cli/monitor.ts`, with a comment explaining why the monitor must stay a pure HTTP client. |
| **O-4** | Superseded: the browser GUI renders live panes from the new endpoint. The TUI monitor stays message-bus-driven by design. |
| **O-5** | New `EnsembleTeamAgent.stalledAt`, set by the watchdog via a `markAgentStalled` dep. Deliberately **not** folded into `status` — delivery targets `status === 'active'`, so a stalled agent must stay 'active' to be able to recover. |

The circumstantial `~/.codex` evidence in the previous section is consistent with this:
codex took its thread-writer lock at spawn and wrote no rollout, because it never received
a user turn — the turn was sitting unsubmitted in its composer.

---

## Third live run (2026-08-13, `run-1786633999449`) — the collaboration worked

Both agents greeted, planned, wrote `it-market-discussion.txt`, reviewed it twice, and
converged. The message bus, push delivery, prompt submission and the watchdog all behaved.
Three things were wrong around the edges.

### R-1 — claude's readiness check timed out while claude was fine

```
10:15:51 [Ensemble] run-…-claude-2 did not become ready within 150s (looking for "❯")
10:15:51 [Ensemble] … attempting prompt injection anyway
```

The best-effort fallback saved the run, but 150s was wasted and the log implied a failure
that never happened. Probing a live `claude` session through `PtyRuntime` showed two
distinct traps:

* **The marker is also a modal cursor.** In a directory claude has not seen before, the
  first screen is `❯ 1. Yes, I trust this folder` — the same `❯` that means "ready". This
  is the exact trap codex's `›` fell into. It is safe *only* because the auto-confirm gate
  for `Quick safety check:` is evaluated before the marker; both screens are now pinned as
  verbatim fixtures in `tests/readiness-gates.test.ts`.
* **One glyph is a single point of failure.** Nothing else in the check survives an
  upstream UI tweak.

Three changes, none of which weaken the gate ordering:

| Change | Where |
|---|---|
| `readyMarkers?: string[]` — any one marker is enough | `types/agent-program.ts`, `agents.json`, `resolveReadyMarkers()` |
| Quiescent-screen fallback: a non-empty screen that is byte-identical for 20s counts as ready, because a starting CLI redraws constantly. Explicitly excludes an empty screen and a bare `PS …>` prompt, which are still for the opposite reason | `lib/pane-readiness.ts` |
| On timeout, the last screen is logged (12 lines) | `waitForReady` |

That last one matters most: the session is killed on disband and its screen goes with it,
so a timeout used to be undiagnosable after the fact. The exact cause of *this* timeout is
therefore still unproven — the next occurrence will explain itself.

### R-2 — both agents looked the same in the transcript

The GUI now colours every speaker: **◆ codex blue**, **● claude green**, **⚙ ensemble
amber**, **› user**, with a matching left stripe on each message and a matching agent-pane
header. Two agents on the same program keep the icon and get distinct colours.

Also fixed while there: `#newTeam { display: flex }` outranked the browser's `[hidden]`
rule, so the "+ new" form was permanently open. Needed `#newTeam[hidden] { display: none }`.

### R-3 — the team auto-disbanded mid-conversation

The run ended 5 seconds after the lead wrote *"I think we are done because…"*, while the
worker was still replying. Two fuzzy rules did it: any two agents matching
`/done|completed|klaar|afgerond/`-ish patterns within 3 minutes disbanded **immediately**,
and a single such match disbanded after 120s idle. Those words appear constantly in normal
working chatter.

Both rules are deleted. A run now ends when:

1. **both** agents send the exact `<<COLLAB_DONE>>` sentinel (immediate — the documented
   protocol, and the only fast path), or
2. the user disbands it, or
3. nothing has been said for **1 hour** (`ENSEMBLE_IDLE_DISBAND_MS`, floor 60s).

The disband notice now states the real reason instead of the hardcoded, and by then
already wrong, "after 60s idle".

---

## Monitoring GUI

Replaces juggling several terminal windows. With the server running, open
**<http://localhost:23000/>**.

One page: **create a team** (+ new) · teams list · transcript + a steer composer · **live
agent PTY panes** · the server console stream. Polls every 2s. Vanilla HTML/CSS/JS in
`public/index.html`, no build step and no dependencies. Rendering verified live with
Playwright against a running server.

**Team creation** posts the same payload as `npm run cli -- run` (`name: run-<ts>`,
`feedMode: 'live'`, first agent is lead). The POST does not return until every agent is
ready and prompted — up to ~150s — so the UI deliberately does **not** await it: the team
record is written early, so normal polling surfaces it within ~2s. Errors still surface
when the promise settles.

Endpoints it uses (all additive, all read-only except the existing send/disband):

| Route | Purpose |
|---|---|
| `GET /` | the page itself |
| `GET /api/ensemble/sessions/:name/pane?lines=N` | rendered terminal output for one agent |
| `GET /api/ensemble/logs?since=<seq>` | server console ring buffer (`lib/log-buffer.ts`, 2000 entries) |

Session names are `<team.name>-<agent.name>`.

## Notable design decisions

- **Bridge pid lives in `bridge.pid` + an in-memory ownership map, not the team record.**
  A JSON record can't be cleaned up after a hard crash. A recovered pid must prove itself
  via `Get-CimInstance Win32_Process` (command line must contain both the `bridge` verb
  *and* the team id) before anything kills it — a recycled pid is never killed blind.
- **The bridge is spawned as `node --import tsx cli/ensemble.ts`, not via
  `bin/ensemble.cjs`** — the wrapper `execFileSync`s a grandchild, so the wrapper's pid
  would be the wrong process to track.
- **Bridge self-terminates** on `.finished`, or after 3 consecutive failed 30s health
  checks if the server vanishes. Verified live: a bridge left by the test suite reaped
  itself with no orphan.
- **Trailing-backslash fix deliberately avoids the textbook "double the backslash"**,
  because `claude` installs as a `.ps1` shim that receives PowerShell strings with no
  command-line re-parse — doubling would corrupt that path instead.

## Corrected from the previous handoff

**`resize()` having "no production caller" is not a defect.** `cli/monitor.ts` is a pure
HTTP client that never calls `getRuntime()` or `capturePane`. The only `capturePane`
consumers regex-scrape rather than render, so a fixed 120×40 is actually preferable — it
keeps scraping deterministic. No HTTP resize endpoint was invented.

---

## How to test — step by step

You need **two Windows Terminal windows** and **a browser**. Everything else that used to
need its own terminal is now in the GUI.

---

### Step 0 — Restart the server (mandatory)

A server started before these fixes is running the old code **in memory**. That is what
made run 2 look like the fixes had not worked. Stop any running server first.

```powershell
# In the window running the old server: Ctrl-C. Then confirm nothing is left:
Get-NetTCPConnection -LocalPort 23000 -State Listen -ErrorAction SilentlyContinue
```

That must print nothing. Then, in **terminal 1**:

```powershell
cd E:\projects\ensemble-win\ensemble
npm run dev
```

Leave it running. Expect `[Ensemble] Server running on http://127.0.0.1:23000`.

---

### Step 1 — Open the GUI

Browser → **<http://localhost:23000/>**

You should see the header dot go green (`server up`), a **Teams** column (probably listing
old teams), and a **Server log** panel at the bottom right mirroring terminal 1.

> If the page 404s, the server is the old build — go back to Step 0.

---

### Step 2 — Launch a 2-agent team

In **terminal 2**:

```powershell
cd E:\projects\ensemble-win\ensemble
npm run cli -- run "Write a short hello.txt in a scratch folder, then discuss and agree on a one-line improvement to it."
```

Click the new team in the GUI's Teams column. The right-hand column now shows **one live
PTY pane per agent**.

---

### Step 3 — Watch startup in the panes *(this is the P0-3 check)*

In the **codex-1** pane, expect this sequence:

1. A `Hooks need review` menu appears — and disappears on its own within ~1s.
   Terminal 1 logs `[Ensemble] Auto-confirmed codex hooks review … (attempt 1/5)`.
2. The codex banner renders: `>_ OpenAI Codex (v…)`, `permissions: YOLO mode`.
3. Terminal 1 logs `[Ensemble] codex-1 is ready (Ns)`.

❌ **Fail:** `codex-1 is ready` appears in under ~3s while the pane still shows the hooks
menu → the banner `readyMarker` regressed.

claude-2 may legitimately take 60–120s if it loads a large MCP/hook stack. That is fine
now — the timeout is 150s (`ENSEMBLE_READY_TIMEOUT_MS`).

---

### Step 4 — Watch the prompt submit *(the run-2 defect — the important one)*

Keep watching the **codex-1** pane. You should see:

```
› [Pasted Content 1929 chars]      ← appears
                                    ← then DISAPPEARS within a few seconds
```

That disappearance **is** the fix (`ensureSubmitted` sending a standalone Enter). Codex
then starts working and the transcript fills.

❌ **Fail:** `[Pasted Content N chars]` stays on screen indefinitely and codex never
speaks → `ensureSubmitted` is not firing. Grab that pane's text.

---

### Step 5 — Confirm two-way conversation *(P0-2, push delivery)*

In the GUI **Transcript** column, the success condition is that **codex-1 replies to
claude-2 without being polled** — messages alternate between both names.

❌ **Fail:** every message is from one agent only. That is the run-1/run-2 symptom.

Optional cross-check that the bridge is alive (team id is in the GUI / `npm run cli -- status`):

```powershell
$RD = "$env:TEMP\ensemble\<TEAM_ID>"
Get-Content "$RD\bridge.pid"
Get-Content "$RD\bridge.log" -Tail 20
```

---

### Step 6 — Steer them from the GUI

Type into the composer under the transcript, pick `→ team` or a single agent, send.
The message must appear in that agent's **pane** (not just the transcript) and be acted
on. This exercises the same paste path as Step 4 for teammate delivery.

---

### Step 7 — Subscription auth (criterion 13)

No login prompt in either pane. The run should appear in your Claude/Codex **subscription**
usage, not API billing. Already verified statically:
`codex login status` → *Logged in using ChatGPT*, `auth_mode: chatgpt`, no API key.
To switch accounts: `codex logout` then `codex login` (never `--with-api-key`).

---

### Step 8 — Kill an agent externally (criterion 12)

End one agent's process in Task Manager. Expect:
- the server stays up;
- that agent's pane header flips to **no session** (red);
- **exactly one** watchdog "stalled: session is gone" message — not one every 30s;
- `GET /api/ensemble/teams` now carries `stalledAt` on that agent (the O-5 fix).

---

### Step 9 — Tear down and check for orphans (criterion 6/9)

Click **disband** in the GUI, then:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*bridge*' }
Get-Process claude,codex -ErrorAction SilentlyContinue
```

Both must come back empty. Note `claude`/`codex` you started yourself will also show here —
match on start time before assuming an orphan, and remember **codex runs as
`powershell → node → codex.exe`**, so check the whole tree, not direct children.

Repeat Steps 2→9 a few times; process count must return to baseline every time.

### If something fails

Most useful artifacts, in order:
1. **The agent's pane text from the GUI** — this is the one that was missing for two runs.
2. Terminal 1's console output (also in the GUI's Server log panel).
3. `%TEMP%\ensemble\<TEAM_ID>\bridge.log` and `messages.jsonl`.

---

## Environment caveat

`pwsh` is not on PATH on this machine, so everything was verified against Windows
PowerShell 5.1 — the weaker shell, so results are conservative. PowerShell 7.3+ changed
native-argument passing (`$PSNativeCommandArgumentPassing`); if you install `pwsh`, the
trailing-backslash behavior is worth re-probing, though `normalizeDirArg` makes ensemble
immune either way.

## Note on agent permissions

`agents.json` runs agents with auto-accept: codex uses
`--dangerously-bypass-approvals-and-sandbox`, gemini uses `--yolo`, claude uses
`--permission-mode auto`. That is pre-existing config, inherent to unattended
collaboration — but it does mean a spawned agent can write files without asking. Point
teams at a scratch directory until you trust a given workflow.
