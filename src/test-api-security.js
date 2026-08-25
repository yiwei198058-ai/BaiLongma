import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-api-security-'))
process.env.BAILONGMA_USER_DIR = tempDir
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
process.env.BAILONGMA_HOST = '127.0.0.1'

let server = null
let closeDBForTest = null

try {
  const { startAPI } = await import('./api.js')
  ;({ closeDBForTest } = await import('./db.js'))
  server = startAPI(0)
  await once(server, 'listening')

  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`

  const settingsRes = await fetch(`${baseUrl}/settings`)
  assert.equal(settingsRes.status, 200)
  const settings = await settingsRes.json()
  assert.equal(Object.prototype.hasOwnProperty.call(settings.llm, 'apiKey'), false, 'LLM settings must not expose apiKey')
  for (const provider of Object.values(settings.providers || {})) {
    assert.equal(Object.prototype.hasOwnProperty.call(provider, 'apiKey'), false, 'provider summaries must not expose apiKey')
  }

  const oversizedBody = JSON.stringify({ content: 'x'.repeat(2 * 1024 * 1024) })
  const oversizedRes = await fetch(`${baseUrl}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: oversizedBody,
  })
  assert.equal(oversizedRes.status, 413, 'oversized JSON bodies must be rejected with HTTP 413')

  console.log('PASS API settings redact credentials and JSON body limits are enforced')
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  closeDBForTest?.()
  fs.rmSync(tempDir, { recursive: true, force: true })
}
