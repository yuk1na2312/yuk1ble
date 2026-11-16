// The "New team" dialog: a task, a name, a folder and one row per agent (program + model).

import { $, h, setChildren } from './dom.js'
import * as api from './api.js'
import { select, state, upsertTeam } from './store.js'

export const MIN_AGENTS = 2
export const MAX_AGENTS = 8
const DEFAULT_MODEL_LABEL = 'default (CLI config)'

let rows = []
let defaultName = ''
let submitting = false

const programs = () => [...state.programs.values()]
const installed = () => programs().filter(p => p.installed)

function stamp() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function currentTemplate() {
  const key = $('nt-template').value
  return state.templates.find(t => t.key === key)
}

function roleLabel(index) {
  const role = currentTemplate()?.roles[index]?.role
  return role ?? (index === 0 ? 'lead' : 'worker')
}

function fillModels(row) {
  const program = state.programs.get(row.program.value)
  const models = program?.models ?? []
  setChildren(row.model,
    h('option', { value: '' }, DEFAULT_MODEL_LABEL),
    ...models.map(m => h('option', { value: m.id }, m.label)))
  row.model.value = ''
  row.model.disabled = models.length === 0
  row.model.title = models.length === 0 ? 'This program has no model list; it uses the CLI\'s own default.' : ''
}

function buildRow(index) {
  const available = installed()
  const preferred = available.length ? available[index % available.length] : undefined

  const label = h('span', { class: 'role-label' })
  const program = h('select', { 'aria-label': `Program for agent ${index + 1}` },
    ...programs().map(p => h('option', { value: p.name, disabled: !p.installed }, p.installed ? `${p.icon} ${p.name}` : `${p.icon} ${p.name} (not installed)`)))
  const model = h('select', { 'aria-label': `Model for agent ${index + 1}` })
  const remove = h('button', { type: 'button', class: 'quiet', onclick: () => removeRow(row) }, 'Remove')
  const el = h('div', { class: 'agent-row' }, label, program, model, remove)
  const row = { el, label, program, model, remove }

  if (preferred) program.value = preferred.name
  program.addEventListener('change', () => fillModels(row))
  fillModels(row)
  return row
}

function paintRows() {
  rows.forEach((row, i) => {
    row.label.textContent = roleLabel(i)
    row.program.setAttribute('aria-label', `Program for agent ${i + 1}, ${roleLabel(i)}`)
    row.model.setAttribute('aria-label', `Model for agent ${i + 1}, ${roleLabel(i)}`)
    row.remove.disabled = rows.length <= MIN_AGENTS
    row.remove.setAttribute('aria-label', `Remove agent ${i + 1}`)
  })
  $('nt-add').disabled = rows.length >= MAX_AGENTS
  setChildren($('nt-agents'), rows.map(r => r.el))
}

function addRow() {
  if (rows.length >= MAX_AGENTS) return
  rows.push(buildRow(rows.length))
  paintRows()
  rows.at(-1).program.focus()
}

function removeRow(row) {
  if (rows.length <= MIN_AGENTS) return
  const at = rows.indexOf(row)
  rows.splice(at, 1)
  paintRows()
  ;(rows[at] ?? rows.at(-1)).program.focus()
}

function setError(text) {
  $('nt-error').textContent = text
}

function paintTemplate() {
  const template = currentTemplate()
  const note = $('nt-template-note')
  note.hidden = !template
  if (template) {
    note.textContent = `${template.description} Roles: ${template.roles.map(r => r.role).join(', ')}.`
    const task = $('nt-task')
    if (!task.value.trim()) task.value = `${template.suggestedTaskPrefix} `
  }
  paintRows()
}

function open() {
  const dialog = $('new-team')
  if (dialog.open) return
  defaultName = `run-${stamp()}`
  $('nt-task').value = ''
  $('nt-name').value = ''
  $('nt-name').placeholder = defaultName
  $('nt-staged').checked = false
  $('nt-worktrees').checked = false
  $('nt-template-field').hidden = state.templates.length === 0
  setChildren($('nt-template'),
    h('option', { value: '' }, 'No template'),
    ...state.templates.map(t => h('option', { value: t.key }, t.name)))
  $('nt-template-note').hidden = true
  rows = [buildRow(0), buildRow(1)]
  paintRows()
  setError(installed().length === 0 ? 'No agent program is installed on this machine, so no team can start. Install one and reload.' : '')
  dialog.showModal()
  $('nt-task').focus()
}

async function submit(event) {
  event.preventDefault()
  if (submitting) return
  const description = $('nt-task').value.trim()
  if (!description) {
    setError('Describe the task so the agents know what to do.')
    $('nt-task').focus()
    return
  }
  const agents = rows.map(row => ({ program: row.program.value, ...(row.model.value ? { model: row.model.value } : {}) }))
  if (agents.some(a => !state.programs.get(a.program)?.installed)) {
    setError('Pick an installed program for every agent.')
    return
  }
  const template = currentTemplate()
  const cwd = $('nt-cwd').value.trim()
  const payload = {
    name: $('nt-name').value.trim() || defaultName,
    description,
    agents,
    ...(cwd ? { workingDirectory: cwd } : {}),
    ...(template ? { templateName: template.key } : {}),
    ...($('nt-staged').checked ? { staged: true } : {}),
    ...($('nt-worktrees').checked ? { useWorktrees: true } : {}),
  }

  submitting = true
  const button = $('nt-submit')
  button.disabled = true
  button.textContent = 'Starting'
  setError('')
  try {
    const team = await api.createTeam(payload)
    upsertTeam(team)
    select(team.id)
    $('new-team').close()
  } catch (err) {
    // The server's own message says what was wrong with the request.
    setError(err.message)
  } finally {
    submitting = false
    button.disabled = false
    button.textContent = 'Start team'
  }
}

export function initNewTeam() {
  for (const id of ['open-new', 'open-new-stage']) $(id).addEventListener('click', open)
  $('nt-add').addEventListener('click', addRow)
  $('nt-template').addEventListener('change', paintTemplate)
  $('nt-cancel').addEventListener('click', () => $('new-team').close())
  $('new-team-close').addEventListener('click', () => $('new-team').close())
  $('new-team-form').addEventListener('submit', submit)
}
