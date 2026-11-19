import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEnvFile } from '../src/load-env'

describe('loadEnvFile', () => {
  const keys = ['ENSEMBLE_LOADENV_NEW', 'ENSEMBLE_LOADENV_SET'] as const
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-env-'))

  afterEach(() => { for (const key of keys) delete process.env[key] })

  it('adds the file values but keeps what the shell already set', () => {
    const file = path.join(dir, '.env')
    fs.writeFileSync(file, 'ENSEMBLE_LOADENV_NEW=from-file\nENSEMBLE_LOADENV_SET=from-file\n')
    process.env.ENSEMBLE_LOADENV_SET = 'from-shell'

    loadEnvFile(file)

    expect(process.env.ENSEMBLE_LOADENV_NEW).toBe('from-file')
    expect(process.env.ENSEMBLE_LOADENV_SET).toBe('from-shell')
  })

  it('does nothing when there is no file', () => {
    expect(() => loadEnvFile(path.join(dir, 'missing.env'))).not.toThrow()
    expect(process.env.ENSEMBLE_LOADENV_NEW).toBeUndefined()
  })
})
