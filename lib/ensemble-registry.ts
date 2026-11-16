/**
 * In-memory store for teams and message feeds.
 *
 * The server process is the only writer, so it owns all state in memory and
 * the files are just a persistence log:
 *   - teams.json   rewritten whole (temp file + rename), debounced, flushed on exit
 *   - feed.jsonl   one append-only log per team
 * Nothing re-reads a file to learn about state. Teams load once at first use, a
 * team's feed loads once on first access (older teams also carry a legacy
 * messages.jsonl in the runtime dir, merged in at that point).
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import type { EnsembleTeam, EnsembleMessage, CreateTeamRequest } from '../types/ensemble'
import { getEnsembleRegistryDir, getFeedFile } from './ensemble-paths'
import { collabMessagesFile } from './collab-paths'
import { bus } from './bus'

const ENSEMBLE_DIR = getEnsembleRegistryDir()
const TEAMS_FILE = path.join(ENSEMBLE_DIR, 'teams.json')

const TEAMS_WRITE_DEBOUNCE_MS = 100
/** Messages kept in memory per team; older ones stay in the feed file. */
export const MAX_MESSAGES_PER_TEAM = 5_000
/** Feeds held in memory at once; feeds of finished teams are evicted beyond this. */
const MAX_LOADED_FEEDS = 16

interface Feed {
  messages: EnsembleMessage[]
  ids: Set<string>
  nextSeq: number
}

const teams = new Map<string, EnsembleTeam>()
const feeds = new Map<string, Feed>() // insertion order doubles as LRU order
let teamsLoaded = false
let teamsDirty = false
let teamsTimer: NodeJS.Timeout | undefined

function getCreatedBy(): string {
  return process.env.ENSEMBLE_CREATED_BY?.trim()
    || process.env.USER
    || process.env.LOGNAME
    || process.env.USERNAME
    || os.hostname()
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

// ─── Teams ──────────────────────────────────────────────────────────────────

function loadTeamsOnce(): void {
  if (teamsLoaded) return
  teamsLoaded = true
  // Registered here, not at module load: a process that merely imports this
  // module (it never does anything with the store) must not get a handler.
  process.once('exit', flushStore)

  if (!fs.existsSync(TEAMS_FILE)) return
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf-8'))
    if (!Array.isArray(parsed)) throw new Error('teams.json is not an array')
    for (const team of parsed as EnsembleTeam[]) teams.set(team.id, team)
  } catch (err) {
    // Keep the unreadable file for inspection instead of overwriting it with [].
    const aside = `${TEAMS_FILE}.corrupt-${Date.now()}`
    console.error(`[Registry] Cannot read ${TEAMS_FILE}: ${err instanceof Error ? err.message : err} — moved to ${aside}`)
    try { fs.renameSync(TEAMS_FILE, aside) } catch { /* best effort */ }
  }
}

function writeTeamsFile(): void {
  const json = JSON.stringify([...teams.values()], null, 2)
  ensureDir(ENSEMBLE_DIR)
  const tmp = `${TEAMS_FILE}.tmp`
  try {
    fs.writeFileSync(tmp, json)
    fs.renameSync(tmp, TEAMS_FILE)
  } catch (err) {
    // rename over a file another process holds open fails transiently on Windows.
    console.warn('[Registry] Atomic teams.json write failed, writing in place:', err instanceof Error ? err.message : err)
    fs.writeFileSync(TEAMS_FILE, json)
  }
}

/** Write any pending state to disk now. Runs on process exit; tests call it directly. */
export function flushStore(): void {
  if (teamsTimer) {
    clearTimeout(teamsTimer)
    teamsTimer = undefined
  }
  if (!teamsDirty) return
  teamsDirty = false
  try {
    writeTeamsFile()
  } catch (err) {
    teamsDirty = true
    console.error('[Registry] Could not write teams.json:', err)
  }
}

function markTeamsDirty(): void {
  teamsDirty = true
  if (teamsTimer) return
  teamsTimer = setTimeout(flushStore, TEAMS_WRITE_DEBOUNCE_MS)
  teamsTimer.unref()
}

export function loadTeams(): EnsembleTeam[] {
  loadTeamsOnce()
  return [...teams.values()].map(team => structuredClone(team))
}

export function getTeam(id: string): EnsembleTeam | undefined {
  loadTeamsOnce()
  const team = teams.get(id)
  return team && structuredClone(team)
}

export function createTeam(request: CreateTeamRequest): EnsembleTeam {
  loadTeamsOnce()
  const team: EnsembleTeam = {
    id: randomUUID(),
    name: request.name,
    description: request.description,
    status: 'forming',
    agents: request.agents.map((a, i) => ({
      agentId: '',
      name: `${a.program.toLowerCase().replace(/\s+/g, '-').split('-')[0]}-${i + 1}`,
      program: a.program,
      role: a.role || (i === 0 ? 'lead' : 'member'),
      status: 'spawning' as const,
    })),
    createdBy: getCreatedBy(),
    createdAt: new Date().toISOString(),
    feedMode: request.feedMode || 'live',
  }
  teams.set(team.id, team)
  markTeamsDirty()
  bus.emit('team', structuredClone(team))
  return structuredClone(team)
}

export function updateTeam(id: string, updates: Partial<EnsembleTeam>): EnsembleTeam | undefined {
  loadTeamsOnce()
  const current = teams.get(id)
  if (!current) return undefined
  const next = { ...current, ...structuredClone(updates) }
  teams.set(id, next)
  markTeamsDirty()
  bus.emit('team', structuredClone(next))
  return structuredClone(next)
}

/**
 * Startup cleanup. PTY sessions live inside the server process, so a team still
 * `forming` or `active` when the server boots lost every agent with the old
 * process. Only the server entrypoint may call this — never a CLI process.
 */
export function disbandLiveTeamsOnBoot(): number {
  loadTeamsOnce()
  const completedAt = new Date().toISOString()
  let count = 0
  for (const team of teams.values()) {
    if (team.status !== 'active' && team.status !== 'forming') continue
    const disbanded: EnsembleTeam = { ...team, status: 'disbanded', completedAt }
    teams.set(team.id, disbanded)
    bus.emit('team', structuredClone(disbanded))
    count++
  }
  if (count > 0) markTeamsDirty()
  return count
}

// ─── Messages ───────────────────────────────────────────────────────────────

function dedupeKey(msg: EnsembleMessage): string {
  return msg.id || `${msg.from}:${msg.timestamp}:${msg.content?.slice(0, 50)}`
}

function readJsonl(file: string): EnsembleMessage[] {
  if (!fs.existsSync(file)) return []
  const out: EnsembleMessage[] = []
  let corrupt = 0
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
      out.push(parsed as EnsembleMessage)
    } catch {
      corrupt++
    }
  }
  if (corrupt > 0) console.warn(`[Registry] Skipped ${corrupt} corrupt line(s) in ${file}`)
  return out
}

function trimFeed(feed: Feed): void {
  const excess = feed.messages.length - MAX_MESSAGES_PER_TEAM
  if (excess <= 0) return
  for (const dropped of feed.messages.splice(0, excess)) feed.ids.delete(dedupeKey(dropped))
}

function loadFeed(teamId: string): Feed {
  const cached = feeds.get(teamId)
  if (cached) {
    feeds.delete(teamId)
    feeds.set(teamId, cached)
    return cached
  }

  // The feed file wins over the legacy runtime-dir file on a duplicate id.
  const seen = new Set<string>()
  const merged: EnsembleMessage[] = []
  for (const file of [getFeedFile(teamId), collabMessagesFile(teamId)]) {
    for (const msg of readJsonl(file)) {
      const key = dedupeKey(msg)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(msg)
    }
  }
  // Timestamp order, messages without a timestamp last. Array.sort is stable.
  const time = (m: EnsembleMessage): number => m.timestamp ? new Date(m.timestamp).getTime() : Infinity
  merged.sort((a, b) => time(a) - time(b))
  merged.forEach((m, i) => { m.seq = i + 1 })

  const feed: Feed = { messages: merged, ids: seen, nextSeq: merged.length + 1 }
  trimFeed(feed)
  feeds.set(teamId, feed)

  if (feeds.size > MAX_LOADED_FEEDS) {
    for (const id of feeds.keys()) {
      if (feeds.size <= MAX_LOADED_FEEDS) break
      const status = teams.get(id)?.status
      if (id !== teamId && status !== 'active' && status !== 'forming') feeds.delete(id)
    }
  }
  return feed
}

/** Append to a team's feed. Assigns `message.seq`; a repeated id is ignored. */
export function appendMessage(teamId: string, message: EnsembleMessage): void {
  const feed = loadFeed(teamId)
  const key = dedupeKey(message)
  if (message.id && feed.ids.has(key)) return

  message.seq = feed.nextSeq++
  feed.messages.push(message)
  feed.ids.add(key)
  trimFeed(feed)

  try {
    const file = getFeedFile(teamId)
    ensureDir(path.dirname(file))
    fs.appendFileSync(file, JSON.stringify(message) + '\n')
  } catch (err) {
    console.error(`[Registry] Could not persist message for ${teamId}:`, err)
  }
  bus.emit('message', { ...message })
}

/**
 * Messages of a team in feed order. `since` is a seq number (as a number or
 * digit string); any other string is treated as an ISO timestamp, the form
 * callers used before messages had a seq.
 */
export function getMessages(teamId: string, since?: string | number): EnsembleMessage[] {
  const all = loadFeed(teamId).messages
  if (since === undefined || since === '') return all.slice()
  if (typeof since === 'number' || /^\d+$/.test(since)) {
    const seq = Number(since)
    return all.filter(m => (m.seq ?? 0) > seq)
  }
  return all.filter(m => m.timestamp && m.timestamp > since)
}
