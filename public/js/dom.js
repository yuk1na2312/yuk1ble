// Pure DOM plumbing. Zero imports — no Motion, no app state, no fetch — so this file
// stays trivially reviewable and independently testable.

// Element factory. attrs: {class, id, text, html, style: {..}, data: {..}, on: {click: fn}, ...}
// Any other key is set via setAttribute. `children` is an element / string / array / null.
export function h(tag, attrs = {}, children = null) {
  const el = document.createElement(tag)
  for (const key in attrs) {
    const value = attrs[key]
    if (value === undefined) continue
    if (key === 'class') {
      el.className = value
    } else if (key === 'id') {
      el.id = value
    } else if (key === 'text') {
      // textContent — never innerHTML — so this path is safe for server/user data.
      el.textContent = value
    } else if (key === 'html') {
      // innerHTML: trusted static markup ONLY. Never pass server or user data here —
      // use `text` (or setText) for anything that isn't a fixed literal you wrote.
      el.innerHTML = value
    } else if (key === 'style') {
      Object.assign(el.style, value)
    } else if (key === 'data') {
      for (const dk in value) el.dataset[dk] = value[dk]
    } else if (key === 'on') {
      for (const ev in value) el.addEventListener(ev, value[ev])
    } else if (value === true) {
      el.setAttribute(key, '')
    } else if (value === false || value === null) {
      // omit — a false/null boolean-ish attribute should not appear at all
    } else {
      el.setAttribute(key, value)
    }
  }
  appendChildren(el, children)
  return el
}

function appendChildren(el, children) {
  if (children === null || children === undefined) return
  if (Array.isArray(children)) {
    for (const c of children) appendChildren(el, c)
    return
  }
  if (typeof children === 'string') {
    el.appendChild(document.createTextNode(children))
    return
  }
  el.appendChild(children)
}

// Sets textContent only when it differs. Returns true if it changed.
export function setText(el, text) {
  if (el.textContent === text) return false
  el.textContent = text
  return true
}

// Sets/removes a class only when it differs. Returns true if it changed.
export function setClass(el, name, on) {
  const want = !!on
  if (el.classList.contains(name) === want) return false
  el.classList.toggle(name, want)
  return true
}

// A child this module does not own. Two cases, both of which must be skipped by every
// traversal below:
//   `.is-leaving` — mid-exit; the caller still owns it until its animation finishes.
//   `.is-static`  — furniture that lives inside a managed container permanently, e.g.
//                   #selBar, which has to be a child of the scroll box so it scrolls
//                   with the rows. It carries no data-key, so without this guard it
//                   would map under the key `undefined`, never appear in `seen`, and be
//                   handed back in `removed` for the caller to animate out and delete.
function isForeign(el) {
  return el.classList.contains('is-leaving') || el.classList.contains('is-static')
}

// Keyed reconciliation of `container`'s children against `items`, IN ORDER.
//  - key(item)      -> stable string
//  - create(item)   -> new HTMLElement (dom.js stamps el.dataset.key itself)
//  - patch(el,item) -> mutate an existing element in place; return value ignored
// Elements to be removed are left IN THE DOM, marked `.is-leaving`, and returned in
// `removed` — the CALLER detaches them (so it can animate them out first). `.is-leaving`
// and `.is-static` elements are invisible to this function on every call: never matched
// against an item's key, never patched, never counted, never repositioned.
export function reconcile(container, items, { key, create, patch }) {
  const existing = new Map()
  for (const el of container.children) {
    if (isForeign(el)) continue
    existing.set(el.dataset.key, el)
  }

  const added = []
  const patched = []
  const seen = new Set()

  // `cursor` walks the "next expected DOM position." insertBefore against it (rather
  // than detach-and-reappend every surviving node) preserves scroll position and any
  // live selection/focus inside untouched rows.
  let cursor = container.firstElementChild

  for (const item of items) {
    const k = String(key(item))
    seen.add(k)
    let el = existing.get(k)
    if (el) {
      patch(el, item)
      patched.push(el)
    } else {
      el = create(item)
      el.dataset.key = k
      added.push(el)
    }

    while (cursor && isForeign(cursor)) cursor = cursor.nextElementSibling

    if (cursor !== el) {
      container.insertBefore(el, cursor)
      // cursor still names the correct "next" node — el was just placed before it.
    } else {
      cursor = cursor.nextElementSibling
    }
  }

  const removed = []
  for (const [k, el] of existing) {
    if (seen.has(k)) continue
    el.classList.add('is-leaving')
    removed.push(el)
  }

  return { added, patched, removed }
}

// Append-only lists (transcript, log). Appends items beyond `container`'s current count.
// `from` overrides the start index; default is container.childElementCount, skipping
// any child carrying class `is-placeholder` (an empty-state node shouldn't count as
// "item 0" and get overwritten-in-place by the first real item) or `is-static` (page
// furniture is not a list item either).
export function append(container, items, { create, from = null }) {
  let start = from
  if (start === null) {
    start = 0
    for (const el of container.children) {
      if (el.classList.contains('is-placeholder')) continue
      if (el.classList.contains('is-static')) continue
      start++
    }
  }

  const out = []
  for (let i = start; i < items.length; i++) {
    const el = create(items[i])
    container.appendChild(el)
    out.push(el)
  }
  return out
}

// Removes every child except `.is-static` furniture. Used for placeholders/empty states.
// The exception matters: #selBar lives inside #teams so it scrolls with the rows, and an
// "empty teams" path that reached for clear() would otherwise delete it permanently —
// every later slideSelection() would then be aimed at a detached node.
export function clear(container) {
  for (const el of [...container.childNodes]) {
    if (el.nodeType === 1 && el.classList.contains('is-static')) continue
    container.removeChild(el)
  }
}
