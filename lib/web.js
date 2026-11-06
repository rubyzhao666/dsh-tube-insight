// /tube-insight/ 只读页面：视频库首页 + 单视频转录页（server-rendered HTML，无前端构建）。
// - 只读：GET/HEAD；其它方法 405
// - 数据全部来自本机缓存 $DSH_HOME/tube-insight/cache/*.json（损坏缓存跳过）
// - 所有来自缓存/URL 的动态文本一律 HTML 转义；页面不加载任何外部资源（YouTube 链接只是跳转）
import { cacheDir } from './paths.js'
import { loadCachedVideos, searchCachedTranscripts } from './search.js'
import { formatDuration, formatTimestamp } from './segment.js'

export const BASE = '/tube-insight'
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/
const MAX_PAGE_BYTES = 2 * 1024 * 1024 // 单页 ≤ 2MB（超长转录截断并说明）

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function youtubeUrl(videoId, seconds = 0) {
  return `https://youtu.be/${videoId}?t=${Math.max(0, Math.floor(Number(seconds) || 0))}`
}

function seconds(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.floor(number)
}

function send(res, status, headers, body, { head = false } = {}) {
  try {
    res.writeHead(status, headers)
    res.end(head ? undefined : body)
  } catch {
    try {
      res.end()
    } catch {
      // 连接已关闭，忽略
    }
  }
}

function sendHtml(res, method, html) {
  send(res, 200, HTML_HEADERS, html, { head: method === 'HEAD' })
}

function notFound(res, method = 'GET') {
  send(res, 404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, 'Not Found', {
    head: method === 'HEAD',
  })
}

function methodNotAllowed(res, method) {
  send(
    res,
    405,
    { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD', 'cache-control': 'no-store' },
    'Method Not Allowed：本页面只读，仅支持 GET/HEAD。',
    { head: method === 'HEAD' },
  )
}

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: #0d1117; color: #c9d1d9;
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
a { color: #58a6ff; text-decoration: none; }
a:hover { text-decoration: underline; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background: #161b22; padding: 1px 5px; border-radius: 4px; }
.wrap { max-width: 960px; margin: 0 auto; padding: 28px 20px 56px; }
.ti-header { border-bottom: 1px solid #21262d; padding-bottom: 18px; margin-bottom: 20px; }
h1 { font-size: 22px; margin: 0 0 6px; color: #f0f6fc; }
h2 { font-size: 16px; margin: 26px 0 10px; color: #f0f6fc; }
.ti-sub { margin: 0 0 14px; color: #8b949e; font-size: 13px; }
#ti-search { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
#ti-search input {
  flex: 1 1 320px; min-width: 220px; padding: 8px 12px; border-radius: 6px;
  border: 1px solid #30363d; background: #161b22; color: #c9d1d9; font-size: 14px; outline: none;
}
#ti-search input:focus { border-color: #58a6ff; }
#ti-search button {
  padding: 8px 16px; border-radius: 6px; border: 1px solid #30363d; background: #21262d;
  color: #f0f6fc; font-size: 14px; cursor: pointer;
}
#ti-search button:hover { background: #30363d; }
#ti-search .ti-clear { color: #8b949e; font-size: 13px; }
.ti-stats { display: flex; gap: 18px; flex-wrap: wrap; margin: 16px 0 8px; color: #8b949e; font-size: 13px; }
.ti-stat strong { color: #f0f6fc; font-weight: 600; }
.ti-warn { color: #d29922; }
.ti-muted { color: #8b949e; }
.ti-error { border: 1px solid #f85149; background: rgba(248, 81, 73, .08); color: #ff7b72; padding: 10px 12px; border-radius: 6px; margin: 12px 0; }
.ti-empty { border: 1px dashed #30363d; border-radius: 8px; padding: 18px; color: #8b949e; margin: 18px 0; }
.ti-empty strong { color: #f0f6fc; }
.ti-video-row {
  display: flex; justify-content: space-between; gap: 16px; align-items: center;
  border: 1px solid #21262d; border-radius: 8px; padding: 12px 14px; margin: 8px 0;
  color: inherit;
}
.ti-video-row:hover { border-color: #30363d; background: #11161d; text-decoration: none; }
.ti-row-title { color: #f0f6fc; font-weight: 600; margin-bottom: 2px; }
.ti-row-meta { color: #8b949e; font-size: 12.5px; }
.ti-open { color: #58a6ff; white-space: nowrap; font-size: 13px; }
.ti-result { border: 1px solid #21262d; border-radius: 8px; padding: 12px 14px; margin: 10px 0; }
.ti-result-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.ti-result-title { font-weight: 600; color: #f0f6fc; }
.ti-time { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #79c0ff; font-size: 12.5px; white-space: nowrap; }
.ti-snippet { margin: 8px 0; color: #c9d1d9; word-break: break-word; }
.ti-links { display: flex; gap: 14px; font-size: 13px; }
.ti-back { display: inline-block; margin-bottom: 14px; font-size: 13px; }
.ti-title { font-size: 22px; margin: 0 0 10px; }
.ti-meta { color: #8b949e; font-size: 13px; margin: 2px 0; }
.ti-actions { margin: 14px 0 4px; }
.ti-btn {
  display: inline-block; padding: 6px 12px; border: 1px solid #30363d; border-radius: 6px;
  color: #f0f6fc; background: #21262d; font-size: 13px;
}
.ti-btn:hover { background: #30363d; text-decoration: none; }
.ti-chapters ul { margin: 6px 0; padding-left: 20px; }
.ti-chapters li { margin: 2px 0; }
.ti-segment { display: flex; gap: 12px; padding: 5px 8px; border-radius: 6px; scroll-margin-top: 24px; }
.ti-segment:hover { background: #11161d; }
.ti-segment:target { background: #1c2b3a; outline: 1px solid #1f6feb; }
.ti-text { color: #c9d1d9; word-break: break-word; }
.ti-footer { margin-top: 36px; padding-top: 16px; border-top: 1px solid #21262d; color: #8b949e; font-size: 12.5px; }
`

function htmlDocument(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>`
}

function footerHtml() {
  return `<footer class="ti-footer">
只读页面 · 数据来自本机缓存 <code>${escapeHtml(cacheDir())}</code> · 页面不加载任何外部资源。<br>
抓取/检索/分析仍可在对话里用自然语言完成，例如「看看这个视频讲了什么」「把看过的视频整理成一篇文章」。
</footer>`
}

function sortedVideos(videos) {
  return [...videos].sort(
    (a, b) =>
      (b.fetchedAtMs ?? 0) - (a.fetchedAtMs ?? 0) ||
      compareText(a.title || a.videoId, b.title || b.videoId) ||
      compareText(a.videoId, b.videoId),
  )
}

function renderVideoRow(video) {
  const title = video.title || video.videoId
  const meta = [
    video.channel || '未知频道',
    `时长 ${formatDuration(video.durationSeconds)}`,
    `${video.segments.length} 段`,
    `抓取 ${video.fetchedAt || '未知'}`,
  ].join(' · ')
  return `<a class="ti-video-row" data-video-id="${escapeHtml(video.videoId)}" href="${BASE}/v/${escapeHtml(video.videoId)}">
  <span>
    <span class="ti-row-title">${escapeHtml(title)}</span>
    <span class="ti-row-meta" style="display:block">${escapeHtml(meta)}</span>
  </span>
  <span class="ti-open">打开转录 →</span>
</a>`
}

function renderSearchResults(query, result) {
  const head = `<p class="ti-muted">命中 <strong>${result.resultCount}</strong> 条 / 扫描 <strong>${result.scannedVideos}</strong> 个视频（${result.scannedSegments} 个段落）</p>`
  if (result.results.length === 0) {
    return `<section class="ti-results">
<h2>检索「${escapeHtml(query)}」</h2>
${head}
<p class="ti-empty">没有命中。可以换更短/更具体的关键词，或 <a href="${BASE}/">清除检索</a> 看看全部视频。</p>
</section>`
  }
  const items = result.results
    .map((hit) => {
      const videoId = escapeHtml(hit.videoId)
      const start = seconds(hit.startSeconds)
      const title = hit.title || hit.videoId
      return `<article class="ti-result" data-video-id="${videoId}" data-start="${start}">
  <div class="ti-result-head">
    <a class="ti-result-title" href="${BASE}/v/${videoId}#t=${start}">${escapeHtml(title)}</a>
    <span class="ti-muted">${escapeHtml(hit.channel || '未知频道')}</span>
    <span class="ti-time">[${escapeHtml(hit.timestamp || formatTimestamp(start))}]</span>
  </div>
  <p class="ti-snippet">${escapeHtml(hit.text)}</p>
  <div class="ti-links">
    <a href="${BASE}/v/${videoId}#t=${start}">打开</a>
    <a href="${escapeHtml(youtubeUrl(hit.videoId, start))}" target="_blank" rel="noopener noreferrer">YouTube 原片</a>
  </div>
</article>`
    })
    .join('\n')
  return `<section class="ti-results">
<h2>检索「${escapeHtml(query)}」</h2>
${head}
${items}
</section>`
}

function renderEmptyState() {
  return `<section class="ti-empty">
<strong>本地还没有缓存的视频转录。</strong><br>
先在对话里让模型调用 <code>tube_transcript</code> 抓取一个视频（例如 <code>tube_transcript({ video: "https://www.youtube.com/watch?v=..." })</code>），然后刷新本页即可看到视频库。
</section>`
}

function renderLibraryPage(query = '') {
  const { videos, skipped } = loadCachedVideos()
  const segmentCount = videos.reduce((sum, video) => sum + video.segments.length, 0)
  const stats = `<div class="ti-stats">
  <span class="ti-stat">缓存 <strong>${videos.length}</strong> 个视频</span>
  <span class="ti-stat">共 <strong>${segmentCount}</strong> 个段落</span>
  ${skipped > 0 ? `<span class="ti-stat ti-warn">跳过 ${skipped} 个损坏缓存</span>` : ''}
</div>`
  const searchForm = `<form id="ti-search" method="get" action="${BASE}/">
  <input id="ti-q" name="q" type="search" value="${escapeHtml(query)}" placeholder="搜索本机缓存字幕，例如：large language model / 模型" maxlength="200" autocomplete="off">
  <button type="submit">搜索</button>
  ${query ? `<a class="ti-clear" href="${BASE}/">清除检索</a>` : ''}
</form>`

  let main
  if (videos.length === 0) {
    main = renderEmptyState()
  } else if (!query) {
    main = `<section class="ti-videos">
<h2>视频列表（按抓取时间）</h2>
${sortedVideos(videos).map(renderVideoRow).join('\n')}
</section>`
  } else {
    let searchHtml
    try {
      const result = searchCachedTranscripts({ query, limit: 20, context: 0 })
      searchHtml = renderSearchResults(query, result)
    } catch (error) {
      searchHtml = `<section class="ti-results">
<h2>检索「${escapeHtml(query)}」</h2>
<div class="ti-error">检索失败：${escapeHtml(error.message)}</div>
<p class="ti-muted"><a href="${BASE}/">清除检索</a> 查看全部视频。</p>
</section>`
    }
    main = searchHtml
  }

  const body = `<header class="ti-header">
<h1>TubeInsight 视频库</h1>
<p class="ti-sub">本机缓存里的 YouTube 视频转录 · 只读页面</p>
${searchForm}
${stats}
</header>
<main>
${main}
</main>
${footerHtml()}`
  return htmlDocument('TubeInsight 视频库', body)
}

function renderChapters(video) {
  if (!Array.isArray(video.chapters) || video.chapters.length === 0) return ''
  const items = video.chapters
    .map((chapter) => {
      const start = seconds(chapter.startSeconds)
      return `<li><a class="ti-time" href="${BASE}/v/${escapeHtml(video.videoId)}#t=${start}">[${formatTimestamp(start)}]</a> ${escapeHtml(chapter.title)}</li>`
    })
    .join('\n')
  return `<section class="ti-chapters">
<h2>章节（${video.chapters.length}）</h2>
<ul>${items}</ul>
</section>`
}

function renderSegmentRow(video, segment, start) {
  return `<div class="ti-segment" id="t=${start}" data-start="${start}">
<a class="ti-time" href="${escapeHtml(youtubeUrl(video.videoId, start))}" target="_blank" rel="noopener noreferrer">[${formatTimestamp(start)}]</a>
<span class="ti-text">${escapeHtml(segment.text)}</span>
</div>`
}

function renderTranscriptPage(video) {
  const videoId = escapeHtml(video.videoId)
  const title = video.title || video.videoId
  const caption = `${video.language || '未知语言'}${video.captionKind === 'asr' ? '（自动生成）' : '（原生）'}`
  const meta = [
    `频道 ${video.channel || '未知'}`,
    `时长 ${formatDuration(video.durationSeconds)}`,
    `字幕 ${caption}`,
    `抓取 ${video.fetchedAt || '未知'}`,
    video.source ? `来源 ${video.source}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  const header = `<a class="ti-back" href="${BASE}/">← 返回视频库</a>
<h1 class="ti-title">${escapeHtml(title)}</h1>
<div class="ti-meta">${escapeHtml(meta)}</div>
<div class="ti-actions"><a class="ti-btn" href="${escapeHtml(youtubeUrl(video.videoId, 0))}" target="_blank" rel="noopener noreferrer">YouTube 打开</a></div>
${renderChapters(video)}`

  const documentTitle = `${title} · TubeInsight 视频库`
  const headerHtml = `<main>${header}
<section class="ti-transcript">
<h2>转录（${video.segments.length} 段）</h2>
`
  const footer = `</section>
</main>
${footerHtml()}`
  // 预算：整页（含 <head>/<style> 与页脚）≤ 2MB；给截断提示留 512 字节余量。
  const docOverhead = Buffer.byteLength(htmlDocument(documentTitle, ''), 'utf8')
  const headerBytes = Buffer.byteLength(headerHtml, 'utf8')
  const footerBytes = Buffer.byteLength(footer, 'utf8')
  let budget = MAX_PAGE_BYTES - docOverhead - headerBytes - footerBytes - 512
  let rows = ''
  let shown = 0
  for (const segment of video.segments) {
    const start = seconds(segment.start)
    const row = renderSegmentRow(video, segment, start)
    const rowBytes = Buffer.byteLength(row, 'utf8')
    if (rowBytes > budget) break
    rows += row
    budget -= rowBytes
    shown += 1
  }
  const truncated =
    shown < video.segments.length
      ? `<p class="ti-warn">转录较长，本页已截断显示前 ${shown} / ${video.segments.length} 段。完整内容可用 <code>read</code> 工具读缓存 Markdown，或在对话里让模型引用。</p>`
      : ''
  const body = `${headerHtml}${rows}
${truncated}
</section>
</main>
${footer}`
  return htmlDocument(documentTitle, body)
}

/**
 * 创建 /tube-insight/ 的请求处理器（由 ctx.webServer.register 挂载）。
 * 路由：GET/HEAD /tube-insight/（可带 ?q=）与 /tube-insight/v/<11 位 videoId>；其余 404，非 GET/HEAD 405。
 */
export function createHandler() {
  return async function handler(req, res) {
    const method = String(req.method || 'GET').toUpperCase()
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      return notFound(res, method)
    }
    if (!url.pathname.startsWith(BASE)) return notFound(res, method)
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, method)

    let rest
    try {
      rest = decodeURIComponent(url.pathname.slice(BASE.length))
    } catch {
      return notFound(res, method)
    }
    if (rest === '' || rest === '/') {
      let query = ''
      try {
        query = String(url.searchParams.get('q') || '').trim()
      } catch {
        query = ''
      }
      return sendHtml(res, method, renderLibraryPage(query))
    }

    const match = rest.match(/^\/v\/([^/]+)\/?$/)
    if (!match) return notFound(res, method)
    const videoId = match[1]
    if (!VIDEO_ID_RE.test(videoId)) return notFound(res, method)
    const { videos } = loadCachedVideos()
    const video = videos.find((item) => item.videoId === videoId)
    if (!video) return notFound(res, method)
    return sendHtml(res, method, renderTranscriptPage(video))
  }
}

export { renderLibraryPage, renderTranscriptPage }
