// Thin fetch wrappers over the server's HTTP API. All paths are same-origin.

const BASE = '/api/ensemble'

async function request(path, options) {
  const res = await fetch(path, options)
  let body = null
  try {
    body = await res.json()
  } catch { /* an empty or non-JSON body */ }
  if (!res.ok) {
    const error = new Error(body?.error || `${res.status} ${res.statusText}`)
    error.status = res.status
    throw error
  }
  return body
}

const post = (path, payload) => request(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export const getPrograms = () => request(`${BASE}/programs`)
export const getTemplates = () => request(`${BASE}/templates`)
export const getTeams = async () => (await request(`${BASE}/teams`)).teams ?? []
export const getFeed = async (teamId, since) =>
  (await request(`${BASE}/teams/${encodeURIComponent(teamId)}/feed${since ? `?since=${since}` : ''}`)).messages ?? []
/** { entries, latest }: the log lines after `since`, and the newest seq the server has. */
export const getLogs = since => request(`${BASE}/logs${since ? `?since=${since}` : ''}`)

/** Resolves to the new team; rejects with the server's own message on a 400. */
export const createTeam = async payload => (await post(`${BASE}/teams`, payload)).team
export const sendMessage = (teamId, to, content) =>
  post(`${BASE}/teams/${encodeURIComponent(teamId)}`, { to, from: 'user', content })
export const disbandTeam = teamId => post(`${BASE}/teams/${encodeURIComponent(teamId)}/disband`, {})
export const archiveTeam = (teamId, archived) => post(`${BASE}/teams/${encodeURIComponent(teamId)}/archive`, { archived })
/** Resolves to { ok, warnings }; erases an archived team for good. */
export const purgeTeam = teamId => post(`${BASE}/teams/${encodeURIComponent(teamId)}/purge`, {})

export const sessionUrl = (sessionName, suffix) => `${BASE}/sessions/${encodeURIComponent(sessionName)}/${suffix}`
export const postInput = (sessionName, data) => post(sessionUrl(sessionName, 'input'), { data })
export const postResize = (sessionName, cols, rows) => post(sessionUrl(sessionName, 'resize'), { cols, rows })
export const eventsUrl = `${BASE}/events`
