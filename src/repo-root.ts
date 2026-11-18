/** The repository root (where package.json, agents.json, web/ and bin/ live): src/ is one level below it. */

import path from 'path'
import { fileURLToPath } from 'url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
