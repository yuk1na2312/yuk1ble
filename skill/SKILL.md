---
name: collab
description: Start a collaborative AI team (Codex + Claude) to work on a task together. Use when the user says "werk samen met Codex", "collab", "team onderzoek", "laat Codex en Claude samenwerken", or wants multiple AI agents to analyze, research, or solve something together autonomously.
allowed-tools: Bash, Read, Write, Agent, TaskOutput
metadata:
  author: michel
  version: 7.0.0
---

# Collab: Autonomous AI Team Collaboration

**Language rule:** ALWAYS respond in the same language the user used to invoke /collab. If the user writes in English, all your output (status updates, summaries, everything) must be in English. If Dutch, respond in Dutch. Never mix languages.

Native Windows only — no tmux, no iTerm, no bash scripts. Launch a Codex + Claude team
through the ensemble HTTP API and CLI (`__ENSEMBLE_DIR__\bin\ensemble.cjs`, run with
`node`). Runtime files are namespaced under `%TEMP%\ensemble\<TEAM_ID>\` (Windows temp
dir; `lib/collab-paths.ts` resolves this as `os.tmpdir()/ensemble`, overridable with
`$env:ENSEMBLE_RUNTIME_DIR`).

## Path Convention
All collab artifacts live in `%TEMP%\ensemble\<TEAM_ID>\`:
- `messages.jsonl` — agent + ensemble message log (what `team-say`/`team-read` write and
  read; the server also merges its own `<ENSEMBLE_DATA_DIR>\messages\<TEAM_ID>\feed.jsonl`,
  default `~\.ensemble\messages\<TEAM_ID>\feed.jsonl`, when you read via the API)
- `summary.txt` — written on disband by ensemble-service
- `bridge.pid` — PID of the `ensemble bridge` process, spawned automatically on team
  creation (see Step 2)
- `bridge.log` — bridge stdout/stderr; check here if push delivery isn't working
- `prompts/`, `delivery/` — agent prompt/delivery files
- `.finished` — written by ensemble-service AFTER summary.txt

There is no `team-id` marker file. The team ID comes back directly in the JSON response
of the team-create API call (Step 1) — capture it there, don't read it from disk.

## Workflow

### Step 1: Launch the team

The server (`npm run dev`, port 23000 by default) must already be running. Create the
team via the HTTP API:

```powershell
$body = @{
  name = "collab-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
  description = "$TASK_DESCRIPTION"
  agents = @(
    @{ program = "claude"; role = "lead" },
    @{ program = "codex"; role = "worker" }
  )
  workingDirectory = (Get-Location).Path
} | ConvertTo-Json -Depth 5

$result = Invoke-RestMethod -Uri "http://localhost:23000/api/ensemble/teams" -Method Post -ContentType "application/json" -Body $body
$TEAM_ID = $result.team.id
```

`program` must be a key in `agents.json`: `claude`, `codex`, `aider`, `gemini`, or
`opencode`.

### Step 2: Confirm the message bridge is running

`createEnsembleTeam` spawns the bridge for you, detached, as soon as the team goes
active — you do **not** start it by hand. The bridge is what pastes one agent's
`team-say` into the *other* agent's terminal; without it, messages only accumulate in
`messages.jsonl` and a quiet agent is never woken.

Verify it came up (it writes its own PID file at spawn time):

```powershell
$RD = "$env:TEMP\ensemble\$TEAM_ID"
$bridgePid = Get-Content "$RD\bridge.pid" -ErrorAction SilentlyContinue
if ($bridgePid -and (Get-Process -Id $bridgePid -ErrorAction SilentlyContinue)) {
  "bridge running (pid $bridgePid)"
} else {
  "BRIDGE NOT RUNNING — see $RD\bridge.log; push delivery is down"
}
```

If it did not start, team creation still succeeded and `team-read` still works — the
collaboration degrades to pull-only rather than failing outright. Check `bridge.log` in
the same directory, and tell the user push delivery is down.

The bridge stops itself: on the `.finished` marker, and also if the server becomes
unreachable for three consecutive 30s health checks. Disband tree-kills it as a backstop.

### Step 3: Tell the user where to watch

The user can optionally open a second terminal (Windows Terminal) for the live TUI
monitor:
```powershell
npm run monitor                                          # most recently active team
node "__ENSEMBLE_DIR__\bin\ensemble.cjs" monitor "<TEAM_ID>"   # this specific team
```
This is optional — Step 4 already surfaces the conversation inline in this chat.

### Step 4: Monitoring — the user MUST see the conversation

**CRITICAL RULE**: The user wants to SEE the team's conversation as it happens. Every
poll result must be presented clearly and formatted as a readable conversation. Do NOT
just dump raw output — format it as a proper dialogue.

Poll `messages.jsonl` and present only the NEW lines each time — track how many lines
you've already shown between polls (e.g. with the Read tool's `offset`, or by counting
lines yourself):

```powershell
$RD = "$env:TEMP\ensemble\<TEAM_ID>"
Get-Content "$RD\messages.jsonl" -Tail 50
```

Each line is one JSON object: `{"from": "...", "to": "...", "content": "...", ...}`.
Skip `from: "ensemble"` lines unless they're a status you want to surface (e.g. an agent
leaving).

**Presentation rules — THIS IS THE KEY PART:**
After each poll, present the new messages to the user like this:

> **codex-1**: [message content]
>
> **claude-2**: [message content]

Use markdown bold for agent names. Show the FULL message content (up to 500 chars), not
truncated summaries. Between polls, add a brief status line like "Team is working... next
check in 15s."

**Completion check**, each poll:
```powershell
Test-Path "$RD\.finished"
```
`summary.txt` is written before `.finished`, so once `.finished` exists it's safe to read
`summary.txt` and present it as the final summary. Stop polling.

**Polling cadence:**
- First poll: wait ~10s
- Normal: wait 15-20s between polls
- If 3+ consecutive polls with no new lines: wait 30s (agents in deep work)
- On `.finished`: stop polling, present final summary

**When done**, cleanup is fully automatic: the server tears down the agent sessions and
writes `summary.txt` itself (auto-disband, `disbandTeam` in
`services/ensemble-service.ts`), which also stops the bridge — gracefully via the
`.finished` marker, then tree-kills it as a backstop. Nothing needs to be killed
manually. If you want to be sure, check that the PID in `bridge.pid` has exited
(`Get-Process -Id <pid> -ErrorAction SilentlyContinue`).

## Important Notes
- Agents run with auto-accept permissions configured in `agents.json`: codex uses
  `--dangerously-bypass-approvals-and-sandbox`, claude uses `--permission-mode auto`.
  They should NEVER ask for file write approval.
- Do not modify project code during a collab session unless the user explicitly asks
- Do not truncate or remove `messages.jsonl`
- Multiple collabs can run simultaneously — each has its own `%TEMP%\ensemble\<TEAM_ID>\` namespace
- The message bus is `team-say` / `team-read`, Node CLI subcommands in `cli/ensemble.ts`.
  Agents invoke them as `node "__ENSEMBLE_DIR__\bin\ensemble.cjs" team-say <team-id> <from> <to> <message>`.
  Writes are appended to `messages.jsonl` under an atomic `fs.mkdirSync`-based lock
  (`acquireFileLock` in `lib/ensemble-registry.ts`) — there is no `.sh` script or
  `fcntl.flock` involved.
- `ensemble bridge <team-id>` has a PID-file guard (won't double-spawn for the same
  team), a server health check on startup, and exponential backoff on delivery failures.
- `.finished` and `summary.txt` are written by ensemble-service, NOT by the CLI or the bridge.
- Bridge auto-stops when it sees the `.finished` marker.
