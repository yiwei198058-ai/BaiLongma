import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const requiredFiles = [
  'README.md',
  'DEVELOPMENT.md',
  '.env.example',
  'config.example.json',
  'electron/main.cjs',
  'src/index.js',
  'src/api.js',
  'src/ui/brain-ui/voice-state.js',
]

const missing = requiredFiles.filter(file => !existsSync(file))
if (missing.length) {
  console.error(`Missing collaboration files: ${missing.join(', ')}`)
  process.exit(1)
}

const syntaxFiles = [
  'electron/main.cjs',
  'src/api.js',
  'src/config.js',
  'src/index.js',
  'src/ui/brain-ui/app.js',
  'src/ui/brain-ui/voice-core.js',
  'src/ui/brain-ui/voice-panel.js',
  'src/ui/brain-ui/voice-state.js',
]

for (const file of syntaxFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'pipe', encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `Syntax check failed: ${file}\n`)
    process.exit(result.status || 1)
  }
}

const trackedConfig = spawnSync('git', ['ls-files', '--error-unmatch', 'config.json'], { stdio: 'ignore' })
if (trackedConfig.status === 0) {
  console.error('config.json must remain local and untracked')
  process.exit(1)
}

console.log(`Collaboration checks passed (${requiredFiles.length} required files, ${syntaxFiles.length} syntax checks).`)
