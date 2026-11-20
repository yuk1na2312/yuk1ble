// The "/" skill picker of the composer. While the recipient is one agent and the text is "/" plus
// the start of a token, it lists that agent's installed skills (grouped, filtered as you type) and
// picking one fills in "/token ". It never sends anything: the composer's own submit decides, using
// lookup() to tell a skill from ordinary text that happens to start with "/".
//
// Which skills there are is the server's answer for (team, agent); the page never names a directory.
// Programs are not named here either: the server says whether the agent supports skills at all.

import { h, setChildren } from './dom.js'
import * as api from './api.js'

/** A fetched catalog is reused this long when a message is sent; the server caches for a minute itself. */
const FRESH_MS = 30_000
const TOKEN_TEXT = /^\/\S*$/

/**
 * @param {{ input: HTMLTextAreaElement, panel: HTMLElement, getContext: () => ({ teamId: string, agent: string } | null) }} options
 *   getContext: the team and agent the composer is addressed to, or null for the whole team or no live team.
 */
export function attachSkillPicker({ input, panel, getContext }) {
  let mode = 'closed' // 'closed' | 'list' | 'hint'
  let loaded = null // { key, at, catalog }
  let filtered = []
  let active = -1
  let ticket = 0

  const keyOf = ctx => `${ctx.teamId}\0${ctx.agent}`

  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-controls', 'skill-list')
  input.setAttribute('aria-expanded', 'false')

  function close() {
    ticket++
    mode = 'closed'
    active = -1
    panel.hidden = true
    setChildren(panel)
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
  }

  async function fetchCatalog(ctx) {
    const catalog = await api.getSkills(ctx.teamId, ctx.agent)
    loaded = { key: keyOf(ctx), at: Date.now(), catalog }
    return catalog
  }

  /** The catalog for `ctx`, from the last fetch when it is the same agent and recent. */
  async function catalogFor(ctx) {
    if (loaded && loaded.key === keyOf(ctx) && Date.now() - loaded.at < FRESH_MS) return loaded.catalog
    return fetchCatalog(ctx)
  }

  /** The catalog entry of `token` for the agent, or null: not a skill, a program without skills, or no answer. */
  async function lookup(ctx, token) {
    try {
      const catalog = await catalogFor(ctx)
      return catalog.invocation === 'none' ? null : (catalog.skills.find(s => s.token === token) ?? null)
    } catch {
      return null
    }
  }

  function showHint(text) {
    mode = 'hint'
    active = -1
    filtered = []
    setChildren(panel, h('p', { class: 'skill-picker-hint', role: 'status' }, text))
    panel.hidden = false
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
  }

  function paintActive() {
    const rows = panel.querySelectorAll('[role="option"]')
    rows.forEach((row, i) => {
      row.classList.toggle('is-active', i === active)
      row.setAttribute('aria-selected', String(i === active))
    })
    const row = rows[active]
    const description = panel.querySelector('.skill-picker-desc')
    if (description) description.textContent = filtered[active]?.description ?? ''
    if (row) {
      input.setAttribute('aria-activedescendant', row.id)
      row.scrollIntoView({ block: 'nearest' })
    } else {
      input.removeAttribute('aria-activedescendant')
    }
  }

  function showList(ctx, catalog) {
    const query = input.value.slice(1).toLowerCase()
    filtered = catalog.skills.filter(s => !query || s.token.toLowerCase().includes(query) || s.group.toLowerCase().includes(query))
    active = filtered.length ? 0 : -1

    const groups = []
    for (const [i, skill] of filtered.entries()) {
      const row = h('div', {
        id: `skill-opt-${i}`, class: 'skill-picker-row', role: 'option', 'aria-selected': 'false',
        // Keep focus in the textarea while the mouse works the list.
        onmousedown: event => event.preventDefault(),
        onmouseenter: () => { active = i; paintActive() },
        onclick: () => pick(i),
      }, h('span', { class: 'skill-picker-token' }, `/${skill.token}`))
      const last = groups[groups.length - 1]
      if (last && last.name === skill.group) last.rows.push(row)
      else groups.push({ name: skill.group, rows: [row] })
    }

    mode = 'list'
    setChildren(panel,
      h('div', { class: 'skill-picker-head' },
        h('span', {}, `Skills for ${ctx.agent}`),
        h('span', { class: 'skill-picker-count' }, String(catalog.skills.length))),
      h('div', { id: 'skill-list', class: 'skill-picker-list', role: 'listbox', 'aria-label': `Skills for ${ctx.agent}` },
        groups.map(g => h('div', { role: 'group', 'aria-label': g.name },
          h('div', { class: 'skill-picker-group', 'aria-hidden': 'true' }, g.name), g.rows)),
        filtered.length === 0 && h('p', { class: 'skill-picker-empty' }, 'No matching skills.')),
      h('p', { class: 'skill-picker-desc' }),
      catalog.detail && h('p', { class: 'skill-picker-foot' }, catalog.detail))
    panel.hidden = false
    input.setAttribute('aria-expanded', String(filtered.length > 0))
    paintActive()
  }

  /** Re-evaluate: whether the picker belongs on screen for the composer's current text and recipient. */
  async function refresh() {
    const ctx = getContext()
    if (!ctx || !TOKEN_TEXT.test(input.value)) return close()
    const mine = ++ticket
    try {
      const catalog = await catalogFor(ctx)
      // The text, the recipient or the team may have changed while the request was out.
      if (mine !== ticket) return
      if (catalog.invocation === 'none') showHint(catalog.detail || `Skills are not available for ${ctx.agent}.`)
      else showList(ctx, catalog)
    } catch {
      if (mine === ticket) showHint('Could not load skills.')
    }
  }

  function pick(index) {
    const skill = filtered[index]
    if (!skill) return
    const text = `/${skill.token} `
    close()
    input.value = text
    input.setSelectionRange(text.length, text.length)
    input.focus()
  }

  function move(step) {
    if (!filtered.length) return
    active = (active + step + filtered.length) % filtered.length
    paintActive()
  }

  input.addEventListener('input', refresh)
  // Registered before the composer's own Enter handler: picking must not also send.
  input.addEventListener('keydown', event => {
    if (mode === 'closed') return
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (mode === 'list' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
    } else if (mode === 'list' && active >= 0 && (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      event.stopImmediatePropagation()
      pick(active)
    }
  })
  input.addEventListener('blur', () => {
    // A click on a row keeps the focus here (mousedown is cancelled), so a blur is a real departure.
    if (mode !== 'closed') close()
  })

  return { refresh, close, lookup }
}
