/**
 * Ensemble Service — Standalone
 * No dependency on ai-maestro's agent-registry or agents-core-service.
 * Uses agent-spawner.ts for local agent lifecycle.
 */

import { randomUUID } from 'crypto'
import type { EnsembleTeam, EnsembleMessage, CreateTeamRequest, ServiceResult } from '../types'
import {
  createTeam, getTeam, updateTeam, loadTeams,
  appendMessage, getMessages,
} from './store'
import { spawnLocalAgent, killLocalAgent } from './agent-spawner'
import { getRuntime } from '../runtime/agent-runtime'
import { deliverStrict } from './delivery'
import { resolveAgentProgram, resolveReadyMarkers, listProgramNames, resolveAgentModels, isValidModel } from '../adapters/agent-config'
import { waitForReady as waitForReadyScreen } from './readiness'
import {
  collabPromptFile, collabRuntimeDir, collabFinishedMarker, ensureCollabDirs,
} from './collab-paths'
import fs from 'fs'
import path from 'path'
import { createWorktree, mergeWorktree, destroyWorktree, type WorktreeInfo } from './worktrees'
import { runStagedWorkflow } from './staged-workflow'
import { buildPromptPreview } from './prompts'
import { writeDisbandSummary } from './summary'
import { TeamSupervisor } from './team-supervisor'
import { agentNameFor, agentSessionName, computeSessionName, sanitizeSessionPart } from './session-name'

// The pieces that used to live here; callers and tests keep importing them from the service.
export { loadCollabTemplate, buildPromptPreview } from './prompts'
export { writeDisbandSummary } from './summary'
export { sendTeamMessage, type SendMessageResult } from './messaging'

const supervisor = new TeamSupervisor(teamId => disbandTeam(teamId))

// How long a freshly spawned agent CLI may take to reach its input prompt.
// 60s is not enough for a Claude Code with a heavy MCP/plugin/hook stack —
// loading a large session context routinely runs past a minute on a cold start.
const READY_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.ENSEMBLE_READY_TIMEOUT_MS) || 150_000
)
// Unchanged-screen window that stands in for an unrecognised ready marker.
const QUIESCENT_READY_MS = 20_000
/** Longest team name accepted. */
const MAX_TEAM_NAME_LENGTH = 64
/** Every agent is a PTY with its own CLI process tree; this bounds a runaway request. */
const MAX_TEAM_SIZE = 8

export interface CreateTeamResult extends ServiceResult<{ team: EnsembleTeam }> {
  /**
   * Settles when background startup (worktrees, spawn, readiness, prompt
   * injection) is over. Never rejects: a failure is logged and written to the
   * feed. The HTTP route ignores it; tests await it.
   */
  completion?: Promise<void>
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Trust boundary for POST /teams: a malformed body must be a 400, never a thrown 500. */
function validateCreateRequest(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'Request body must be a JSON object'
  const body = raw as Record<string, unknown>
  if (!isNonEmptyString(body.name)) return 'name is required (non-empty string)'
  if (body.name.trim().length > MAX_TEAM_NAME_LENGTH) return `name is longer than ${MAX_TEAM_NAME_LENGTH} characters`
  if (sanitizeSessionPart(body.name).length === 0) {
    return 'name must contain at least one letter, digit, dash, underscore or dot: terminal sessions are named after it'
  }
  if (!isNonEmptyString(body.description)) return 'description is required (non-empty string)'
  if (!Array.isArray(body.agents) || body.agents.length < 2) {
    return 'agents must be an array of at least 2 entries — agents collaborate by messaging each other'
  }
  if (body.agents.length > MAX_TEAM_SIZE) {
    return `agents has ${body.agents.length} entries; a team holds at most ${MAX_TEAM_SIZE}`
  }
  for (const [i, agent] of body.agents.entries()) {
    if (typeof agent !== 'object' || agent === null || !isNonEmptyString((agent as { program?: unknown }).program)) {
      return `agents[${i}].program is required (non-empty string)`
    }
    // No fallback to a default CLI: an unknown name must stop here, before any record or PTY exists.
    const program = (agent as { program: string }).program
    if (!resolveAgentProgram(program)) {
      return `unknown program "${program}"; available: ${listProgramNames().join(', ')}`
    }
    // An unlisted model makes the CLI exit at once and the readiness wait burn its whole window, so reject it here.
    const model = (agent as { model?: unknown }).model
    if (model !== undefined) {
      if (!isNonEmptyString(model)) return `agents[${i}].model must be a non-empty string`
      if (!isValidModel(program, model)) {
        const ids = resolveAgentModels(program).map(m => m.id)
        return `agents[${i}].model "${model}" is not available for ${resolveAgentProgram(program)?.name ?? program}; `
          + (ids.length ? `available: ${ids.join(', ')}` : 'this program has no model catalog')
      }
    }
  }
  if (body.workingDirectory !== undefined && typeof body.workingDirectory !== 'string') {
    return 'workingDirectory must be a string'
  }
  return undefined
}

/**
 * Validate, record the team and answer at once with 202. Spawning the agents,
 * waiting for their CLIs to reach a prompt (up to ENSEMBLE_READY_TIMEOUT_MS) and
 * injecting the task continue in the background, reporting through the team's
 * status and its feed.
 */
/** The session name a new team would share with a team that is still running, if any. */
function findSessionNameCollision(request: CreateTeamRequest): string | undefined {
  const inUse = new Set<string>()
  for (const team of loadTeams()) {
    if (team.status === 'disbanded') continue
    for (const agent of team.agents) inUse.add(agentSessionName(team, agent))
  }
  return request.agents
    .map((agent, i) => computeSessionName(request.name, agentNameFor(agent.program, i)))
    .find(name => inUse.has(name))
}

export async function createEnsembleTeam(raw: unknown): Promise<CreateTeamResult> {
  const invalid = validateCreateRequest(raw)
  if (invalid) return { error: `Bad Request: ${invalid}`, status: 400 }

  const request = raw as CreateTeamRequest
  const taken = findSessionNameCollision(request)
  if (taken) return { error: `Bad Request: a running team already uses the terminal name "${taken}"; choose a different team name`, status: 400 }
  const team = createTeam(request)
  const snapshot = structuredClone(team) // startup mutates `team` as it goes

  const completion = startTeam(team, request).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[Ensemble] Team startup failed for ${team.id}:`, err)
    try {
      appendMessage(team.id, {
        id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `❌ Team startup failed: ${message}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
      // Sessions may already be running; leaving them would orphan the processes.
      await disbandTeam(team.id)
    } catch (cleanupErr) {
      console.error(`[Ensemble] Cleanup after failed startup of ${team.id} failed:`, cleanupErr)
    }
  })

  return { data: { team: snapshot }, status: 202, completion }
}

async function startTeam(team: EnsembleTeam, request: CreateTeamRequest): Promise<void> {
  const cwd = request.workingDirectory || process.cwd()
  const worktreeMap = new Map<string, WorktreeInfo>()

  // A team can be disbanded (API, auto-disband) while startup is still spawning or
  // waiting on readiness. Without this check startup marches on, spawns sessions
  // nobody will ever kill and reports "PTY session not found" for ones it killed itself.
  const teamWasDisbanded = (): boolean => {
    const current = getTeam(team.id)
    return !current || current.status === 'disbanded'
  }

  // Publish progress without resurrecting a team disbanded while startup was running.
  const persist = (updates: Partial<EnsembleTeam>): void => {
    const current = getTeam(team.id)
    if (current && current.status !== 'disbanded') updateTeam(team.id, updates)
  }

  // Phase 0: Create worktrees if requested
  if (request.useWorktrees) {
    for (let i = 0; i < team.agents.length; i++) {
      const agentSpec = team.agents[i]
      try {
        const worktreeInfo = await createWorktree(team.id, agentSpec.name, cwd)
        worktreeMap.set(agentSpec.name, worktreeInfo)
        team.agents[i].worktreePath = worktreeInfo.path
        team.agents[i].worktreeBranch = worktreeInfo.branch
        appendMessage(team.id, {
          id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `🌳 Worktree created for ${agentSpec.name}: ${worktreeInfo.branch}`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[Ensemble] Failed to create worktree for ${agentSpec.name}:`, message)
        appendMessage(team.id, {
          id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `⚠️ Worktree creation failed for ${agentSpec.name}: ${message}. Using shared directory.`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
      }
    }
    // disbandTeam merges and removes worktrees from the stored record.
    persist({ agents: team.agents })
  }

  const buildPrompt = (agentName: string, otherNames: string[], agentIndex: number) => {
    return buildPromptPreview({
      teamId: team.id,
      teamName: team.name,
      description: team.description,
      agentName,
      teammateNames: otherNames,
      agentIndex,
      templateName: request.templateName,
    })
  }

  // Phase 1: Spawn all agents
  for (let i = 0; i < team.agents.length; i++) {
    const agentSpec = team.agents[i]
    const agentName = agentSessionName(team, agentSpec)
    if (teamWasDisbanded()) {
      console.log(`[Ensemble] Team ${team.id} was disbanded during startup — not spawning ${agentName}`)
      return
    }
    const prompt = buildPrompt(agentSpec.name, team.agents.filter((_, j) => j !== i).map(a => a.name), i)

    ensureCollabDirs(team.id)
    const promptFile = collabPromptFile(team.id, agentSpec.name)
    fs.writeFileSync(promptFile, prompt)
    console.log(`[Ensemble] Prompt for ${agentSpec.name}: ${prompt}`)

    try {
      console.log(`[Ensemble] Spawning ${agentName} (${agentSpec.program})`)

      const agentCwd = worktreeMap.get(agentSpec.name)?.path || cwd
      const spawned = await spawnLocalAgent({
        sessionName: agentName,
        program: agentSpec.program,
        workingDirectory: agentCwd,
        model: agentSpec.model,
      })

      if (teamWasDisbanded()) {
        // disbandTeam only kills agents it saw as active; this one is not recorded yet.
        console.log(`[Ensemble] Team ${team.id} was disbanded while ${agentName} was spawning — killing it`)
        await killLocalAgent(agentName).catch(() => { /* session may already be gone */ })
        return
      }

      team.agents[i].agentId = spawned.id
      team.agents[i].status = 'active'

      appendMessage(team.id, {
        id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `${agentSpec.name} (${agentSpec.program}) has joined #${team.name}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
      persist({ agents: team.agents })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[Ensemble] Failed to spawn ${agentName}:`, message)
      team.agents[i].status = 'idle'
      appendMessage(team.id, {
        id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `Failed to spawn ${agentName}: ${message}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
      persist({ agents: team.agents })
    }
  }

  persist({ status: 'active', agents: team.agents })

  // Phase 2: Wait for ALL agents to be ready, then inject prompts
  const activeAgents = team.agents.filter(a => a.status === 'active')
  if (activeAgents.length >= 2) {
    const runtime = getRuntime()

    const sessionHasExited = (sessionName: string): boolean => {
      try {
        return runtime.exists(sessionName) === false
      } catch {
        return false
      }
    }

    const waitForReady = (sessionName: string, program: string): Promise<boolean> => waitForReadyScreen({
      runtime,
      sessionName,
      readyMarkers: resolveReadyMarkers(program),
      gates: resolveAgentProgram(program)?.gates ?? [],
      isAborted: teamWasDisbanded,
      abortReason: `team ${team.id} was disbanded`,
      maxWaitMs: READY_TIMEOUT_MS,
      quiescentMs: QUIESCENT_READY_MS,
    })

    console.log(`[Ensemble] Waiting for all ${activeAgents.length} agents to be ready...`)
    const readyResults = await Promise.all(
      activeAgents.map(agent => {
        const sessionName = agentSessionName(team, agent)
        return waitForReady(sessionName, agent.program).then(ready => ({ agent, sessionName, ready }))
      })
    )

    if (teamWasDisbanded()) {
      console.log(`[Ensemble] Team ${team.id} was disbanded during startup — skipping prompt injection`)
      return
    }

    const ready = readyResults.filter(r => r.ready)
    const notReady = readyResults.filter(r => !r.ready)

    // Best-effort readiness — Codex CLI in particular often misses the readyMarker
    // while being functionally ready. Don't abort; warn and proceed with prompt
    // injection for ALL agents whose terminal session exists. Their CLI will buffer
    // the paste and process it when they reach the input prompt.
    for (const nr of notReady) {
      console.warn(`[Ensemble] ${nr.sessionName} did not signal ready in time — attempting prompt injection anyway`)
      appendMessage(team.id, {
        id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `⚠ ${nr.agent.name} did not signal ready in time — injecting prompt anyway (best-effort)`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }

    // Inject into every agent whose session is still alive — "not ready" is only
    // best-effort evidence, but a dead session is definitive: pasting into it just
    // raises "PTY session not found" and buries the real cause.
    const liveness = readyResults.map(result => ({
      result,
      alive: !sessionHasExited(result.sessionName),
    }))
    for (const { result } of liveness.filter(entry => !entry.alive)) {
      console.error(`[Ensemble] ${result.sessionName} has no live session — skipping prompt injection`)
      appendMessage(team.id, {
        id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `❌ ${result.agent.name} exited before it could be prompted — its CLI never reached an input prompt`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }
    const injectTargets = liveness.filter(entry => entry.alive).map(entry => entry.result)
    if (injectTargets.length === 0) {
      appendMessage(team.id, {
        id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `❌ Team start aborted: no agents available for prompt injection`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
      return
    }
    if (notReady.length > 0) {
      // Give the non-ready agents a small extra grace window before pasting,
      // so any in-progress trust prompts or async init can complete.
      await new Promise(r => setTimeout(r, 3000))
    }

    await new Promise(r => setTimeout(r, 2000))

    // Phase 3: Inject prompts (skip if staged — staged workflow handles its own prompts)
    if (request.staged) {
      // Staged mode: skip normal prompt injection, run plan→exec→verify workflow
      appendMessage(team.id, {
        id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `🚀 ${injectTargets.length}/${activeAgents.length} agents — starting staged workflow (plan → exec → verify)`,
        type: 'chat', timestamp: new Date().toISOString(),
      })

      const buildStagedPlanPrompt = (agentName: string, otherNames: string[], agentIndex: number): string => [
        buildPrompt(agentName, otherNames, agentIndex),
        `STAGED WORKFLOW MODE.`,
        `PHASE 1 PLAN: ONLY create and share a plan via team-say.`,
        `Do NOT write code, edit files, or run mutating commands yet.`,
        `Every agent must share its plan before implementation begins.`,
        `After sharing your plan, run team-read and align on the execution approach.`,
      ].join(' ')

      const buildStagedExecPrompt = (otherNames: string[]): string => [
        `PHASE 2 EXEC: Planning is complete.`,
        `You may now execute the agreed plan and make code changes.`,
        `Share concrete progress via team-say and explicitly report when your implementation is done.`,
        `Keep coordinating with ${otherNames.join(', ')} as you work.`,
      ].join(' ')

      const buildStagedVerifyPrompt = (teammateToReview?: string): string => [
        `PHASE 3 VERIFY: Review ${teammateToReview || 'your teammate'}'s work.`,
        `Inspect what they changed, compare it against the plan, and report findings via team-say.`,
        `Focus on bugs, regressions, missing tests, and mismatches with the agreed approach.`,
      ].join(' ')

      // Run in background so createEnsembleTeam returns immediately
      runStagedWorkflow(team, request.stagedConfig, {
        buildPlanPrompt: ({ agent, teammates, index }) => buildStagedPlanPrompt(agent.name, teammates, index),
        buildExecPrompt: ({ teammates }) => buildStagedExecPrompt(teammates),
        buildVerifyPrompt: ({ teammateToReview }) => buildStagedVerifyPrompt(teammateToReview),
      }).catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[Ensemble] Staged workflow failed for ${team.id}:`, message)
        appendMessage(team.id, {
          id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `❌ Staged workflow failed: ${message}`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
      })
    } else {
      // Normal mode: inject prompts simultaneously
      console.log(`[Ensemble] Injecting prompts into ${injectTargets.length} agents (${ready.length} ready, ${notReady.length} best-effort)`)
      await Promise.all(
        injectTargets.map(async ({ agent, sessionName }) => {
          const promptFile = collabPromptFile(team.id, agent.name)
          try {
            const agentCfg = resolveAgentProgram(agent.program)
            await deliverStrict(sessionName, fs.readFileSync(promptFile, 'utf-8'), {
              inputMethod: agentCfg?.inputMethod,
              pasteMarker: agentCfg?.pasteMarker,
            })
            console.log(`[Ensemble] ✓ Prompt injected into ${sessionName}`)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            appendMessage(team.id, {
              id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
              content: `❌ Delivery to ${agent.name} failed: ${message}`,
              type: 'chat', timestamp: new Date().toISOString(),
            })
            console.error(`[Ensemble] ✗ Failed to inject prompt into ${sessionName}:`, err)
          }
        })
      )

      appendMessage(team.id, {
        id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `🚀 ${injectTargets.length} agents received their task — collaboration started${notReady.length ? ` (${notReady.length} via best-effort fallback)` : ''}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }
  } else {
    // Nobody is told this over HTTP any more (the POST answered 202 long ago), so say it in the feed.
    appendMessage(team.id, {
      id: randomUUID(), teamId: team.id, from: 'ensemble', to: 'team',
      content: `❌ Team start aborted: only ${activeAgents.length} of ${team.agents.length} agents spawned (at least 2 are needed)`,
      type: 'chat', timestamp: new Date().toISOString(),
    })
  }
}

export function getEnsembleTeam(teamId: string): ServiceResult<{ team: EnsembleTeam; messages: EnsembleMessage[] }> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  return { data: { team, messages: getMessages(teamId) }, status: 200 }
}

export function listEnsembleTeams(): ServiceResult<{ teams: EnsembleTeam[] }> {
  return { data: { teams: loadTeams() }, status: 200 }
}

export async function checkIdleTeams(): Promise<void> {
  await supervisor.checkIdleTeams()
}

export function getTeamFeed(teamId: string, since?: string): ServiceResult<{ messages: EnsembleMessage[] }> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  return { data: { messages: getMessages(teamId, since) }, status: 200 }
}

export async function disbandTeam(teamId: string): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }

  // Write summary before killing sessions so the Claude Code session can present it
  await writeDisbandSummary(teamId)

  for (const agent of team.agents) {
    if (agent.status === 'active') {
      appendMessage(teamId, {
        id: randomUUID(), teamId, from: 'ensemble', to: 'team',
        content: `${agent.name} has left #${team.name}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })

      try {
        await killLocalAgent(agentSessionName(team, agent))
      } catch { /* session may already be gone */ }
    }
  }

  const agentsWithWorktrees = team.agents.filter(
    a => a.worktreePath && a.worktreeBranch
  )
  if (agentsWithWorktrees.length > 0) {
    await new Promise(resolve => setTimeout(resolve, 2000))

    const firstWorktree = agentsWithWorktrees[0].worktreePath!
    const worktreesDir = path.dirname(firstWorktree)
    const basePath = path.dirname(worktreesDir)

    for (const agent of agentsWithWorktrees) {
      const worktreeInfo: WorktreeInfo = {
        path: agent.worktreePath!,
        branch: agent.worktreeBranch!,
        agentName: agent.name,
      }
      const result = await mergeWorktree(worktreeInfo, basePath)

      appendMessage(teamId, {
        id: randomUUID(), teamId, from: 'ensemble', to: 'team',
        content: result.success
          ? `🌳 Merged ${agent.name}'s worktree (${agent.worktreeBranch})`
          : `⚠️ Merge conflict for ${agent.name}: ${result.conflicts?.join(', ')}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }

    for (const agent of agentsWithWorktrees) {
      const worktreeInfo: WorktreeInfo = {
        path: agent.worktreePath!,
        branch: agent.worktreeBranch!,
        agentName: agent.name,
      }
      await destroyWorktree(worktreeInfo, basePath)
    }
  }

  const updated = updateTeam(teamId, {
    status: 'disbanded',
    completedAt: new Date().toISOString(),
  })

  // .finished is written after summary.txt: anything watching the runtime dir
  // (the /collab skill) treats it as "safe to read the summary".
  try {
    fs.mkdirSync(collabRuntimeDir(teamId), { recursive: true })
    fs.writeFileSync(collabFinishedMarker(teamId), new Date().toISOString())
  } catch { /* non-fatal cleanup */ }

  return { data: { team: updated! }, status: 200 }
}
