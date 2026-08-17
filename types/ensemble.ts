export interface EnsembleTeam {
  id: string
  name: string
  description: string
  status: 'forming' | 'active' | 'paused' | 'completed' | 'disbanded' | 'failed'
  agents: EnsembleTeamAgent[]
  createdBy: string
  createdAt: string
  completedAt?: string
  feedMode: 'silent' | 'summary' | 'live'
  result?: EnsembleTeamResult
  /**
   * ISO timestamp of when this run was archived; absent means not archived.
   * No migration — records written before this field existed are simply
   * treated as not archived.
   */
  archivedAt?: string
  /**
   * The directory this team's agents were spawned into, as requested at
   * creation time. Absent means "the server's own cwd was used" — see
   * `resolveAgentProjectDir` in services/ensemble-service.ts, which is the
   * only place that fallback is applied.
   *
   * Persisted because project-scoped skill discovery needs to read it back
   * long after creation. Before this field existed the value lived only as a
   * local inside createEnsembleTeam, so nothing could recover it later. No
   * migration: records written earlier simply have no value, which resolves
   * to the same cwd default they were created under.
   */
  workingDirectory?: string
}

export interface EnsembleTeamAgent {
  agentId: string
  name: string
  program: string
  role: string
  hostId: string
  status: 'spawning' | 'active' | 'idle' | 'done' | 'failed'
  /**
   * Set by the watchdog when an agent stops making progress after a nudge.
   * Deliberately NOT folded into `status`: message delivery only targets
   * `status === 'active'` agents, and a stalled agent must keep receiving
   * teammate messages so it can recover.
   */
  stalledAt?: string
  worktreePath?: string
  worktreeBranch?: string
}

export interface EnsembleTeamResult {
  summary: string
  decisions: string[]
  discoveries: string[]
  filesChanged: string[]
  duration: number
}

export interface EnsembleMessage {
  id: string
  teamId: string
  from: string
  to: string
  content: string
  type: 'chat' | 'decision' | 'question' | 'result' | 'command'
  timestamp: string
  options?: string[]
}

export interface CreateTeamRequest {
  name: string
  description: string
  agents: Array<{
    program: string
    role?: string
    hostId?: string
  }>
  feedMode?: 'silent' | 'summary' | 'live'
  workingDirectory?: string
  templateName?: string
  useWorktrees?: boolean
  staged?: boolean
  stagedConfig?: StagedWorkflowConfig
}

export type StagedPhase = 'plan' | 'exec' | 'verify'

export interface StagedWorkflowConfig {
  planTimeoutMs?: number   // Max time for PLAN phase before auto-advancing (default: 120000 = 2min)
  execTimeoutMs?: number   // Max time for EXEC phase before auto-advancing (default: 300000 = 5min)
  verifyTimeoutMs?: number // Max time for VERIFY phase before completing (default: 120000 = 2min)
  pollIntervalMs?: number  // How often to check for phase completion (default: 5000 = 5s)
}

export interface CollabTemplateRole {
  role: string
  focus: string
}

export interface CollabTemplate {
  name: string
  description: string
  suggestedTaskPrefix: string
  roles: CollabTemplateRole[]
}

export interface CollabTemplatesFile {
  templates: Record<string, CollabTemplate>
}
