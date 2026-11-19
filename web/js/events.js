// The one push stream for team, message and log events. EventSource reconnects by
// itself (the server sends `retry: 2000`); this module reports the connection
// state and tells the rest of the page when a reconnect happened so it can refetch.

import { eventsUrl } from './api.js'
import { emit, setConnection } from './store.js'

let source
let everOpened = false

function parse(event) {
  try {
    return JSON.parse(event.data)
  } catch {
    return undefined
  }
}

export function startEvents() {
  if (source) return
  source = new EventSource(eventsUrl)

  source.addEventListener('open', () => {
    setConnection('live')
    // A second open is a reconnect: anything pushed while we were away is gone, so refetch.
    emit('stream-open', { reconnected: everOpened })
    everOpened = true
  })

  source.addEventListener('error', () => {
    // readyState CONNECTING means the browser is retrying; CLOSED means it gave up (e.g. a 429).
    setConnection('reconnecting')
    if (source.readyState === EventSource.CLOSED) {
      source.close()
      source = undefined
      setTimeout(startEvents, 3000)
    }
  })

  for (const type of ['team', 'team-removed', 'message', 'log']) {
    source.addEventListener(type, event => {
      const data = parse(event)
      if (data) emit(`event:${type}`, data)
    })
  }
}
