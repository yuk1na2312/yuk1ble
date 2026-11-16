import os from 'os'
import path from 'path'

function trimConfiguredDir(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function getEnsembleDataDir(): string {
  return trimConfiguredDir(process.env.ENSEMBLE_DATA_DIR)
    || path.join(os.homedir(), '.ensemble')
}

export function getEnsembleRegistryDir(): string {
  return path.join(getEnsembleDataDir(), 'ensemble')
}

/** Append-only message log of one team (the persistence side of the in-memory feed). */
export function getFeedFile(teamId: string): string {
  return path.join(getEnsembleRegistryDir(), 'messages', teamId, 'feed.jsonl')
}
