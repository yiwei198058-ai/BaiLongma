import fs from 'fs'
import path from 'path'
import { savePrefetchCache, clearExpiredPrefetchCache, getEnabledPrefetchTasks } from '../db.js'
import { paths } from '../paths.js'

const DEFAULT_TIMEOUT_MS = 10000

async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const res = await globalThis.fetch(url, {
    headers: {
      'User-Agent': 'Bailongma/1.0 (+https://localhost)',
      Accept: 'application/rss+xml,application/atom+xml,application/json,text/html,text/plain,*/*',
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

async function fetchJson(url, options = {}) {
  return JSON.parse(await fetchText(url, {
    ...options,
    headers: {
      Accept: 'application/json,text/plain,*/*',
      ...(options.headers || {}),
    },
  }))
}

function decodeXmlEntities(text = '') {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function stripHtml(text = '') {
  return decodeXmlEntities(text)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractTag(block = '', tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match ? stripHtml(match[1]) : ''
}

function parseFeedItems(xml = '', limit = 5) {
  const itemBlocks = [...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(m => m[0])
  const entryBlocks = [...String(xml).matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map(m => m[0])
  const blocks = itemBlocks.length ? itemBlocks : entryBlocks
  return blocks.slice(0, limit).map(block => {
    const title = extractTag(block, 'title')
    const summary = extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content')
    let link = extractTag(block, 'link')
    if (!link) link = block.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] || ''
    const date = extractTag(block, 'pubDate') || extractTag(block, 'updated') || extractTag(block, 'published')
    return { title, summary, link, date }
  }).filter(item => item.title)
}

function formatItems(label, items = []) {
  if (!items.length) return `## ${label}\n- 暂无可用数据`
  const lines = [`## ${label}`]
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title}`)
    if (item.summary) lines.push(`   - 摘要：${item.summary.slice(0, 180)}`)
    if (item.link) lines.push(`   - 链接：${item.link}`)
  })
  return lines.join('\n')
}

function formatCompactItems(label, items = [], limit = 3) {
  if (!items.length) return []
  const lines = [`## ${label}`]
  items.slice(0, limit).forEach((item, index) => {
    const summary = item.summary ? ` - ${item.summary.replace(/\s+/g, ' ').slice(0, 90)}` : ''
    const link = item.link ? ` (${item.link})` : ''
    lines.push(`${index + 1}. ${item.title}${summary}${link}`)
  })
  return lines
}

function writeAiNewsFullDigest(content) {
  const dir = path.join(paths.sandboxArticlesDir, 'ai-news')
  fs.mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  const filePath = path.join(dir, `${date}_AI新闻预抓.md`)
  fs.writeFileSync(filePath, content, 'utf8')
  return filePath
}

async function safeSection(label, loader) {
  try {
    return { ok: true, label, items: await loader() }
  } catch (err) {
    return { ok: false, label, error: err.message || String(err), items: [] }
  }
}

// 解析 wttr.in JSON，提取完整天气信息
function parseWttrJson(data, cityName) {
  const cur = data.current_condition?.[0]
  if (!cur) return '天气数据解析失败'

  const desc = cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || ''
  const tempC = cur.temp_C
  const feelsC = cur.FeelsLikeC
  const humidity = cur.humidity
  const windKmph = cur.windspeedKmph
  const windDir = cur.winddir16Point
  const cloudcover = cur.cloudcover
  const visibility = cur.visibility
  const uvIndex = cur.uvIndex
  const precip = cur.precipMM

  const lines = [
    `【当前】${desc}，${tempC}°C（体感 ${feelsC}°C）`,
    `湿度 ${humidity}%  | 云量 ${cloudcover}%  | 能见度 ${visibility}km  | UV ${uvIndex}`,
    `风 ${windDir} ${windKmph}km/h  | 降水 ${precip}mm`,
  ]

  const forecast = data.weather?.slice(0, 3) || []
  if (forecast.length) {
    lines.push('')
    lines.push('【预报】')
    forecast.forEach(day => {
      const dayDesc = day.hourly?.[4]?.lang_zh?.[0]?.value || day.hourly?.[4]?.weatherDesc?.[0]?.value || ''
      const rainChance = Math.max(...(day.hourly?.map(h => Number(h.chanceofrain) || 0) || [0]))
      const snowChance = Math.max(...(day.hourly?.map(h => Number(h.chanceofsnow) || 0) || [0]))
      const maxWind = Math.max(...(day.hourly?.map(h => Number(h.windspeedKmph) || 0) || [0]))
      const totalPrecip = (day.hourly?.reduce((s, h) => s + Number(h.precipMM || 0), 0) || 0).toFixed(1)
      let extra = `雨概率${rainChance}%`
      if (snowChance > 0) extra += `  雪概率${snowChance}%`
      extra += `  最大风速${maxWind}km/h  降水${totalPrecip}mm`
      lines.push(`${day.date}  ${dayDesc}  最高${day.maxtempC}°C / 最低${day.mintempC}°C  ${extra}`)
    })
  }

  return lines.join('\n')
}

async function fetchWeather(city) {
  const res = await globalThis.fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return parseWttrJson(data, city)
}

async function fetchGithubAiProjects() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const query = encodeURIComponent(`created:>${since} is:public archived:false AI OR LLM OR agent`)
  const data = await fetchJson(`https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=8`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  return (data.items || []).slice(0, 8).map(repo => ({
    title: `${repo.full_name}（${repo.stargazers_count}★，${repo.language || 'unknown'}，${repo.license?.spdx_id || 'no license'}）`,
    summary: repo.description || '',
    link: repo.html_url,
  }))
}

async function fetchHackerNewsAi() {
  const ids = (await fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json', { timeoutMs: 8000 })).slice(0, 45)
  const stories = await Promise.allSettled(ids.map(id =>
    fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { timeoutMs: 5000 })
  ))
  const aiRe = /\b(ai|artificial intelligence|llm|agent|openai|anthropic|deepseek|model|neural|machine learning|ml)\b/i
  return stories
    .map(result => result.status === 'fulfilled' ? result.value : null)
    .filter(story => story?.title && aiRe.test(story.title))
    .slice(0, 6)
    .map(story => ({
      title: `${story.title}（HN ${story.score || 0}）`,
      summary: '',
      link: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
    }))
}

async function fetchFeed(label, url, limit = 5) {
  const xml = await fetchText(url, { timeoutMs: 12000 })
  return parseFeedItems(xml, limit)
}

async function fetchArxivAi() {
  const query = encodeURIComponent('cat:cs.AI OR cat:cs.LG')
  const xml = await fetchText(`https://export.arxiv.org/api/query?search_query=${query}&sortBy=submittedDate&sortOrder=descending&max_results=6`, { timeoutMs: 15000 })
  return parseFeedItems(xml, 6)
}

async function fetchDeepSeekNews() {
  const releases = await fetchJson('https://api.github.com/repos/deepseek-ai/DeepSeek-V3/releases?per_page=5', {
    headers: { Accept: 'application/vnd.github+json' },
  })
  return (Array.isArray(releases) ? releases : []).slice(0, 5).map(release => ({
    title: release.name || release.tag_name || 'DeepSeek release',
    summary: stripHtml(release.body || '').slice(0, 220),
    link: release.html_url,
    date: release.published_at || release.created_at,
  })).filter(item => item.title)
}

async function fetchAiNewsDigest() {
  const sections = await Promise.all([
    safeSection('GitHub AI 热门项目', fetchGithubAiProjects),
    safeSection('Hacker News AI 热点', fetchHackerNewsAi),
    safeSection('OpenAI Blog', () => fetchFeed('OpenAI Blog', 'https://openai.com/news/rss.xml', 5)),
    safeSection('Anthropic News', () => fetchFeed('Anthropic News', 'https://www.anthropic.com/news/rss.xml', 5)),
    safeSection('Hugging Face Papers', () => fetchFeed('Hugging Face Papers', 'https://huggingface.co/papers/rss.xml', 5)),
    safeSection('arXiv cs.AI / cs.LG', fetchArxivAi),
    safeSection('量子位', () => fetchFeed('量子位', 'https://www.qbitai.com/feed', 5)),
    safeSection('机器之心', () => fetchFeed('机器之心', 'https://www.jiqizhixin.com/rss', 5)),
    safeSection('新智元', () => fetchFeed('新智元', 'https://www.aixinzhijie.com/rss', 5)),
    safeSection('DeepSeek News', fetchDeepSeekNews),
  ])

  const okSections = sections.filter(section => section.ok && section.items.length)
  const failed = sections.filter(section => !section.ok || !section.items.length)
  const fullLines = [
    `# AI 新闻预抓摘要`,
    `抓取时间：${new Date().toISOString()}`,
    '',
    '用途：这是 BaiLongma prefetch 自动预抓的 AI 新闻素材。回答“AI 新闻/日报/公众号选题/热点”时可优先使用；若用户要求最新且缓存较旧，再联网补查。',
    '',
    ...okSections.map(section => formatItems(section.label, section.items)),
  ]
  if (failed.length) {
    fullLines.push('## 失败或空数据来源')
    failed.forEach(section => fullLines.push(`- ${section.label}：${section.error || '无数据'}`))
  }
  const fullContent = fullLines.join('\n\n').slice(0, 20000)
  const filePath = writeAiNewsFullDigest(fullContent)

  const compactLines = [
    '# AI 新闻预抓摘要（短版）',
    `抓取时间：${new Date().toISOString()}`,
    `完整文件：${filePath}`,
    '',
    '说明：这是低 token 版本，仅在用户询问 AI 新闻、日报、公众号素材、热点选题时注入。需要细节时读取完整文件。',
    '',
    ...okSections.flatMap(section => formatCompactItems(section.label, section.items, 3)),
  ]
  if (failed.length) {
    compactLines.push('', '## 失败或空数据来源')
    failed.slice(0, 8).forEach(section => compactLines.push(`- ${section.label}：${section.error || '无数据'}`))
  }
  return compactLines.join('\n').slice(0, 3500)
}

// 预热任务定义
// fetch 函数只做数据获取，不写 DB——runner 统一写
const TASKS = [
  {
    source: 'weather:Beijing',
    ttlMinutes: 60,
    tags: ['weather', 'Beijing', '北京', '天气'],
    label: '北京天气',
    async fetch() { return fetchWeather('Beijing') },
  },
  {
    source: 'weather:Lufeng',
    ttlMinutes: 60,
    tags: ['weather', 'Lufeng', '陆丰', '天气'],
    label: '陆丰天气',
    async fetch() { return fetchWeather('Lufeng') },
  },
  {
    source: 'news:hackernews',
    ttlMinutes: 30,
    tags: ['news', '新闻', 'tech', 'hackernews'],
    label: 'HackerNews 热榜',
    async fetch() {
      const res = await globalThis.fetch('https://hacker-news.firebaseio.com/v0/topstories.json', { signal: AbortSignal.timeout(8000) })
      const ids = (await res.json()).slice(0, 5)
      const items = await Promise.all(
        ids.map(id =>
          globalThis.fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(5000) })
            .then(r => r.json())
        )
      )
      return items.map((item, i) => `${i + 1}. ${item.title}`).join('\n')
    },
  },
  {
    source: 'news:ai-digest',
    ttlMinutes: 1440,
    tags: ['news', '新闻', 'AI', '人工智能', 'LLM', 'agent', 'github', 'arxiv', '公众号'],
    label: 'AI 新闻采集器预抓',
    async fetch() { return fetchAiNewsDigest() },
  },
]

// 外部可注册自定义任务（代码级，用于内置扩展）
const customTasks = []
export function registerPrefetchTask(task) {
  customTasks.push(task)
}

// 把 DB 里的动态任务转成统一格式
function buildDbTasks() {
  return getEnabledPrefetchTasks().map(row => ({
    source: row.source,
    label: row.label,
    ttlMinutes: row.ttl_minutes,
    tags: JSON.parse(row.tags || '[]'),
    async fetch() {
      const res = await globalThis.fetch(row.url, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      return text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{3,}/g, '\n')
        .trim()
        .slice(0, 2000)
    },
  }))
}

// 执行预热
// taskSources: string[] 指定只跑哪些 source，不传则全跑
export async function runPrefetch(taskSources = null) {
  clearExpiredPrefetchCache()

  const allTasks = [...TASKS, ...customTasks, ...buildDbTasks()]
  const targets = taskSources
    ? allTasks.filter(t => taskSources.includes(t.source))
    : allTasks

  if (targets.length === 0) {
    console.log('[预热] 没有匹配的任务')
    return []
  }

  const results = await Promise.allSettled(
    targets.map(async task => {
      const content = await task.fetch()
      savePrefetchCache(task.source, content, task.ttlMinutes, task.tags)
      console.log(`[预热] ✓ ${task.label || task.source}`)
      return { source: task.source, ok: true }
    })
  )

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[预热] ✗ ${targets[i].label || targets[i].source}：${r.reason?.message || r.reason}`)
    }
  })

  return results
}
