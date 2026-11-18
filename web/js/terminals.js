// The stage: one real xterm.js terminal per agent of the selected team, fed by that
// agent's session stream. Streams (and terminals, observers, timers) exist only for the
// selected team and are torn down the moment the selection changes.

import { Terminal } from '/vendor/xterm/xterm.mjs'
import { FitAddon } from '/vendor/xterm/addon-fit.mjs'
import { $, debounce, h, setChildren } from './dom.js'
import * as api from './api.js'
import { agentLook, on, selectedTeam } from './store.js'
import { statusLabel } from './teams.js'

export const SCROLLBACK_LINES = 5000
const INPUT_BATCH_MS = 10
const INPUT_CHUNK_CHARS = 16_000
/** Keystrokes waiting for the network; a paste beyond this is dropped rather than held. */
const MAX_PENDING_INPUT = 1_000_000
const RESIZE_DEBOUNCE_MS = 120
const SIZE_LIMITS = { cols: [20, 400], rows: [5, 200] }

const STATE_LABEL = { connecting: 'connecting', live: 'live', exited: 'exited', none: 'no session' }

const ANSI = {
  black: '#1c1b21', red: '#ef7a7a', green: '#7ec98f', yellow: '#e0b866',
  blue: '#6aa9ff', magenta: '#c99ae3', cyan: '#6ccbd0', white: '#d9d5e0',
  brightBlack: '#6d6a7a', brightRed: '#f59b9b', brightGreen: '#9fdcac', brightYellow: '#ecd08f',
  brightBlue: '#92c1ff', brightMagenta: '#dcb7ee', brightCyan: '#92dde1', brightWhite: '#f4f1f8',
}

const panes = new Map() // agent name -> pane
let mountedTeamId

function decode(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function cssVar(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

const clamp = (value, [min, max]) => Math.min(max, Math.max(min, value))

function createPane(team, agent) {
  const look = agentLook(agent)
  let state = 'connecting'
  let source
  let disposed = false
  let sentSize = ''
  let pending = ''
  let inputTimer
  let sending = false
  let gotReplay = false
  let starting = false
  let replaying = false
  let toastTimer

  const stalled = h('span', { class: 'badge stalled', hidden: true }, 'stalled')
  const badge = h('span', { class: 'badge state', dataset: { state } }, STATE_LABEL[state])
  const maximize = h('button', {
    type: 'button', class: 'quiet icon-btn', 'aria-pressed': 'false', title: 'Maximize this terminal',
    onclick: () => toggleMaximize(agent.name),
  }, 'Maximize')
  const note = h('div', { class: 'term-note' })
  const toast = h('div', { class: 'term-toast', role: 'status', hidden: true })
  const host = h('div', { class: 'term-host' })
  const title = h('span', { class: 'pane-title' },
    h('span', { class: 'pane-icon', 'aria-hidden': 'true' }, look.icon),
    h('strong', {}, agent.name))
  const metaText = `${agent.program}, ${look.model}, ${agent.role}`
  const meta = h('span', { class: 'pane-meta', title: metaText }, metaText)
  const el = h('section', {
    class: 'pane', dataset: { state, agent: agent.name }, style: `--voice:${look.color}`,
    'aria-label': `Terminal of ${agent.name}`,
  },
  h('header', { class: 'pane-head' }, title, meta, h('span', { class: 'pane-spacer' }), stalled, badge, maximize),
  h('div', { class: 'term-wrap' }, host, note, toast))

  const term = new Terminal({
    scrollback: SCROLLBACK_LINES,
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.12,
    cursorBlink: true,
    cursorStyle: 'bar',
    theme: {
      ...ANSI,
      background: cssVar('--term-bg', '#121115'),
      foreground: cssVar('--term-fg', '#e4e0ea'),
      cursor: cssVar('--brass', '#e0b866'),
      selectionBackground: '#e0b86655',
    },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)

  function setState(next, message) {
    state = next
    el.dataset.state = next
    badge.dataset.state = next
    badge.textContent = STATE_LABEL[next]
    note.textContent = message ?? ''
    note.hidden = !message
  }

  function flash(text) {
    toast.textContent = text
    toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toast.hidden = true }, 5000)
  }

  // ── size ──
  function refit() {
    if (disposed || host.clientWidth < 20 || host.clientHeight < 20) return // hidden or collapsed
    try {
      fit.fit()
    } catch { /* the renderer is not ready yet */ }
    reportSize()
  }

  function reportSize(force = false) {
    if (state !== 'live' && !force) return
    const cols = clamp(term.cols, SIZE_LIMITS.cols)
    const rows = clamp(term.rows, SIZE_LIMITS.rows)
    const key = `${cols}x${rows}`
    if (key === sentSize && !force) return
    sentSize = key
    api.postResize(agent.sessionName, cols, rows).catch(() => { sentSize = '' })
  }

  const refitSoon = debounce(refit, RESIZE_DEBOUNCE_MS)
  const observer = new ResizeObserver(refitSoon)

  // ── input: batched, and one request in flight so keystrokes stay in order ──
  function takeChunk() {
    let end = Math.min(pending.length, INPUT_CHUNK_CHARS)
    const last = pending.charCodeAt(end - 1)
    if (end < pending.length && last >= 0xd800 && last <= 0xdbff) end-- // never split a surrogate pair
    const chunk = pending.slice(0, end)
    pending = pending.slice(end)
    return chunk
  }

  async function flushInput() {
    inputTimer = undefined
    if (sending) return
    sending = true
    try {
      while (pending && !disposed) {
        await api.postInput(agent.sessionName, takeChunk())
      }
    } catch (err) {
      pending = ''
      flash(`Input was not delivered: ${err.message}`)
    } finally {
      sending = false
    }
  }

  term.onData(data => {
    // Terminal queries found in a replay (device attributes, cursor position) were asked long ago of
    // a terminal that no longer exists; answering them would type garbage into the agent.
    if (state !== 'live' || replaying) return
    if (pending.length + data.length > MAX_PENDING_INPUT) return
    pending += data
    if (!inputTimer && !sending) inputTimer = setTimeout(flushInput, INPUT_BATCH_MS)
  })

  // A terminal keeps Tab for the agent, so give the keyboard a way out.
  term.attachCustomKeyEventHandler(event => {
    if (event.type === 'keydown' && event.ctrlKey && event.shiftKey && event.key === 'ArrowUp') {
      maximize.focus()
      return false
    }
    return true
  })

  // ── stream ──
  function closeStream() {
    source?.close()
    source = undefined
  }

  async function connect() {
    if (source || starting || disposed || !agent.sessionName) return
    starting = true
    setState('connecting', 'Connecting to the terminal.')
    refit() // the PTY should know the real size before its first output reaches us
    await api.postResize(agent.sessionName, clamp(term.cols, SIZE_LIMITS.cols), clamp(term.rows, SIZE_LIMITS.rows))
      .then(() => { sentSize = `${clamp(term.cols, SIZE_LIMITS.cols)}x${clamp(term.rows, SIZE_LIMITS.rows)}` })
      .catch(() => { /* no session yet or already gone: the stream says which */ })
    starting = false
    if (disposed || source) return

    source = new EventSource(api.sessionUrl(agent.sessionName, 'stream'))
    source.addEventListener('replay', event => {
      gotReplay = true
      term.reset() // a reconnect replays the whole scrollback again
      replaying = true
      term.write(decode(event.data), () => { replaying = false })
      setState('live')
      reportSize(true)
    })
    source.addEventListener('data', event => term.write(decode(event.data)))
    source.addEventListener('exit', () => {
      closeStream()
      setState('exited', 'The agent\'s terminal has closed.')
    })
    source.addEventListener('error', () => {
      if (!source) return
      if (source.readyState === EventSource.CLOSED) {
        closeStream()
        if (gotReplay) setState('exited', 'The connection to this terminal ended.')
        else setState('none', 'No terminal for this agent: its session is gone or could not be opened.')
      } else if (state === 'live') {
        setState('connecting', 'Connection lost. Reconnecting.')
      }
    })
  }

  /** Reconcile with the latest team record: start the stream when the agent has a session. */
  function sync(current) {
    const found = current.agents.find(a => a.name === agent.name)
    if (found) {
      agent = found
      const stalledNow = found.stalledAt && current.status !== 'disbanded' // an ended team's agents are not stalled
      stalled.hidden = !stalledNow
      stalled.title = stalledNow ? `No progress since ${new Date(found.stalledAt).toLocaleTimeString()}` : ''
    }
    if (source || starting || state === 'exited' || state === 'none') return
    if (current.status === 'disbanded') setState('none', 'This team has ended, so its terminals are closed.')
    else if (agent.status === 'active') void connect()
    else if (agent.status === 'spawning' || current.status === 'forming') setState('connecting', 'Waiting for this agent to start.')
    else setState('none', 'This agent did not start.')
  }

  function dispose() {
    disposed = true
    closeStream()
    observer.disconnect()
    refitSoon.cancel()
    clearTimeout(inputTimer)
    clearTimeout(toastTimer)
    term.dispose()
    el.remove()
  }

  term.open(host)
  observer.observe(host)
  setState('connecting')

  return {
    el, maximize, sync, dispose, refit,
    focus: () => term.focus(),
  }
}

// ── stage ──

function toggleMaximize(agentName) {
  const container = $('terminals')
  const maximizing = container.dataset.max !== agentName
  if (maximizing) container.dataset.max = agentName
  else delete container.dataset.max
  for (const [name, pane] of panes) {
    const isMax = maximizing && name === agentName
    pane.el.dataset.max = isMax ? 'true' : 'false'
    pane.maximize.textContent = isMax ? 'Restore' : 'Maximize'
    pane.maximize.setAttribute('aria-pressed', String(isMax))
    pane.maximize.title = isMax ? 'Show all terminals again' : 'Maximize this terminal'
  }
  // The observers refit as the layout settles; the maximized one also takes the keyboard.
  if (maximizing) panes.get(agentName)?.focus()
}

function unmount() {
  for (const pane of panes.values()) pane.dispose()
  panes.clear()
  const container = $('terminals')
  delete container.dataset.max
  container.dataset.count = '0'
  mountedTeamId = undefined
}

function paintHeader(team) {
  const head = $('stage-head')
  head.hidden = !team
  if (!team) return
  $('stage-name').textContent = team.name
  const status = $('stage-status')
  status.textContent = statusLabel(team.status)
  status.dataset.status = team.status
  const task = $('stage-task')
  task.textContent = team.description
  task.title = team.description
}

function mount(team) {
  unmount()
  paintHeader(team)
  $('stage-empty').hidden = Boolean(team)
  if (!team) return
  mountedTeamId = team.id
  const container = $('terminals')
  container.dataset.count = String(team.agents.length)
  for (const agent of team.agents) {
    const pane = createPane(team, agent)
    panes.set(agent.name, pane)
    container.append(pane.el)
  }
  // Panes are in the document now, so they can measure themselves before connecting.
  for (const pane of panes.values()) pane.sync(team)
}

export function initTerminals() {
  on('selected', mount)
  on('selected-updated', team => {
    if (team.id !== mountedTeamId) return
    paintHeader(team)
    for (const pane of panes.values()) pane.sync(team)
  })
  setChildren($('terminals'))
  mount(selectedTeam())
}
