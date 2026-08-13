/**
 * Host Configuration — Stripped for Ensemble standalone
 * Only identity + discovery functions, no CRUD/org management
 */

import fs from 'fs'
import os from 'os'
import { getHostsConfigPath } from './ensemble-paths'

export interface Host {
  id: string
  name: string
  url: string
  type?: string
  aliases?: string[]
  enabled?: boolean
  description?: string
  tailscale?: boolean
  tags?: string[]
  syncedAt?: string
  syncSource?: string
}

interface HostsConfig {
  hosts: Host[]
  organization?: string
  organizationSetAt?: string
  organizationSetBy?: string
}

const HOSTS_CONFIG_PATH = getHostsConfigPath()
let cachedHosts: Host[] | null = null

export function getSelfHostId(): string {
  return os.hostname().toLowerCase().replace(/\.local$/, '')
}

function getLocalIPs(): string[] {
  const interfaces = os.networkInterfaces()
  const ips: string[] = []
  for (const [, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue
    for (const addr of addrs) {
      if (!addr.internal && addr.family === 'IPv4') ips.push(addr.address)
    }
  }
  return ips
}

export function isSelf(hostId: string): boolean {
  if (!hostId) return false
  const selfId = getSelfHostId()
  const hostIdLower = hostId.toLowerCase()
  if (hostIdLower === selfId) return true
  if (hostId === 'local') return true
  const selfIPs = getLocalIPs().map(ip => ip.toLowerCase())
  if (selfIPs.includes(hostIdLower)) return true
  try {
    const url = new URL(hostId)
    if (url.hostname.toLowerCase() === selfId || selfIPs.includes(url.hostname.toLowerCase())) return true
  } catch { /* not a URL */ }
  return false
}

function getDefaultSelfHost(): Host {
  const hostname = getSelfHostId()
  const preferredIP = getLocalIPs().find(ip => ip.startsWith('100.')) ||
                      getLocalIPs().find(ip => ip.startsWith('192.168.') || ip.startsWith('10.')) ||
                      getLocalIPs()[0]
  return {
    id: hostname,
    name: hostname,
    url: preferredIP ? `http://${preferredIP}:23000` : `http://${hostname}:23000`,
    enabled: true,
    description: 'This machine',
  }
}

export function getHosts(): Host[] {
  if (cachedHosts) return cachedHosts
  if (fs.existsSync(HOSTS_CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(HOSTS_CONFIG_PATH, 'utf-8')) as HostsConfig
      const hosts = config.hosts
        .map(h => ({ ...h, id: h.id === 'local' ? getSelfHostId() : h.id.toLowerCase() }))
        .filter(h => h.enabled !== false && h.id && h.name && h.url)
      if (!hosts.some(h => isSelf(h.id))) hosts.unshift(getDefaultSelfHost())
      cachedHosts = hosts
      return hosts
    } catch { /* fall through */ }
  }
  cachedHosts = [getDefaultSelfHost()]
  return cachedHosts
}

export function getHostById(hostId: string): Host | undefined {
  const hosts = getHosts()
  if (hostId === 'local') return hosts.find(h => isSelf(h.id))
  return hosts.find(h => h.id.toLowerCase() === hostId.toLowerCase())
}

export function clearHostsCache(): void {
  cachedHosts = null
}
