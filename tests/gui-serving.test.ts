import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootServer } from './helpers/boot-server'

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')

/** The real server serves the real web/ directory, and the page keeps the rules the CSP and the GUI depend on. */
describe('GUI at /', () => {
  let server: Awaited<ReturnType<typeof bootServer>>

  beforeAll(async () => { server = await bootServer() })
  afterAll(() => { server.restore(); server.cleanup() })

  const jsFiles = fs.readdirSync(path.join(WEB, 'js')).filter(f => f.endsWith('.js'))

  it('serves index.html at / and /index.html with the CSP, and every file it references', async () => {
    for (const url of ['/', '/index.html']) {
      const res = await fetch(`${server.baseUrl}${url}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'")
    }
    const html = await (await fetch(`${server.baseUrl}/`)).text()
    const refs = [...html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].map(m => m[1])
    expect(refs).toEqual(expect.arrayContaining(['/app.css', '/js/main.js', '/vendor/xterm/xterm.css']))
    for (const ref of refs) expect((await fetch(`${server.baseUrl}${ref}`)).status, ref).toBe(200)
  })

  it('serves every module of web/js and the vendored terminal modules they import', async () => {
    for (const file of jsFiles) {
      const res = await fetch(`${server.baseUrl}/js/${file}`)
      expect(res.status, file).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/javascript')
    }
    for (const file of ['xterm/xterm.mjs', 'xterm/addon-fit.mjs', 'xterm/xterm.css']) {
      expect((await fetch(`${server.baseUrl}/vendor/${file}`)).status, file).toBe(200)
    }
  })

  it('keeps all script in files and never builds markup from text', () => {
    const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8')
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/)
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
    for (const file of jsFiles) {
      const code = fs.readFileSync(path.join(WEB, 'js', file), 'utf8')
      expect(code, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/)
      expect(code, file).not.toMatch(/https?:\/\//)
    }
  })

  it('has no polling timer for data in the modules', () => {
    for (const file of jsFiles) {
      expect(fs.readFileSync(path.join(WEB, 'js', file), 'utf8'), file).not.toMatch(/setInterval/)
    }
  })

  it('lists the collaboration templates at /api/ensemble/templates', async () => {
    const res = await fetch(`${server.baseUrl}/api/ensemble/templates`)
    expect(res.status).toBe(200)
    const templates = await res.json() as Array<{ key: string; name: string; description: string; roles: Array<{ role: string }> }>
    expect(templates.length).toBeGreaterThan(0)
    expect(templates[0]).toMatchObject({ key: expect.any(String), name: expect.any(String), description: expect.any(String) })
    expect(templates[0].roles[0].role).toEqual(expect.any(String))
  })
})
