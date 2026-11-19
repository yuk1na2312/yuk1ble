/**
 * The SSE endpoints against the real server on an ephemeral port: the event
 * stream (bus -> client), the per-session terminal stream (replay, then live
 * chunks, then exit), and the bounds on both.
 */

import http from 'http'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { bootServer } from './helpers/boot-server'

interface SseEvent { event: string; data: string }

interface Client {
  status: number
  headers: http.IncomingHttpHeaders
  events: SseEvent[]
  raw: () => string
  /** Resolves with the first event (from the start) matching `event`; rejects after 3 s. */
  waitFor: (event: string, nth?: number) => Promise<SseEvent>
  ended: Promise<void>
  pause: () => void
  close: () => void
  /** The JSON body of a non-200 answer. */
  json: () => unknown
}

describe('SSE', () => {
  let server: Awaited<ReturnType<typeof bootServer>>
  let port: number
  const clients: Client[] = []

  beforeAll(async () => {
    server = await bootServer()
    port = Number(new URL(server.baseUrl).port)
  })
  afterEach(async () => {
    vi.useRealTimers()
    for (const client of clients.splice(0)) client.close()
    // The server notices a closed client a moment later; the next test must start from nothing open.
    const { sseConnectionCount } = await import('../src/server/sse')
    await vi.waitFor(() => expect(sseConnectionCount()).toBe(0))
  })
  afterAll(() => {
    server.restore()
    server.cleanup()
  })

  function connect(path: string, headers: Record<string, string> = {}): Promise<Client> {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path, headers, agent: false }, res => {
        let text = ''
        let body = ''
        const events: SseEvent[] = []
        const waiters: Array<() => void> = []
        let buffer = ''
        let end!: () => void
        const ended = new Promise<void>(r => { end = r })
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          text += chunk
          if (res.statusCode !== 200) { body += chunk; return }
          buffer += chunk
          for (let split = buffer.indexOf('\n\n'); split >= 0; split = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, split)
            buffer = buffer.slice(split + 2)
            const event = /^event: (.*)$/m.exec(block)?.[1]
            const data = /^data: (.*)$/m.exec(block)?.[1]
            if (event !== undefined && data !== undefined) events.push({ event, data })
          }
          for (const wake of waiters.splice(0)) wake()
        })
        res.on('end', end)
        res.on('close', end)
        res.on('error', () => end())
        const client: Client = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          events,
          raw: () => text,
          waitFor: (event, nth = 0) => new Promise((resolveEvent, rejectEvent) => {
            const timer = setTimeout(() => rejectEvent(new Error(`no "${event}" event; got ${JSON.stringify(events)}`)), 3000)
            const look = (): void => {
              const found = events.filter(e => e.event === event)[nth]
              if (found) { clearTimeout(timer); resolveEvent(found) } else waiters.push(look)
            }
            look()
          }),
          ended,
          pause: () => { res.pause() },
          close: () => { req.destroy() },
          json: () => JSON.parse(body),
        }
        clients.push(client)
        resolve(client)
      })
      req.on('error', reject)
    })
  }

  const bus = () => import('../src/core/bus').then(m => m.bus)
  const decode = (base64: string): string => Buffer.from(base64, 'base64').toString('utf8')
  const settled = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms))

  describe('GET /api/ensemble/events', () => {
    it('opens a text/event-stream that is not cached', async () => {
      const client = await connect('/api/ensemble/events')

      expect(client.status).toBe(200)
      expect(client.headers['content-type']).toBe('text/event-stream')
      expect(client.headers['cache-control']).toBe('no-store')
    })

    it('pushes team, message and log events as JSON, the moment they happen', async () => {
      const store = await server.store()
      const client = await connect('/api/ensemble/events')

      const team = store.createTeam({ name: 'sse-team', description: 'd', agents: [{ program: 'codex' }, { program: 'claude' }] })
      const sentTeam = JSON.parse((await client.waitFor('team')).data)
      expect(sentTeam).toMatchObject({ id: team.id, name: 'sse-team', status: 'forming' })

      store.appendMessage(team.id, { id: 'm-1', teamId: team.id, from: 'codex-1', to: 'team', content: 'hello', type: 'chat', timestamp: new Date().toISOString() })
      expect(JSON.parse((await client.waitFor('message')).data)).toMatchObject({ id: 'm-1', teamId: team.id, content: 'hello', seq: 1 })

      console.log('[sse-test] a line for the log stream')
      const log = JSON.parse((await client.waitFor('log')).data)
      expect(log).toMatchObject({ level: 'log' })
      expect(log.text).toContain('a line for the log stream')
    })

    it('pushes team-removed with the id when a team is purged', async () => {
      const store = await server.store()
      const team = store.createTeam({ name: 'gone', description: 'd', agents: [{ program: 'codex' }, { program: 'claude' }] })
      const client = await connect('/api/ensemble/events')

      store.deleteTeam(team.id)

      expect(JSON.parse((await client.waitFor('team-removed')).data)).toEqual({ id: team.id })
    })

    it('?team=<id> keeps other teams\' messages out, but not team events', async () => {
      const store = await server.store()
      const mine = store.createTeam({ name: 'mine', description: 'd', agents: [{ program: 'codex' }, { program: 'claude' }] })
      const other = store.createTeam({ name: 'other', description: 'd', agents: [{ program: 'codex' }, { program: 'claude' }] })
      const client = await connect(`/api/ensemble/events?team=${mine.id}`)
      const message = (teamId: string, id: string) =>
        ({ id, teamId, from: 'codex-1', to: 'team', content: id, type: 'chat' as const, timestamp: new Date().toISOString() })

      store.appendMessage(other.id, message(other.id, 'not-mine'))
      store.appendMessage(mine.id, message(mine.id, 'mine-1'))
      store.updateTeam(other.id, { status: 'active' })

      await client.waitFor('message')
      await client.waitFor('team')
      expect(client.events.filter(e => e.event === 'message').map(e => JSON.parse(e.data).id)).toEqual(['mine-1'])
      expect(client.events.some(e => e.event === 'team' && JSON.parse(e.data).id === other.id)).toBe(true)
    })

    it('sends a comment heartbeat every 20 s', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      const client = await connect('/api/ensemble/events')
      expect(client.raw()).not.toContain(': ping')

      vi.advanceTimersByTime(20_000)
      await vi.waitFor(() => expect(client.raw()).toContain(': ping\n\n'))
    })

    it('unsubscribes from the bus when the client goes away', async () => {
      const b = await bus()
      const baseline = { team: b.listenerCount('team'), message: b.listenerCount('message'), log: b.listenerCount('log') }
      const clientsOpen = await Promise.all([1, 2, 3].map(() => connect('/api/ensemble/events')))
      expect(b.listenerCount('team')).toBe(baseline.team + 3)
      expect(b.listenerCount('message')).toBe(baseline.message + 3)
      expect(b.listenerCount('log')).toBe(baseline.log + 3)

      for (const client of clientsOpen) client.close()

      await vi.waitFor(() => {
        expect(b.listenerCount('team')).toBe(baseline.team)
        expect(b.listenerCount('message')).toBe(baseline.message)
        expect(b.listenerCount('log')).toBe(baseline.log)
      })
    })

    it('refuses the 33rd stream with a 429, and takes one again when a stream closes', async () => {
      const open = await Promise.all(Array.from({ length: 32 }, () => connect('/api/ensemble/events')))
      expect(open.every(c => c.status === 200)).toBe(true)

      const refused = await connect('/api/ensemble/events')
      expect(refused.status).toBe(429)
      expect(refused.headers['content-type']).toContain('application/json')

      open[0].close()
      await vi.waitFor(async () => {
        const again = await connect('/api/ensemble/events')
        expect(again.status).toBe(200)
      })
    })

    it('does not open a stream for a foreign Origin', async () => {
      const client = await connect('/api/ensemble/events', { Origin: 'http://evil.example' })
      expect(client.status).toBe(403)
    })
  })

  describe('GET /api/ensemble/sessions/:name/stream', () => {
    const session = 'sse-team-codex-1'

    it('sends the replay first, then the output that follows, in order, then exit', async () => {
      server.runtime.replay.mockReturnValueOnce('\x1b[32mold output\x1b[0m')
      const client = await connect(`/api/ensemble/sessions/${session}/stream`)

      expect(client.headers['content-type']).toBe('text/event-stream')
      expect(client.headers['cache-control']).toBe('no-store')
      expect(decode((await client.waitFor('replay')).data)).toBe('\x1b[32mold output\x1b[0m')

      server.pty.emit(session, 'new ')
      server.pty.emit(session, 'output ✓')
      await settled()
      server.pty.emit(session, 'later')
      await vi.waitFor(() => expect(client.events.filter(e => e.event === 'data').map(e => decode(e.data)).join('')).toBe('new output ✓later'))

      server.pty.end(session)
      await client.waitFor('exit')
      await client.ended
      expect(client.events.map(e => e.event)[0]).toBe('replay')
      expect(client.events.at(-1)?.event).toBe('exit')
      expect(client.events.filter(e => e.event === 'replay')).toHaveLength(1)
    })

    it('batches the chunks of one burst into a single data event', async () => {
      const client = await connect(`/api/ensemble/sessions/${session}/stream`)
      await client.waitFor('replay')

      for (let i = 0; i < 200; i++) server.pty.emit(session, `chunk-${i};`)
      await vi.waitFor(() => expect(client.events.filter(e => e.event === 'data').length).toBeGreaterThan(0))
      await settled(150)

      const data = client.events.filter(e => e.event === 'data')
      expect(data).toHaveLength(1)
      expect(decode(data[0].data)).toBe(Array.from({ length: 200 }, (_, i) => `chunk-${i};`).join(''))
    })

    it('answers 404 as JSON when the session does not exist', async () => {
      server.runtime.exists.mockReturnValueOnce(false)
      const client = await connect('/api/ensemble/sessions/nope/stream')

      expect(client.status).toBe(404)
      expect(client.headers['content-type']).toContain('application/json')
      expect(client.json()).toEqual({ error: 'Session not found' })
    })

    it('hands nothing to a client that left: every PTY listener is gone once it disconnects', async () => {
      const baseline = server.pty.listenerCount()
      const watchers = await Promise.all([1, 2, 3].map(() => connect(`/api/ensemble/sessions/${session}/stream`)))
      await Promise.all(watchers.map(w => w.waitFor('replay')))
      expect(server.pty.listenerCount()).toBe(baseline + 6) // data + exit per watcher

      for (const watcher of watchers) watcher.close()

      await vi.waitFor(() => expect(server.pty.listenerCount()).toBe(baseline))
    })

    it('answers 429 when the session already has as many watchers as the runtime allows', async () => {
      server.runtime.onData.mockImplementationOnce(() => { throw new Error('Too many data listeners on PTY session x (max 16)') })
      const client = await connect(`/api/ensemble/sessions/${session}/stream`)

      expect(client.status).toBe(429)
      expect((client.json() as { error: string }).error).toContain('Too many')
    })

    it('shares the 32-connection cap with the event stream', async () => {
      const open = await Promise.all(Array.from({ length: 32 }, () => connect(`/api/ensemble/sessions/${session}/stream`)))
      expect(open.every(c => c.status === 200)).toBe(true)

      expect((await connect('/api/ensemble/events')).status).toBe(429)
      expect((await connect(`/api/ensemble/sessions/${session}/stream`)).status).toBe(429)
    })

    it('drops a client that does not read, instead of buffering its output without limit', async () => {
      const baseline = server.pty.listenerCount()
      const client = await connect(`/api/ensemble/sessions/${session}/stream`)
      await client.waitFor('replay')
      client.pause() // stops reading: the socket buffers fill, then the server's queue grows

      const chunk = 'x'.repeat(256 * 1024)
      let dropped = false
      for (let i = 0; i < 400 && !dropped; i++) {
        server.pty.emit(session, chunk)
        if (i % 10 === 9) {
          await settled(20)
          dropped = server.pty.listenerCount() === baseline
        }
      }

      expect(dropped).toBe(true)
    }, 30_000)
  })
})
