// The "/" autocomplete widget for the composer. Self-contained: owns its own fetch,
// DOM, and keyboard handling. Knows nothing about teams, delivery, or how a pick gets
// sent — it only ever inserts "/<token> " into the input it was given and lets the
// caller's own submit handler (see app.js §8.3) take it from there.
//
// Mount strategy: this module creates its own element and inserts it as the previous
// sibling of `input.form` (i.e. into whatever wraps the composer form in index.html —
// `#composerWrap`, styled `position:relative` there so this widget's `position:absolute;
// bottom:100%` lands it directly above the composer, not the whole column). That keeps
// this file decoupled from any specific id in index.html: it only assumes `input` sits
// inside a <form> and that form has a positioned parent.
//
// Not inside #feed or #teams, and never polled, so dom.js's `is-static` / reconcile()
// discipline does not apply here — it is rebuilt wholesale on every filter keystroke.

import { h, clear } from './dom.js'
import { enter, exit } from './motion-kit.js'

export function attachSkillPicker({ input, getContext, onPick }) {
  let pickerEl = null       // the single mounted .skill-picker div, reused across renders
  let isOpen = false        // true while the listbox (not the hint) is showing
  let hintShown = false     // true while the one-line "invocation: none" hint is showing
  let opening = false       // fetch in flight for a fresh open — guards re-fetch per keystroke
  let query = ''
  let catalog = null        // last-fetched SkillCatalog for the current context
  let filtered = []
  let highlight = -1

  const form = input.form

  function mount() {
    if (pickerEl && pickerEl.isConnected) return pickerEl
    pickerEl = h('div', { class: 'skill-picker', hidden: true })
    const anchor = form || input
    const wrap = anchor.parentElement || document.body
    wrap.insertBefore(pickerEl, anchor)
    return pickerEl
  }

  function setInputExpanded(expanded) {
    input.setAttribute('aria-expanded', String(expanded))
    if (!expanded) input.removeAttribute('aria-activedescendant')
  }

  // The only path that actually removes the widget with an exit animation. List<->hint
  // content swaps reuse the same mounted element instead (see renderList/renderHint) so
  // a "no skills, here's why" hint never races its own predecessor out of the DOM.
  function dismiss() {
    if (!isOpen && !hintShown) return
    isOpen = false
    hintShown = false
    highlight = -1
    setInputExpanded(false)
    if (pickerEl && pickerEl.isConnected) exit(pickerEl) // exit() always detaches when done
    pickerEl = null
  }

  // ── fetch ───────────────────────────────────────────────────────────────
  async function fetchCatalog(ctx) {
    const url = `/api/ensemble/skills?team=${encodeURIComponent(ctx.teamId)}&agent=${encodeURIComponent(ctx.agentName)}`
    const res = await fetch(url)
    let data = {}
    try { data = await res.json() } catch { /* no body */ }
    if (!res.ok) throw new Error(data.error || (res.status + ' ' + url))
    return data
  }

  // ── filtering ───────────────────────────────────────────────────────────
  function computeFiltered() {
    const skills = (catalog && catalog.skills) || []
    const q = query.trim().toLowerCase()
    if (!q) return skills
    return skills.filter(s =>
      s.token.toLowerCase().includes(q) || s.group.toLowerCase().includes(q))
  }

  // ── rendering ───────────────────────────────────────────────────────────
  function createRow(entry, index) {
    return h('div', {
      id: `skill-opt-${index}`,
      class: 'skill-picker-row',
      role: 'option',
      'aria-selected': 'false',
      on: {
        mousedown: e => e.preventDefault(), // keep focus on the input
        mouseenter: () => { highlight = index; updateHighlight() },
        click: () => pick(index),
      },
    }, [
      h('span', { class: 'skill-picker-token', text: `/${entry.token}` }),
      entry.name && entry.name !== entry.token
        ? h('span', { class: 'skill-picker-name', text: entry.name })
        : null,
    ])
  }

  function updateHighlight() {
    if (!pickerEl) return
    const rows = pickerEl.querySelectorAll('.skill-picker-row')
    const oldDesc = pickerEl.querySelector('.skill-picker-desc')
    if (oldDesc) oldDesc.remove()

    rows.forEach((row, i) => {
      const active = i === highlight
      row.classList.toggle('is-active', active)
      row.setAttribute('aria-selected', String(active))
    })

    const activeRow = highlight >= 0 ? rows[highlight] : null
    if (activeRow) {
      input.setAttribute('aria-activedescendant', activeRow.id)
      const entry = filtered[highlight]
      if (entry && entry.description) {
        activeRow.insertAdjacentElement('afterend',
          h('div', { class: 'skill-picker-desc', text: entry.description }))
      }
      activeRow.scrollIntoView({ block: 'nearest' })
    } else {
      input.removeAttribute('aria-activedescendant')
    }
  }

  function renderList(ctx) {
    const wasVisible = isOpen || hintShown
    const el = mount()
    clear(el)
    el.hidden = false
    el.setAttribute('role', 'listbox')
    el.removeAttribute('data-mode')
    el.setAttribute('aria-label', `Skills for ${ctx.agentName}`)

    filtered = computeFiltered()
    highlight = filtered.length ? 0 : -1

    const total = (catalog.skills || []).length
    const header = h('div', { class: 'skill-picker-header' }, [
      h('span', { text: `skills for ${ctx.agentName}` }),
      h('span', { class: 'count', text: String(total) }),
    ])

    const list = h('div', { class: 'skill-picker-list' })
    let lastGroup = null
    for (let i = 0; i < filtered.length; i++) {
      const s = filtered[i]
      if (s.group !== lastGroup) {
        list.append(h('div', { class: 'skill-picker-group', role: 'presentation', text: s.group }))
        lastGroup = s.group
      }
      list.append(createRow(s, i))
    }
    if (!filtered.length) {
      list.append(h('div', { class: 'skill-picker-empty', text: 'No matching skills.' }))
    }

    el.append(header, list)
    if (catalog.detail) el.append(h('div', { class: 'skill-picker-footer', text: catalog.detail }))

    updateHighlight()

    isOpen = true
    hintShown = false
    setInputExpanded(true)
    if (!wasVisible) enter([el])
  }

  function renderHint(text) {
    const wasVisible = isOpen || hintShown
    const el = mount()
    clear(el)
    el.hidden = false
    el.setAttribute('role', 'status')
    el.setAttribute('data-mode', 'hint')
    el.removeAttribute('aria-label')
    el.append(h('span', { text }))

    hintShown = true
    isOpen = false
    setInputExpanded(false)
    if (!wasVisible) enter([el])
  }

  // ── open / refresh ──────────────────────────────────────────────────────
  async function tryOpen(ctx) {
    let data
    try {
      data = await fetchCatalog(ctx)
    } catch {
      renderHint('Could not load skills.')
      return
    }
    // The recipient (or team) may have changed again while this was in flight.
    const latest = getContext()
    if (!latest || latest.teamId !== ctx.teamId || latest.agentName !== ctx.agentName) return
    // The composer text may have changed too — bail if the leading "/" is gone.
    if (!input.value.startsWith('/')) return

    catalog = data
    if (data.invocation === 'none') {
      renderHint(data.detail || `Skills are not available for ${ctx.agentName}.`)
      return
    }
    renderList(ctx)
  }

  function refreshOrOpen() {
    const text = input.value
    if (!text.startsWith('/')) { dismiss(); return }
    const ctx = getContext()
    if (!ctx) { dismiss(); return }
    query = text.slice(1)
    if (isOpen) { renderList(ctx); return }
    if (hintShown || opening) return // still resolving/showing "none" — don't spam fetches
    opening = true
    tryOpen(ctx).finally(() => { opening = false })
  }

  // ── picking ─────────────────────────────────────────────────────────────
  function pick(index) {
    const entry = filtered[index]
    if (!entry) return
    const value = `/${entry.token} `
    input.value = value
    input.setSelectionRange(value.length, value.length)
    dismiss()
    input.focus()
    if (typeof onPick === 'function') onPick(entry)
  }

  function move(delta) {
    if (!filtered.length) return
    highlight = (highlight + delta + filtered.length) % filtered.length
    updateHighlight()
  }

  // ── events ──────────────────────────────────────────────────────────────
  input.addEventListener('input', refreshOrOpen)

  input.addEventListener('keydown', e => {
    // Escape dismisses either the listbox or the invocation:'none' hint; everything
    // else below is listbox-only navigation, meaningless while just a hint is showing.
    if (e.key === 'Escape' && (isOpen || hintShown)) {
      e.preventDefault()
      dismiss()
      return
    }
    if (!isOpen) return
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (highlight >= 0 && filtered[highlight]) {
        e.preventDefault()
        pick(highlight)
      }
    }
  })

  // A recipient change (the <select> living in the same composer form) can flip the
  // picker between agents (re-fetch + rebuild in place) or into "-> team" (close outright).
  const recipientEl = form ? form.querySelector('select') : null
  if (recipientEl) {
    recipientEl.addEventListener('change', () => {
      if (!input.value.startsWith('/')) return
      const ctx = getContext()
      if (!ctx) { dismiss(); return }
      opening = true
      tryOpen(ctx).finally(() => { opening = false })
    })
  }

  // The form submitting (send button, or Enter with no picker match) always dismisses
  // the widget — nothing here should be left dangling once the composer content is gone.
  if (form) form.addEventListener('submit', () => dismiss())

  // Clicking anywhere outside the input and the picker itself closes it, same as Escape.
  document.addEventListener('mousedown', e => {
    if (!isOpen && !hintShown) return
    if (e.target === input) return
    if (pickerEl && pickerEl.contains(e.target)) return
    dismiss()
  })

  // Exposed so the host can force the widget shut on a state change it owns and the
  // picker cannot observe. Switching teams re-points everything an open list was built
  // from, but fires no `change` on the recipient <select> this module listens to — so
  // without this the list would keep showing the previous team's agent's skills.
  return { dismiss }
}
