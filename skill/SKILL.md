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
Runtime artifacts live in `%TEMP%\ensemble\<TEAM_ID>\`:
- `summary.txt` — written on disband by ensemble-service
- `prompts/` — what each agent was told at startup (a debugging record)
- `.finished` — written by ensemble-service AFTER summary.txt

The **transcript is not in that directory.** The server holds it in memory and logs every
message, one JSON object per line (each with a per-team `seq`), to
`<ENSEMBLE_DATA_DIR>\ensemble\messages\<TEAM_ID>\feed.jsonl` — by default
`%USERPROFILE%\.ensemble\ensemble\messages\<TEAM_ID>\feed.jsonl`. `summary.txt` names the
exact path on its `Full transcript:` line. Read the transcript through the API while the
run is live (Step 4); open the file afterwards if you need all of it. A team created
before the in-memory store may also have a `messages.jsonl` in the runtime dir — the
server merges it into the feed.

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

`program` must be a key in `agents.json` (`GET /api/ensemble/programs` lists them with
their models and whether the CLI is installed; by default `claude`, `codex`, `aider`,
`gemini` and `opencode`). An unknown program is a 400 (`unknown program "x"; available:
...`); nothing falls back to another CLI. A team holds 2 to 8 agents: the first is the lead,
the rest are workers. To choose a model per agent add `model` (for example
`@{ program = "codex"; model = "gpt-5.6-sol" }`); it must be in that program's catalog or the
call is a 400. Leave it out to use the CLI's own default.

The call answers **202** with the team record as soon as it exists — it does not wait for
the agents. Spawning them, waiting for their CLIs to reach a prompt (up to
`ENSEMBLE_READY_TIMEOUT_MS`, 150 s by default) and injecting the task continue in the
background and report through the team status and the feed (`ensemble` messages such as
"has joined", "collaboration started" or "Team start aborted"). A malformed request
(fewer than 2 or more than 8 agents, a missing or unknown `program`, a model outside the
program's catalog, no name or description) is a **400** with the
reason in `error`.

### Step 2: Confirm the agents came up

The team starts in the background, so give it a moment, then check its status and the
`ensemble` lines of its feed:

```powershell
$t = Invoke-RestMethod "http://localhost:23000/api/ensemble/teams/$TEAM_ID"
$t.team.status                                        # forming -> active
$t.messages | Where-Object from -eq 'ensemble' | ForEach-Object content
```

Good: `... has joined #<team>` for each agent, then `collaboration started`. Bad:
`Failed to spawn ...`, `did not signal ready in time` (injected anyway, best effort),
`Team start aborted ...` or `Team startup failed ...` (the team is disbanded; tell the user
why and stop).

Messages between agents need nothing running besides the server: `team-say` POSTs to it,
and it records the message, answers at once and pastes it into the recipient's terminal in
the background (recipient `team` reaches every other agent). If the server
dies, the agents die with it and `team-say` fails with an error instead of silently
dropping the message.

### Step 3: Tell the user where to watch

The user can optionally open the monitoring GUI in a browser: <http://localhost:23000/>
(teams, transcript, live agent panes, server log). Besides the page, the server pushes the same
data over Server-Sent Events (`GET /api/ensemble/events`, optionally `?team=<id>`) — for a
script, the feed polled as above is simpler. This is optional — Step 4 already
surfaces the conversation inline in this chat.

### Step 4: Monitoring — the user MUST see the conversation

**CRITICAL RULE**: The user wants to SEE the team's conversation as it happens. Every
poll result must be presented clearly and formatted as a readable conversation. Do NOT
just dump raw output — format it as a proper dialogue.

Poll the feed and present only the NEW messages each time. Every message has a `seq`;
remember the highest one you have shown and pass it as `since`:

```powershell
$since = 0   # keep this between polls
$feed = Invoke-RestMethod "http://localhost:23000/api/ensemble/teams/$TEAM_ID/feed?since=$since"
foreach ($m in $feed.messages) { "[{0}] {1} -> {2}: {3}" -f $m.seq, $m.from, $m.to, $m.content }
if ($feed.messages) { $since = ($feed.messages | Select-Object -Last 1).seq }
```

Each message is `{"seq": 7, "from": "...", "to": "...", "content": "...", ...}`. Skip
`from: "ensemble"` messages unless they're a status you want to surface (e.g. an agent
leaving). The agents themselves read the feed with
`node "__ENSEMBLE_DIR__\bin\ensemble.cjs" team-read <TEAM_ID>`, which prints every message as
`from -> to: content` — handy for a one-off look at the whole conversation.

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
$RD = "$env:TEMP\ensemble\$TEAM_ID"
Test-Path "$RD\.finished"
```
(or `(Invoke-RestMethod "http://localhost:23000/api/ensemble/teams/$TEAM_ID").team.status`
being `disbanded`). `summary.txt` is written before `.finished`, so once `.finished`
exists it's safe to read `summary.txt` and present it as the final summary. Stop polling.
If the API stops answering, the server is down and the agents went with it — tell the
user, there is nothing left to wait for.

**Polling cadence:**
- First poll: wait ~10s
- Normal: wait 15-20s between polls
- If 3+ consecutive polls with no new messages: wait 30s (agents in deep work)
- On `.finished`: stop polling, present final summary

**When done**, cleanup is fully automatic: the server tears down the agent sessions and
writes `summary.txt` itself (auto-disband, `disbandTeam` in
`services/ensemble-service.ts`), as soon as every agent still active has sent `<<COLLAB_DONE>>`, when
the user disbands, or after an hour of silence. Nothing needs to be killed manually.

## Important Notes
- Agents run with auto-accept permissions configured in `agents.json`: codex uses
  `--dangerously-bypass-approvals-and-sandbox`, claude uses `--permission-mode auto`.
  They should NEVER ask for file write approval.
- Do not modify project code during a collab session unless the user explicitly asks
- Do not edit or delete the team's `feed.jsonl` while the server is running — the server
  keeps the transcript in memory and would not see the change anyway.
- Multiple collabs can run simultaneously — each has its own `%TEMP%\ensemble\<TEAM_ID>\` namespace
- The message bus is `team-say` / `team-read`, Node CLI subcommands in `cli/ensemble.ts`
  (a pure HTTP client). Agents invoke them as
  `node "__ENSEMBLE_DIR__\bin\ensemble.cjs" team-say <team-id> <from> <to> <message>`; it prints
  `Sent to <to>` on success and exits non-zero with an error on stderr if the server
  is unreachable or rejects the message. There is no bridge process and no message file
  to append to.
- `.finished` and `summary.txt` are written by ensemble-service, NOT by the CLI.
