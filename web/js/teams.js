// The teams rail: one keyed row per team, updated in place on `team` events.

import { $, h, setChildren } from './dom.js'
import { agentLook, on, select, state, teamsNewestFirst } from './store.js'

const STATUS_LABEL = {
  forming: 'starting',
  active: 'running',
  paused: 'paused',
  completed: 'finished',
  disbanded: 'ended',
  failed: 'failed',
}

export const statusLabel = status => STATUS_LABEL[status] ?? status

const rows = new Map() // team id -> { li, button, name, status, chips }

function chipFor(agent) {
  const look = agentLook(agent)
  return h('span', { class: 'chip', title: `${agent.name}, ${agent.program}, ${look.model}` },
    h('span', { class: 'chip-icon', style: `color:${look.color}`, 'aria-hidden': 'true' }, look.icon),
    agent.name)
}

function buildRow(team) {
  const name = h('span', { class: 'team-name' })
  const status = h('span', { class: 'status' })
  const chips = h('span', { class: 'chips' })
  const button = h('button', { type: 'button', class: 'team-row', onclick: () => select(team.id) },
    h('span', { class: 'team-top' }, name, status), chips)
  const li = h('li', {}, button)
  return { li, button, name, status, chips }
}

function paintRow(row, team) {
  row.name.textContent = team.name
  row.status.textContent = statusLabel(team.status)
  row.status.dataset.status = team.status
  row.li.dataset.status = team.status
  const signature = team.agents.map(a => `${a.name}|${a.program}|${a.status}`).join(',')
  if (row.chips.dataset.signature !== signature) {
    row.chips.dataset.signature = signature
    setChildren(row.chips, team.agents.map(chipFor))
  }
  row.button.setAttribute('aria-current', team.id === state.selectedId ? 'true' : 'false')
}

function render() {
  const list = $('team-list')
  const teams = teamsNewestFirst()
  $('team-empty').hidden = teams.length > 0

  const wanted = new Set(teams.map(t => t.id))
  for (const [id, row] of rows) {
    if (!wanted.has(id)) {
      row.li.remove()
      rows.delete(id)
    }
  }
  teams.forEach((team, index) => {
    let row = rows.get(team.id)
    if (!row) {
      row = buildRow(team)
      rows.set(team.id, row)
    }
    paintRow(row, team)
    // Keep DOM order equal to newest-first without rebuilding rows.
    if (list.children[index] !== row.li) list.insertBefore(row.li, list.children[index] ?? null)
  })
}

export function initTeams() {
  on('teams', render)
  on('selected', render)
  render()
}
