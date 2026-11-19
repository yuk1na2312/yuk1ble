// Boot and wiring. All data arrives over the push stream; the only fetches are the
// ones made when the stream (re)opens, so a reconnect always resynchronises the page.

import { $ } from './dom.js'
import * as api from './api.js'
import { initArchive } from './archive.js'
import { startEvents } from './events.js'
import { initLog, backfillLog } from './log.js'
import { initNewTeam } from './new-team.js'
import { initTeams } from './teams.js'
import { initTerminals } from './terminals.js'
import { initTranscript, resumeAfterReconnect } from './transcript.js'
import { on, removeTeam, select, setTeams, state, teamsNewestFirst, upsertTeam } from './store.js'

const CONNECTION_TEXT = { connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting' }

const teamIdFromHash = () => new URLSearchParams(location.hash.slice(1)).get('team')

function paintConnection(value) {
  $('connection').dataset.state = value
  $('connection-text').textContent = CONNECTION_TEXT[value]
}

/** Everything the page shows that did not arrive as an event: refetched whenever the stream opens. */
async function resync(reconnected) {
  const [programs, teams] = await Promise.all([api.getPrograms(), api.getTeams()])
  state.programs = new Map(programs.map(p => [p.name, p]))
  if (!reconnected) {
    try {
      state.templates = await api.getTemplates()
    } catch { /* the form simply has no template picker */ }
  }
  setTeams(teams)
  if (reconnected) {
    resumeAfterReconnect()
  } else {
    const wanted = teamIdFromHash()
    const fallback = teamsNewestFirst().find(t => t.status === 'active' || t.status === 'forming')
    select(wanted && state.teams.has(wanted) ? wanted : fallback?.id ?? null)
  }
  backfillLog()
}

function boot() {
  initTeams()
  initArchive()
  initTranscript()
  initTerminals()
  initNewTeam()
  initLog()

  on('connection', paintConnection)
  on('event:team', upsertTeam)
  on('event:team-removed', ({ id }) => removeTeam(id))
  on('stream-open', ({ reconnected }) => {
    resync(reconnected).catch(err => console.error('Could not load the page data', err))
  })
  window.addEventListener('hashchange', () => {
    const wanted = teamIdFromHash()
    if (wanted !== state.selectedId) select(wanted)
  })

  startEvents()
}

boot()
