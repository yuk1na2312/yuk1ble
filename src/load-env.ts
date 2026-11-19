/**
 * Loads `.env` from the repository root into process.env, so the copy of `.env.example`
 * the docs ask for takes effect. The server and the CLI import this module first:
 * other modules read their settings while they load.
 */

import fs from 'fs'
import path from 'path'
import { REPO_ROOT } from './repo-root'

/** A variable already set in the environment wins over the file. A missing file is fine. */
export function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return
  if (typeof process.loadEnvFile !== 'function') {
    console.warn(`[Ensemble] ${file} was not loaded: that needs Node 20.12 or newer. Set the variables in the shell instead.`)
    return
  }
  process.loadEnvFile(file)
}

loadEnvFile(path.join(REPO_ROOT, '.env'))
