/**
 * Static files for the GUI: the web/ directory, and the browser builds of xterm.js from
 * node_modules at three fixed /vendor paths. Nothing else on disk is reachable:
 *   - a web/ path is resolved and realpath'd, and must stay inside the realpath of web/
 *     (so `..`, encoded `..`, backslashes and symlinks or junctions cannot leave it);
 *   - only the extensions in CONTENT_TYPES are served, anything else is a 404;
 *   - /vendor is a lookup table of exact paths, never a directory mapping.
 * Every response is `no-store` (the GUI is development-grade: a stale module is worse than a
 * reload) and HTML carries a Content-Security-Policy that forbids inline scripts.
 */

import fs from 'fs'
import path from 'path'
import type http from 'http'
import { REPO_ROOT } from '../repo-root'

export const WEB_ROOT = path.join(REPO_ROOT, 'web')

/** xterm needs inline styles (it positions its layers with style attributes); scripts stay external. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; "
  + "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

const NODE_MODULES = path.join(REPO_ROOT, 'node_modules', '@xterm')

/** The only files outside web/ that are served, by their exact URL path. */
export const VENDOR_FILES: Readonly<Record<string, string>> = {
  '/vendor/xterm/xterm.mjs': path.join(NODE_MODULES, 'xterm', 'lib', 'xterm.mjs'),
  '/vendor/xterm/xterm.css': path.join(NODE_MODULES, 'xterm', 'css', 'xterm.css'),
  '/vendor/xterm/addon-fit.mjs': path.join(NODE_MODULES, 'addon-fit', 'lib', 'addon-fit.mjs'),
}

export interface StaticOptions {
  /** Directory served at `/`. Tests point it at a temp dir. */
  webRoot?: string
}

/** The file inside `root` that `pathname` names, or undefined when there is none or it would escape. */
async function resolveInside(root: string, pathname: string): Promise<string | undefined> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined
  const relative = decoded.endsWith('/') ? decoded + 'index.html' : decoded
  try {
    const realRoot = await fs.promises.realpath(root)
    const real = await fs.promises.realpath(path.resolve(realRoot, '.' + relative))
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return undefined
    return (await fs.promises.stat(real)).isFile() ? real : undefined
  } catch {
    return undefined
  }
}

/**
 * Serve `pathname` if it is a GUI file. Returns false when it is not (the caller answers 404);
 * the API routes must have been tried first.
 */
export async function serveStatic(
  req: http.IncomingMessage, res: http.ServerResponse, pathname: string, options: StaticOptions = {},
): Promise<boolean> {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || pathname.startsWith('/api/')) return false

  const vendor = Object.hasOwn(VENDOR_FILES, pathname) ? VENDOR_FILES[pathname] : undefined
  const file = vendor ?? await resolveInside(options.webRoot ?? WEB_ROOT, pathname)
  if (!file) return false
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()]
  if (!type) return false

  let body: Buffer
  try {
    body = await fs.promises.readFile(file)
  } catch {
    return false
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(type.startsWith('text/html') ? { 'Content-Security-Policy': CONTENT_SECURITY_POLICY } : {}),
  })
  res.end(req.method === 'HEAD' ? undefined : body)
  return true
}
