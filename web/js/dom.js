// DOM helpers. Server and user text only ever enters the page as text nodes or
// attribute values through these: no markup is ever built from a string anywhere in the GUI.

export const $ = id => document.getElementById(id)

/**
 * h('button', { class: 'x', onclick: fn, dataset: { id }, 'aria-label': 'y' }, 'text', childNode)
 * String and number children become text nodes. null/false/undefined children are skipped.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'dataset') Object.assign(el.dataset, value)
    else if (key === 'style') el.style.cssText = value
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value)
    else if (key in el && key !== 'list' && key !== 'form') el[key] = value
    else el.setAttribute(key, value === true ? '' : String(value))
  }
  append(el, children)
  return el
}

export function append(el, children) {
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

export function clear(el) {
  el.replaceChildren()
}

/** Sets el's whole content to the given children. */
export function setChildren(el, ...children) {
  el.replaceChildren(...children.flat().filter(c => c !== undefined && c !== null && c !== false)
    .map(c => (c instanceof Node ? c : document.createTextNode(String(c)))))
}

/** Whether a scroll container is within `slack` px of its bottom. */
export function atBottom(el, slack = 24) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack
}

export function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight
}

export function timeOf(iso) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function debounce(fn, ms) {
  let timer
  const wrapped = (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
  wrapped.cancel = () => clearTimeout(timer)
  return wrapped
}
