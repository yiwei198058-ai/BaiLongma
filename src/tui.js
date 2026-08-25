import readline from 'readline'
import { pushMessage } from './queue.js'

export function startTUI(userId = 'ID:000001') {
  // Electron/App 运行时由图形界面 + HTTP API 负责交互，不启动命令行 TUI。
  // 后台/LaunchServices 启动时 stdin 可能立即关闭；若 readline 监听 close 并 process.exit，
  // 会导致正式 App 刚启动 API 就退出。
  if (process.versions?.electron && process.env.BAILONGMA_ENABLE_TUI !== '1') {
    console.log('[TUI] Electron/App 模式，TUI 已跳过（使用 UI/API 发消息）')
    return
  }

  // 非交互式终端（如后台运行、管道）时跳过 TUI
  if (!process.stdin.isTTY) {
    console.log('[TUI] 非交互式模式，TUI 已跳过（使用 API 发消息）')
    return
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n你: '
  })

  rl.prompt()

  rl.on('line', (line) => {
    const text = line.trim()
    if (text) {
      pushMessage(userId, text)
    }
    rl.prompt()
  })

  rl.on('close', () => {
    console.log('\nJarvis 关闭中...')
    process.exit(0)
  })
}
