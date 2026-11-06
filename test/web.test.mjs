// /tube-insight/ 视频工作台测试（0.5.0）：SPA 壳 + JSON API + 旧路由兼容 + 安全边界。
// 用临时 DSH_HOME fixture（2 个正常视频 + 1 个损坏缓存）与真实本地 http server。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearSearchCache } from '../lib/search.js'
import { BASE, buildVideoPayload, buildVideosPayload, createHandler } from '../lib/web.js'
import { makeTempDshHome, writeCacheFixture, writeRawCacheFile } from './_helpers.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ID_A = 'webtest0001'
const ID_B = 'webtest0002'
const ID_CORRUPT = 'webtest0003'

function setup(t) {
  const home = makeTempDshHome()
  clearSearchCache()
  t.after(() => home.restore())
  return home
}

async function startServer(t) {
  const server = createServer(createHandler())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  })
  return base
}

async function request(base, path, options) {
  const response = await fetch(`${base}${path}`, options)
  const text = await response.text()
  return { response, text }
}

async function requestJson(base, path, options) {
  const { response, text } = await request(base, path, options)
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { response, text, json }
}

function writeFixtures() {
  writeCacheFixture({
    videoId: ID_A,
    title: 'LLM 基础 <script>alert(1)</script>',
    channel: '频道甲 <img src=x onerror=alert(2)>',
    durationSeconds: 600,
    fetchedAt: '2026-06-01T00:00:00.000Z',
    language: 'zh-Hans',
    captionKind: 'native',
    chapters: [
      { title: 'Intro <b>bold</b>', startSeconds: 0 },
      { title: 'Training', startSeconds: 30 },
    ],
    segments: [
      { start: 0, text: 'alpha beta 介绍大语言模型 <script>alert(3)</script>' },
      { start: 30, text: 'alpha appears again in the middle' },
      { start: 60, text: '模型训练需要大量数据' },
    ],
  })
  writeCacheFixture({
    videoId: ID_B,
    title: 'Product Video',
    channel: '频道乙',
    durationSeconds: 300,
    fetchedAt: '2026-06-02T00:00:00.000Z',
    segments: [{ start: 10, text: 'alpha in product video about pricing' }],
  })
  writeRawCacheFile(`${ID_CORRUPT}.json`, '{not valid json')
}

test('SPA 壳：内联 CSS/JS、DOM 骨架、主题与动作桥契约、无外部资源', async (t) => {
  setup(t)
  writeFixtures()
  const base = await startServer(t)

  const { response, text } = await request(base, '/tube-insight/')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /text\/html/)
  assert.match(text, /<html lang="zh-CN" data-theme="light">/)
  assert.match(text, /<title>TubeInsight 视频工作台<\/title>/)
  assert.ok(text.includes('<style>') && text.includes('</style>'), '样式应内联')
  assert.ok(text.includes('<script>') && text.includes('</script>'), '脚本应内联')
  for (const id of ['video-list', 'detail', 'video-search', 'compare-bar', 'compare-count', 'compare-btn', 'refresh-btn', 'stats', 'toast-container']) {
    assert.ok(text.includes(`id="${id}"`), `缺少 DOM 骨架 #${id}`)
  }
  // 页面不再服务端渲染列表：数据走 API + 前端渲染
  assert.ok(!text.includes('LLM 基础'), 'SPA 壳不应内联视频数据')

  // 前端契约（主题 + 动作桥 + hash 路由 + 笔记）
  for (const needle of [
    'tube-insight:ready',
    'tube-insight:theme',
    'tube-insight:start-session',
    'data-theme',
    '#/v/',
    'localStorage',
    'transcript-search',
    'data-tab',
    'compare-bar',
  ]) {
    assert.ok(text.includes(needle), `前端脚本缺少契约：${needle}`)
  }

  // 无外部资源（YouTube 只是跳转链接，不是加载资源）
  assert.ok(!/<link[\s>]/i.test(text), '不应有 <link> 外部资源')
  assert.ok(!/src="https?:/i.test(text), '不应有外部 src')
  assert.ok(!/@import/i.test(text), '不应 @import 外部样式')
  assert.ok(!/url\(\s*['"]?https?:/i.test(text), '不应在 CSS 里引用外部 URL')

  // 无 innerHTML（动态文本一律 textContent/createTextNode）
  assert.ok(!text.includes('innerHTML'), '前端脚本不应使用 innerHTML')

  // 查询串多余参数忽略
  const withQuery = await request(base, '/tube-insight/?foo=bar')
  assert.equal(withQuery.response.status, 200)
  assert.match(withQuery.text, /TubeInsight 视频工作台/)

  // HEAD 不返回 body
  const head = await request(base, '/tube-insight/', { method: 'HEAD' })
  assert.equal(head.response.status, 200)
  assert.equal(head.text, '')
})

test('API：GET /api/videos 形状、倒序、统计、损坏缓存跳过', async (t) => {
  setup(t)
  writeFixtures()
  const base = await startServer(t)

  const { response, json } = await requestJson(base, '/tube-insight/api/videos')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /application\/json/)
  assert.ok(json)
  assert.equal(Array.isArray(json.videos), true)
  assert.equal(json.videos.length, 2, '损坏缓存应被跳过')
  assert.deepEqual(json.stats, { videos: 2, segments: 4, skipped: 1 })
  assert.deepEqual(json.videos.map((video) => video.videoId), [ID_B, ID_A], '按 fetchedAt 倒序')

  const first = json.videos.find((video) => video.videoId === ID_A)
  assert.equal(first.title, 'LLM 基础 <script>alert(1)</script>')
  assert.equal(first.channel, '频道甲 <img src=x onerror=alert(2)>')
  assert.equal(first.durationSeconds, 600)
  assert.equal(first.segmentCount, 3)
  assert.equal(first.language, 'zh-Hans')
  assert.equal(first.captionKind, 'native')
  assert.equal(first.fetchedAt, '2026-06-01T00:00:00.000Z')
  assert.deepEqual(first.chapters, [
    { start: 0, title: 'Intro <b>bold</b>' },
    { start: 30, title: 'Training' },
  ])

  // 直接调用 payload 构建函数时结果一致
  assert.equal(buildVideosPayload().stats.videos, 2)
})

test('API：GET /api/videos/<id> 详情形状（章节 start 字段、段落、youtubeUrl）', async (t) => {
  setup(t)
  writeFixtures()
  const base = await startServer(t)

  const { response, json } = await requestJson(base, `/tube-insight/api/videos/${ID_A}`)
  assert.equal(response.status, 200)
  assert.ok(json)
  assert.equal(json.youtubeUrl, 'https://www.youtube.com/watch?v=webtest0001')
  assert.ok(json.video)
  assert.equal(json.video.videoId, ID_A)
  assert.equal(json.video.segmentCount, 3)
  assert.deepEqual(json.video.chapters, [
    { start: 0, title: 'Intro <b>bold</b>' },
    { start: 30, title: 'Training' },
  ])
  assert.deepEqual(json.video.segments, [
    { start: 0, text: 'alpha beta 介绍大语言模型 <script>alert(3)</script>' },
    { start: 30, text: 'alpha appears again in the middle' },
    { start: 60, text: '模型训练需要大量数据' },
  ])
  assert.equal(json.video.fetchedAt, '2026-06-01T00:00:00.000Z')

  // API 是 JSON，不转义 HTML（前端用 textContent 渲染；页面侧无 innerHTML）
  const raw = buildVideoPayload(ID_A)
  assert.equal(raw.video.segments[0].text.includes('<script>'), true)

  // 非法 / 不存在 / 损坏 → 404 JSON
  for (const bad of ['invalid-id', 'aaaaaaaaaaa', ID_CORRUPT]) {
    const missing = await requestJson(base, `/tube-insight/api/videos/${bad}`)
    assert.equal(missing.response.status, 404, `${bad} 应为 404`)
    assert.equal(missing.json?.error, 'not_found')
  }
  assert.equal(buildVideoPayload('nope'), null)
})

test('旧路由兼容：/v/<id> → 302 到单页 hash 路由；未知/非法 → 404', async (t) => {
  setup(t)
  writeFixtures()
  const base = await startServer(t)

  const legacy = await fetch(`${base}/tube-insight/v/${ID_A}`, { redirect: 'manual' })
  assert.equal(legacy.status, 302)
  assert.equal(legacy.headers.get('location'), `/tube-insight/#/v/${ID_A}`)

  assert.equal((await request(base, '/tube-insight/v/aaaaaaaaaaa')).response.status, 404)
  assert.equal((await request(base, '/tube-insight/v/invalid-id')).response.status, 404)
})

test('404 / 405 / HEAD（页面与 API 一致）', async (t) => {
  setup(t)
  writeFixtures()
  const base = await startServer(t)

  assert.equal((await request(base, '/tube-insight/unknown')).response.status, 404)
  assert.equal((await request(base, '/tube-insight/api/nope')).response.status, 404)

  for (const [path, method] of [
    ['/tube-insight/', 'POST'],
    ['/tube-insight/', 'PUT'],
    [`/tube-insight/api/videos/${ID_A}`, 'DELETE'],
  ]) {
    const { response } = await request(base, path, { method })
    assert.equal(response.status, 405, `${method} ${path} 应为 405`)
    assert.match(response.headers.get('allow') || '', /GET/)
  }

  const headApi = await request(base, '/tube-insight/api/videos', { method: 'HEAD' })
  assert.equal(headApi.response.status, 200)
  assert.equal(headApi.text, '')
  assert.match(headApi.response.headers.get('content-type') || '', /application\/json/)
})

test('空缓存：API 空列表、stats 归零、页面仍可加载', async (t) => {
  setup(t)
  const base = await startServer(t)

  const { json } = await requestJson(base, '/tube-insight/api/videos')
  assert.deepEqual(json.videos, [])
  assert.deepEqual(json.stats, { videos: 0, segments: 0, skipped: 0 })

  const shell = await request(base, '/tube-insight/')
  assert.equal(shell.response.status, 200)
  assert.match(shell.text, /TubeInsight 视频工作台/)
})

test('只有损坏缓存：不崩，报告 skipped', async (t) => {
  setup(t)
  writeRawCacheFile(`${ID_CORRUPT}.json`, '{"oops":')
  const base = await startServer(t)
  const { json } = await requestJson(base, '/tube-insight/api/videos')
  assert.deepEqual(json.videos, [])
  assert.equal(json.stats.skipped, 1)
})

test('前端静态资源：app.js/app.css 契约（无外链、无 innerHTML、设计 token 与组件类）', () => {
  const js = readFileSync(join(ROOT, 'lib', 'app.js'), 'utf8')
  const css = readFileSync(join(ROOT, 'lib', 'app.css'), 'utf8')

  assert.ok(!js.includes('innerHTML'), 'app.js 不应使用 innerHTML')
  assert.ok(js.includes('textContent'), 'app.js 应使用 textContent 渲染动态文本')
  assert.ok(!/src\s*=\s*['"]https?:/.test(js), 'app.js 不应加载外部资源')
  assert.ok(!/@import/.test(css), 'app.css 不应 @import 外部样式')
  assert.ok(!/url\(\s*['"]?https?:/.test(css), 'app.css 不应引用外部 url()')

  // 设计系统 token 与组件类（共享设计系统 §0）
  const compact = css.replace(/\s+/g, '')
  for (const needle of ['--bg:#f6f4ef', '--panel:#ffffff', '--text:#1c1a17', '--accent:#e8552f', '--accent-2:#f59e0b', 'html[data-theme="dark"]', '--bg:#0d1017']) {
    assert.ok(compact.includes(needle), `app.css 缺少 token：${needle}`)
  }
  for (const cls of ['.topbar', '.toolbar', '.search', '.list', '.card', '.row', '.badge', '.btn', '.toast', '.empty', '.skeleton', '.detail', '.tabs', '.tab', '.tabpanel', '.seg']) {
    assert.ok(css.includes(cls), `app.css 缺少组件类：${cls}`)
  }
  assert.ok(/@media\s*\(max-width:\s*900px\)/.test(css), '应有移动端布局')

  // SPA 功能覆盖面（找回原扩展能力）
  for (const needle of [
    'transcript-search',
    'match-count',
    'copy-citation',
    'copy-text',
    'save-note',
    'chapter-list',
    'action-grid',
    'data-action',
    'notes-list',
    'localStorage',
    'compare-bar',
    'start-session',
    'exportTranscriptPrompt',
    'comparePrompt',
    'organizeNotesPrompt',
    'data-theme',
  ]) {
    assert.ok(js.includes(needle), `app.js 缺少功能：${needle}`)
  }
  assert.equal(BASE, '/tube-insight')
})
