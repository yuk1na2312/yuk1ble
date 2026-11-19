// The page's state and a minimal pub/sub. Modules read from here and listen to
// named events; nothing else is shared between them.

const listeners = new Map()

export const state = {
  /** name -> { name, icon, color, models, installed } */
  programs: new Map(),
  templates: [],
  /** id -> team */
  teams: new Map(),
  selectedId: null,
  /** Whether archived teams are listed in the rail. */
  showArchived: false,
  /** 'connecting' | 'live' | 'reconnecting' */
  connection: 'connecting',
}

export function on(event, fn) {
  const set = listeners.get(event) ?? new Set()
  listeners.set(event, set)
  set.add(fn)
  return () => set.delete(fn)
}

export function emit(event, payload) {
  for (const fn of [...(listeners.get(event) ?? [])]) {
    try {
      fn(payload)
    } catch (err) {
      console.error(`listener for "${event}" failed`, err)
    }
  }
}

export const selectedTeam = () => (state.selectedId ? state.teams.get(state.selectedId) : undefined)

export function upsertTeam(team) {
  state.teams.set(team.id, team)
  emit('teams', team)
  if (team.id === state.selectedId) emit('selected-updated', team)
}

/** A team was purged: forget it, and leave it if it was the selected one. */
export function removeTeam(id) {
  if (!state.teams.delete(id)) return
  emit('teams', undefined)
  if (id === state.selectedId) select(null)
}

/** Replace all teams (initial load and reconnect). */
export function setTeams(teams) {
  state.teams = new Map(teams.map(team => [team.id, team]))
  emit('teams', undefined)
  const selected = selectedTeam()
  if (selected) emit('selected-updated', selected)
  else if (state.selectedId) select(null)
}

export function select(id) {
  const next = id && state.teams.has(id) ? id : null
  if (next === state.selectedId) return // re-selecting must not rebuild the terminals
  state.selectedId = next
  try {
    history.replaceState(null, '', state.selectedId ? `#team=${encodeURIComponent(state.selectedId)}` : location.pathname)
  } catch { /* a sandboxed frame without history access */ }
  emit('selected', selectedTeam())
}

export function setConnection(value) {
  if (state.connection === value) return
  state.connection = value
  emit('connection', value)
}

/** Program catalog entry for a program name, matched the way the server resolves aliases (first word, lower case). */
export function programOf(name) {
  if (!name) return undefined
  const key = String(name).toLowerCase()
  return state.programs.get(key) ?? [...state.programs.values()].find(p => p.name.toLowerCase() === key.split(/[\s-]/)[0])
}

/** Display facts for an agent: colour, icon and model label from the catalog. */
export function agentLook(agent) {
  const program = programOf(agent?.program)
  const model = agent?.model ? (program?.models.find(m => m.id === agent.model)?.label ?? agent.model) : 'default model'
  return { color: program?.color ?? '#9b97a8', icon: program?.icon ?? '•', model }
}

export function teamsNewestFirst() {
  return [...state.teams.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}
