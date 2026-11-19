// The Accounts view: which account each program's CLI is signed in as. Read-only on purpose:
// the server runs each CLI's own status command and answers state, account, plan and detail.
// There is nothing here to sign in or out with. The server caches answers for a minute.

import { $, h, setChildren } from './dom.js'
import * as api from './api.js'
import { programOf } from './store.js'

const STATE_TEXT = { 'signed-in': 'Signed in', 'signed-out': 'Signed out', unsupported: 'Unsupported', error: 'Error' }

let loading = false

function row(status) {
  const program = programOf(status.program)
  return h('li', { class: 'acct', style: `--voice: ${program?.color ?? 'var(--line-strong)'}` },
    h('div', { class: 'acct-head' },
      h('span', { class: 'acct-name' }, h('span', { class: 'acct-icon', 'aria-hidden': 'true' }, program?.icon ?? '•'), status.program),
      h('span', { class: 'acct-state', 'data-state': status.state }, STATE_TEXT[status.state] ?? status.state)),
    (status.account || status.plan) && h('p', { class: 'acct-meta' },
      status.account && h('span', {}, status.account),
      status.plan && h('span', {}, status.plan)),
    status.detail && h('p', { class: 'acct-detail' }, status.detail))
}

async function load() {
  if (loading) return
  loading = true
  $('accounts-refresh').disabled = true
  $('accounts-error').textContent = ''
  $('accounts-note').textContent = 'Checking…'
  try {
    const statuses = await api.getAccounts()
    setChildren($('accounts-list'), statuses.map(row))
    $('accounts-note').textContent = statuses.length ? '' : 'No programs are configured.'
  } catch (err) {
    $('accounts-note').textContent = ''
    $('accounts-error').textContent = `Could not read account status: ${err.message}`
  } finally {
    loading = false
    $('accounts-refresh').disabled = false
  }
}

export function initAccounts() {
  const dialog = $('accounts-dialog')
  $('open-accounts').addEventListener('click', () => {
    if (dialog.open) return
    dialog.showModal()
    load()
  })
  $('accounts-refresh').addEventListener('click', load)
  $('accounts-close').addEventListener('click', () => dialog.close())
}
