import { h, setText, setClass, reconcile, append, clear } from './dom.js'
import {
  MOTION_OK, enter, exit, slideSelection, expand, pulse, breathe,
  crossfade, pressable, toast, skeleton,
} from './motion-kit.js'
import { attachSkillPicker } from './skill-picker.js'

const $ = id => document.getElementById(id)

const state = {
  teams: [],
  selected: null,
  logSeq: 0,
  // session -> { wrap, pre, msgs, live, toggleBtn, session, agentName, mode, stopBreathe }
  // mode is 'messages' (default) or 'raw' — per-pane, independent of every other pane.
  paneEls: new Map(),
  lastMessages: [],          // most recent /feed result, cached so pollPanes() can seed a
                              // freshly (re)created pane's message view without waiting for
                              // the next pollFeed() tick — see renderPaneMessages().
  archivedExpanded: false,   // persisted here, not the DOM — #teams is reconciled every tick
  activeTab: 'monitor',
  accountsTimer: null,
  selectedRowEl: null,       // the .team element under #selBar, refreshed every pollTeams()
}

// Escapes for attribute/HTML-string context. Most rendering below goes through
// h() + textContent, which is inherently safe, so this is only needed for the
// handful of spots that still interpolate agent/program names (free text from
// the "new team" form) into something other than textContent.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }
const esc = s => String(s).replace(/[&<>"'`]/g, c => ESCAPES[c])
const timeOf = iso => { try { return new Date(iso).toLocaleTimeString() } catch { return '' } }

async function api(path, opts) {
  const res = await fetch(path, opts)
  if (!res.ok) throw new Error(res.status + ' ' + path)
  return res.json()
}

// Like api(), but reads the JSON body even on failure and throws the server's
// own `error` string — archive/purge need that surfaced verbatim (409/404/400).
async function apiAction(path, opts) {
  const res = await fetch(path, opts)
  let data = {}
  try { data = await res.json() } catch { /* no body */ }
  if (!res.ok) throw new Error(data.error || (res.status + ' ' + path))
  return data
}

function follow(el) { if ($('autoscroll').checked) el.scrollTop = el.scrollHeight }

function btn(cls, label, onClick, attrs = {}) {
  const el = h('button', { type: 'button', class: cls, text: label, on: { click: onClick }, ...attrs })
  pressable(el)
  return el
}

// ── speaker colors ──────────────────────────────────────────────────────────
// One colour + icon per agent so a two-way transcript is readable at a glance.
// Keyed by program (mirroring the colour/icon fields in agents.json) with a
// per-position fallback, so two agents are never the same colour even when the
// team runs two of the same program. Colours reuse the shared design tokens
// where one already fits (codex -> info, claude -> accent, gemini -> warn);
// the rest are one-off hexes because there is no token for them.
const PROGRAM_STYLES = [
  { match: 'codex', color: 'var(--info)', icon: '◆' },
  { match: 'claude', color: 'var(--accent)', icon: '●' },
  { match: 'aider', color: '#C99AE3', icon: '▲' },
  { match: 'gemini', color: 'var(--warn)', icon: '★' },
  { match: 'opencode', color: '#6ED4D0', icon: '▣' },
]
const FALLBACK_STYLES = [
  { color: 'var(--info)', icon: '◆' }, { color: 'var(--accent)', icon: '●' },
  { color: '#C99AE3', icon: '▲' }, { color: 'var(--warn)', icon: '★' },
  { color: '#6ED4D0', icon: '▣' }, { color: 'var(--err)', icon: '◇' },
]
const SYSTEM_STYLE = { color: 'var(--warn)', icon: '⚙' }
const USER_STYLE = { color: 'var(--text)', icon: '›' }

function speakerStyle(who) {
  if (who === 'ensemble') return SYSTEM_STYLE
  if (who === 'user') return USER_STYLE
  const agents = (currentTeam() || {}).agents || []
  const index = agents.findIndex(a => a.name === who)
  if (index < 0) return { color: 'var(--dim)', icon: '·' }
  const program = String(agents[index].program || '').toLowerCase()
  const byProgram = PROGRAM_STYLES.find(s => program.includes(s.match))
  // Two agents on the same program: keep the icon, take a distinct colour.
  const twin = agents.findIndex(a => a.program === agents[index].program) !== index
  if (byProgram && !twin) return byProgram
  const fallback = FALLBACK_STYLES[index % FALLBACK_STYLES.length]
  return { color: fallback.color, icon: byProgram ? byProgram.icon : fallback.icon }
}

const STATUS_COLOR = {
  active: 'var(--accent)', forming: 'var(--warn)', paused: 'var(--warn)',
  disbanded: 'var(--err)', failed: 'var(--err)',
}
const statusColor = s => STATUS_COLOR[s] || 'var(--dim)'

function currentTeam() { return state.teams.find(t => t.id === state.selected) }

// ── teams ───────────────────────────────────────────────────────────────────
// Archived runs (archivedAt set) are hidden by default behind a toggle whose
// open/closed state lives in `state.archivedExpanded`, not the DOM — pollTeams
// reconciles #teams every tick, so anything held only on a DOM node here would
// be at the mercy of that node surviving reconciliation.
function buildTeamItems() {
  const active = state.teams.filter(t => !t.archivedAt)
  const archived = state.teams.filter(t => t.archivedAt)
  const items = active.map(t => ({ kind: 'team', team: t, archived: false }))
  if (archived.length) {
    items.push({ kind: 'toggle', count: archived.length })
    if (state.archivedExpanded) {
      for (const t of archived) items.push({ kind: 'team', team: t, archived: true })
    }
  }
  if (!items.length) items.push({ kind: 'empty' })
  return items
}

// Archived state is folded into the key on purpose: a team moving between the
// active and archived groups gets a fresh element (exit from one spot, enter
// in the other) rather than an in-place patch that would jump across the
// archive-toggle divider.
const teamItemKey = item => item.kind === 'team'
  ? `team:${item.team.id}:${item.archived ? 'a' : 'l'}`
  : item.kind

function createTeamItemEl(item) {
  if (item.kind === 'toggle') return createToggleRow(item)
  if (item.kind === 'empty') return h('div', { class: 'empty is-placeholder', text: 'No teams yet. npm run cli -- run "<task>"' })
  return createTeamRow(item)
}

function patchTeamItemEl(el, item) {
  if (item.kind === 'toggle') return patchToggleRow(el, item)
  if (item.kind === 'team') return patchTeamRow(el, item)
}

function createToggleRow(item) {
  const el = h('div', {
    class: 'archive-toggle', role: 'button', tabindex: '0',
    on: {
      click: () => { state.archivedExpanded = !state.archivedExpanded; pollTeams().catch(() => {}) },
      keydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click() } },
    },
  })
  patchToggleRow(el, item)
  return el
}
function patchToggleRow(el, item) {
  setText(el, state.archivedExpanded ? '[ hide archived ]' : `[ show ${item.count} archived ]`)
}

function buildTeamActions(actions, t, archived) {
  clear(actions)
  if (archived) {
    actions.append(
      btn('btn ghost', 'restore', e => {
        e.stopPropagation()
        const cur = state.teams.find(x => x.id === t.id)
        if (cur) archiveTeam(cur, false)
      }, { title: 'Restore to the active list', 'aria-label': `Restore ${t.name}` }),
      btn('btn danger', 'purge', e => {
        e.stopPropagation()
        const cur = state.teams.find(x => x.id === t.id)
        if (cur) purgeTeam(cur)
      }, { title: 'Permanently erase this run', 'aria-label': `Permanently purge ${t.name}` }),
    )
  } else {
    const archiveBtn = btn('btn ghost', 'archive', e => {
      e.stopPropagation()
      const cur = state.teams.find(x => x.id === t.id)
      if (cur) archiveTeam(cur, true)
    }, { 'aria-label': `Archive ${t.name}` })
    actions.append(archiveBtn)
    actions._archiveBtn = archiveBtn
  }
}

function createTeamRow(item) {
  const { team: t, archived } = item
  const dot = h('span', { class: 'dot', 'aria-hidden': 'true' })
  const statusEl = h('span', { class: 'status' })
  const countHint = h('span', { class: 'count-hint' })
  const name = h('div', { class: 'team-name' })
  const metaStatus = h('div', { class: 'team-meta' }, [dot, statusEl, countHint])
  const metaAgents = h('div', { class: 'team-meta' })
  const actions = h('div', { class: 'team-actions' })
  const el = h('div', {
    class: `team${archived ? ' archived' : ''}`,
    on: { click: () => select(t.id) },
  }, [name, metaStatus, metaAgents, actions])
  el._refs = { name, dot, statusEl, countHint, metaAgents, actions, prevStatus: null }
  buildTeamActions(actions, t, archived)
  patchTeamRow(el, item)
  return el
}

function patchTeamRow(el, item) {
  const { team: t } = item
  const r = el._refs
  setText(r.name, t.name)
  const agentCount = (t.agents || []).length
  setText(r.countHint, ` · ${agentCount} agent${agentCount === 1 ? '' : 's'}`)
  setText(r.metaAgents, (t.agents || []).map(a => a.name).join(', '))
  setClass(el, 'sel', t.id === state.selected)

  if (t.status !== r.prevStatus) {
    if (r.prevStatus) {
      setClass(r.dot, r.prevStatus, false)
      setClass(r.statusEl, r.prevStatus, false)
    }
    setClass(r.dot, t.status, true)
    setClass(r.statusEl, t.status, true)
    setText(r.statusEl, t.status)
    if (r.prevStatus) pulse(r.dot, statusColor(t.status))
    r.prevStatus = t.status
  }

  if (r.actions._archiveBtn) {
    const isActiveRun = t.status === 'active'
    r.actions._archiveBtn.disabled = isActiveRun
    r.actions._archiveBtn.title = isActiveRun ? 'Disband this run first' : ''
  }

  if (t.id === state.selected) state.selectedRowEl = el
}

async function pollTeams() {
  const { teams } = await api('/api/ensemble/teams')
  state.teams = teams || []
  const active = state.teams.filter(t => !t.archivedAt)
  setText($('teamCount'), String(active.length))

  state.selectedRowEl = null
  const { added, removed } = reconcile($('teams'), buildTeamItems(), {
    key: teamItemKey,
    create: createTeamItemEl,
    patch: patchTeamItemEl,
  })
  if (added.length) enter(added)
  for (const el of removed) exit(el)

  if (state.selected && !state.teams.some(t => t.id === state.selected)) {
    select(null)
    return
  }
  slideSelection($('selBar'), state.selectedRowEl)
  refreshSelectionControls()
}

// #disband (and the composer inputs) reflect the *currently selected* team's
// live status. This must run every poll tick, not just once from select() —
// a status change (e.g. active -> disbanded from elsewhere) would otherwise
// leave a stale disabled state until the user re-selects the team.
function refreshSelectionControls() {
  const team = currentTeam()
  $('disband').disabled = !team || team.status === 'disbanded'
  $('text').disabled = !team
  $('send').disabled = !team
}

async function archiveTeam(team, archived) {
  if (archived && !confirm(
    `Archive "${team.name}"?\n\nIt stays on disk and can be restored later from the archived list.`,
  )) return
  try {
    await apiAction(`/api/ensemble/teams/${encodeURIComponent(team.id)}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived }),
    })
  } catch (err) {
    toast((archived ? 'Archive' : 'Restore') + ' failed: ' + err.message, 'err')
  }
  await pollTeams()
}

// The message count is fetched here rather than read from a poll cache: purge
// is offered on *archived* runs, which are never the selected team, so pollFeed
// has never seen their transcript. If the fetch fails the confirm still names
// what is destroyed, just without a number.
async function messageCount(teamId) {
  try {
    const { messages } = await api(`/api/ensemble/teams/${encodeURIComponent(teamId)}/feed`)
    return (messages || []).length
  } catch { return null }
}

async function purgeTeam(team) {
  const count = await messageCount(team.id)
  const countText = typeof count === 'number' ? `${count} message${count === 1 ? '' : 's'}` : 'its messages'
  if (!confirm(
    `Permanently purge "${team.name}"?\n\nThis CANNOT be undone. It erases the transcript (${countText}), ` +
    `both message stores, and the run's runtime artifacts.`,
  )) return
  try {
    const data = await apiAction(`/api/ensemble/teams/${encodeURIComponent(team.id)}/purge`, { method: 'POST' })
    if (data.warnings && data.warnings.length) toast('Purge finished with warnings:\n' + data.warnings.join('\n'), 'err')
  } catch (err) {
    toast('Purge failed: ' + err.message, 'err')
    return
  }
  if (state.selected === team.id) select(null)
  await pollTeams()
}

// ── program catalog (new-team form) ─────────────────────────────────────────
// GET /api/ensemble/programs is owned by another agent and may not exist yet, or
// may 404/500 on an older server. Either way this degrades to a hardcoded
// codex/claude list with no models — an empty `models` array is itself a safe
// fallback, since populateModelSelect() then disables the model dropdown and no
// `model` field is ever sent, which is always a valid request.
const FALLBACK_PROGRAMS = [
  { name: 'codex', icon: '◆', color: 'blue', models: [] },
  { name: 'claude', icon: '●', color: 'green', models: [] },
]
let programsCatalog = null
let programsWarned = false

async function loadPrograms() {
  if (programsCatalog) return programsCatalog
  try {
    const list = await api('/api/ensemble/programs')
    programsCatalog = Array.isArray(list) && list.length ? list : FALLBACK_PROGRAMS
  } catch (err) {
    if (!programsWarned) {
      programsWarned = true
      console.warn('[monitor] GET /api/ensemble/programs unavailable, using fallback program list:', err.message)
    }
    programsCatalog = FALLBACK_PROGRAMS
  }
  return programsCatalog
}

function programEntry(name) {
  const list = programsCatalog || FALLBACK_PROGRAMS
  return list.find(p => p.name === name) || list[0]
}

// ── agent rows (new-team form) ──────────────────────────────────────────────
// Built and mutated directly — never handed to reconcile(). reconcile() only
// runs over #teams and the accounts table, both re-rendered from server state
// every poll tick; this form holds un-submitted user input that a reconciliation
// pass would clobber. See the comment on #ntAgents in index.html.
const DEFAULT_MODEL_VALUE = '' // sentinel: omit the `model` key entirely
let agentRowSeq = 0
const agentRows = [] // [{ id, el, roleEl, programSel, modelSel, removeBtn }]

const agentRoleLabel = index => (index === 0 ? 'lead' : 'worker')

// The model dropdown's first option is always "default (CLI config)" (value ""),
// a first-class choice that omits --model so an agent's own config (e.g.
// ~/.codex/config.toml's model + model_reasoning_effort) is left alone. A program
// with no models gets a *disabled* select, not a hidden one, so row height and
// column alignment stay put when the program dropdown changes.
function populateModelSelect(sel, programName) {
  const entry = programEntry(programName)
  const models = (entry && entry.models) || []
  clear(sel)
  sel.append(h('option', { value: DEFAULT_MODEL_VALUE, text: 'default (CLI config)' }))
  for (const m of models) sel.append(h('option', { value: m.id, text: m.label }))
  sel.value = DEFAULT_MODEL_VALUE
  sel.disabled = models.length === 0
}

function refreshAgentRoleLabels() {
  agentRows.forEach((row, i) => setText(row.roleEl, agentRoleLabel(i)))
}

// The "need at least 2 agents" rule lives here, not as a submit-time error: once
// only two rows remain, every remove button disables so the count can't drop
// below 2 in the first place.
function refreshAgentRemoveButtons() {
  const disable = agentRows.length <= 2
  for (const row of agentRows) row.removeBtn.disabled = disable
}

function createAgentRow(programName) {
  const id = ++agentRowSeq
  const roleEl = h('span', { class: 'agent-role' })
  const programSel = h('select', { class: 'agent-program', 'aria-label': 'Program' })
  const modelSel = h('select', { class: 'agent-model', 'aria-label': 'Model' })
  const removeBtn = btn('btn ghost agent-remove', '×', () => removeAgentRow(id), { 'aria-label': 'Remove agent' })

  for (const p of (programsCatalog || FALLBACK_PROGRAMS)) {
    programSel.append(h('option', { value: p.name, text: p.icon ? `${p.icon} ${p.name}` : p.name }))
  }
  programSel.value = programName
  populateModelSelect(modelSel, programSel.value)
  programSel.addEventListener('change', () => populateModelSelect(modelSel, programSel.value))

  const el = h('div', { class: 'agent-row' }, [roleEl, programSel, modelSel, removeBtn])
  const row = { id, el, roleEl, programSel, modelSel, removeBtn }
  agentRows.push(row)
  $('ntAgents').append(el)
  refreshAgentRoleLabels()
  refreshAgentRemoveButtons()
  return row
}

function removeAgentRow(id) {
  if (agentRows.length <= 2) return // belt-and-suspenders: the button is disabled too
  const idx = agentRows.findIndex(r => r.id === id)
  if (idx < 0) return
  agentRows.splice(idx, 1)[0].el.remove()
  refreshAgentRoleLabels()
  refreshAgentRemoveButtons()
}

async function initAgentRows() {
  await loadPrograms()
  clear($('ntAgents'))
  agentRows.length = 0
  const seedNames = programsCatalog.length >= 2
    ? [programsCatalog[0].name, programsCatalog[1].name]
    : [programEntry('codex').name, programEntry('claude').name]
  for (const name of seedNames) createAgentRow(name)
}

$('ntAddAgent').addEventListener('click', () => {
  const fallbackName = (programsCatalog && programsCatalog[0] && programsCatalog[0].name) || 'codex'
  createAgentRow(fallbackName)
})

// ── create a team ───────────────────────────────────────────────────────────
let newTeamOpen = false
$('toggleNew').addEventListener('click', () => {
  newTeamOpen = !newTeamOpen
  const form = $('newTeam')
  // Keep `hidden` in sync even though expand() drives the visible animation —
  // app.css has `#newTeam[hidden]{display:none}` because `display:flex` on
  // the form otherwise outranks the UA [hidden] rule.
  form.hidden = !newTeamOpen
  expand(form, newTeamOpen)
  if (newTeamOpen) $('ntTask').focus()
})

$('newTeam').addEventListener('submit', e => {
  e.preventDefault()
  const task = $('ntTask').value.trim()
  if (!task) return

  // Row 0 is always the lead, every row after it is a worker — order is the only
  // lead indicator (see the design doc's rejection of a separate lead control).
  // The "at least 2 agents" rule is enforced earlier, by disabling remove buttons
  // at 2 rows (refreshAgentRemoveButtons), not here.
  const body = {
    name: `run-${Date.now()}`,
    description: task,
    agents: agentRows.map((row, i) => {
      const agent = { program: row.programSel.value, role: i === 0 ? 'lead' : 'worker', hostId: 'local' }
      // DEFAULT_MODEL_VALUE ("") means "no --model was picked" — omit the key
      // entirely rather than sending an empty string, so the agent CLI's own
      // config (e.g. ~/.codex/config.toml) decides the model.
      if (row.modelSel.value) agent.model = row.modelSel.value
      return agent
    }),
    feedMode: 'live',
  }
  const cwd = $('ntCwd').value.trim()
  if (cwd) body.workingDirectory = cwd

  $('ntGo').disabled = true
  setNtStatus('launching — agents take up to ~150s to be ready…')

  // POST /api/ensemble/teams does not return until every agent is ready and
  // prompted, which can take minutes. So the request is deliberately NOT
  // awaited for UI purposes: the team record is written early, so normal
  // polling shows it within a couple of seconds. Errors still surface when
  // the promise settles.
  api('/api/ensemble/teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(() => {
    setNtStatus('team started', 'ok')
    $('ntTask').value = ''
  }).catch(err => {
    setNtStatus('failed: ' + err.message, 'err')
  }).finally(() => {
    $('ntGo').disabled = false
  })

  // Surface the team as soon as the record exists, without waiting on the POST.
  setTimeout(() => pollTeams().catch(() => {}), 1500)
})

function setNtStatus(text, cls) {
  const el = $('ntStatus')
  setText(el, text)
  el.className = cls || ''
}

function select(id) {
  state.selected = id
  // The open skill list belongs to the team we are leaving — see attachSkillPicker's
  // return value for why the picker can't notice this on its own.
  if (skillPicker) skillPicker.dismiss()
  for (const p of state.paneEls.values()) if (p.stopBreathe) p.stopBreathe()
  state.paneEls.clear()
  state.lastMessages = [] // stale cache from the previous team must not seed the new panes

  clear($('panes'))
  clear($('feed'))
  if (id) {
    skeleton($('panes'), 3)
    skeleton($('feed'), 3)
  } else {
    $('panes').append(h('div', { class: 'empty is-placeholder', text: 'Select a team.' }))
    $('feed').append(h('div', { class: 'empty is-placeholder', text: 'Select a team.' }))
  }

  const team = currentTeam()
  setText($('teamTitle'), team ? team.name : '')
  $('disband').disabled = !team || team.status === 'disbanded'
  $('text').disabled = !team
  $('send').disabled = !team

  const to = $('to')
  clear(to)
  to.append(h('option', { value: 'team', text: '→ team' }))
  if (team) {
    for (const a of (team.agents || [])) {
      const style = speakerStyle(a.name)
      to.append(h('option', { value: a.name, text: `${style.icon} ${a.name}` }))
    }
  }

  pollTeams().catch(() => {})
  if (id) { pollFeed().catch(() => {}); pollPanes().catch(() => {}) }
}

// ── transcript ──────────────────────────────────────────────────────────────
function createMessageEl(m) {
  const style = speakerStyle(m.from)
  const isCommand = m.type === 'command'
  const from = h('span', { class: 'msg-from', text: `${style.icon} ${m.from}`, style: { color: style.color } })
  const to = h('span', { text: `→ ${m.to}` })
  const time = h('span', { text: timeOf(m.timestamp) })
  const hd = h('div', { class: 'msg-hd' }, [from, to, time])
  const body = h('div', { class: 'msg-body', text: m.content })
  return h('div', {
    class: `msg${m.from === 'ensemble' ? ' ensemble' : ''}${isCommand ? ' command' : ''}`,
    // A fired skill command gets a fixed --info border regardless of speaker, so it
    // reads as "a command" at a glance rather than blending into the sender's own colour.
    style: { borderLeftColor: isCommand ? 'var(--info)' : style.color },
  }, [hd, body])
}

async function pollFeed() {
  if (!state.selected) return
  const { messages } = await api(`/api/ensemble/teams/${encodeURIComponent(state.selected)}/feed`)
  state.lastMessages = messages || []
  renderPaneMessages(state.lastMessages)
  const box = $('feed')

  if (!messages || !messages.length) {
    if (!box.querySelector('.empty')) {
      clear(box)
      box.append(h('div', { class: 'empty is-placeholder', text: 'No messages yet.' }))
    }
    return
  }

  const placeholder = box.querySelector('.is-placeholder')
  if (placeholder) placeholder.remove()
  // Messages are append-only — never re-render the ones already on screen,
  // that is what made the old wholesale innerHTML replace flicker on every
  // 2s poll and steal text selection out from under the reader.
  const added = append(box, messages, { create: createMessageEl })
  if (added.length) enter(added)
  follow(box)
}

// A leading "/<token> args" fired at an individual agent (never "→ team", see the
// design doc's non-goals) is a skill invocation, not a plain message — it takes the
// dedicated skill route instead of the normal wrapped-message POST. apiAction (not
// api) so a 400 unknown-token or 409 dead-session surfaces the server's own message
// in the toast rather than a bare status code.
$('composer').addEventListener('submit', async e => {
  e.preventDefault()
  const text = $('text').value.trim()
  if (!text || !state.selected) return
  $('send').disabled = true
  try {
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text)
    if (m && $('to').value !== 'team') {
      await apiAction(`/api/ensemble/teams/${encodeURIComponent(state.selected)}/skill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: $('to').value, token: m[1], args: m[2].trim() }),
      })
    } else {
      await api(`/api/ensemble/teams/${encodeURIComponent(state.selected)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: $('to').value, from: 'user', content: text }),
      })
    }
    $('text').value = ''
    await pollFeed()
  } catch (err) {
    toast('Send failed: ' + err.message, 'err')
  } finally {
    $('send').disabled = false
  }
})

$('disband').addEventListener('click', async () => {
  const team = currentTeam()
  if (!team || !confirm(`Disband "${team.name}"? This kills its agent sessions.`)) return
  try {
    await api(`/api/ensemble/teams/${encodeURIComponent(team.id)}/disband`, { method: 'POST' })
  } catch (err) {
    toast('Disband failed: ' + err.message, 'err')
  }
  await pollTeams()
})

// ── agent panes ─────────────────────────────────────────────────────────────
// Each pane defaults to a filtered view of the same transcript messages shown
// in the center column (see renderPaneMessages) rather than the raw PTY dump.
// A per-pane toggle (p.mode) switches that one pane to the raw capture and
// back; the /pane fetch itself always runs (see pollPanes) so the live/no
// session indicator keeps working no matter which view is showing.
function togglePaneMode(p) {
  p.mode = p.mode === 'raw' ? 'messages' : 'raw'
  setClass(p.wrap, 'raw-mode', p.mode === 'raw')
  setText(p.toggleBtn, p.mode === 'raw' ? 'msgs' : 'raw')
}

function createPaneEl(agent, team) {
  const session = `${team.name}-${agent.name}`
  const style = speakerStyle(agent.name)
  const nameEl = h('strong', { text: `${style.icon} ${agent.name}`, style: { color: style.color } })
  // Third segment (the model) only appears when one was picked at creation —
  // absent means "no --model was passed, the CLI used its own config," which is
  // a real, distinct state from any specific model and must not be guessed at.
  const metaText = `${agent.program} · ${agent.role || ''}` + (agent.model ? ` · ${agent.model}` : '')
  const metaEl = h('span', { class: 'pane-meta', text: metaText })
  const live = h('span', { class: 'live', text: '…' })
  const p = {
    wrap: null, pre: null, msgs: null, live, toggleBtn: null,
    session, agentName: agent.name, mode: 'messages', stopBreathe: null,
  }
  const toggleBtn = btn('btn ghost pane-toggle', 'raw', () => togglePaneMode(p),
    { title: 'Toggle raw terminal view', 'aria-label': `Toggle raw terminal view for ${agent.name}` })
  const hd = h('div', { class: 'pane-hd', style: { boxShadow: `inset 3px 0 0 ${style.color}` } },
    [nameEl, metaEl, h('span', { class: 'spacer' }), toggleBtn, live])
  const pre = h('pre', { class: 'pane-body' })
  const msgs = h('div', { class: 'pane-msgs' },
    [h('div', { class: 'empty is-placeholder', text: 'No messages yet.' })])
  const wrap = h('div', { class: 'pane' }, [hd, pre, msgs])
  p.wrap = wrap
  p.pre = pre
  p.msgs = msgs
  p.toggleBtn = toggleBtn
  return p
}

// Filters the same `messages` array pollFeed() already fetched for the transcript
// down to each pane's own agent, and appends any new entries into that pane's
// `.pane-msgs` box. Called from pollFeed() every poll tick, and again from
// pollPanes() right after a pane is (re)created so a fresh pane doesn't sit on
// its placeholder until the next tick happens to land after it exists.
function renderPaneMessages(messages) {
  const all = messages || []
  for (const p of state.paneEls.values()) {
    const box = p.msgs
    const name = p.agentName
    const mine = all.filter(m => m.from === name || m.to === name ||
      (m.from === 'ensemble' && typeof m.content === 'string' && m.content.includes(name)))

    if (!mine.length) {
      if (!box.querySelector('.empty')) {
        clear(box)
        box.append(h('div', { class: 'empty is-placeholder', text: 'No messages yet.' }))
      }
      continue
    }

    const placeholder = box.querySelector('.is-placeholder')
    if (placeholder) placeholder.remove()
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
    const added = append(box, mine, { create: createMessageEl })
    if (added.length) enter(added)
    if (atBottom) box.scrollTop = box.scrollHeight
  }
}

async function pollPanes() {
  const team = currentTeam()
  if (!team) return
  const agents = team.agents || []
  const box = $('panes')

  if (state.paneEls.size !== agents.length) {
    for (const p of state.paneEls.values()) if (p.stopBreathe) p.stopBreathe()
    state.paneEls.clear()
    clear(box)
    if (!agents.length) {
      box.append(h('div', { class: 'empty is-placeholder', text: 'No agents.' }))
    } else {
      for (const agent of agents) {
        const p = createPaneEl(agent, team)
        p.wrap.style.height = agents.length > 1 ? `${100 / agents.length}%` : '100%'
        box.append(p.wrap)
        state.paneEls.set(p.session, p)
      }
      // Seed the freshly created panes from the last-known feed rather than
      // waiting on the next pollFeed() tick to fill them in.
      renderPaneMessages(state.lastMessages)
    }
  }

  await Promise.all(agents.map(async agent => {
    const session = `${team.name}-${agent.name}`
    const p = state.paneEls.get(session)
    if (!p) return
    try {
      const data = await api(`/api/ensemble/sessions/${encodeURIComponent(session)}/pane?lines=80`)
      setText(p.live, data.exists ? 'live' : 'no session')
      // The dot and its glow both read currentColor, so this one class is what stops a
      // dead pane from advertising itself in the same accent green as a live one.
      setClass(p.live, 'off', !data.exists)
      p.stopBreathe = breathe(p.live, !!data.exists)
      // Always kept up to date even in 'messages' mode — cheap (lines=80) and it means
      // toggling to raw never shows stale text while the next poll tick catches up.
      // Visibility between the raw <pre> and the message list is CSS-only (.raw-mode).
      const atBottom = p.pre.scrollHeight - p.pre.scrollTop - p.pre.clientHeight < 40
      setText(p.pre, data.pane || (data.exists ? '(empty)' : ''))
      if (atBottom) p.pre.scrollTop = p.pre.scrollHeight
    } catch { /* transient */ }
  }))
}

// ── server log ──────────────────────────────────────────────────────────────
async function pollLog() {
  const data = await api('/api/ensemble/logs?since=' + state.logSeq)
  if (!data.entries.length) { state.logSeq = data.latest; return }
  state.logSeq = data.latest
  const box = $('log')
  append(box, data.entries, {
    create: entry => h('div', { class: `logline ${entry.level}` },
      [h('span', { class: 'ts', text: timeOf(entry.timestamp) }), ' ' + entry.text]),
  })
  while (box.childElementCount > 1500) box.removeChild(box.firstChild)
  follow(box)
}
$('clearLog').addEventListener('click', () => clear($('log')))

// ── accounts ────────────────────────────────────────────────────────────────
// Read-only. GET /api/ensemble/accounts runs each CLI's own status subcommand
// server-side and returns an allowlisted {program,state,account,plan,detail}.
// There is deliberately no sign-in or sign-out control here — the HTTP API
// has no auth, so a logout button would be a one-line unauthenticated curl
// that ends a paid subscription session.
const ACCOUNT_STATE_COLOR = {
  'signed-in': 'var(--accent)',
  'signed-out': 'var(--warn)',
  'unsupported': 'var(--dim)',
  'error': 'var(--err)',
}

// Probes are cached server-side for 60s, so polling faster than that only
// re-serves the same cache. This interval runs *only* while the tab is open.
const ACCOUNTS_POLL_MS = 60_000

function createAccountEl(a) {
  const style = PROGRAM_STYLES.find(s => String(a.program).toLowerCase().includes(s.match))
  const icon = h('span', { text: style ? style.icon : '·', 'aria-hidden': 'true', style: { color: style ? style.color : 'var(--dim)' } })
  const nameEl = h('span', { text: a.program })
  const statusEl = h('span', { class: 'status' })
  const name = h('div', { class: 'account-name' }, [icon, nameEl, h('span', { class: 'spacer' }), statusEl])
  const meta = h('div', { class: 'account-meta' })
  const el = h('div', { class: 'account' }, [name, meta])
  el._refs = { statusEl, meta }
  patchAccountEl(el, a)
  return el
}

function patchAccountEl(el, a) {
  const r = el._refs
  setText(r.statusEl, a.state)
  r.statusEl.style.color = ACCOUNT_STATE_COLOR[a.state] || 'var(--dim)'
  const meta = [
    a.account ? `account: ${a.account}` : '',
    a.plan ? `plan: ${a.plan}` : '',
    a.detail || '',
  ].filter(Boolean).join(' · ')
  setText(r.meta, meta)
}

async function pollAccounts() {
  const box = $('accounts')
  try {
    const accounts = await api('/api/ensemble/accounts')
    const placeholder = box.querySelector('.is-placeholder')
    if (placeholder) placeholder.remove()
    if (!accounts || !accounts.length) {
      clear(box)
      box.append(h('div', { class: 'empty is-placeholder', text: 'No agent programs known.' }))
      return
    }
    const { added, removed } = reconcile(box, accounts, {
      key: a => a.program,
      create: createAccountEl,
      patch: patchAccountEl,
    })
    if (added.length) enter(added)
    // reconcile() deliberately leaves departed rows attached and marked .is-leaving so
    // the caller can animate them out. Dropping `removed` on the floor doesn't keep the
    // list tidy — it strands those rows on the page permanently.
    for (const el of removed) exit(el)
  } catch (err) {
    clear(box)
    box.append(h('div', { class: 'empty is-placeholder', text: `Could not read account status: ${err.message}` }))
  }
}

// ── tabs ────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  if (tab === state.activeTab) return
  const dir = tab === 'accounts' ? 1 : -1
  state.activeTab = tab

  const outEl = tab === 'accounts' ? $('monitorView') : $('accountsView')
  const inEl = tab === 'accounts' ? $('accountsView') : $('monitorView')
  inEl.hidden = false
  // Same trap as #newTeam: #monitorView (`main{display:grid}`) and
  // #accountsView (`.col{display:flex}`) both set their own `display`, which
  // can tie with or outrank the UA [hidden] rule — app.css compensates with
  // compound id+attribute selectors, but `hidden` still has to be flipped for
  // real once the crossfade finishes.
  crossfade(outEl, inEl, dir).then(() => { outEl.hidden = true })

  setClass($('tabMonitor'), 'active', tab === 'monitor')
  setClass($('tabAccounts'), 'active', tab === 'accounts')
  $('tabMonitor').setAttribute('aria-selected', String(tab === 'monitor'))
  $('tabAccounts').setAttribute('aria-selected', String(tab === 'accounts'))
  slideSelection($('tabUnderline'), tab === 'monitor' ? $('tabMonitor') : $('tabAccounts'))

  // Own interval, cleared on the way out, so a hidden tab never polls.
  clearInterval(state.accountsTimer)
  state.accountsTimer = null
  if (tab === 'accounts') {
    if (!$('accounts').children.length) skeleton($('accounts'), 3)
    pollAccounts()
    state.accountsTimer = setInterval(() => pollAccounts(), ACCOUNTS_POLL_MS)
  }
}

$('tabMonitor').addEventListener('click', () => switchTab('monitor'))
$('tabAccounts').addEventListener('click', () => switchTab('accounts'))
$('refreshAccounts').addEventListener('click', () => pollAccounts())

// ── health + loop ───────────────────────────────────────────────────────────
async function pollHealth() {
  try {
    await api('/api/v1/health')
    setClass($('health'), 'up', true)
    setClass($('health'), 'down', false)
    setText($('healthText'), 'server up')
  } catch {
    setClass($('health'), 'up', false)
    setClass($('health'), 'down', true)
    setText($('healthText'), 'server unreachable')
  }
}

async function tick() {
  await pollHealth()
  // The transcript and the PTY panes are only polled while the monitor tab is
  // visible — capturing panes for a hidden view is pure server work for
  // pixels nobody can see. Teams and the log keep polling so switching back
  // to monitor is instant.
  const monitorVisible = state.activeTab === 'monitor'
  const results = await Promise.allSettled(
    monitorVisible
      ? [pollTeams(), pollLog(), pollFeed(), pollPanes()]
      : [pollTeams(), pollLog()],
  )
  // allSettled is here so one failing poll doesn't stop the others — but silence is not
  // part of that bargain. A bug that made pollTeams throw every tick went unnoticed for
  // a whole session precisely because nothing reported it. Fetch failures while the
  // server is down are expected and already visible in the health dot; anything else
  // wants to be seen.
  for (const r of results) {
    if (r.status === 'rejected') console.error('[monitor] poll failed:', r.reason)
  }
}

$('refresh').addEventListener('click', () => {
  tick()
  if (state.activeTab === 'accounts') pollAccounts()
})

// ── skill picker ────────────────────────────────────────────────────────────
// Triggers only on a leading "/" with an individual agent selected in #to — never
// "→ team" (see design doc §2 non-goals: mixed-program teams can't share one token
// namespace). getContext() is the picker's only window into app state; it otherwise
// knows nothing about teams or delivery.
const skillPicker = attachSkillPicker({
  input: $('text'),
  getContext: () => {
    const to = $('to').value
    if (!state.selected || to === 'team') return null
    return { teamId: state.selected, agentName: to }
  },
})

// ── bootstrap ───────────────────────────────────────────────────────────────
for (const el of [
  $('refresh'), $('disband'), $('send'), $('ntGo'), $('toggleNew'),
  $('clearLog'), $('refreshAccounts'), $('tabMonitor'), $('tabAccounts'),
  $('ntAddAgent'),
]) pressable(el)

initAgentRows().catch(err => console.error('[monitor] failed to init agent rows:', err))

// The underline has to be placed once up front. switchTab() early-returns when the
// requested tab is already active, so the monitor tab — the one we boot into — would
// otherwise never trigger a slide, leaving the pill at width 0 and the active tab's
// dark-on-accent label sitting on the page background instead.
slideSelection($('tabUnderline'), $('tabMonitor'))

skeleton($('teams'), 3)
tick()
setInterval(() => { tick() }, 2000)
