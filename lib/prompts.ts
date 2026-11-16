/**
 * What agents are told: the collaboration template roles and the startup prompt
 * each agent receives, plus the sentinel that ends a run.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { CollabTemplatesFile } from '../types/ensemble'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

// Explicit sentinel: when every agent still active has sent this exact marker
// as a full message, the team auto-disbands immediately — no idle wait, no minimum
// message count. Agents are instructed to use it in buildPromptPreview. It is
// checked on the bus 'message' event, the moment the last one is appended.
export const EXPLICIT_DONE_SENTINEL = '<<COLLAB_DONE>>'

export function loadCollabTemplate(templateName?: string): CollabTemplatesFile['templates'][string] | undefined {
  if (!templateName) return undefined
  try {
    const templatesPath = path.join(__dirname, '..', 'collab-templates.json')
    const raw = fs.readFileSync(templatesPath, 'utf-8')
    const data: CollabTemplatesFile = JSON.parse(raw)
    const template = data.templates[templateName]
    if (!template) {
      console.warn(`[Ensemble] Unknown template "${templateName}", falling back to default roles`)
      return undefined
    }
    console.log(`[Ensemble] Loaded template "${templateName}" (${template.name})`)
    return template
  } catch (err) {
    console.warn(`[Ensemble] Failed to load templates:`, err)
    return undefined
  }
}

/** Every preset in collab-templates.json, keyed for `templateName`; behind GET /api/ensemble/templates. */
export function listCollabTemplates(): Array<CollabTemplatesFile['templates'][string] & { key: string }> {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'collab-templates.json'), 'utf-8')
    const data: CollabTemplatesFile = JSON.parse(raw)
    return Object.entries(data.templates).map(([key, template]) => ({ key, ...template }))
  } catch (err) {
    console.warn('[Ensemble] Failed to load templates:', err)
    return []
  }
}

export function buildPromptPreview(params: {
  teamId: string
  teamName: string
  description: string
  agentName: string
  teammateNames: string[]
  agentIndex: number
  templateName?: string
}): string {
  const template = loadCollabTemplate(params.templateName)
  const cli = `node "${path.join(REPO_ROOT, 'bin', 'ensemble.cjs')}"`
  // `team` reaches every teammate; a teammate's name reaches just that one.
  const teamSayCmd = `${cli} team-say ${params.teamId} ${params.agentName} team`
  const teamReadCmd = `${cli} team-read ${params.teamId}`

  let roleInstructions: string[]

  if (template && params.agentIndex < template.roles.length) {
    const templateRole = template.roles[params.agentIndex]
    roleInstructions = [
      `ROLE: ${templateRole.role}.`,
      templateRole.focus,
    ]
  } else {
    const isLead = params.agentIndex === 0
    const roleName = isLead ? 'LEAD' : 'WORKER'
    roleInstructions = isLead
      ? [
          `ROLE: ${roleName}.`,
          `You own architecture, planning, high-level design, task breakdown, and code review.`,
          `Your first action after greeting is to share a concrete implementation plan with your teammates before any implementation starts.`,
          `Keep the workers focused by delegating clear implementation steps, reviewing progress, and calling out risks or design corrections early.`,
        ]
      : [
          `ROLE: ${roleName}.`,
          `You own implementation, writing code, running tests, and reporting concrete execution progress.`,
          `After greeting, wait for the lead's plan before starting implementation work.`,
          `Once the lead shares a plan, execute it pragmatically, report what you changed, and surface blockers or test failures quickly.`,
        ]
  }

  return [
    `You are ${params.agentName} in team "${params.teamName}" with teammate${params.teammateNames.length === 1 ? '' : 's'} ${params.teammateNames.join(', ')}.`,
    `Task: ${params.description}`,
    ...roleInstructions,
    `COMMUNICATION RULES:`,
    `1. Send findings: ${teamSayCmd} "your message" (the recipient "team" reaches every teammate; use a teammate's name instead to message only them)`,
    `2. Read teammate messages: ${teamReadCmd}`,
    `3. After EVERY analysis step, run team-say to share what you found`,
    `4. After EVERY team-say, run team-read to check for responses`,
    `5. If teammate shared findings, RESPOND to them`,
    `6. Keep alternating: analyze, share, read, respond, analyze`,
    `DONE PROTOCOL (important):`,
    `7. When you believe the task is fully converged and there is nothing substantive left to say, explicitly propose closure to your teammates in a normal team-say message ("I think we're done because X — agree?").`,
    `8. Only once your teammates have confirmed agreement, send a FINAL team-say whose message is EXACTLY the sentinel <<COLLAB_DONE>> (nothing else, no quotes, no prose). As soon as every agent still active in the team has sent <<COLLAB_DONE>>, the system auto-disbands the team and writes the summary — so do not send it prematurely.`,
    `9. Before sending <<COLLAB_DONE>>, make sure the important conclusions (recommendation, rationale, build list, layout, decisions) are actually present as long team-say messages in the transcript — that is what the summary will preserve. Do not keep insights only in your head.`,
    `Start NOW: greet your teammates with team-say, then begin.`,
  ].join(' ')
}
