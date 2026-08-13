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

export function getHostsConfigPath(): string {
  return path.join(getEnsembleDataDir(), 'hosts.json')
}
