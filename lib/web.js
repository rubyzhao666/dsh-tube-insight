// /tube-insight/ 视频工作台：单页应用壳（内联 CSS/JS）+ 只读 JSON API。
// - 页面：GET/HEAD /tube-insight/ → SPA 壳（light 默认，data-theme 由 client 的 postMessage 驱动）
// - API：GET /tube-insight/api/videos、GET /tube-insight/api/videos/<11 位 videoId>
// - 兼容：旧路由 GET /tube-insight/v/<id> → 302 到 /tube-insight/#/v/<id>
// - 只读：数据来自本机缓存（损坏缓存跳过），不写盘、不发起外部请求；非 GET/HEAD 一律 405。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadCachedVideos } from './search.js'
import { watchUrl } from './yt/url.js'

export const BASE = '/tube-insight'
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/
const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff'
}
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff'
}

function readAsset(name, fallback) {
  try {
    return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')
  } catch {
    return fallback
  }
}

// 构建期无需打包：运行时把同目录的 app.css / app.js 内联进 HTML。
const APP_CSS = readAsset('./app.css', '/* app.css missing */')
const APP_JS = readAsset('./app.js', '/* app.js missing */')

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function toSeconds(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.floor(number)
}

function normalizeChapters(chapters) {
  return (Array.isArray(chapters) ? chapters : [])
    .filter((chapter) => chapter && typeof chapter.title === 'string' && Number.isFinite(Number(chapter.startSeconds)))
    .map((chapter) => ({ start: toSeconds(chapter.startSeconds), title: chapter.title }))
}

function baseVideoFields(video) {
  return {
    videoId: video.videoId,
    title: video.title || '',
    channel: video.channel || '',
    durationSeconds: Math.max(0, Math.floor(Number(video.durationSeconds) || 0)),
    segmentCount: video.segments.length,
    chapters: normalizeChapters(video.chapters),
    language: video.language || '',
    captionKind: video.captionKind === 'asr' ? 'asr' : 'native',
    fetchedAt: video.fetchedAt || ''
  }
}

/** GET /tube-insight/api/videos 的返回体（按 fetchedAt 倒序；损坏缓存跳过并计数）。 */
export function buildVideosPayload() {
  const { videos, skipped } = loadCachedVideos()
  const sorted = [...videos].sort(
    (a, b) =>
      (b.fetchedAtMs ?? 0) - (a.fetchedAtMs ?? 0) ||
      compareText(a.title || a.videoId, b.title || b.videoId) ||
      compareText(a.videoId, b.videoId),
  )
  return {
    videos: sorted.map(baseVideoFields),
    stats: {
      videos: sorted.length,
      segments: sorted.reduce((sum, video) => sum + video.segments.length, 0),
      skipped,
    },
  }
}

/**
 * GET /tube-insight/api/videos/<videoId> 的返回体；视频不在缓存里返回 null。
 * 文本不做 HTML 转义（JSON），前端用 textContent 渲染。
 */
export function buildVideoPayload(videoId) {
  if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) return null
  const { videos } = loadCachedVideos()
  const video = videos.find((item) => item.videoId === videoId)
  if (!video) return null
  return {
    video: {
      ...baseVideoFields(video),
      source: video.source || '',
      publishedAt: video.publishedAt || '',
      description: video.description || '',
      segments: video.segments.map((segment) => ({
        start: toSeconds(segment.start),
        text: segment.text,
      })),
    },
    youtubeUrl: watchUrl(video.videoId),
  }
}

function renderShell() {
  return `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>TubeInsight 视频工作台</title>
<style>${APP_CSS}</style>
</head>
<body>
<div class="app" id="ti-app">
  <header class="topbar">
    <div class="topbar-brand">
      <span class="topbar-icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" stroke="none"></path></svg>
      </span>
      <div>
        <h1>TubeInsight</h1>
        <p class="topbar-sub" id="stats">正在加载…</p>
      </div>
    </div>
    <div class="topbar-actions">
      <button class="btn ghost small" id="sidebar-toggle" type="button" aria-pressed="false" title="折叠 / 展开视频列表">列表</button>
      <button class="btn ghost" id="refresh-btn" type="button">刷新</button>
    </div>
  </header>
  <div class="layout" id="layout">
    <aside class="sidebar" id="sidebar" aria-label="视频列表">
      <div class="toolbar">
        <input class="search" id="video-search" type="search" placeholder="搜索标题 / 频道（按 / 聚焦）" autocomplete="off" aria-label="搜索视频">
      </div>
      <div class="list" id="video-list" role="list"></div>
      <div class="compare-bar" id="compare-bar" hidden>
        <span class="compare-count" id="compare-count">已选 0/10</span>
        <button class="compare-clear" id="compare-clear" type="button">清空</button>
        <button class="btn primary small" id="compare-btn" type="button">生成多视频对比</button>
      </div>
    </aside>
    <main class="detail" id="detail" aria-label="视频详情"></main>
  </div>
</div>
<div class="toast-container" id="toast-container" role="status" aria-live="polite" aria-atomic="true"></div>
<script>${APP_JS}</script>
</body>
</html>`
}

function send(res, status, headers, body, options = {}) {
  try {
    res.writeHead(status, headers)
    res.end(options.head ? undefined : body)
  } catch {
    try {
      res.end()
    } catch {
      // 连接已关闭
    }
  }
}

function notFound(res, method, { json = false } = {}) {
  const head = method === 'HEAD'
  if (json) {
    send(res, 404, JSON_HEADERS, JSON.stringify({ error: 'not_found', message: '视频不在本地缓存里，或路径不存在。' }), { head })
    return
  }
  send(res, 404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, 'Not Found', { head })
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

/**
 * 创建 /tube-insight/ 的请求处理器（由 ctx.webServer.register 挂载，prefix 形式）。
 * 路由：GET/HEAD /tube-insight/、/tube-insight/api/videos、/tube-insight/api/videos/<id>；
 * 旧 /tube-insight/v/<id> 302 到单页应用 hash 路由；其余 404；非 GET/HEAD 405。
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
    const head = method === 'HEAD'

    // 单页应用壳（首页与 hash 路由都从这里进入）
    if (rest === '' || rest === '/' || rest === '/index.html') {
      return send(res, 200, HTML_HEADERS, renderShell(), { head })
    }

    // JSON API
    if (rest === '/api/videos' || rest === '/api/videos/') {
      return send(res, 200, JSON_HEADERS, JSON.stringify(buildVideosPayload()), { head })
    }
    const apiMatch = rest.match(/^\/api\/videos\/([^/]+)\/?$/)
    if (apiMatch) {
      const videoId = apiMatch[1]
      if (!VIDEO_ID_RE.test(videoId)) return notFound(res, method, { json: true })
      const payload = buildVideoPayload(videoId)
      if (!payload) return notFound(res, method, { json: true })
      return send(res, 200, JSON_HEADERS, JSON.stringify(payload), { head })
    }

    // 旧路由兼容：/v/<id> → 302 到单页应用 hash 路由
    const legacyMatch = rest.match(/^\/v\/([^/]+)\/?$/)
    if (legacyMatch) {
      const videoId = legacyMatch[1]
      if (!VIDEO_ID_RE.test(videoId)) return notFound(res, method)
      const { videos } = loadCachedVideos()
      if (!videos.some((video) => video.videoId === videoId)) return notFound(res, method)
      return send(
        res,
        302,
        { location: `${BASE}/#/v/${videoId}`, 'cache-control': 'no-store' },
        '',
        { head },
      )
    }

    return notFound(res, method)
  }
}

export { renderShell }
