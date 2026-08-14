# Run removal + read-only accounts tab — design

Date: 2026-08-14
Status: approved in brainstorming, pending spec review
Repo: `E:\projects\ensemble-win\yuk1naaa`

---

## Problem

Two gaps in the monitoring GUI:

1. **Runs accumulate forever.** `disbandTeam` mutates the record to
   `status: 'disbanded'` (`services/ensemble-service.ts:1278`) but never removes it.
   `lib/ensemble-registry.ts` has no delete function of any kind. The sidebar grows
   without bound and there is no way to get rid of a run.
2. **Account state is invisible.** Agents authenticate through their own on-disk
   subscription credentials, which ensemble deliberately never touches. There is no way to
   see which account is signed in without leaving the app.

## Non-goals

- **Signing in from the GUI.** All three CLIs use browser OAuth that opens on the *server*
  machine and completes on a loopback callback there. Driving it from a browser would
  require exposing raw keystroke injection plus a streaming transport — i.e. building a
  web terminal. Explicitly out of scope.
- **Signing out from the GUI.** Technically possible for claude and codex, but the HTTP
  API has no authentication (`AGENTS.md:97`, loopback by design) and the CORS check only
  fires when an `Origin` header is present — so any non-browser caller bypasses it, and
  `/api/ensemble/*` skips rate limiting entirely. A logout route would be a one-line
  unauthenticated curl that ends a paid subscription session. It also contradicts the
  stated principle at `AGENTS.md:111` that ensemble does not make authorization decisions
  on the user's behalf.
- **Gemini account status.** No `gemini auth` subcommand exists. A file-existence
  heuristic is already wrong on the current machine: `.gemini/oauth_creds.json` is absent
  while the key lives in Windows Credential Manager. We display an honest "unavailable"
  rather than a guess.
- **Recovering worktrees for runs that never disbanded.** The worktree base path is not
  persisted; disband reconstructs it from a surviving `worktreePath`
  (`ensemble-service.ts:1247`). For a run that died at `forming`/`failed` it is
  unrecoverable. Purge reports this rather than guessing.

---

## Feature 1 — Two-tier run removal

Removal is split into **archive** (reversible, no disk writes) and **purge**
(irreversible, erases everything). This mirrors `codex archive` / `codex delete`.

### 1.1 Data model

Add one optional field to `EnsembleTeam` in `types/ensemble.ts`:

```ts
archivedAt?: string   // ISO timestamp; absent = not archived
```

No migration. Records without the field are simply not archived.

### 1.2 Archive

- Sets / clears `archivedAt` via the existing `updateTeam`.
- **Refused while `status === 'active'`** → 409. The control renders disabled with
  "disband this run first".
- Rationale for the gate: it is what prevents every resurrection race in §1.3. A live
  agent's `team-say` (`cli/ensemble.ts:122`) and the watchdog's `appendMessage`
  (`lib/agent-watchdog.ts:137,169,179,233,246`) both `mkdir -p` on write.

### 1.3 Purge

New `purgeTeam(teamId)` in `services/ensemble-service.ts`, in this exact order:

1. `getTeam` → 404 if absent. **This is also the path-traversal gate** — `server.ts:170`
   captures the id with `([^/]+)` and neither decodes nor validates it.
2. Validate the id is a UUID (`createTeam` uses `uuidv4()`,
   `ensemble-registry.ts:107`). Defense in depth before any recursive delete.
3. Refuse if `status === 'active'` → 409.
4. Refuse unless `archivedAt` is set → 409. This is what makes the two tiers real.
5. Write `.finished`, `await stopCollabBridge(teamId)`. Idempotent; stops the bridge
   tailing a file about to be deleted.
6. Recursively remove **both** feed locations:
   - `<ENSEMBLE_DATA_DIR>/ensemble/messages/<id>/` (`ensemble-registry.ts:141`)
   - `<ENSEMBLE_RUNTIME_DIR>/<id>/` (`lib/collab-paths.ts:37`)
   `getMessages()` merges both at read time (`ensemble-registry.ts:147-180`); deleting
   one leaves half the transcript alive.
7. `deleteTeam(teamId)` **last**.

**Ordering rationale:** the record is removed last so that a throw at any earlier step
leaves a retryable record. The reverse would strand files with nothing pointing at them.

**Return value:** `{ ok: true, warnings: string[] }`. Unrecoverable worktrees go in
`warnings` and are surfaced in the UI.

### 1.4 Registry

Add `deleteTeam(teamId)` **inside** `lib/ensemble-registry.ts`, using the private
read/write helpers under a single `withTeamsLock`, mirroring `updateTeam:129`.

**Trap:** `withTeamsLock` (`:80-87`) is a non-reentrant mkdir mutex with a 5s timeout.
Composing `withTeamsLock(() => saveTeams(filtered))` self-deadlocks. Composing
`loadTeams()` + `saveTeams()` from outside is a TOCTOU race against `createTeam`.

### 1.5 HTTP

Added inside the existing `teamMatch` block (`server.ts:169-192`), following the
established `/disband` sub-path convention:

| Method | Path | Body | Purpose |
|---|---|---|---|
| `POST` | `/api/ensemble/teams/:id/archive` | `{archived: boolean}` | Archive / unarchive |
| `POST` | `/api/ensemble/teams/:id/purge` | — | Erase permanently |

`DELETE /api/ensemble/teams/:id` is left alone. It currently maps to `disbandTeam`, is
documented that way in `README.md`, and nothing in the repo calls it. Silently
repurposing it would change behavior for any external script.

### 1.6 GUI

- Archived runs are hidden from `#teams` by default, behind a `[ show N archived ]`
  toggle. Purge is offered only on archived runs.
- **Confirmations use `window.confirm`**, matching the page's existing idiom
  (`public/index.html:375`). It blocks the event loop, so it survives the 2-second
  `#teams` re-render (`:198`, `:467`) that would destroy any inline confirm markup.
  - Archive: names the run, states it stays on disk and can be restored.
  - Purge: names the run, states it is irreversible, lists what is erased (transcript,
    both message stores, runtime artifacts) and the message count.
- Per-card buttons are safe **only because they hold no transient state** — `pollTeams`
  re-binds `.team` handlers every tick, so re-created buttons re-bind with them. An
  expandable inline "are you sure?" would not survive.

**Targeted fix in code being touched:** `#disband` enablement is computed only in
`select()` (`:286`) and never refreshed by the poll, so it goes stale when status changes
underneath. Move enablement into the render path so the new status-dependent controls do
not inherit the bug.

---

## Feature 2 — Read-only accounts tab

### 2.1 Probes

New `lib/account-status.ts`:

| Program | Command | Notes |
|---|---|---|
| claude | `claude auth status --json` | JSON by default |
| codex | `codex doctor --json` | redacted machine-readable; fall back to `codex login status` |
| gemini, aider, opencode | — | reported `unsupported` with an honest reason |

- `execFile` with a 5s timeout. Never shell-interpolated.
- **Field allowlist.** Only `signedIn`, an account label, and a plan label are serialized.
  Raw stdout never reaches the browser.
- Cached with a 60s TTL in a bounded map (`AGENTS.md`: bound all in-memory buffers).
- Strictly read-only. No login route, no logout route, no credential writes.

### 2.2 HTTP

`GET /api/ensemble/accounts` →

```json
[{ "program": "claude", "state": "signed-in", "account": "…", "plan": "…" },
 { "program": "gemini", "state": "unsupported", "detail": "no auth CLI — use /auth in the gemini TUI" }]
```

### 2.3 GUI

A header tab strip — `[ monitor ] [ accounts ]` — switching the main area.

---

## Testing

New coverage:

- `deleteTeam` completes under `withTeamsLock` without deadlock.
- Purge refuses an active run.
- Purge refuses an unarchived run.
- Purge clears **both** feed stores.
- A non-UUID id is rejected before any filesystem call.
- Account probes parse and allowlist correctly against a stubbed `execFile`; raw stdout
  never appears in the response.

Existing tests that must not break:

- `tests/ensemble.test.ts` — `getMessages()` dual-store merge (`:97-232`), worktree
  isolation lifecycle (`:579-816`).
- `tests/bridge-lifecycle.test.ts` — `disbandTeam()` (`:385-400`) asserts `.finished`,
  exactly one `taskkill /T /F /PID`, and `bridge.pid` removal. Any reuse of
  `stopCollabBridge` must preserve these call shapes.
- `tests/agent-watchdog.test.ts:168` — extend from "team disbanded" to "team deleted
  entirely".
- `tests/onboarding-smoke.test.ts:115` — could assert the list returns to empty after
  purge.

---

## Risks

| Risk | Mitigation |
|---|---|
| Re-entrant lock deadlock | `deleteTeam` lives inside the registry, one `withTeamsLock` |
| Half-deleted transcript | Purge removes both stores; test asserts it |
| Resurrection by a live agent or the watchdog | Archive gated on non-active; purge additionally stops the bridge first |
| Path traversal into `rmSync` | `getTeam` existence check + UUID validation before any FS call |
| Confirmation UI destroyed by the 2s re-render | `window.confirm` blocks the event loop |
| Credential leakage through the accounts API | Field allowlist; raw stdout never serialized; no write routes |
