import fs from 'fs'
import crypto from 'crypto'
import { paths } from './paths.js'
import { upsertMemoryByMemId } from './db.js'
import { nowTimestamp } from './time.js'
import { config as llmConfig } from './config.js'

const DEFAULT_REFRESH_MINUTES = 30
const DEFAULT_NEWS_REFRESH_MINUTES = 20
const DEFAULT_ANALYSIS_REFRESH_HOURS = 6
const HOTSPOT_CONTEXT_TTL_MINUTES = 60
const DEFAULT_TIMEOUT_MS = 10000
const USER_AGENT = 'Bailongma/1.0 (+https://localhost)'
const PUBLIC_HOTDATA_API_KEY = 'zIisgRZJLLXgqKCwBirNLegtNNRuL70eBsbHXPxEBWU='

const NEWS_FEEDS = [
  { label: '中新网即时', url: 'https://www.chinanews.com.cn/rss/scroll-news.xml', category: '综合' },
  { label: '中新网时政', url: 'https://www.chinanews.com.cn/rss/china.xml', category: '政策' },
  { label: '中新网财经', url: 'https://www.chinanews.com.cn/rss/finance.xml', category: '财经' },
  { label: '量子位', url: 'https://www.qbitai.com/feed', category: '科技' },
  { label: 'Hacker News', url: 'https://hnrss.org/frontpage', category: '科技' },
]

const PLATFORM_ORDER = ['ai', 'douyin', 'xiaohongshu', 'wechat', 'weibo']
const PLATFORM_LABELS = {
  ai: 'AI人工智能',
  douyin: '抖音',
  xiaohongshu: '小红书',
  wechat: '微信热点',
  weibo: '微博',
}

const AI_TOPIC_QUERIES = [
  { title: 'GitHub 近 30 天 AI 开源项目热度', tag: 'GitHub' },
  { title: 'AI Agent 工具链与自动化工作流', tag: 'Agent' },
  { title: '大模型推理加速与上下文工程', tag: 'LLM' },
  { title: '多模态模型与 AI 视频生成', tag: '多模态' },
  { title: 'AI 编程助手与代码审查', tag: 'Coding' },
]

let cache = null
let inFlight = null
let liveFeedCache = null
let liveFeedInFlight = null
let analysisCache = null
let analysisInFlight = null
let panelActiveUntilMs = 0
let panelState = {
  active: false,
  updatedAtMs: 0,
  source: 'startup',
}

export function noteHotspotPanelViewed() {
  panelActiveUntilMs = Date.now() + HOTSPOT_CONTEXT_TTL_MINUTES * 60 * 1000
  setHotspotPanelState({ active: true, source: 'viewed' })
}

export function setHotspotPanelState({ active, source = 'unknown' } = {}) {
  if (typeof active !== 'boolean') return getHotspotPanelState()
  panelState = {
    active,
    updatedAtMs: Date.now(),
    source,
  }
  if (active) panelActiveUntilMs = Date.now() + HOTSPOT_CONTEXT_TTL_MINUTES * 60 * 1000
  return getHotspotPanelState()
}

export function getHotspotPanelState() {
  const now = Date.now()
  return {
    ...panelState,
    updatedAt: panelState.updatedAtMs ? new Date(panelState.updatedAtMs).toISOString() : null,
    contextActive: now < panelActiveUntilMs,
    contextTtlSeconds: Math.max(0, Math.round((panelActiveUntilMs - now) / 1000)),
  }
}

export function buildHotspotPanelStateContext() {
  const state = getHotspotPanelState()
  const status = state.active ? 'open' : 'closed'
  const ttl = state.contextActive ? `Hotspot context TTL has about ${Math.ceil(state.contextTtlSeconds / 60)} minutes remaining` : 'No active hotspot context TTL'
  return `## Hotspot Panel State
Current hotspot panel: ${status}. ${ttl}.
Use the hotspot_mode tool to open or close the hotspot panel only when display, demo, troubleshooting, or an explicit user request calls for it. Do not open it proactively for ordinary answers.`
}

function readHotspotConfig() {
  let stored = {}
  try {
    stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.hotspots || {}
  } catch {}

  const refreshMinutes = Math.max(
    5,
    Math.min(24 * 60, Number(stored.refreshMinutes || process.env.HOTSPOT_REFRESH_MINUTES || DEFAULT_REFRESH_MINUTES) || DEFAULT_REFRESH_MINUTES)
  )

  const newsRefreshMinutes = Math.max(
    10,
    Math.min(30, Number(stored.newsRefreshMinutes || process.env.HOTSPOT_NEWS_REFRESH_MINUTES || DEFAULT_NEWS_REFRESH_MINUTES) || DEFAULT_NEWS_REFRESH_MINUTES)
  )

  const analysisRefreshHours = Math.max(
    1,
    Math.min(24, Number(stored.analysisRefreshHours || process.env.HOTSPOT_ANALYSIS_REFRESH_HOURS || DEFAULT_ANALYSIS_REFRESH_HOURS) || DEFAULT_ANALYSIS_REFRESH_HOURS)
  )

  const tianapiKey = String(stored.tianapiKey || process.env.TIANAPI_KEY || process.env.TIANAPI_DOUYIN_KEY || '').trim()
  const customNewsFeeds = Array.isArray(stored.newsFeeds)
    ? stored.newsFeeds.map(item => {
      if (typeof item === 'string') return { label: '自定义新闻源', url: item, category: '新闻' }
      return {
        label: String(item?.label || item?.name || '自定义新闻源').trim(),
        url: String(item?.url || '').trim(),
        category: String(item?.category || '新闻').trim(),
      }
    }).filter(item => item.url)
    : []

  return {
    provider: String(stored.provider || process.env.HOTSPOT_PROVIDER || 'auto').trim().toLowerCase(),
    refreshMinutes,
    newsRefreshMinutes,
    analysisRefreshHours,
    newsFeeds: customNewsFeeds.length ? customNewsFeeds : NEWS_FEEDS,
    tianapiKey,
    douyin: {
      url: String(stored.customDouyinUrl || process.env.HOTSPOT_DOUYIN_URL || '').trim(),
    },
    xiaohongshu: {
      url: String(stored.customXiaohongshuUrl || stored.customXhsUrl || process.env.HOTSPOT_XHS_URL || process.env.HOTSPOT_XIAOHONGSHU_URL || '').trim(),
      token: String(stored.tikhubToken || process.env.TIKHUB_TOKEN || process.env.HOTSPOT_TIKHUB_TOKEN || '').trim(),
    },
    hotdata: {
      key: String(stored.hotdataApiKey || process.env.HOTDATA_API_KEY || PUBLIC_HOTDATA_API_KEY || '').trim(),
    },
    wechat: {
      url: String(stored.customWechatUrl || process.env.HOTSPOT_WECHAT_URL || '').trim(),
      tianapiKey: String(stored.wechatTianapiKey || process.env.TIANAPI_WECHAT_KEY || tianapiKey || '').trim(),
    },
    weibo: {
      url: String(stored.customWeiboUrl || process.env.HOTSPOT_WEIBO_URL || '').trim(),
      tianapiKey: String(stored.weiboTianapiKey || process.env.TIANAPI_WEIBO_KEY || tianapiKey || '').trim(),
    },
  }
}

function isCacheFresh(now = Date.now()) {
  if (!cache?.fetchedAtMs) return false
  const ttlMs = cache.refreshMinutes * 60 * 1000
  return now - cache.fetchedAtMs < ttlMs
}

function isLiveFeedFresh(config, now = Date.now()) {
  if (!liveFeedCache?.fetchedAtMs) return false
  const ttlMs = (config?.newsRefreshMinutes || DEFAULT_NEWS_REFRESH_MINUTES) * 60 * 1000
  return now - liveFeedCache.fetchedAtMs < ttlMs
}

function isAnalysisFresh(config, now = Date.now()) {
  if (!analysisCache?.analyzedAtMs) return false
  const ttlMs = (config?.analysisRefreshHours || DEFAULT_ANALYSIS_REFRESH_HOURS) * 60 * 60 * 1000
  return now - analysisCache.analyzedAtMs < ttlMs
}

function isContextFresh(now = Date.now()) {
  if (!cache?.fetchedAtMs) return false
  const ttlMs = HOTSPOT_CONTEXT_TTL_MINUTES * 60 * 1000
  return now - cache.fetchedAtMs < ttlMs
}

async function fetchJson(url, options = {}) {
  const res = await globalThis.fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json,text/plain,*/*',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('返回内容不是 JSON')
  }
}

async function fetchText(url, options = {}) {
  const res = await globalThis.fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,text/plain,*/*',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

function decodeEntities(value = '') {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

function stripHtml(value = '') {
  return decodeEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractTag(block = '', tag) {
  const match = String(block).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match ? stripHtml(match[1]) : ''
}

function parseFeedDate(value = '') {
  if (!value) return ''
  const date = new Date(stripHtml(value))
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function cleanFeedSummary(value = '') {
  return stripHtml(value)
    .replace(/Article URL:\s*https?:\/\/\S+/gi, '')
    .replace(/Comments URL:\s*https?:\/\/\S+/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseFeedItems(xml = '', source = {}, limit = 8) {
  const itemBlocks = [...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(m => m[0])
  const entryBlocks = [...String(xml).matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map(m => m[0])
  const blocks = itemBlocks.length ? itemBlocks : entryBlocks
  return blocks.slice(0, limit).map((block) => {
    const title = extractTag(block, 'title')
    const desc = cleanFeedSummary(extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content'))
    let link = extractTag(block, 'link')
    if (!link) link = block.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] || ''
    const publishedAt = parseFeedDate(extractTag(block, 'pubDate') || extractTag(block, 'updated') || extractTag(block, 'published') || extractTag(block, 'dc:date'))
    if (!title || !publishedAt) return null
    return {
      title,
      desc: desc.slice(0, 120),
      publishedAt,
      cat: source.category || '新闻',
      source: source.label || '新闻源',
      loc: source.label || '新闻源',
      url: link,
    }
  }).filter(Boolean)
}

function normalizeNewsKey(title = '') {
  return normalizeSearchText(title).slice(0, 90)
}

async function fetchLiveFeed(config) {
  const fetchedAt = new Date()
  const results = await Promise.allSettled((config.newsFeeds || NEWS_FEEDS).map(async (source) => {
    const xml = await fetchText(source.url, { timeoutMs: 9000 })
    return parseFeedItems(xml, source, 8)
  }))

  const seen = new Set()
  const items = []
  const status = []
  results.forEach((result, idx) => {
    const source = (config.newsFeeds || NEWS_FEEDS)[idx]
    if (result.status === 'rejected') {
      status.push({ source: source.label, ok: false, error: result.reason?.message || String(result.reason) })
      return
    }
    status.push({ source: source.label, ok: true, count: result.value.length })
    for (const item of result.value) {
      const key = normalizeNewsKey(item.title)
      if (!key || seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
  })

  items.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
  return {
    ok: true,
    refreshMinutes: config.newsRefreshMinutes,
    fetchedAt: fetchedAt.toISOString(),
    fetchedAtMs: fetchedAt.getTime(),
    items: items.slice(0, 24),
    status,
  }
}

async function getLiveFeed(config, { force = false } = {}) {
  if (!force && isLiveFeedFresh(config)) return liveFeedCache
  if (liveFeedInFlight) return liveFeedInFlight
  liveFeedInFlight = fetchLiveFeed(config)
    .then(result => {
      liveFeedCache = result
      return result
    })
    .catch(err => {
      if (liveFeedCache) return { ...liveFeedCache, stale: true, error: err.message }
      return {
        ok: false,
        refreshMinutes: config.newsRefreshMinutes,
        fetchedAt: new Date().toISOString(),
        fetchedAtMs: Date.now(),
        items: [],
        status: [],
        error: err.message,
      }
    })
    .finally(() => {
      liveFeedInFlight = null
    })
  return liveFeedInFlight
}

function formatHeat(value) {
  const n = Number(value)
  if (Number.isFinite(n) && n <= 0) return ''
  if (!Number.isFinite(n)) return String(value || '')
  if (n >= 100000000) return `${(n / 100000000).toFixed(n >= 1000000000 ? 1 : 2).replace(/\.0+$/, '')}亿`
  if (n >= 10000) return `${Math.round(n / 10000)}万`
  return String(n)
}

function labelText(label) {
  const value = String(label ?? '').trim()
  if (!value || value === '0') return ''
  const labels = {
    1: '热',
    3: '热',
    5: '荐',
    8: '新',
    16: '辟谣',
    17: '活动',
  }
  return labels[value] || value
}

function normalizeSearchText(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, '')
}

function hotspotTitle(item = {}) {
  return String(item.title || item.text || item.word || '').trim()
}

function extractHotspotKeywords(title = '') {
  const cleaned = String(title || '').replace(/[^\p{Script=Han}a-zA-Z0-9]+/gu, ' ').trim()
  const words = new Set()
  for (const part of cleaned.split(/\s+/).filter(Boolean)) {
    if (/^[a-zA-Z0-9]{3,}$/.test(part)) words.add(part.toLowerCase())
  }

  const compact = cleaned.replace(/\s+/g, '')
  for (let i = 0; i < compact.length - 1; i++) {
    for (let len = 2; len <= 5 && i + len <= compact.length; len++) {
      const token = compact.slice(i, i + len)
      if (/[\p{Script=Han}]/u.test(token)) words.add(token)
    }
  }

  return [...words].slice(0, 24)
}

function hotspotEventId(item = {}) {
  const platform = String(item.platform || 'hotspot')
  const title = normalizeSearchText(hotspotTitle(item)).slice(0, 80)
  const hash = crypto.createHash('sha1').update(`${platform}:${title || JSON.stringify(item)}`).digest('hex').slice(0, 12)
  return `hotspot_event_${hash}`
}

function platformLabel(platform) {
  return PLATFORM_LABELS[platform] || platform || '热点'
}

function getCurrentHotspotItems(perPlatformLimit = 20) {
  const items = []
  for (const platform of PLATFORM_ORDER) {
    const list = cache?.platforms?.[platform] || []
    if (Array.isArray(list)) items.push(...list.filter(item => hotspotTitle(item)).slice(0, perPlatformLimit))
  }
  return items
}

function formatFetchedAt(value) {
  if (!value) return '未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知'
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatHotspotLines(items = []) {
  return items.map((item, idx) => {
    const rank = item.rank || idx + 1
    const heat = item.heat ? `（热度 ${item.heat}）` : ''
    return `${platformLabel(item.platform)} ${rank}. ${hotspotTitle(item)}${heat}`
  }).join('\n')
}

const REGION_RULES = [
  { name: '中国地区', re: /中国|北京|上海|广州|深圳|香港|台湾|澳门|杭州|南京|成都|重庆|武汉|西安|天津|广东|浙江|江苏|四川|河南|山东|河北|福建|湖南|湖北/ },
  { name: '亚太地区', re: /日本|韩国|朝鲜|印度|东南亚|新加坡|马来西亚|泰国|越南|菲律宾|印尼|澳大利亚|新西兰|亚太|亚洲/ },
  { name: '北美地区', re: /美国|加拿大|硅谷|华盛顿|纽约|洛杉矶|旧金山|北美|美联储|OpenAI|Google|Microsoft|Meta|Apple|Nvidia|Anthropic/ },
  { name: '欧洲地区', re: /欧洲|欧盟|英国|法国|德国|意大利|西班牙|荷兰|瑞士|乌克兰|俄罗斯|伦敦|巴黎|柏林/ },
  { name: '中东地区', re: /中东|以色列|伊朗|巴勒斯坦|加沙|沙特|阿联酋|卡塔尔|叙利亚|也门|黎巴嫩/ },
  { name: '南美地区', re: /南美|巴西|阿根廷|智利|秘鲁|哥伦比亚|委内瑞拉/ },
  { name: '非洲地区', re: /非洲|埃及|南非|尼日利亚|肯尼亚|埃塞俄比亚|摩洛哥/ },
]

const CATEGORY_RULES = [
  { name: '科技', re: /AI|人工智能|模型|大模型|芯片|机器人|Agent|OpenAI|DeepSeek|英伟达|Nvidia|算法|算力|数据中心|GitHub|Hacker News/i },
  { name: '财经', re: /股|基金|市场|经济|金融|央行|美联储|汇率|美元|人民币|财报|通胀|关税|投资|融资|上市|债券/ },
  { name: '政策', re: /政策|监管|法规|法案|会议|政府|外交|制裁|法院|总统|首相|部委|国会|选举/ },
  { name: '社会', re: /事故|警方|调查|教育|医疗|医院|学校|就业|民生|通报|争议|回应/ },
  { name: '灾害', re: /地震|洪水|暴雨|台风|火灾|山火|灾害|坠毁|爆炸|袭击|死亡|伤亡|救援/ },
  { name: '文娱', re: /电影|音乐|明星|综艺|游戏|体育|比赛|演唱会|票房|冠军|世界杯|奥运/ },
]

const NEGATIVE_RE = /事故|灾|死亡|伤亡|爆炸|坠毁|袭击|冲突|战争|危机|风险|下跌|暴跌|裁员|诈骗|调查|处罚|制裁|泄露|故障|抗议|封禁|争议|回应|辟谣|造假|感染|疫情/
const POSITIVE_RE = /突破|发布|上线|增长|上涨|创新|合作|达成|获批|冠军|成功|开放|升级|改善|恢复|盈利|融资|获奖|推荐|新高/
const ALERT_RE = /预警|紧急|突发|事故|爆炸|地震|台风|暴雨|洪水|袭击|死亡|伤亡|战争|冲突|火灾|坠毁|召回|泄露|风险/

function scoreHeat(item = {}, idx = 0) {
  const rank = Number(item.rank || idx + 1)
  const rankScore = Math.max(4, 60 - Math.min(rank, 50))
  const heatText = String(item.heat || '')
  const heatNumber = Number(heatText.replace(/[^\d.]/g, ''))
  const heatScore = Number.isFinite(heatNumber) ? Math.min(40, Math.log10(Math.max(heatNumber, 10)) * 8) : 8
  return rankScore + heatScore
}

function itemText(item = {}) {
  return [hotspotTitle(item), item.desc, item.summary, item.source].filter(Boolean).join(' ')
}

function summarizeFocus(topItems = [], liveItems = []) {
  const titles = [
    ...topItems.slice(0, 5).map(hotspotTitle),
    ...liveItems.slice(0, 3).map(item => item.title),
  ].filter(Boolean)
  if (!titles.length) return '暂无足够真实热点样本生成态势摘要。'
  return `当前热榜样本聚焦：${titles.slice(0, 4).join('；')}。`
}

function analyzeSituation(platforms = {}, liveItems = [], config = readHotspotConfig()) {
  const analyzedAt = new Date()
  const hotspotItems = PLATFORM_ORDER.flatMap(platform => (
    Array.isArray(platforms?.[platform]) ? platforms[platform].slice(0, 12) : []
  ))
  const allItems = [
    ...hotspotItems,
    ...liveItems.slice(0, 12).map((item, idx) => ({
      platform: 'news',
      rank: idx + 1,
      title: item.title,
      heat: '',
      source: item.source,
      desc: item.desc,
    })),
  ].filter(item => itemText(item))

  const regionScores = new Map(REGION_RULES.map(rule => [rule.name, 0]))
  const categoryScores = new Map()
  let negative = 0
  let positive = 0
  let alertCount = 0
  let highAttention = 0

  allItems.forEach((item, idx) => {
    const text = itemText(item)
    const weight = scoreHeat(item, idx)
    if (idx < 20 || weight >= 38) highAttention += 1
    if (ALERT_RE.test(text)) alertCount += 1
    if (NEGATIVE_RE.test(text)) negative += weight
    if (POSITIVE_RE.test(text)) positive += weight
    for (const rule of REGION_RULES) {
      if (rule.re.test(text)) regionScores.set(rule.name, (regionScores.get(rule.name) || 0) + weight)
    }
    for (const rule of CATEGORY_RULES) {
      if (rule.re.test(text)) categoryScores.set(rule.name, (categoryScores.get(rule.name) || 0) + weight)
    }
  })

  const fallbackRegionScore = Math.max(12, Math.round(allItems.length * 2))
  if ([...regionScores.values()].every(value => value <= 0) && allItems.length) {
    regionScores.set('综合热点', fallbackRegionScore)
  }

  const maxRegion = Math.max(1, ...regionScores.values())
  const regionAttention = [...regionScores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, score]) => ({
      name,
      value: Math.max(8, Math.min(100, Math.round((score / maxRegion) * 100))),
    }))

  const categoryFocus = [...categoryScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name)

  const totalSignal = Math.max(1, positive + negative)
  const sentimentRaw = Math.round(50 + ((positive - negative) / totalSignal) * 32 + Math.min(12, allItems.length / 4))
  const sentimentScore = Math.max(0, Math.min(100, sentimentRaw))
  const sentimentLabel = sentimentScore >= 75 ? '高热偏正'
    : sentimentScore >= 58 ? '中性偏热'
      : sentimentScore >= 42 ? '中性'
        : sentimentScore >= 25 ? '偏谨慎'
          : '风险偏高'

  const confidence = allItems.length >= 45 ? 88 : allItems.length >= 25 ? 80 : allItems.length >= 12 ? 68 : 52
  const summary = summarizeFocus(hotspotItems, liveItems)
  const topCategory = categoryFocus[0] || '综合'

  return {
    ok: true,
    mode: 'local-low-token',
    refreshHours: config.analysisRefreshHours,
    analyzedAt: analyzedAt.toISOString(),
    analyzedAtMs: analyzedAt.getTime(),
    summary,
    categoryFocus,
    regionAttention,
    sentiment: {
      score: sentimentScore,
      label: sentimentLabel,
      delta: '6h缓存',
    },
    stats: {
      alerts: alertCount,
      alertsDelta: '真实源规则计算',
      highAttention,
      highAttentionDelta: `${topCategory}占优`,
      confidence,
      confidenceDelta: `${allItems.length}条样本 / ${config.analysisRefreshHours}小时分析`,
    },
    contextSummary: [
      summary,
      categoryFocus.length ? `主题侧重：${categoryFocus.join('、')}。` : '',
      regionAttention.length ? `区域关注：${regionAttention.slice(0, 3).map(item => `${item.name}${item.value}%`).join('、')}。` : '',
      `情绪指数：${sentimentScore}（${sentimentLabel}）。`,
    ].filter(Boolean).join('\n'),
  }
}

function parseJsonObject(text = '') {
  const raw = String(text || '').trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const candidate = fenced || raw.match(/\{[\s\S]*\}/)?.[0] || raw
  return JSON.parse(candidate)
}

function compactAnalysisInput(platforms = {}, liveItems = []) {
  const hotspotLines = PLATFORM_ORDER.flatMap(platform => {
    const list = Array.isArray(platforms?.[platform]) ? platforms[platform] : []
    return list.slice(0, 6).map(item => `${platformLabel(platform)}#${item.rank || ''} ${hotspotTitle(item)} ${item.heat || ''}`.trim())
  })
  const newsLines = liveItems.slice(0, 8).map(item => `${item.publishedAt || ''} ${item.source || item.loc || 'news'} ${item.title}`.trim())
  return [
    'HOTSPOTS:',
    ...hotspotLines,
    'NEWS:',
    ...newsLines,
  ].join('\n').slice(0, 6000)
}

function clampPercent(value, fallback = 0) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(100, n))
}

function normalizeAiSituation(raw, fallback, config) {
  const analyzedAt = new Date()
  const regionAttention = Array.isArray(raw?.regionAttention)
    ? raw.regionAttention.slice(0, 6).map(item => ({
      name: String(item?.name || '').trim(),
      value: clampPercent(item?.value ?? item?.score ?? item?.percent, 0),
    })).filter(item => item.name && item.value > 0)
    : []
  const sentimentScore = clampPercent(raw?.sentiment?.score, fallback.sentiment.score)
  const sentimentLabel = String(raw?.sentiment?.label || fallback.sentiment.label || '中性').trim()
  const categoryFocus = Array.isArray(raw?.categoryFocus)
    ? raw.categoryFocus.map(item => String(item || '').trim()).filter(Boolean).slice(0, 3)
    : fallback.categoryFocus
  const summary = String(raw?.summary || fallback.summary || '').trim().slice(0, 220)
  const stats = raw?.stats || {}
  return {
    ...fallback,
    mode: 'ai-low-token',
    refreshHours: config.analysisRefreshHours,
    analyzedAt: analyzedAt.toISOString(),
    analyzedAtMs: analyzedAt.getTime(),
    summary,
    categoryFocus,
    regionAttention: regionAttention.length ? regionAttention : fallback.regionAttention,
    sentiment: {
      score: sentimentScore,
      label: sentimentLabel,
      delta: '6h AI缓存',
    },
    stats: {
      alerts: Number.isFinite(Number(stats.alerts)) ? Number(stats.alerts) : fallback.stats.alerts,
      alertsDelta: String(stats.alertsDelta || 'AI低频分析').slice(0, 24),
      highAttention: Number.isFinite(Number(stats.highAttention)) ? Number(stats.highAttention) : fallback.stats.highAttention,
      highAttentionDelta: String(stats.highAttentionDelta || fallback.stats.highAttentionDelta || '').slice(0, 24),
      confidence: clampPercent(stats.confidence, fallback.stats.confidence),
      confidenceDelta: String(stats.confidenceDelta || `${config.analysisRefreshHours}小时AI分析`).slice(0, 32),
    },
    contextSummary: [
      summary,
      categoryFocus.length ? `主题侧重：${categoryFocus.join('、')}。` : '',
      (regionAttention.length ? regionAttention : fallback.regionAttention).length
        ? `区域关注：${(regionAttention.length ? regionAttention : fallback.regionAttention).slice(0, 3).map(item => `${item.name}${item.value}%`).join('、')}。`
        : '',
      `情绪指数：${sentimentScore}（${sentimentLabel}）。`,
    ].filter(Boolean).join('\n'),
  }
}

async function analyzeSituationWithAi(platforms = {}, liveItems = [], config = readHotspotConfig()) {
  const fallback = analyzeSituation(platforms, liveItems, config)
  if (!llmConfig?.apiKey || !llmConfig?.model) return fallback

  const systemPrompt = `你是热点态势分析器。只基于用户提供的热榜标题和新闻标题输出 JSON，不要补充未知事实。目标是低 token：摘要短、字段少。
输出 JSON：
{
  "summary": "120字以内中文摘要",
  "categoryFocus": ["最多3个主题"],
  "regionAttention": [{"name":"区域名","value":0-100}],
  "sentiment": {"score":0-100,"label":"中性/中性偏热/偏谨慎/风险偏高/高热偏正"},
  "stats": {"alerts":数字,"alertsDelta":"短文本","highAttention":数字,"highAttentionDelta":"短文本","confidence":0-100,"confidenceDelta":"短文本"}
}`

  try {
    const { callLLM } = await import('./llm.js')
    const result = await callLLM({
      systemPrompt,
      message: compactAnalysisInput(platforms, liveItems),
      tools: [],
      maxTokens: 420,
      temperature: 0.2,
      topP: 0.8,
      thinking: false,
      mustReply: false,
      localReply: true,
      toolContext: { currentChannel: 'hotspot-analysis' },
    })
    const parsed = parseJsonObject(result?.content || '')
    return normalizeAiSituation(parsed, fallback, config)
  } catch (err) {
    console.warn('[Hotspot] AI 态势分析失败，已回退本地规则:', err.message)
    return { ...fallback, aiError: err.message }
  }
}

async function getSituationAnalysis(platforms, liveItems, config, { force = false } = {}) {
  if (!force && isAnalysisFresh(config)) return analysisCache
  if (analysisInFlight) return analysisInFlight
  analysisInFlight = Promise.resolve()
    .then(() => analyzeSituationWithAi(platforms, liveItems, config))
    .then(result => {
      analysisCache = result
      return result
    })
    .catch(err => {
      if (analysisCache) return { ...analysisCache, stale: true, error: err.message }
      const result = analyzeSituation(platforms, liveItems, config)
      analysisCache = { ...result, error: err.message }
      return analysisCache
    })
    .finally(() => {
      analysisInFlight = null
    })
  return analysisInFlight
}

function matchHotspots(message = '', items = getCurrentHotspotItems(20)) {
  const normalizedMessage = normalizeSearchText(message)
  if (!normalizedMessage) return []
  const rawMessage = String(message || '')

  const matches = []
  for (const item of items) {
    const title = hotspotTitle(item)
    const normalizedTitle = normalizeSearchText(title)
    if (!normalizedTitle) continue
    const rank = Number(item.rank || 0)
    const platform = platformLabel(item.platform)
    const rankRef = rank > 0 && (
      new RegExp(`(热搜|热点|榜单|${platform}).{0,4}(第\\s*${rank}|${rank}\\s*(条|名|位))`).test(rawMessage) ||
      (rank === 1 && new RegExp(`(热搜|热点|榜单|${platform}).{0,4}(第一|榜一|第\\s*1|1\\s*(条|名|位))`).test(rawMessage))
    )

    const direct =
      normalizedMessage.includes(normalizedTitle) ||
      (normalizedTitle.length >= 4 && normalizedTitle.includes(normalizedMessage))

    const keywords = extractHotspotKeywords(title)
    const hitCount = keywords.filter(k => normalizedMessage.includes(normalizeSearchText(k))).length

    if (direct || rankRef || hitCount >= 2) {
      matches.push({ item, keywords: keywords.slice(0, 8), direct, rankRef, hitCount })
    }
  }

  return matches.slice(0, 5)
}

function persistMentionedHotspot(match, message = '') {
  const item = match?.item
  if (!item) return null

  const title = hotspotTitle(item)
  const memId = hotspotEventId(item)
  const timestamp = nowTimestamp()
  const concepts = [...new Set([title, platformLabel(item.platform), ...(match.keywords || [])])].filter(Boolean).slice(0, 16)
  const source = item.source || 'hotspot-api'
  const content = `The user mentioned a recent hotspot: ${title}`
  const detail = [
    `Hotspot source: ${source}`,
    `Platform: ${platformLabel(item.platform)}`,
    `Rank: ${item.rank || 'unknown'}`,
    item.heat ? `Heat: ${item.heat}` : '',
    item.tag ? `Tag: ${item.tag}` : '',
    item.url ? `Link: ${item.url}` : '',
    cache?.fetchedAt ? `Fetched at: ${cache.fetchedAt}` : '',
    `Trigger message excerpt: ${String(message || '').slice(0, 120)}`,
    'This is an automatically archived hotspot-event fact. If later conversation adds user preferences, judgments, or event progress, the agent may update the same mem_id with upsert_memory.',
  ].filter(Boolean).join('\n')

  return upsertMemoryByMemId({
    mem_id: memId,
    type: 'hotspot_event',
    title: `Hotspot event: ${title}`,
    content,
    detail,
    entities: ['SYSTEM'],
    concepts,
    tags: ['hotspot', 'hotspot_event', `platform:${item.platform || 'unknown'}`, `source:${source}`],
    source_ref: 'hotspot_context',
    timestamp,
  })
}

export function buildHotspotRuntimeContext(message = '') {
  if (!cache || !isContextFresh()) return ''

  const items = getCurrentHotspotItems(20)
  const summary = cache.situationAnalysis?.contextSummary || ''
  if (!items.length && !summary) return ''

  const matches = matchHotspots(message, items)
  const persisted = []
  for (const match of matches) {
    try {
      const result = persistMentionedHotspot(match, message)
      if (result?.mem_id) persisted.push(result.mem_id)
    } catch (err) {
      console.warn('[Hotspot] failed to auto-archive hotspot memory:', err.message)
    }
  }

  const shouldInjectPanelContext = Date.now() < panelActiveUntilMs
  if (!shouldInjectPanelContext && !matches.length) return ''

  const matchText = matches.length
    ? `\n\nThe current user message may have mentioned these recent hotspots:\n${formatHotspotLines(matches.map(m => m.item).slice(0, 3))}${persisted.length ? `\nAutomatically archived as long-term hotspot memories: ${persisted.join(', ')}` : ''}`
    : ''

  return `## Hotspot Context
Source: hotspot mode UI, automatically collected by the system. Sender: SYSTEM. Purpose: provide current environment background; this is not a user request.

The user recently opened the hotspot panel. The following is a compact situation summary only; full news and hot-list items are intentionally not injected to minimize tokens. Do not proactively summarize it, do not treat it as a user message, and do not reply to the user solely because of this context.

Mention hotspots proactively only when one of these is true:
- The hotspot is directly related to the user's current question, task, or topic.
- The hotspot contains an urgent risk, major change, or high-priority information that clearly needs the user's attention.
- The user explicitly asks about hotspots, trending searches, or what is happening now.

Fetched at: ${formatFetchedAt(cache.fetchedAt)}${cache.stale ? ', partly cached data' : ''}
Analysis cadence: every ${cache.situationAnalysis?.refreshHours || DEFAULT_ANALYSIS_REFRESH_HOURS} hours; live feed cadence: every ${cache.liveFeedMeta?.refreshMinutes || DEFAULT_NEWS_REFRESH_MINUTES} minutes; current hotspot panel: ${getHotspotPanelState().active ? 'open' : 'closed'}.

${summary || 'No compact situation summary is available yet.'}${matchText}`
}

function pickArray(data) {
  if (Array.isArray(data)) return data
  const candidates = [
    data?.result,
    data?.data,
    data?.newslist,
    data?.list,
    data?.result?.list,
    data?.data?.list,
    data?.data?.items,
    data?.data?.data,
    data?.data?.data?.items,
    data?.data?.hot_list,
    data?.data?.hotList,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate
  }
  return []
}

function normalizeItems(platform, rawItems, source) {
  const list = Array.isArray(rawItems) ? rawItems : []
  return list
    .map((item, idx) => {
      const title = item?.word || item?.hotword || item?.sentence || item?.title || item?.name || item?.keyword || item?.query || item?.text || item?.display_query || ''
      if (!String(title).trim()) return null
      const tag = labelText(item?.label ?? item?.sentence_tag ?? item?.tag ?? item?.type)
      return {
        platform,
        rank: Number(item?.position || item?.rank || item?.index || idx + 1),
        title: String(title).trim(),
        heat: formatHeat(item?.hot_value ?? item?.hotValue ?? item?.hotwordnum ?? item?.heat ?? item?.score ?? item?.views ?? item?.view_count ?? item?.num ?? '') || tag || (platform === 'wechat' ? '热' : ''),
        tag,
        trend: 'same',
        isNew: tag === '新' || item?.is_new === true || item?.isNew === true,
        url: item?.url || item?.share_url || item?.link || item?.jump_url || '',
        source,
      }
    })
    .filter(Boolean)
    .slice(0, 50)
}

function normalizeAiItem(item = {}, idx, source) {
  const title = String(item.title || item.name || item.full_name || item.text || '').trim()
  if (!title) return null
  const tag = item.tag || item.language || item.license?.spdx_id || ''
  const stars = Number(item.stargazers_count || item.stars || 0)
  return {
    platform: 'ai',
    rank: idx + 1,
    title,
    heat: stars ? `${stars.toLocaleString('zh-CN')}★` : (tag || 'AI'),
    tag,
    trend: 'same',
    isNew: !!item.isNew,
    url: item.html_url || item.url || item.link || '',
    source,
  }
}

async function fetchCustomPlatform(platform, url) {
  if (!url) throw new Error(`缺少 ${platformLabel(platform)} 自定义热榜地址`)
  const data = await fetchJson(url)
  const items = normalizeItems(platform, pickArray(data), 'custom')
  if (!items.length) throw new Error('自定义热榜返回空数据')
  return items
}

async function fetchTianapi(platform, apiName, key) {
  if (!key) throw new Error('缺少 TianAPI key')
  const data = await fetchJson(`https://apis.tianapi.com/${apiName}/index?key=${encodeURIComponent(key)}`)
  const items = normalizeItems(platform, pickArray(data), 'tianapi')
  if (!items.length) throw new Error('TianAPI 返回空热榜')
  return items
}

async function fetchHaotechsDouyin() {
  const data = await fetchJson('https://www.haotechs.cn/ljh-wx/api/douyinHot')
  const items = normalizeItems('douyin', pickArray(data), 'haotechs')
  if (!items.length) throw new Error('haotechs 返回空热榜')
  return items
}

async function fetchXxapi(platform, apiName) {
  const data = await fetchJson(`https://v2.xxapi.cn/api/${apiName}`)
  const items = normalizeItems(platform, pickArray(data), 'xxapi')
  if (!items.length) throw new Error('xxapi 返回空热榜')
  return items
}

async function fetchTikhubXiaohongshu(config) {
  if (!config.xiaohongshu.token) throw new Error('缺少 TikHub token')
  const data = await fetchJson('https://api.tikhub.io/api/v1/xiaohongshu/web_v2/fetch_hot_list', {
    headers: { Authorization: `Bearer ${config.xiaohongshu.token}` },
  })
  const items = normalizeItems('xiaohongshu', pickArray(data), 'tikhub')
  if (!items.length) throw new Error('TikHub 返回空热榜')
  return items
}

async function fetchHotData(platform, dataId, key) {
  if (!key) throw new Error('缺少 Hot Data key')
  const data = await fetchJson(`https://w-hotdata.aipromptnav.com/api/hot-data/${dataId}`, {
    headers: { 'X-API-Key': key },
  })
  const items = normalizeItems(platform, pickArray(data), 'hotdata')
  if (!items.length) throw new Error('Hot Data 返回空热榜')
  return items
}

async function fetchGithubAiHotspots() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const query = encodeURIComponent(`created:>${since} is:public archived:false AI OR LLM OR agent`)
  const data = await fetchJson(`https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=12`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  const items = (data?.items || [])
    .map((repo, idx) => normalizeAiItem({
      title: repo.full_name,
      stargazers_count: repo.stargazers_count,
      language: repo.language || repo.license?.spdx_id || 'GitHub',
      html_url: repo.html_url,
      isNew: idx < 3,
    }, idx, 'github-search'))
    .filter(Boolean)
  if (!items.length) throw new Error('GitHub AI 热点返回空数据')
  return items
}

async function fetchHackerNewsAiHotspots() {
  const ids = await fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json', { timeoutMs: 8000 })
  const topIds = Array.isArray(ids) ? ids.slice(0, 40) : []
  if (!topIds.length) throw new Error('Hacker News topstories 返回空数据')
  const stories = await Promise.allSettled(topIds.map(id =>
    fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { timeoutMs: 5000 })
  ))
  const aiRe = /\b(ai|artificial intelligence|llm|agent|openai|anthropic|deepseek|model|neural|machine learning|ml)\b/i
  const items = stories
    .map(result => result.status === 'fulfilled' ? result.value : null)
    .filter(story => story?.title && aiRe.test(story.title))
    .slice(0, 12)
    .map((story, idx) => normalizeAiItem({
      title: story.title,
      stars: story.score,
      tag: 'HN',
      url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
      isNew: idx < 2,
    }, idx, 'hackernews'))
    .filter(Boolean)
  if (!items.length) throw new Error('Hacker News 暂无 AI 热点')
  return items
}

function fetchFallbackAiTopics() {
  return AI_TOPIC_QUERIES.map((topic, idx) => normalizeAiItem({
    title: topic.title,
    tag: topic.tag,
    isNew: idx < 2,
    url: `https://github.com/search?q=${encodeURIComponent(topic.title)}&type=repositories&s=stars&o=desc`,
  }, idx, 'fallback-ai-topics')).filter(Boolean)
}

async function fetchAiHotspots() {
  const providers = [
    fetchGithubAiHotspots,
    fetchHackerNewsAiHotspots,
    () => Promise.resolve(fetchFallbackAiTopics()),
  ]
  return runProviders(providers, 'AI人工智能热点源不可用')
}

async function fetchDouyin(config) {
  const providers = []
  if (config.provider === 'custom') providers.push(() => fetchCustomPlatform('douyin', config.douyin.url))
  if (config.provider === 'tianapi' || (config.provider === 'auto' && config.tianapiKey)) {
    providers.push(() => fetchTianapi('douyin', 'douyinhot', config.tianapiKey))
  }
  if (config.provider === 'haotechs' || config.provider === 'auto') providers.push(fetchHaotechsDouyin)
  if (config.provider === 'xxapi' || config.provider === 'auto') providers.push(() => fetchXxapi('douyin', 'douyinhot'))
  return runProviders(providers, `未知抖音热点 provider: ${config.provider}`)
}

async function fetchXiaohongshu(config) {
  const providers = []
  if (config.xiaohongshu.url) providers.push(() => fetchCustomPlatform('xiaohongshu', config.xiaohongshu.url))
  if (config.xiaohongshu.token) providers.push(() => fetchTikhubXiaohongshu(config))
  if (config.provider === 'auto' || config.provider === 'hotdata') providers.push(() => fetchHotData('xiaohongshu', 'xiaohongshu', config.hotdata.key))
  return runProviders(providers, '小红书实时源未配置')
}

async function fetchWechat(config) {
  const providers = []
  if (config.wechat.url) providers.push(() => fetchCustomPlatform('wechat', config.wechat.url))
  if (config.wechat.tianapiKey) providers.push(() => fetchTianapi('wechat', 'wxhottopic', config.wechat.tianapiKey))
  if (config.provider === 'auto' || config.provider === 'hotdata') providers.push(() => fetchHotData('wechat', 'wxhottopic', config.hotdata.key))
  return runProviders(providers, '微信热点实时源未配置')
}

async function fetchWeibo(config) {
  const providers = []
  if (config.weibo.url) providers.push(() => fetchCustomPlatform('weibo', config.weibo.url))
  if (config.weibo.tianapiKey) providers.push(() => fetchTianapi('weibo', 'weibohot', config.weibo.tianapiKey))
  if (config.provider === 'auto' || config.provider === 'hotdata') providers.push(() => fetchHotData('weibo', 'weibohot', config.hotdata.key))
  if (config.provider === 'auto' || config.provider === 'xxapi') providers.push(() => fetchXxapi('weibo', 'weibohot'))
  return runProviders(providers, '微博热搜实时源未配置')
}

async function runProviders(providers, emptyMessage) {
  if (!providers.length) throw new Error(emptyMessage)
  const errors = []
  for (const provider of providers) {
    try {
      return await provider()
    } catch (err) {
      errors.push(err.message)
    }
  }
  throw new Error(errors.join('；') || emptyMessage)
}

async function fetchPlatform(platform, loader) {
  try {
    const items = await loader()
    return { platform, items, status: { ok: true, count: items.length, source: items[0]?.source || 'hotspot-api' } }
  } catch (err) {
    return { platform, items: [], status: { ok: false, count: 0, error: err.message } }
  }
}

async function fetchHotspots() {
  const config = readHotspotConfig()
  const fetchedAt = new Date()
  const [results, liveFeed] = await Promise.all([
    Promise.all([
      fetchPlatform('ai', fetchAiHotspots),
      fetchPlatform('douyin', () => fetchDouyin(config)),
      fetchPlatform('xiaohongshu', () => fetchXiaohongshu(config)),
      fetchPlatform('wechat', () => fetchWechat(config)),
      fetchPlatform('weibo', () => fetchWeibo(config)),
    ]),
    getLiveFeed(config),
  ])

  const platforms = {}
  const status = {}
  for (const result of results) {
    platforms[result.platform] = result.items
    status[result.platform] = result.status
  }

  const hasAnyItems = Object.values(platforms).some(items => Array.isArray(items) && items.length)
  if (!hasAnyItems) {
    const errors = Object.entries(status).map(([platform, s]) => `${platformLabel(platform)}：${s.error || '无数据'}`).join('；')
    throw new Error(errors || '全部热点源均不可用')
  }

  const situationAnalysis = await getSituationAnalysis(platforms, liveFeed.items || [], config)

  return {
    ok: true,
    refreshMinutes: config.refreshMinutes,
    newsRefreshMinutes: config.newsRefreshMinutes,
    analysisRefreshHours: config.analysisRefreshHours,
    fetchedAt: fetchedAt.toISOString(),
    fetchedAtMs: fetchedAt.getTime(),
    stale: false,
    liveFeed: liveFeed.items || [],
    liveFeedMeta: {
      ok: liveFeed.ok !== false,
      fetchedAt: liveFeed.fetchedAt,
      fetchedAtMs: liveFeed.fetchedAtMs,
      refreshMinutes: liveFeed.refreshMinutes || config.newsRefreshMinutes,
      stale: !!liveFeed.stale,
      error: liveFeed.error,
      status: liveFeed.status || [],
    },
    situationAnalysis,
    platforms,
    status,
  }
}

export async function getHotspots({ force = false, viewed = false } = {}) {
  if (viewed) noteHotspotPanelViewed()
  const config = readHotspotConfig()
  if (!force && isCacheFresh()) {
    const liveFeed = await getLiveFeed(config)
    const situationAnalysis = await getSituationAnalysis(cache.platforms || {}, liveFeed.items || [], config)
    cache = {
      ...cache,
      newsRefreshMinutes: config.newsRefreshMinutes,
      analysisRefreshHours: config.analysisRefreshHours,
      liveFeed: liveFeed.items || [],
      liveFeedMeta: {
        ok: liveFeed.ok !== false,
        fetchedAt: liveFeed.fetchedAt,
        fetchedAtMs: liveFeed.fetchedAtMs,
        refreshMinutes: liveFeed.refreshMinutes || config.newsRefreshMinutes,
        stale: !!liveFeed.stale,
        error: liveFeed.error,
        status: liveFeed.status || [],
      },
      situationAnalysis,
    }
    return cache
  }
  if (inFlight) return inFlight

  inFlight = fetchHotspots()
    .then((result) => {
      cache = result
      return result
    })
    .catch((err) => {
      if (cache) {
        return {
          ...cache,
          ok: true,
          stale: true,
          error: err.message,
        }
      }
      throw err
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}
