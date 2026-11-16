// The server log drawer: backfilled from /logs, then fed by `log` events.

import { $, atBottom, h, scrollToBottom, timeOf } from './dom.js'
import * as api from './api.js'
import { on } from './store.js'

/** Log lines kept in the page. */
export const MAX_LOG_LINES = 1500

let lastSeq = 0
let errors = 0

function paintToggle() {
  const toggle = $('log-toggle')
  toggle.dataset.errors = errors > 0 ? 'true' : 'false'
  $('log-title').textContent = errors > 0 ? `Server log, ${errors} error${errors === 1 ? '' : 's'}` : 'Server log'
}

function lineNode(entry) {
  return h('div', { class: 'log-line', dataset: { level: entry.level } },
    h('span', { class: 'log-time' }, timeOf(entry.timestamp)),
    h('span', { class: 'log-text' }, entry.text))
}

function add(entries) {
  const body = $('log-body')
  const fresh = entries.filter(e => e.seq > lastSeq)
  if (fresh.length === 0) return
  const follow = atBottom(body)
  for (const entry of fresh) {
    lastSeq = entry.seq
    if (entry.level === 'error') errors++
  }
  body.append(...fresh.map(lineNode))
  while (body.childElementCount > MAX_LOG_LINES) body.firstElementChild.remove()
  $('log-last').textContent = fresh.at(-1).text.split('\n')[0]
  paintToggle()
  if (follow) scrollToBottom(body)
}

/** Fetch what the server logged after the last line seen (all of it, the first time). */
export async function backfillLog() {
  try {
    const { entries, latest } = await api.getLogs(lastSeq || undefined)
    if (latest < lastSeq) {
      // The server restarted and numbers from 1 again: start the panel over.
      lastSeq = 0
      $('log-body').replaceChildren()
      errors = 0
      add((await api.getLogs()).entries)
      return
    }
    add(entries)
  } catch { /* the drawer is a convenience; the connection indicator shows the outage */ }
}

export function initLog() {
  const drawer = $('log-drawer')
  const toggle = $('log-toggle')
  toggle.addEventListener('click', () => {
    const open = drawer.dataset.open !== 'true'
    drawer.dataset.open = String(open)
    toggle.setAttribute('aria-expanded', String(open))
    if (open) scrollToBottom($('log-body'))
  })
  $('log-clear').addEventListener('click', () => {
    $('log-body').replaceChildren()
    $('log-last').textContent = ''
    errors = 0
    paintToggle()
  })
  on('event:log', entry => add([entry]))
}
