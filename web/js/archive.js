// Archive / Restore / Purge for the selected team, in the conversation column's header.
// Archive hides a run behind the list's "Show N archived" toggle and deletes nothing. Purge,
// offered only on an archived run, erases it for good and asks first in a modal <dialog>.

import { $, h, setChildren } from './dom.js'
import * as api from './api.js'
import { on, selectedTeam, state } from './store.js'

const isLive = team => team.status === 'active' || team.status === 'forming'

let busy = false
let error = ''
/** The team the purge dialog is about, and whether its request is in flight. */
let purging = null
let purgeInFlight = false

function paint(team) {
  const slot = $('archive-slot')
  const hadFocus = slot.contains(document.activeElement)
  if (!team || isLive(team)) {
    setChildren(slot)
    return
  }
  setChildren(slot,
    error && h('span', { class: 'form-error', role: 'alert' }, error),
    h('button', { type: 'button', class: 'quiet', disabled: busy, onclick: () => setArchived(team, !team.archivedAt) },
      team.archivedAt ? 'Restore' : 'Archive'),
    team.archivedAt && h('button', { type: 'button', class: 'danger', disabled: busy, onclick: () => openPurge(team) }, 'Purge'))
  // The button that was clicked is replaced by its counterpart; keep keyboard focus in the slot.
  if (hadFocus) slot.querySelector('button')?.focus()
}

async function setArchived(team, archived) {
  busy = true
  error = ''
  paint(team)
  try {
    await api.archiveTeam(team.id, archived)
  } catch (err) {
    error = `Could not ${archived ? 'archive' : 'restore'}: ${err.message}`
  } finally {
    busy = false
    paint(selectedTeam())
  }
}

// ── purge confirmation ───────────────────────────────────────────────────

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

async function openPurge(team) {
  // The count is the last message's per-team seq: the true total even when older ones left the server's memory.
  let count
  try {
    count = (await api.getFeed(team.id)).at(-1)?.seq ?? 0
  } catch { /* counted as "its messages" below */ }
  const dialog = $('purge-dialog')
  if (dialog.open) return
  purging = team
  $('purge-text').textContent = `This erases "${team.name}" for good: its record, ${count === undefined ? 'its messages' : plural(count, 'message')} and the files from its run. It cannot be undone.`
  $('purge-error').textContent = ''
  $('purge-confirm').hidden = false
  $('purge-confirm').disabled = false
  $('purge-cancel').textContent = 'Cancel'
  dialog.showModal()
}

async function confirmPurge() {
  const team = purging
  if (!team || purgeInFlight) return
  purgeInFlight = true
  $('purge-confirm').disabled = true
  $('purge-error').textContent = ''
  try {
    const { warnings = [] } = await api.purgeTeam(team.id)
    if (warnings.length === 0) {
      $('purge-dialog').close()
    } else {
      $('purge-text').textContent = `"${team.name}" was erased, but: ${warnings.join(' ')}`
      $('purge-confirm').hidden = true
      $('purge-cancel').textContent = 'Close'
    }
  } catch (err) {
    $('purge-error').textContent = `Could not purge: ${err.message}`
    $('purge-confirm').disabled = false
  } finally {
    purgeInFlight = false
  }
}

export function initArchive() {
  const dialog = $('purge-dialog')
  $('purge-confirm').addEventListener('click', confirmPurge)
  $('purge-cancel').addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => { purging = null })

  const repaint = () => paint(selectedTeam())
  on('selected', () => { error = ''; repaint() })
  on('selected-updated', repaint)
  // A team purged from another tab while its dialog is open; one purged here keeps the dialog for its warnings.
  on('teams', () => {
    if (purging && !purgeInFlight && dialog.open && !state.teams.has(purging.id)) dialog.close()
  })
  repaint()
}
