import os from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { PtyRuntime } from '../lib/pty-runtime'

const runtime = new PtyRuntime()
const activeSessions = new Set<string>()

async function waitForCapture(
  sessionName: string,
  predicate: (output: string) => boolean,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let output = ''
  while (Date.now() < deadline) {
    output = await runtime.capturePane(sessionName, 60)
    if (predicate(output)) return output
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for PTY output. Last capture:\n${output}`)
}

afterEach(async () => {
  await Promise.all([...activeSessions].map(async sessionName => {
    await runtime.killSession(sessionName)
    activeSessions.delete(sessionName)
  }))
})

describe('PtyRuntime capturePane()', () => {
  it('returns the rendered screen without ANSI redraw artifacts', async () => {
    const sessionName = `capture-pane-${process.pid}-${Date.now()}`
    activeSessions.add(sessionName)
    await runtime.createSession(sessionName, os.tmpdir())
    await waitForCapture(sessionName, output => />\s*$/.test(output))

    // The marker is assembled by PowerShell at runtime, so the literal
    // 'ANSIPROBE9137' never appears in the command line PSReadLine echoes back.
    // A naive `echo MARKER` lets the echoed command satisfy the wait predicate,
    // so the assertion below would pass even if the 3x PSReadLine redraw
    // regression returned — the marker has to come from *output* only.
    await runtime.sendKeys(sessionName, "Write-Host ('ANSI'+'PROBE'+'9137')", {
      literal: true,
      enter: true,
    })
    // Wait for the prompt to redraw *after* the marker: that gives PSReadLine
    // every opportunity to emit the incremental redraws this test guards against.
    const output = await waitForCapture(
      sessionName,
      capture => capture.includes('ANSIPROBE9137') && />\s*$/.test(capture),
    )
    const escCount = output.match(/\x1b/g)?.length ?? 0
    const markerCount = output.match(/ANSIPROBE9137/g)?.length ?? 0
    const echoedCommand = output.match(/'ANSI'\+'PROBE'\+'9137'/g)?.length ?? 0

    console.log(
      `capturePane regression: ESC=${escCount}, marker=${markerCount}, echoed=${echoedCommand}`,
    )
    expect(escCount).toBe(0)
    // Exactly one rendered marker: the command echo cannot contribute, and a
    // redraw regression would push this above 1.
    expect(markerCount).toBe(1)
    expect(echoedCommand).toBe(1)
    expect(output).not.toMatch(/\x1b\[[0-9;]*[A-Za-z]/)
  })

  it('preserves literal spaces in unmapped non-literal input after resize', async () => {
    const sessionName = `send-keys-${process.pid}-${Date.now()}`
    activeSessions.add(sessionName)
    await runtime.createSession(sessionName, os.tmpdir())
    runtime.resize(sessionName, 100, 30)
    await waitForCapture(sessionName, output => />\s*$/.test(output))

    await runtime.sendKeys(sessionName, 'echo SPACE PRESERVED', { enter: true })
    const output = await waitForCapture(
      sessionName,
      capture => capture.includes('SPACE PRESERVED'),
    )

    expect(output).toContain('SPACE PRESERVED')
  })
})
