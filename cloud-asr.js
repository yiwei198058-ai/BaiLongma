// 云端 ASR WebSocket 代理
// 前端 → ws://127.0.0.1:3721/voice/cloud → 后端签名/鉴权 → 云端 ASR
//
// 支持语音识别服务商：
//   local   — 平台本地识别；当前 macOS 使用 Speech.framework
//   aliyun  — 阿里云百炼 Paraformer（首选）
//   tencent — 腾讯云 ASR
//   xunfei  — 科大讯飞 RTASR
//   volcengine — 火山引擎豆包大模型流式 ASR
//   baidu — 百度实时语音识别 WebSocket

import crypto from 'crypto'
import zlib from 'zlib'
import { WebSocket } from 'ws'
import { createMacSpeechSession } from './macos-speech.js'

// ─── 阿里云 Paraformer ───
// 协议：run-task → PCM binary chunks → finish-task
// 结果：{header:{event:"result-generated"}, payload:{output:{sentence:{text,status}}}}
// 连接建立前的待发音频上限（~4s，防止连接失败时无限堆积）
const MAX_PENDING_CHUNKS = 16

function createAliyunSession(apiKey, lang, onTranscript, onError, onClose, onEvent) {
  const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/'
  const taskId = crypto.randomUUID()

  let ready = false
  let finishing = false   // 我们主动发了 finish-task → 随后的 task-finished 属预期，不算异常
  const pending = []

  const ws = new WebSocket(WS_URL, {
    headers: { Authorization: `bearer ${apiKey}` },
  })

  ws.on('open', () => {
    const langCode = (lang === 'zh' || !lang) ? 'zh' : lang
    ws.send(JSON.stringify({
      header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio',
        task: 'asr',
        function: 'recognition',
        model: 'paraformer-realtime-v2',
        parameters: {
            sample_rate: 16000,
            format: 'pcm',
            language_hints: [langCode],
            punctuation_prediction: true,
            inverse_text_normalization: true,
          },
        input: {},
      },
    }))
    ready = true
    for (const buf of pending) {
      try { ws.send(buf) } catch {}
    }
    pending.length = 0
  })

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      const event = msg?.header?.event
      if (event === 'result-generated') {
        const sentence = msg?.payload?.output?.sentence
        if (sentence?.text) {
          const isFinal = sentence.status === 'sentence_end'
          // begin_time 唯一标识一句：同一句的多帧（含重复 final）共用同一 seg，供前端去重
          const seg = sentence.begin_time != null ? `a${sentence.begin_time}` : null
          onTranscript(sentence.text, isFinal, seg)
        }
      } else if (event === 'task-failed') {
        onEvent?.('task-failed', msg?.header?.error_message)
        onError(msg?.header?.error_message || '阿里云 ASR 错误')
      } else {
        // task-started / task-finished / 其它：转发给前端诊断（result-generated 太频繁不转）
        onEvent?.(event)
        // Aliyun 在我们没主动 finish 的情况下自己结束了任务（疑似超长单任务上限）→
        // 关掉这条连接，触发前端重连续上（重连会保住前文 + 缓冲音频，识别接着走）。
        if (event === 'task-finished' && !finishing) {
          try { ws.close() } catch {}
        }
      }
    } catch {}
  })

  ws.on('error', (err) => { pending.length = 0; onError(err.message) })
  ws.on('close', () => { pending.length = 0; onClose() })

  return {
    sendAudio(pcmBuffer) {
      if (!ready) {
        if (pending.length < MAX_PENDING_CHUNKS) pending.push(pcmBuffer)
        return
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(pcmBuffer)
    },
    flush() {
      if (ws.readyState !== WebSocket.OPEN) return
      finishing = true
      ws.send(JSON.stringify({
        header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
        payload: { input: {} },
      }))
    },
    close() { try { ws.close() } catch {} },
  }
}

function isValidAliyunAsrKey(value) {
  return /^sk-[A-Za-z0-9_\-.]{20,}$/.test(String(value || '').trim())
}

let baiduAsrTokenCache = { key: '', token: '', expiresAt: 0 }

async function getBaiduAsrAccessToken(apiKey, secretKey) {
  const cacheKey = `${apiKey}:${secretKey}`
  const now = Date.now()
  if (baiduAsrTokenCache.key === cacheKey && baiduAsrTokenCache.token && baiduAsrTokenCache.expiresAt > now + 60_000) {
    return baiduAsrTokenCache.token
  }
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: apiKey,
    client_secret: secretKey,
  })
  const resp = await fetch('https://aip.baidubce.com/oauth/2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || !data?.access_token) {
    throw new Error(`百度 ASR: 获取 access_token 失败 (${resp.status}): ${JSON.stringify(data).slice(0, 300)}`)
  }
  const expiresIn = Number(data.expires_in || 0)
  baiduAsrTokenCache = {
    key: cacheKey,
    token: data.access_token,
    expiresAt: now + Math.max(60, expiresIn - 300) * 1000,
  }
  return data.access_token
}

function resolveBaiduRestDevPid(lang, devPid) {
  const n = Number(devPid)
  if (Number.isFinite(n) && n > 0) {
    const realtimeToRest = {
      15372: 1537,
      17372: 1737,
      16372: 1637,
      18372: 1837,
    }
    return realtimeToRest[n] || n
  }
  return lang === 'en' || lang === 'en-US' ? 1737 : 1537
}

async function recognizeBaiduRest({ audio, config, lang }) {
  const token = await getBaiduAsrAccessToken(config.baiduAsrApiKey, config.baiduAsrSecretKey)
  const body = {
    format: 'pcm',
    rate: 16000,
    channel: 1,
    cuid: config.baiduAsrCuid || 'bailongma',
    token,
    dev_pid: resolveBaiduRestDevPid(lang, config.baiduAsrDevPid),
    speech: audio.toString('base64'),
    len: audio.length,
  }
  const resp = await fetch('https://vop.baidu.com/server_api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || Number(data.err_no) !== 0) {
    if ([3301, 3307].includes(Number(data.err_no))) return ''
    throw new Error(`百度 ASR 错误 ${data.err_no ?? resp.status}: ${data.err_msg || JSON.stringify(data).slice(0, 200)}`)
  }
  const text = Array.isArray(data.result) ? data.result.join('') : String(data.result || '')
  return text.trim()
}

function isBaiduRestNoiseTranscript(text) {
  const normalized = String(text || '')
    .trim()
    .replace(/[。！？!?，,、.\s]/g, '')
  // 常开麦克风下百度短语音很容易把底噪/呼吸/回声识别成单个语气词。
  // 这些不是可执行语音指令，直接丢弃，避免进入对话后再触发 TTS。
  return normalized.length <= 4 && /^[哦噢喔啊嗯呃额诶唉哎呀哈呵]+$/.test(normalized)
}

function createBaiduRestSession(config, lang, onTranscript, onError, onClose) {
  const chunks = []
  let closed = false
  let flushing = false
  return {
    sendAudio(pcmBuffer) {
      if (closed || flushing || !pcmBuffer?.length) return
      chunks.push(Buffer.from(pcmBuffer))
    },
    async flush() {
      if (closed || flushing) return
      flushing = true
      try {
        const audio = Buffer.concat(chunks)
        chunks.length = 0
        if (!audio.length) return
        const text = await recognizeBaiduRest({ audio, config, lang })
        if (isBaiduRestNoiseTranscript(text)) return
        if (text) onTranscript(text, true, 'brest')
      } catch (err) {
        onError(err.message || String(err))
      } finally {
        flushing = false
      }
    },
    close() {
      chunks.length = 0
      closed = true
      onClose()
    },
  }
}

// ─── 百度实时语音识别 WebSocket ───
// 协议：START JSON → PCM binary chunks → FINISH JSON
// 文档：https://ai.baidu.com/ai-doc/SPEECH/jlbxejt2i
function resolveBaiduDevPid(lang, devPid) {
  const n = Number(devPid)
  if (Number.isFinite(n) && n > 0) return n
  return lang === 'en' || lang === 'en-US' ? 17372 : 15372
}

function createBaiduSession(config, lang, onTranscript, onError, onClose) {
  const sn = crypto.randomUUID()
  const ws = new WebSocket(`wss://vop.baidu.com/realtime_asr?sn=${encodeURIComponent(sn)}`)
  let ready = false
  let closed = false
  let currentSeg = 'b0'
  let segCounter = 0
  const pending = []

  ws.on('open', () => {
    const devPid = resolveBaiduDevPid(lang, config.baiduAsrDevPid)
    const startData = {
      appid: Number(config.baiduAsrAppId) || config.baiduAsrAppId,
      appkey: config.baiduAsrApiKey,
      dev_pid: devPid,
      cuid: config.baiduAsrCuid || 'bailongma',
      format: 'pcm',
      sample: 16000,
    }
    if (config.baiduAsrLmId) startData.lm_id = Number(config.baiduAsrLmId) || config.baiduAsrLmId
    if (devPid === 15376) startData.user = config.baiduAsrUser || 'bailongma'
    try { ws.send(JSON.stringify({ type: 'START', data: startData })) } catch {}
    ready = true
    for (const buf of pending) {
      try { ws.send(buf) } catch {}
    }
    pending.length = 0
  })

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'HEARTBEAT') return
      const isFinal = msg.type === 'FIN_TEXT'
      if (msg.err_no && msg.err_no !== 0) {
        onError(`百度 ASR 错误 ${msg.err_no}: ${msg.err_msg || '未知错误'}`)
        return
      }
      const text = String(msg.result || '').trim()
      if (!text) return
      if (isFinal) {
        const seg = msg.start_time != null ? `b${msg.start_time}` : currentSeg
        onTranscript(text, true, seg)
        currentSeg = `b${++segCounter}`
      } else {
        onTranscript(text, false, currentSeg)
      }
    } catch {}
  })

  ws.on('error', (err) => { pending.length = 0; onError(err.message) })
  ws.on('close', () => { pending.length = 0; closed = true; onClose() })

  return {
    sendAudio(pcmBuffer) {
      if (closed) return
      if (!ready) {
        if (pending.length < MAX_PENDING_CHUNKS) pending.push(Buffer.from(pcmBuffer))
        return
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(pcmBuffer)
    },
    flush() {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ type: 'FINISH' }))
    },
    close() {
      try {
        closed = true
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CANCEL' }))
        ws.close()
      } catch {}
    },
  }
}

// ─── 腾讯云 ASR ───
// 签名：HMAC-SHA256(SecretKey, host+path+?+sorted_query) → base64 → URL 参数
// 结果：{code:0, result:{slice_type:0|2, ...}}，slice_type=2 为最终结果
function createTencentSession(secretId, secretKey, appId, lang, onTranscript, onError, onClose) {
  const host = 'asr.cloud.tencent.com'
  const path = `/asr/v2/${appId}`
  const ts = Math.floor(Date.now() / 1000)
  const nonce = Math.floor(Math.random() * 1000000)

  const params = {
    secretid: secretId,
    timestamp: ts,
    expired: ts + 86400,
    nonce,
    engine_model_type: lang === 'zh' ? '16k_zh' : '16k_en',
    voice_format: 1,
    needvad: 1,
  }

  const sortedQuery = Object.keys(params).sort()
    .map(k => `${k}=${params[k]}`).join('&')
  const signStr = `${host}${path}?${sortedQuery}`
  const signature = crypto.createHmac('sha256', secretKey)
    .update(signStr).digest('base64')

  const url = `wss://${host}${path}?${sortedQuery}&signature=${encodeURIComponent(signature)}`
  const ws = new WebSocket(url)

  let ready = false
  const pending = []

  ws.on('open', () => {
    ready = true
    for (const buf of pending) {
      try { ws.send(buf) } catch {}
    }
    pending.length = 0
  })

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.code !== 0) { onError(`腾讯云 ASR 错误: ${msg.message}`); return }
      const result = msg.result
      if (result?.voice_text_str) {
        const isFinal = result.slice_type === 2
        const seg = result.index != null ? `t${result.index}` : null
        onTranscript(result.voice_text_str, isFinal, seg)
      }
    } catch {}
  })

  ws.on('error', (err) => { pending.length = 0; onError(err.message) })
  ws.on('close', () => { pending.length = 0; onClose() })

  return {
    sendAudio(pcmBuffer) {
      if (!ready) {
        if (pending.length < MAX_PENDING_CHUNKS) pending.push(pcmBuffer)
        return
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(pcmBuffer)
    },
    flush() {
      // 腾讯 ASR 通过关闭连接来结束会话
      try { ws.close() } catch {}
    },
    close() { try { ws.close() } catch {} },
  }
}

// ─── 科大讯飞 RTASR ───
// 签名：base64(hmac-sha1(md5(appid+ts), apiKey))
// 结果：JSON data 字段，type="1" 为最终
function createXunfeiSession(appId, apiKey, lang, onTranscript, onError, onClose) {
  const ts = Math.floor(Date.now() / 1000).toString()
  const md5Base = crypto.createHash('md5').update(appId + ts).digest('hex')
  const signa = crypto.createHmac('sha1', apiKey).update(md5Base).digest('base64')

  const langParam = lang === 'en' ? 'en_us' : 'cn'
  const url = `wss://rtasr.xfyun.cn/v1/ws?appid=${appId}&ts=${ts}&signa=${encodeURIComponent(signa)}&lang=${langParam}`
  const ws = new WebSocket(url)

  let ready = false
  const pending = []

  ws.on('open', () => {
    ready = true
    for (const buf of pending) {
      try { ws.send(buf) } catch {}
    }
    pending.length = 0
  })

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.action === 'error') { onError(`讯飞 RTASR 错误: ${msg.desc}`); return }
      if (msg.action === 'result') {
        const parsed = JSON.parse(msg.data)
        const isFinal = parsed.type === '1'
        const text = (parsed.ws || [])
          .flatMap(w => w.cw || [])
          .map(c => c.w || '').join('')
        if (text) onTranscript(text, isFinal)
      }
    } catch {}
  })

  ws.on('error', (err) => { pending.length = 0; onError(err.message) })
  ws.on('close', () => { pending.length = 0; onClose() })

  return {
    sendAudio(pcmBuffer) {
      if (!ready) {
        if (pending.length < MAX_PENDING_CHUNKS) pending.push(pcmBuffer)
        return
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(pcmBuffer)
    },
    flush() {
      if (ws.readyState !== WebSocket.OPEN) return
      // 讯飞要求发送结束帧
      ws.send(JSON.stringify({ end: true }))
    },
    close() { try { ws.close() } catch {} },
  }
}

// ─── 火山引擎豆包大模型流式 ASR ───
// 协议：自定义二进制帧，首包 gzip JSON full request，后续 gzip PCM audio only request。
// 端点用 bigmodel_async（官方文档：双向流式优化版，数据变化即返回、低延迟，推荐的实时端点）。
// 不要用 bigmodel_nostream（流式输入模式：音频>15s 或收到最后一包才返回）。bigmodel 为 legacy 双向流式。
const VOLC_BIGMODEL_ASR_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
const VOLC_DEFAULT_RESOURCE_ID = 'volc.bigasr.sauc.duration'
const VOLC_SEED_RESOURCE_ID = 'volc.seedasr.sauc.duration'
const VOLC_PROTOCOL_VERSION = 0x1
const VOLC_HEADER_SIZE = 0x1
const VOLC_SERIALIZATION_NONE = 0x0
const VOLC_SERIALIZATION_JSON = 0x1
const VOLC_COMPRESSION_GZIP = 0x1
const VOLC_MESSAGE_FULL_CLIENT_REQUEST = 0x1
const VOLC_MESSAGE_AUDIO_ONLY_REQUEST = 0x2
const VOLC_MESSAGE_FULL_SERVER_RESPONSE = 0x9
const VOLC_MESSAGE_ERROR = 0xf
const VOLC_FLAG_NO_SEQUENCE = 0x0
const VOLC_FLAG_LAST_NO_SEQUENCE = 0x2

function makeVolcHeader(messageType, flags, serialization, compression) {
  return Buffer.from([
    (VOLC_PROTOCOL_VERSION << 4) | VOLC_HEADER_SIZE,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ])
}

function makeVolcFrame(messageType, flags, serialization, payload) {
  const body = zlib.gzipSync(payload && payload.length ? payload : Buffer.alloc(0))
  const size = Buffer.alloc(4)
  size.writeUInt32BE(body.length, 0)
  return Buffer.concat([
    makeVolcHeader(messageType, flags, serialization, VOLC_COMPRESSION_GZIP),
    size,
    body,
  ])
}

function makeVolcFullClientRequest(lang) {
  const langCode = lang === 'zh' ? 'zh-CN' : lang
  const payload = Buffer.from(JSON.stringify({
    user: { uid: 'bailongma' },
    audio: {
      format: 'pcm',
      codec: 'raw',
      rate: 16000,
      bits: 16,
      channel: 1,
      language: langCode || 'zh-CN',
    },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: false,
      result_type: 'full',
      show_utterances: true,
    },
  }), 'utf-8')
  return makeVolcFrame(
    VOLC_MESSAGE_FULL_CLIENT_REQUEST,
    VOLC_FLAG_NO_SEQUENCE,
    VOLC_SERIALIZATION_JSON,
    payload
  )
}

function makeVolcAudioFrame(pcmBuffer, isLast = false) {
  return makeVolcFrame(
    VOLC_MESSAGE_AUDIO_ONLY_REQUEST,
    isLast ? VOLC_FLAG_LAST_NO_SEQUENCE : VOLC_FLAG_NO_SEQUENCE,
    VOLC_SERIALIZATION_NONE,
    Buffer.from(pcmBuffer || Buffer.alloc(0))
  )
}

function parseVolcResponse(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  if (buf.length < 8) return null
  const headerSize = (buf[0] & 0x0f) * 4
  const messageType = (buf[1] >> 4) & 0x0f
  const flags = buf[1] & 0x0f
  const compression = buf[2] & 0x0f
  let offset = headerSize

  if (messageType === VOLC_MESSAGE_ERROR) {
    if (buf.length < offset + 8) return { error: '火山 ASR 返回错误帧' }
    const code = buf.readUInt32BE(offset); offset += 4
    const size = buf.readUInt32BE(offset); offset += 4
    const message = buf.slice(offset, offset + size).toString('utf-8')
    return { error: `火山 ASR 错误 ${code}: ${message}` }
  }

  if (messageType !== VOLC_MESSAGE_FULL_SERVER_RESPONSE) return null
  if (flags === 0x1 || flags === 0x3) offset += 4
  if (buf.length < offset + 4) return null
  const size = buf.readUInt32BE(offset); offset += 4
  let payload = buf.slice(offset, offset + size)
  if (compression === VOLC_COMPRESSION_GZIP && payload.length) {
    payload = zlib.gunzipSync(payload)
  }
  const text = payload.toString('utf-8')
  if (!text) return null
  return { body: JSON.parse(text), isLast: flags === 0x3 }
}

// 火山 result 是「累积」的：每帧带从头到现在的全部 utterances（最后一条通常是非 definite 的
// 当前句，前面的是 definite 已定句）。逐条下发、用累积列表里的稳定下标作 seg，正好套进前端
// 那套（与阿里云一致）按 seg 去重/替换的累积模型：definite→final 入库、非 definite→interim 显示。
// 不要把它们拼成一坨整段重发——那样跨多句会被前端当新内容反复追加，导致重复/错乱。
function emitVolcTranscripts(body, isLast, onTranscript) {
  const results = Array.isArray(body?.result) ? body.result : (body?.result ? [body.result] : [])
  const utterances = results.flatMap(r => Array.isArray(r?.utterances) ? r.utterances : [])
  if (utterances.length > 0) {
    utterances.forEach((u, i) => {
      if (!u?.text) return
      // 下标在累积列表里稳定（第 i 句永远是第 i 条）→ 作 seg 供前端去重，重发同句即替换不追加
      onTranscript(u.text, !!u.definite, `v${i}`)
    })
    return
  }
  // 兜底：没有 utterances 字段时用整段 text，常量 seg 让前端替换而非追加
  const text = results.map(r => r?.text || '').filter(Boolean).join('')
  if (text) onTranscript(text, !!isLast, 'vfull')
}

function createVolcengineSession(config, lang, onTranscript, onError, onClose) {
  const requestId = crypto.randomUUID()
  const headers = {
    'X-Api-Resource-Id': config.volcAsrResourceId || VOLC_DEFAULT_RESOURCE_ID,
    'X-Api-Request-Id': requestId,
    'X-Api-Connect-Id': requestId,
    'X-Api-Sequence': '-1',
  }
  if (config.volcAsrApiKey) {
    headers['X-Api-Key'] = config.volcAsrApiKey
  } else {
    headers['X-Api-App-Key'] = config.volcAsrAppKey
    headers['X-Api-Access-Key'] = config.volcAsrAccessKey
  }

  const ws = new WebSocket(VOLC_BIGMODEL_ASR_URL, { headers })
  let ready = false
  let closed = false
  const pending = []

  ws.on('open', () => {
    try { ws.send(makeVolcFullClientRequest(lang)) } catch {}
    ready = true
    for (const buf of pending) {
      try { ws.send(makeVolcAudioFrame(buf)) } catch {}
    }
    pending.length = 0
  })

  ws.on('message', (data) => {
    try {
      const parsed = parseVolcResponse(data)
      if (!parsed) return
      if (parsed.error) { onError(parsed.error); return }
      emitVolcTranscripts(parsed.body, parsed.isLast, onTranscript)
    } catch (err) {
      onError(`火山 ASR 响应解析失败: ${err.message}`)
    }
  })

  ws.on('error', (err) => {
    pending.length = 0
    const resourceId = headers['X-Api-Resource-Id']
    if (/Unexpected server response:\s*403/i.test(err.message || '') && resourceId === VOLC_SEED_RESOURCE_ID) {
      onError(`${err.message}; current Resource ID is ${resourceId}. If this account has not enabled Doubao streaming ASR 2.0, use ${VOLC_DEFAULT_RESOURCE_ID}.`)
      return
    }
    onError(err.message)
  })
  ws.on('close', () => { pending.length = 0; closed = true; onClose() })

  return {
    sendAudio(pcmBuffer) {
      if (closed) return
      if (!ready) {
        if (pending.length < MAX_PENDING_CHUNKS) pending.push(Buffer.from(pcmBuffer))
        return
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(makeVolcAudioFrame(pcmBuffer))
    },
    flush() {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(makeVolcAudioFrame(Buffer.alloc(0), true))
    },
    close() { try { closed = true; ws.close() } catch {} },
  }
}

// ─── 工厂函数 ───
// config: { provider, lang, aliyunApiKey?, baiduAsrAppId?, baiduAsrApiKey?,
//           baiduAsrDevPid?, baiduAsrCuid?, baiduAsrLmId?, baiduAsrUser?,
//           tencentSecretId?, tencentSecretKey?,
//           tencentAppId?, xunfeiAppId?, xunfeiApiKey?,
//           volcAsrApiKey?, volcAsrAppKey?, volcAsrAccessKey?, volcAsrResourceId? }
export function createCloudASRSession(config, onTranscript, onError, onClose, onEvent) {
  const { provider = 'aliyun', lang = 'zh' } = config

  if (provider === 'local') {
    if (process.platform === 'darwin') {
      return createMacSpeechSession({ ...config, lang }, onTranscript, onError, onClose)
    }
    onError(`本地语音识别暂不支持当前平台: ${process.platform}`)
    return null
  }

  if (provider === 'aliyun') {
    if (!config.aliyunApiKey) { onError('未配置阿里云 API Key'); return null }
    if (!isValidAliyunAsrKey(config.aliyunApiKey)) {
      onError('阿里云 ASR Key 格式不正确：请填写百炼/DashScope 控制台的 sk- 开头 API Key')
      return null
    }
    return createAliyunSession(config.aliyunApiKey, lang, onTranscript, onError, onClose, onEvent)
  }

  if (provider === 'baidu') {
    const mode = String(config.baiduAsrMode || 'rest').trim().toLowerCase()
    if (mode === 'realtime') {
      if (!config.baiduAsrAppId || !config.baiduAsrApiKey) {
        onError('未配置百度实时 ASR AppID/API Key')
        return null
      }
      return createBaiduSession(config, lang, onTranscript, onError, onClose)
    }
    if (!config.baiduAsrApiKey || !config.baiduAsrSecretKey) {
      onError('未配置百度 ASR API Key/Secret Key')
      return null
    }
    return createBaiduRestSession(config, lang, onTranscript, onError, onClose)
  }

  if (provider === 'tencent') {
    if (!config.tencentSecretId || !config.tencentSecretKey) {
      onError('未配置腾讯云 SecretId/SecretKey'); return null
    }
    const appId = config.tencentAppId || ''
    return createTencentSession(config.tencentSecretId, config.tencentSecretKey, appId, lang, onTranscript, onError, onClose)
  }

  if (provider === 'xunfei') {
    if (!config.xunfeiAppId || !config.xunfeiApiKey) {
      onError('未配置讯飞 AppId/ApiKey'); return null
    }
    return createXunfeiSession(config.xunfeiAppId, config.xunfeiApiKey, lang, onTranscript, onError, onClose)
  }

  if (provider === 'volcengine') {
    if (!config.volcAsrApiKey && (!config.volcAsrAppKey || !config.volcAsrAccessKey)) {
      onError('未配置火山引擎 ASR API Key 或 AppKey/AccessKey')
      return null
    }
    return createVolcengineSession(config, lang, onTranscript, onError, onClose)
  }

  onError(`未知云端 ASR 服务商: ${provider}`)
  return null
}
