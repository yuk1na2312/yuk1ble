import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/** Static serving: containment, content types, headers, and the API winning over files. */
describe('static GUI files', () => {
  const saved = { data: process.env.ENSEMBLE_DATA_DIR, runtime: process.env.ENSEMBLE_RUNTIME_DIR }
  let root: string
  let webRoot: string
  let outside: string
  let server: http.Server
  let port: number
  let canLink = true

  const get = (rawPath: string, method = 'GET') => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    // http.request sends the path exactly as written, so `..` reaches the server unnormalized.
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method, agent: false }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-static-'))
    process.env.ENSEMBLE_DATA_DIR = root
    process.env.ENSEMBLE_RUNTIME_DIR = path.join(root, 'runtime')
    webRoot = path.join(root, 'web')
    outside = path.join(root, 'outside')
    fs.mkdirSync(path.join(webRoot, 'js'), { recursive: true })
    fs.mkdirSync(path.join(webRoot, 'api', 'v1'), { recursive: true })
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>t</title>')
    fs.writeFileSync(path.join(webRoot, 'page.html'), '<!doctype html><title>t</title>')
    fs.writeFileSync(path.join(webRoot, 'app.css'), 'body{}')
    fs.writeFileSync(path.join(webRoot, 'js', 'main.js'), 'export {}')
    fs.writeFileSync(path.join(webRoot, 'notes.xyz'), 'unknown type')
    fs.writeFileSync(path.join(webRoot, 'api', 'v1', 'health'), 'IMPOSTOR')
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET')
    fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET')
    try {
      fs.symlinkSync(outside, path.join(webRoot, 'link'), 'junction')
    } catch {
      canLink = false
    }

    const { createRequestHandler } = await import('../src/server/routes')
    server = http.createServer(createRequestHandler({ host: '127.0.0.1', port: 0, webRoot }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve))
    for (const [key, value] of [['ENSEMBLE_DATA_DIR', saved.data], ['ENSEMBLE_RUNTIME_DIR', saved.runtime]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('serves an html page with no-store and a CSP that forbids inline scripts', async () => {
    const res = await get('/page.html')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-store')
    const csp = res.headers['content-security-policy'] ?? ''
    expect(csp).toContain("default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'")
    expect(csp).not.toMatch(/script-src[^;]*unsafe/)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.body).toContain('<title>t</title>')
  })

  it('serves css and js modules with their content types, and HEAD without a body', async () => {
    expect((await get('/app.css')).headers['content-type']).toBe('text/css; charset=utf-8')
    const js = await get('/js/main.js')
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(js.headers['content-security-policy']).toBeUndefined()
    const head = await get('/js/main.js', 'HEAD')
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
  })

  it.each([
    ['plain ..', '/../secret.txt'],
    ['deep ..', '/js/../../secret.txt'],
    ['encoded ..', '/%2e%2e/secret.txt'],
    ['encoded slash', '/..%2fsecret.txt'],
    ['double encoded', '/%252e%252e/secret.txt'],
    ['backslash', '/..\\secret.txt'],
    ['backslash encoded', '/..%5csecret.txt'],
    ['NUL byte', '/index.html%00.png'],
    ['bad escape', '/%zz'],
  ])('refuses traversal (%s)', async (_label, rawPath) => {
    const res = await get(rawPath)
    expect(res.status).toBe(404)
    expect(res.body).not.toContain('SECRET')
  })

  it('does not follow a link out of the web root', async () => {
    if (!canLink) return // no permission to create a junction on this machine
    const res = await get('/link/secret.txt')
    expect(res.status).toBe(404)
    expect(res.body).not.toContain('SECRET')
  })

  it('does not serve a file of an unknown extension, a directory or a missing file', async () => {
    expect((await get('/notes.xyz')).status).toBe(404)
    expect((await get('/js')).status).toBe(404)
    expect((await get('/missing.js')).status).toBe(404)
  })

  it('does not accept writes to a file path', async () => {
    expect((await get('/page.html', 'POST')).status).toBe(404)
    expect((await get('/page.html', 'DELETE')).status).toBe(404)
  })

  it('matches API routes before files: a file under web/api never shadows a route', async () => {
    const health = await get('/api/v1/health')
    expect(health.status).toBe(200)
    expect(JSON.parse(health.body)).toMatchObject({ status: 'healthy' })
    const unknown = await get('/api/ensemble/nope')
    expect(unknown.status).toBe(404)
    expect(JSON.parse(unknown.body)).toEqual({ error: 'Not found' })
  })

  describe('vendored xterm', () => {
    it.each([
      ['/vendor/xterm/xterm.mjs', 'text/javascript; charset=utf-8'],
      ['/vendor/xterm/xterm.css', 'text/css; charset=utf-8'],
      ['/vendor/xterm/addon-fit.mjs', 'text/javascript; charset=utf-8'],
    ])('serves %s', async (url, type) => {
      const res = await get(url)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe(type)
      expect(res.body.length).toBeGreaterThan(1000)
    })

    it.each([
      '/vendor/xterm/package.json',
      '/vendor/xterm/xterm.mjs.map',
      '/vendor/xterm/../../package.json',
      '/vendor/../package.json',
      '/vendor/',
      '/node_modules/@xterm/xterm/package.json',
      '/vendor/constructor',
      '/vendor/__proto__',
    ])('does not serve %s', async url => {
      expect((await get(url)).status).toBe(404)
    })
  })
})
