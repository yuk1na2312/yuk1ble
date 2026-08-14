// Thin wrapper over the vendored Motion global (public/vendor/motion.dom.js —
// window.Motion, exposing animate/scroll/inView/stagger/spring/hover/press).
//
// Every export degrades TWICE: if the user prefers reduced motion, or if the vendor
// script failed to load (window.Motion undefined), each function still produces the
// correct END STATE synchronously and resolves immediately. A missing vendor file must
// never leave the UI broken, only un-animated.

// The one import here, and only for skeleton(): emptying a container is an invariant
// (`.is-static` furniture survives) that must not exist in two places. dom.js imports
// nothing, so this cannot cycle.
import { clear } from './dom.js'

const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

// Live binding — reassigned in place (not shadowed) by the change listener below, so
// every caller that read `MOTION_OK` at import time keeps seeing the current value.
export let MOTION_OK = !reduceMotionQuery.matches
reduceMotionQuery.addEventListener('change', e => { MOTION_OK = !e.matches })

const motionReady = () => MOTION_OK && typeof window.Motion !== 'undefined'

// One in-flight animation per element. A re-entrant call on the same element cancels
// (not queues behind) whatever was already running, so a click mid-animation is never
// blocked. Only transform/opacity/box-shadow/height (the one documented exception,
// see expand()) are ever animated — no layout-thrashing properties.
const running = new WeakMap()

function stopRunning(el) {
  const prev = running.get(el)
  if (!prev) return
  running.delete(el)
  try { prev.stop() } catch { /* already finished */ }
}

const toList = els => {
  if (Array.isArray(els)) return els
  if (els instanceof Element) return [els]
  return Array.from(els || [])
}

// color-mix() works with both hex literals and CSS custom properties (var(--accent)),
// so pulse() doesn't need its own hex/rgb parser.
const ringColor = (color, alpha) => `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`

// Stagger-enter a set of elements. 30ms stagger, spring(stiffness 400, damping 34),
// from { opacity: 0, y: 8 }.
export function enter(els) {
  const list = toList(els)
  if (!list.length) return Promise.resolve()

  if (!motionReady()) {
    for (const el of list) {
      el.style.opacity = '1'
      el.style.transform = ''
    }
    return Promise.resolve()
  }

  for (const el of list) stopRunning(el)
  const { animate, stagger } = window.Motion
  const controls = animate(list, { opacity: [0, 1], y: [8, 0] }, {
    type: 'spring', stiffness: 400, damping: 34,
    delay: stagger(0.03),
  })
  for (const el of list) running.set(el, controls)
  return controls.finished.then(() => {}, () => {})
}

// Exit + detach. 140ms, opacity->0, x->-6. ALWAYS removes el from the DOM when done,
// including in the reduced-motion and no-Motion paths.
export function exit(el) {
  stopRunning(el)
  const detach = () => { el.remove() }

  if (!motionReady()) {
    detach()
    return Promise.resolve()
  }

  const controls = window.Motion.animate(el, { opacity: [1, 0], x: [0, -6] }, { duration: 0.14 })
  running.set(el, controls)
  // detach on both fulfil and reject — an animation cut short by a later stopRunning()
  // call must still remove the element, not strand it mid-exit.
  return controls.finished.then(detach, detach)
}

// Move a shared indicator bar to sit over `target` (spring). Pass target=null to hide it.
// Not async: callers don't need to await a purely decorative indicator move.
//
// Two orientations, chosen by the bar's own `data-axis` attribute so the caller can keep
// using one call shape for both. `y` (the default) tracks the target's top+height — the
// vertical rail beside a list, e.g. #selBar. `x` tracks left+width — a horizontal
// underline beneath a row of tabs, e.g. #tabUnderline. Getting this wrong is silent and
// ugly: an x-axis bar driven on the y axis keeps the width: 0 its stylesheet gave it and
// simply never appears.
export function slideSelection(bar, target) {
  stopRunning(bar)

  if (target === null) {
    if (!motionReady()) { bar.style.opacity = '0'; return }
    const controls = window.Motion.animate(bar, { opacity: 0 }, { duration: 0.14 })
    running.set(bar, controls)
    return
  }

  const horizontal = bar.dataset.axis === 'x'
  const parent = bar.offsetParent || bar.parentElement
  const parentRect = parent.getBoundingClientRect()
  const rect = target.getBoundingClientRect()

  // clientLeft/clientTop are the parent's border widths. They have to come off because
  // an absolutely positioned bar is laid out against its ancestor's PADDING box, while
  // getBoundingClientRect() reports the BORDER box. Without this the bar lands short by
  // exactly the parent's border+padding — invisible on a borderless list, a clear 5px
  // misalignment on #tabBar, which has both.
  const offset = horizontal
    ? rect.left - parentRect.left - parent.clientLeft + parent.scrollLeft
    : rect.top - parentRect.top - parent.clientTop + parent.scrollTop
  const size = horizontal ? rect.width : rect.height

  const first = bar.dataset.slidePositioned !== '1'
  bar.dataset.slidePositioned = '1'

  if (!motionReady() || first) {
    // First call (or reduced motion): place directly — there is no prior position to
    // animate from, and animating a bar in from nowhere would look like a bug.
    bar.style.transform = horizontal ? `translateX(${offset}px)` : `translateY(${offset}px)`
    bar.style[horizontal ? 'width' : 'height'] = `${size}px`
    bar.style.opacity = '1'
    return
  }

  const to = horizontal ? { x: offset, width: size } : { y: offset, height: size }
  to.opacity = 1
  const controls = window.Motion.animate(bar, to, {
    type: 'spring', stiffness: 400, damping: 34,
  })
  running.set(bar, controls)
}

// Animate height between 0 and auto. `open` boolean. Sets `hidden`/inline height itself.
export function expand(el, open) {
  stopRunning(el)
  if (open) el.hidden = false

  const target = open ? el.scrollHeight : 0
  const current = (el.style.height && el.style.height !== 'auto')
    ? (parseFloat(el.style.height) || 0)
    : (open ? 0 : el.scrollHeight)

  if (!motionReady()) {
    el.style.overflow = ''
    if (open) { el.style.height = 'auto' } else { el.style.height = '0px'; el.hidden = true }
    return Promise.resolve()
  }

  // height:auto isn't directly animatable. Measure scrollHeight, animate a pixel height
  // between the two states, then hand back 'auto' on open so later content changes
  // reflow naturally. This is the one permitted exception to the no-height-animation
  // rule — unavoidable for a disclosure, and not in a hot path.
  el.style.overflow = 'hidden'
  const controls = window.Motion.animate(el, { height: [`${current}px`, `${target}px`] }, { duration: 0.18 })
  running.set(el, controls)

  return controls.finished.then(() => {
    el.style.overflow = ''
    if (open) { el.style.height = 'auto' } else { el.style.height = '0px'; el.hidden = true }
  }, () => {
    el.style.overflow = ''
  })
}

// One-shot attention pulse (box-shadow ring) in `color`. Used on status change.
export function pulse(el, color) {
  stopRunning(el)

  if (!motionReady()) return // no lingering state to apply — box-shadow was never set

  const controls = window.Motion.animate(el, {
    boxShadow: [`0 0 0 0 ${ringColor(color, 0.55)}`, `0 0 0 8px ${ringColor(color, 0)}`],
  }, { duration: 0.5 })
  running.set(el, controls)
  controls.finished.then(() => {
    el.style.boxShadow = ''
    if (running.get(el) === controls) running.delete(el)
  }, () => {})
}

// Slow breathing glow while `on`. Idempotent; calling with the same value is a no-op.
// Driven entirely by CSS (`@keyframes breathe`, toggled via `.is-breathing`), so it
// costs nothing on the main thread and degrades for free under the CSS-level
// prefers-reduced-motion rule — no JS gate needed here.
export function breathe(el, on) {
  const want = !!on
  if (el.classList.contains('is-breathing') !== want) el.classList.toggle('is-breathing', want)
  return () => breathe(el, false)
}

// Crossfade two sibling views. dir: 1 = forward (slide up 4px), -1 = back (slide down).
export function crossfade(outEl, inEl, dir = 1) {
  stopRunning(outEl)
  stopRunning(inEl)
  const sign = dir >= 0 ? 1 : -1

  if (!motionReady()) {
    outEl.hidden = true
    outEl.style.opacity = ''
    outEl.style.transform = ''
    inEl.hidden = false
    inEl.style.opacity = '1'
    inEl.style.transform = ''
    return Promise.resolve()
  }

  inEl.hidden = false
  const outControls = window.Motion.animate(outEl, { opacity: [1, 0], y: [0, -4 * sign] }, { duration: 0.16 })
  const inControls = window.Motion.animate(inEl, { opacity: [0, 1], y: [4 * sign, 0] }, { duration: 0.16 })
  running.set(outEl, outControls)
  running.set(inEl, inControls)

  return Promise.all([outControls.finished, inControls.finished]).then(() => {
    outEl.hidden = true
    outEl.style.opacity = ''
    outEl.style.transform = ''
  }, () => {})
}

// Wire hover + press feedback on a button-ish element. Press uses transform scale .97 —
// NEVER width/height/top/left. Safe to call twice on the same element.
export function pressable(el) {
  if (el.dataset.pressable === '1') return
  el.dataset.pressable = '1'

  if (!motionReady()) return // native :hover/:active CSS already covers the affordance

  const { hover, press } = window.Motion
  if (typeof hover === 'function') {
    hover(el, () => {
      const c = window.Motion.animate(el, { scale: 1.015 }, { duration: 0.12 })
      running.set(el, c)
      return () => {
        const c2 = window.Motion.animate(el, { scale: 1 }, { duration: 0.12 })
        running.set(el, c2)
      }
    })
  }
  if (typeof press === 'function') {
    press(el, () => {
      const c = window.Motion.animate(el, { scale: 0.97 }, { duration: 0.08 })
      running.set(el, c)
      return () => {
        const c2 = window.Motion.animate(el, { scale: 1 }, { duration: 0.12 })
        running.set(el, c2)
      }
    })
  }
}

// ── toast ────────────────────────────────────────────────────────────────────────
let toastsEl = null
const MAX_TOASTS = 4

function ensureToasts() {
  if (toastsEl && document.body.contains(toastsEl)) return toastsEl
  toastsEl = document.createElement('div')
  toastsEl.id = 'toasts'
  // polite + status: announced without stealing focus from whatever the user is doing.
  toastsEl.setAttribute('aria-live', 'polite')
  toastsEl.setAttribute('role', 'status')
  document.body.appendChild(toastsEl)
  return toastsEl
}

function dismissToast(el) {
  if (!el.isConnected) return
  stopRunning(el)
  if (!motionReady()) { el.remove(); return }
  const controls = window.Motion.animate(el, { opacity: [1, 0], y: [0, 8] }, { duration: 0.14 })
  running.set(el, controls)
  controls.finished.then(() => el.remove(), () => el.remove())
}

// Non-blocking toast. level: 'err' | 'ok' | 'info'. Auto-dismisses after 4s.
// Creates its own #toasts container (aria-live="polite") on first use.
export function toast(message, level = 'info') {
  const container = ensureToasts()
  const el = document.createElement('div')
  el.className = `toast ${level}`
  el.textContent = message
  container.appendChild(el) // newest at the bottom

  // Cap at 4 visible; drop the oldest beyond that immediately rather than waiting out
  // its own timer.
  const all = Array.from(container.children)
  while (all.length > MAX_TOASTS) dismissToast(all.shift())

  if (!motionReady()) {
    el.style.opacity = '1'
  } else {
    const controls = window.Motion.animate(el, { opacity: [0, 1], y: [8, 0] }, {
      type: 'spring', stiffness: 400, damping: 34,
    })
    running.set(el, controls)
  }

  setTimeout(() => dismissToast(el), 4000)
}

// Skeleton shimmer rows for loading states. Replaces `container`'s content with a
// `.skeleton` block of `rows` `.skeleton-row`s (shimmer comes from CSS `@keyframes
// shimmer`) and returns that new `.skeleton` element — not the container passed in.
export function skeleton(container, rows = 3) {
  const wrap = document.createElement('div')
  // is-placeholder is not cosmetic: it is the marker every consumer already uses to
  // recognise a node that stands in for content rather than being content. Without it
  // the shimmer carries no data-key, so a later reconcile() files it under `undefined`,
  // hands it back in `removed`, and any caller that ignores `removed` leaves the
  // skeleton sitting under the real rows forever.
  wrap.className = 'skeleton is-placeholder'
  for (let i = 0; i < rows; i++) {
    const row = document.createElement('div')
    row.className = 'skeleton-row'
    wrap.appendChild(row)
  }
  // clear(), not a bare removeChild loop: #selBar lives inside #teams, and #teams is
  // exactly the container the boot sequence shows a skeleton in. A loop that took every
  // child would delete the selection bar before the first poll ever ran.
  clear(container)
  container.appendChild(wrap)
  return wrap
}
