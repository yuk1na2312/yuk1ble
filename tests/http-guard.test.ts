import http from 'http'
import net from 'net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isAllowedHost, MAX_BODY_BYTES } from '../src/server/guard'
import { bootServer } from './helpers/boot-server'

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: string }

describe('isAllowedHost', () => {
  it.each([
    'localhost', 'localhost:23000', 'LOCALHOST:23000', '127.0.0.1', '127.0.0.1:9', '[::1]', '[::1]:23000',
  ])('allows the loopback name %s', host => {
    expect(isAllowedHost(host)).toBe(true)
  })

  it.each([
    undefined, '', 'evil.example', 'evil.example:23000', 'localhost.evil.example', '127.0.0.1.evil.example',
    'evil.example#localhost', 'localhost:notaport', 'localhost:23000:1', '0.0.0.0', '192.168.1.5', '[::2]', 'user@localhost',
  ])('refuses %j', host => {
    expect(isAllowedHost(host)).toBe(false)
  })

  it('also allows the host the server was deliberately bound to', () => {
    expect(isAllowedHost('192.168.1.5:23000', '192.168.1.5')).toBe(true)
    expect(isAllowedHost('Box.lan', 'box.lan')).toBe(true)
    expect(isAllowedHost('[fe80::1]:23000', 'fe80::1')).toBe(true)
    expect(isAllowedHost('192.168.1.6:23000', '192.168.1.5')).toBe(false)
    expect(isAllowedHost('evil.example', '192.168.1.5')).toBe(false)
  })
})

describe('request guard on a running server', () => {
  let server: Awaited<ReturnType<typeof bootServer>>
  let port: number

  beforeAll(async () => {
    server = await bootServer()
    port = Number(new URL(server.baseUrl).port)
  })
  afterAll(() => {
    server.restore()
    server.cleanup()
  })

  function request(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      })
      // The server may close the connection after answering a request it did not read.
      req.on('error', err => (err as NodeJS.ErrnoException).code === 'ECONNRESET' || (err as NodeJS.ErrnoException).code === 'EPIPE' ? undefined : reject(err))
      req.end(body)
    })
  }

  describe('Host header', () => {
    it('refuses a foreign Host with 403 on every route, so a DNS-rebinding page gets nothing', async () => {
      for (const [method, path] of [
        ['GET', '/api/v1/health'], ['GET', '/'], ['GET', '/api/ensemble/teams'], ['GET', '/api/ensemble/logs'],
        ['POST', '/api/ensemble/teams'], ['GET', '/api/ensemble/programs'],
      ]) {
        const res = await request(method, path, { Host: 'evil.example' }, method === 'POST' ? '{}' : undefined)
        expect(res.status, `${method} ${path}`).toBe(403)
        expect(JSON.parse(res.body).error).toContain('Host not allowed')
      }
    })

    it('refuses a foreign Host even with an allowed Origin, and a rebinding name that only starts with localhost', async () => {
      expect((await request('GET', '/api/v1/health', { Host: 'evil.example:23000', Origin: 'http://localhost:3000' })).status).toBe(403)
      expect((await request('GET', '/api/v1/health', { Host: 'localhost.evil.example' })).status).toBe(403)
    })

    it('serves the loopback names, with or without a port', async () => {
      for (const host of ['localhost', `localhost:${port}`, '127.0.0.1', `127.0.0.1:${port}`, `[::1]:${port}`]) {
        expect((await request('GET', '/api/v1/health', { Host: host })).status, host).toBe(200)
      }
    })

    it('refuses a request with no Host header at all', async () => {
      const status = await new Promise<number>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write('GET /api/v1/health HTTP/1.0\r\n\r\n'))
        let text = ''
        socket.on('data', chunk => { text += chunk })
        socket.on('end', () => resolve(Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1])))
        socket.on('error', reject)
      })
      expect(status).toBe(403)
    })
  })

  describe('Origin header', () => {
    const body = JSON.stringify({ name: 'x', description: 'y', agents: [{ program: 'codex' }] })

    it('refuses a state-changing request from a foreign origin, and creates nothing', async () => {
      const post = await request('POST', '/api/ensemble/teams', { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body)
      expect(post.status).toBe(403)
      expect(JSON.parse(post.body).error).toContain('CORS origin forbidden')
      expect((await request('DELETE', '/api/ensemble/teams/anything', { Origin: 'http://evil.example' })).status).toBe(403)
      expect((await request('POST', '/api/ensemble/teams/anything/disband', { Origin: 'https://localhost:3000' })).status).toBe(403)
      expect(server.spawnLocalAgent).not.toHaveBeenCalled()
    })

    it('also refuses a foreign origin on reads, as before', async () => {
      expect((await request('GET', '/api/ensemble/teams', { Origin: 'http://evil.example' })).status).toBe(403)
    })

    it('lets a request with no Origin through (the CLI, curl) and echoes an allowed one', async () => {
      const noOrigin = await request('POST', '/api/ensemble/teams', { 'Content-Type': 'application/json' }, body)
      expect(noOrigin.status).toBe(400) // reached the route: one agent is not a team
      expect(noOrigin.body).toContain('at least 2')

      const local = await request('POST', '/api/ensemble/teams', { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body)
      expect(local.status).toBe(400)
      expect(local.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    })
  })

  describe('request body cap', () => {
    it('refuses a body over 1 MB with 413 and closes the connection', async () => {
      const big = JSON.stringify({ name: 'x', description: 'y'.repeat(MAX_BODY_BYTES + 10), agents: [] })
      const res = await request('POST', '/api/ensemble/teams', { 'Content-Type': 'application/json' }, big)

      expect(res.status).toBe(413)
      expect(JSON.parse(res.body).error).toContain('too large')
      expect(res.headers.connection).toBe('close')
      expect(server.spawnLocalAgent).not.toHaveBeenCalled()
    })

    it('refuses a body that streams past the cap without announcing its length', async () => {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/ensemble/teams', agent: false }, res => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.on('error', err => (err as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(err))
        // Chunked transfer: no Content-Length, so only counting bytes can notice.
        const chunk = 'z'.repeat(256 * 1024)
        let sent = 0
        const pump = (): void => {
          while (sent < MAX_BODY_BYTES + 512 * 1024) {
            sent += chunk.length
            if (!req.write(chunk)) return void req.once('drain', pump)
          }
          req.end()
        }
        pump()
      })
      expect(status).toBe(413)
    })

    it('accepts a body just under the cap, and keeps serving afterwards', async () => {
      const ok = JSON.stringify({ name: 'x', description: 'y'.repeat(MAX_BODY_BYTES - 1000), agents: [] })
      const res = await request('POST', '/api/ensemble/teams', { 'Content-Type': 'application/json' }, ok)

      expect(res.status).toBe(400) // parsed fine; refused by validation, not by size
      expect(res.body).toContain('at least 2')
      expect((await request('GET', '/api/v1/health')).status).toBe(200)
    })
  })
})
