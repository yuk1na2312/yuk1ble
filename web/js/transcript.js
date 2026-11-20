// The conversation column: the selected team's messages, the composer and the disband control.
// Messages are appended as they are pushed; the feed is fetched once per selection (and again,
// from the last seq seen, after a reconnect). A message is shown once, by its per-team seq.

import { $, atBottom, h, scrollToBottom, setChildren, timeOf } from './dom.js'
import * as api from './api.js'
import { agentLook, on, selectedTeam } from './store.js'
import { attachSkillPicker } from './skill-picker.js'

/** Message nodes kept in the page; older ones scroll away for good (they stay in the feed). */
export const MAX_MESSAGE_NODES = 2000

let view = freshView(undefined)
/** The composer's "/" skill picker, attached in initTranscript. */
let picker

function freshView(teamId) {
  return { teamId, lastSeq: 0, loading: true, buffered: [], unseen: 0, confirming: false, disbanding: false }
}

const list = () => $('transcript')

function voiceOf(team, from) {
  if (from === 'user') return { kind: 'user', color: 'var(--brass)', icon: '' }
  if (from === 'ensemble') return { kind: 'system', color: 'var(--dim)', icon: '' }
  const agent = team?.agents.find(a => a.name === from)
  if (agent) {
    const look = agentLook(agent)
    return { kind: 'agent', color: look.color, icon: look.icon }
  }
  return { kind: 'agent', color: 'var(--dim)', icon: '' }
}

function messageNode(team, message) {
  const voice = voiceOf(team, message.from)
  const command = message.type === 'command' // a skill fired at one agent from the "/" picker
  return h('li', { class: 'msg', dataset: { kind: voice.kind, type: message.type }, style: `--voice:${voice.color}` },
    h('div', { class: 'msg-head' },
      voice.icon && h('span', { class: 'msg-icon', 'aria-hidden': 'true' }, voice.icon),
      h('span', { class: 'msg-from' }, message.from),
      message.to && message.to !== 'team' && h('span', { class: 'msg-to' }, `to ${message.to}`),
      command && h('span', { class: 'msg-badge' }, 'skill'),
      h('time', { class: 'msg-time', dateTime: message.timestamp }, timeOf(message.timestamp))),
    h('div', { class: 'msg-body' }, message.content))
}

function append(messages) {
  const team = selectedTeam()
  const fresh = messages.filter(m => typeof m.seq === 'number' && m.seq > view.lastSeq)
  if (fresh.length === 0) return
  const el = list()
  const follow = atBottom(el)
  const nodes = []
  for (const message of fresh) {
    view.lastSeq = message.seq
    nodes.push(messageNode(team, message))
  }
  el.append(...nodes)
  while (el.childElementCount > MAX_MESSAGE_NODES) el.firstElementChild.remove()
  $('transcript-empty').hidden = true
  if (follow) {
    scrollToBottom(el)
  } else {
    view.unseen += nodes.length
    paintJump()
  }
}

function paintJump() {
  const jump = $('jump')
  jump.hidden = view.unseen === 0
  jump.textContent = view.unseen === 1 ? 'Jump to latest (1 new)' : `Jump to latest (${view.unseen} new)`
}

async function load(teamId) {
  const mine = view
  try {
    const messages = await api.getFeed(teamId, mine.lastSeq || undefined)
    if (view !== mine) return // the selection moved on while this was in flight
    append(messages)
  } catch (err) {
    if (view !== mine) return
    setComposerError(`Could not load the conversation: ${err.message}`)
  }
  if (view !== mine) return
  mine.loading = false
  const buffered = mine.buffered
  mine.buffered = []
  append(buffered)
  if (list().childElementCount === 0) $('transcript-empty').hidden = false
  $('transcript-empty').textContent = 'No messages yet. The agents post here as soon as they start talking.'
}

function onSelected(team) {
  view = freshView(team?.id)
  setChildren(list())
  view.unseen = 0
  paintJump()
  setComposerError('')
  $('composer-to').value = 'team' // a recipient picked for another team does not carry over
  const empty = $('transcript-empty')
  empty.hidden = false
  empty.textContent = team ? 'Loading the conversation.' : 'Select a team to read what its agents say to each other.'
  paintComposer(team)
  paintDisband(team)
  if (team) load(team.id)
}

function onMessage(message) {
  if (message.teamId !== view.teamId) return
  if (view.loading) view.buffered.push(message)
  else append([message])
}

/** After a reconnect: whatever was pushed while the stream was down comes from the feed. */
export function resumeAfterReconnect() {
  const team = selectedTeam()
  if (!team || team.id !== view.teamId) return
  view.loading = true
  load(team.id)
}

// ── composer ─────────────────────────────────────────────────────────────

function setComposerError(text) {
  const el = $('composer-error')
  if (el) el.textContent = text
}

function paintComposer(team) {
  const to = $('composer-to')
  const text = $('composer-text')
  const live = team && team.status !== 'disbanded'
  // Rebuilt only when the agents change: replacing the options would close an open dropdown.
  const signature = (team?.agents ?? []).map(a => a.name).join(',')
  if (to.dataset.signature !== signature) {
    const previous = to.value
    to.dataset.signature = signature
    setChildren(to,
      h('option', { value: 'team' }, 'Whole team'),
      ...(team?.agents ?? []).map(agent => h('option', { value: agent.name }, `${agent.name} (${agent.program})`)))
    if ([...to.options].some(o => o.value === previous)) to.value = previous
  }
  to.disabled = !live
  text.disabled = !live
  $('composer-send').disabled = !live
  text.placeholder = !team ? 'Select a team to talk to it.'
    : !live ? 'This team has ended.'
    : 'Steer the team. Enter sends, Shift+Enter adds a line.'
}

/** The live team and single agent the composer is addressed to, or null: skills go to one agent only. */
function skillContext() {
  const team = selectedTeam()
  const to = $('composer-to').value
  return team && team.status !== 'disbanded' && to && to !== 'team' ? { teamId: team.id, agent: to } : null
}

async function submitComposer(event) {
  event?.preventDefault()
  const team = selectedTeam()
  const text = $('composer-text')
  const content = text.value.trim()
  if (!team || !content) return
  const send = $('composer-send')
  send.disabled = true
  setComposerError('')
  try {
    const to = $('composer-to').value || 'team'
    // "/token args" to one agent is a skill when the token is one of that agent's own; anything else is plain text.
    const slash = to !== 'team' && /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(content)
    const skill = slash && await picker.lookup({ teamId: team.id, agent: to }, slash[1])
    if (skill) await api.invokeSkill(team.id, to, skill.token, (slash[2] ?? '').trim())
    else await api.sendMessage(team.id, to, content)
    picker.close()
    text.value = ''
  } catch (err) {
    setComposerError(`Message not sent: ${err.message}`)
  } finally {
    send.disabled = !selectedTeam() || selectedTeam().status === 'disbanded'
    text.focus()
  }
}

// ── disband, with an inline confirm ──────────────────────────────────────

function paintDisband(team) {
  const slot = $('disband-slot')
  if (!team || team.status === 'disbanded') {
    setChildren(slot)
    return
  }
  if (view.disbanding) {
    setChildren(slot, h('span', { class: 'hint' }, 'Disbanding'))
  } else if (view.confirming) {
    const keep = h('button', { type: 'button', class: 'quiet', onclick: () => { view.confirming = false; paintDisband(team); slot.querySelector('button')?.focus() } }, 'Keep running')
    const confirm = h('button', { type: 'button', class: 'danger', onclick: () => disband(team) }, 'Disband')
    setChildren(slot, h('span', { class: 'confirm', role: 'group', 'aria-label': 'Confirm disband' },
      h('span', {}, 'End this team?'), confirm, keep))
    confirm.focus()
  } else {
    setChildren(slot, h('button', { type: 'button', class: 'quiet', onclick: () => { view.confirming = true; paintDisband(team) } }, 'Disband'))
  }
}

async function disband(team) {
  view.confirming = false
  view.disbanding = true
  paintDisband(team)
  try {
    await api.disbandTeam(team.id)
  } catch (err) {
    setComposerError(`Could not disband: ${err.message}`)
  } finally {
    view.disbanding = false
    paintDisband(selectedTeam())
  }
}

// ── wiring ───────────────────────────────────────────────────────────────

export function initTranscript() {
  const el = list()
  el.addEventListener('scroll', () => {
    if (atBottom(el) && view.unseen) {
      view.unseen = 0
      paintJump()
    }
  })
  $('jump').addEventListener('click', () => {
    scrollToBottom(el)
    view.unseen = 0
    paintJump()
  })
  $('composer').addEventListener('submit', submitComposer)
  // Before the Enter handler below, so that Enter on a highlighted skill picks it instead of sending.
  picker = attachSkillPicker({ input: $('composer-text'), panel: $('skill-picker'), getContext: skillContext })
  $('composer-to').addEventListener('change', picker.refresh)
  $('composer-text').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      submitComposer()
    }
  })

  on('selected', onSelected)
  on('selected-updated', team => {
    if (team.id !== view.teamId) return
    paintComposer(team)
    paintDisband(team)
  })
  on('event:message', onMessage)
  paintComposer(undefined)
}
