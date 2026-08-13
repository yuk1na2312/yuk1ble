/**
 * Git Worktree Manager — Isolates each agent in its own git worktree
 * to prevent file conflicts when agents write concurrently.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'

const execFileAsync = promisify(execFile)

export interface WorktreeInfo {
  path: string
  branch: string
  agentName: string
}

/**
 * Create an isolated git worktree for an agent.
 * Creates a new branch `collab/<teamId>/<agentName>` from the current HEAD.
 */
export async function createWorktree(
  teamId: string,
  agentName: string,
  basePath: string,
): Promise<WorktreeInfo> {
  const branch = `collab/${teamId}/${agentName}`
  const worktreeDir = path.join(basePath, '.worktrees', `${teamId}-${agentName}`)

  // Ensure parent dir exists
  fs.mkdirSync(path.dirname(worktreeDir), { recursive: true })

  // Create a new branch + worktree in one step
  await execFileAsync('git', ['worktree', 'add', '-b', branch, worktreeDir], {
    cwd: basePath,
  })

  console.log(`[Worktree] Created worktree for ${agentName}: ${worktreeDir} (branch: ${branch})`)
  return { path: worktreeDir, branch, agentName }
}

/**
 * Merge changes from a worktree branch back to the target branch.
 * Uses --no-ff to preserve the merge commit for traceability.
 * Returns true if merge succeeded, false if there were conflicts.
 */
export async function mergeWorktree(
  worktreeInfo: WorktreeInfo,
  basePath: string,
  targetBranch?: string,
): Promise<{ success: boolean; conflicts?: string[] }> {
  // Determine what branch to merge into
  const target = targetBranch || await getCurrentBranch(basePath)

  // Check if the worktree branch has any commits ahead of target
  try {
    const { stdout: diffStat } = await execFileAsync(
      'git', ['diff', '--stat', `${target}...${worktreeInfo.branch}`],
      { cwd: basePath },
    )
    if (!diffStat.trim()) {
      console.log(`[Worktree] No changes in ${worktreeInfo.branch}, skipping merge`)
      return { success: true }
    }
  } catch {
    // Branch comparison failed, try merge anyway
  }

  try {
    await execFileAsync(
      'git',
      ['merge', worktreeInfo.branch, '--no-ff', '-m', `collab: merge ${worktreeInfo.agentName} work`],
      { cwd: basePath },
    )
    console.log(`[Worktree] Merged ${worktreeInfo.branch} into ${target}`)
    return { success: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? (err as Error & { stderr?: string }).stderr || err.message : String(err)
    console.error(`[Worktree] Merge conflict for ${worktreeInfo.branch}:`, message)

    // Get list of conflicted files
    try {
      const { stdout } = await execFileAsync(
        'git', ['diff', '--name-only', '--diff-filter=U'],
        { cwd: basePath },
      )
      const conflicts = stdout.trim().split('\n').filter(Boolean)

      // Abort the failed merge
      await execFileAsync('git', ['merge', '--abort'], { cwd: basePath })
      return { success: false, conflicts }
    } catch {
      // If we can't even get conflicts, abort and report
      try {
        await execFileAsync('git', ['merge', '--abort'], { cwd: basePath })
      } catch { /* already clean */ }
      return { success: false, conflicts: ['unknown — merge aborted'] }
    }
  }
}

/**
 * Remove a worktree and optionally delete its branch.
 */
export async function destroyWorktree(
  worktreeInfo: WorktreeInfo,
  basePath: string,
  deleteBranch = true,
): Promise<void> {
  try {
    await execFileAsync('git', ['worktree', 'remove', worktreeInfo.path, '--force'], {
      cwd: basePath,
    })
    console.log(`[Worktree] Removed worktree at ${worktreeInfo.path}`)
  } catch (err) {
    // Worktree may already be gone
    console.warn(`[Worktree] Could not remove worktree ${worktreeInfo.path}:`, err)
    // Try manual cleanup if the dir exists
    if (fs.existsSync(worktreeInfo.path)) {
      fs.rmSync(worktreeInfo.path, { recursive: true, force: true })
    }
    // Prune stale worktree entries
    try {
      await execFileAsync('git', ['worktree', 'prune'], { cwd: basePath })
    } catch { /* non-fatal */ }
  }

  if (deleteBranch) {
    try {
      await execFileAsync('git', ['branch', '-D', worktreeInfo.branch], {
        cwd: basePath,
      })
      console.log(`[Worktree] Deleted branch ${worktreeInfo.branch}`)
    } catch {
      // Branch may already be gone or not fully merged — that's OK after force remove
    }
  }
}

/**
 * Get the current branch name for a repo.
 */
async function getCurrentBranch(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: repoPath },
  )
  return stdout.trim()
}

/**
 * List all active worktrees for a given team.
 */
export async function listTeamWorktrees(
  teamId: string,
  basePath: string,
): Promise<WorktreeInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      'git', ['worktree', 'list', '--porcelain'],
      { cwd: basePath },
    )

    const worktrees: WorktreeInfo[] = []
    const entries = stdout.split('\n\n')

    for (const entry of entries) {
      const branchMatch = entry.match(/branch refs\/heads\/(collab\/[^\n]+)/)
      const pathMatch = entry.match(/^worktree (.+)$/m)
      if (branchMatch && pathMatch) {
        const branch = branchMatch[1]
        if (branch.startsWith(`collab/${teamId}/`)) {
          const agentName = branch.replace(`collab/${teamId}/`, '')
          worktrees.push({ path: pathMatch[1], branch, agentName })
        }
      }
    }

    return worktrees
  } catch {
    return []
  }
}
