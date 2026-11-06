// /tube-insight/ 只读页面测试（H1）：真实本地 http server + 临时 DSH_HOME fixture。
// 覆盖：首页/搜索结果/转录页 HTML 契约、XSS 转义、404/405/HEAD、损坏缓存跳过、空缓存引导、
// 检索 limit 20、单页 ≤2MB 截断。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { clearSearchCache } from '../lib/search.js'
import { createHandler } from '../lib/web.js'
import { makeTempDshHome, writeCacheFixture, writeRawCacheFile } from './_helpers.mjs'

const ID_A = 'webtest0001'
const ID_B = 'webtest0002'
const ID_CORRUPT = 'webtest0003'
const MAX_PAGE_BYTES = 2 * 1024 * 1024

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

function writeFixtures() {
  writeCacheFixture({
    videoId: ID_A,
    title: 'LLM 基础 <script>alert(1)</script>',
    channel: '频道甲 <img src=x onerror=alert(2)>',
    durationSeconds: 600,
    fetchedAt: '2026-06-01T00:00:00.000Z',
    language: 'zh-Hans',
    captionKind: 'native',
    source: 'innertube-ios',
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

test('首页：HTML 契约、统计、按抓取时间排序、XSS 转义、无外部资源', async (t) => {
  setup(t)
  writeFixtures()
  const base = await startServer(t)

  const { response, text } = await request(base, '/tube-insight/')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /text\/html/)
  assert.match(text, /<title>TubeInsight 视频库<\/title>/)
  assert.match(text, /id="ti-search"/)
  assert.match(text, /method="get"/)
  assert.match(text, /class="ti-stat"/)
  assert.match(text, /缓存 <strong>2<\/strong> 个视频/)
  assert.match(text, /共 <strong>4<\/strong> 个段落/)
  assert.match(text, /损坏缓存/)

  // 视频行：2 条正常视频（损坏缓存跳过），按 fetchedAt 降序（B 比 A 新）
  const rows = text.match(/class="ti-video-row"/g) || []
  assert.equal(rows.length, 2)
  assert.match(text, new RegExp(`data-video-id="${ID_A}"`))
  assert.match(text, new RegExp(`data-video-id="${ID_B}"`))
  assert.ok(text.indexOf(ID_B) < text.indexOf(ID_A), '视频列表应按 fetchedAt 降序')
  assert.match(text, new RegExp(`href="/tube-insight/v/${ID_A}"`))

  // XSS：缓存的标题/频道/段落里的标签必须被转义
  assert.ok(!/<script[\s>]/i.test(text), '页面不应出现未转义的 <script>')
  assert.ok(!/<img[\s>]/i.test(text), '页面不应出现未转义的 <img>')
  assert.ok(!text.includes('<script>alert'), '缓存的 <script> 必须被转义')
  assert.ok(text.includes('&lt;script&gt;alert'), '标题/段落里的 <script> 应显示为 &lt;script&gt;')
  assert.ok(text.includes('&lt;img src=x'), '频道里的 <img> 应显示为 &lt;img')

  // 无外部资源（YouTube 只是跳转链接，不加载资源）
  assert.ok(!/<link[\s>]/i.test(text), '不应有外部 <link> 资源')
  assert.ok(!/<iframe[\s>]/i.test(text), '页面不应内嵌 iframe')
  assert.ok(!/src="https?:\/\//i.test(text), '页面不应加载外部资源')

  // /tube-insight（无尾斜杠）同样可用
  const bare = await request(base, '/tube-insight')
  assert.equal(bare.response.status, 200)
  assert.match(bare.text, /TubeInsight 视频库/)
})

test('搜索：?q= 结果契约、[MM:SS]、#t= 与 youtu.be 链接、命中统计、多余参数忽略', async (t) => {
  setup(t)
  writeFixtures()
  const base = await startServer(t)

  const { response, text } = await request(base, '/tube-insight/?q=alpha&foo=bar')
  assert.equal(response.status, 200)
  const results = text.match(/class="ti-result"/g) || []
  assert.equal(results.length, 3, 'alpha 应命中 3 条（视频 A 两条 + 视频 B 一条）')
  assert.match(text, /data-video-id="webtest0001" data-start="0"/)
  assert.match(text, /data-video-id="webtest0001" data-start="30"/)
  assert.match(text, /data-video-id="webtest0002" data-start="10"/)
  assert.match(text, /\[0:00\]/)
  assert.match(text, /\[0:30\]/)
  assert.match(text, new RegExp(`href="/tube-insight/v/${ID_A}#t=0"`))
  assert.match(text, new RegExp(`href="https://youtu\\.be/${ID_A}\\?t=0"`))
  assert.match(text, /命中 <strong>3<\/strong> 条/)
  assert.match(text, /扫描 <strong>2<\/strong> 个视频/)

  // 中文查询命中中文段落（bigram 搜索：「模型训练」也会命中「大语言模型」段落，共 2 条）
  const chinese = await request(base, `/tube-insight/?q=${encodeURIComponent('模型训练')}`)
  assert.equal(chinese.response.status, 200)
  const chineseResults = (chinese.text.match(/class="ti-result"/g) || []).length
  assert.ok(chineseResults >= 1, '中文查询应有命中')
  assert.match(chinese.text, /data-start="60"/)
  const chineseStarts = [...chinese.text.matchAll(/<article class="ti-result"[^>]*data-start="(\d+)"/g)].map((m) => m[1])
  assert.equal(chineseStarts[0], '60', '包含完整「模型训练」的段落应排在最前面')

  // 无命中：明确提示 + 清除检索入口
  const none = await request(base, '/tube-insight/?q=zzzznohit')
  assert.equal(none.response.status, 200)
  assert.match(none.text, /没有命中/)
  assert.match(none.text, /命中 <strong>0<\/strong> 条/)

  // query 回显必须转义（不能原样输出 <script>）
  const xss = await request(base, `/tube-insight/?q=${encodeURIComponent('<script>alert(9)</script>')}`)
  assert.equal(xss.response.status, 200)
  assert.ok(!xss.text.includes('<script>alert'), 'query 回显必须转义')
  assert.ok(!/<script[\s>]/i.test(xss.text))
})

test('转录页：元数据、章节、完整转录、[MM:SS] 链接、锚点与转义', async (t) => {
  setup(t)
  writeFixtures()
  const base = await startServer(t)

  const { response, text } = await request(base, `/tube-insight/v/${ID_A}`)
  assert.equal(response.status, 200)
  assert.match(text, /class="ti-back"/)
  assert.match(text, /class="ti-title"/)
  assert.match(text, /class="ti-time"/)
  assert.match(text, /章节（2）/)
  assert.match(text, /#t=30/)
  assert.match(text, /zh-Hans/)
  assert.match(text, /原生/)
  assert.ok(text.includes(`${ID_A}`) && /youtu\.be\/webtest0001\?t=0/.test(text), '应有 YouTube 打开按钮')

  const segments = text.match(/class="ti-segment"/g) || []
  assert.equal(segments.length, 3, '.ti-segment 数量应等于段落数')
  assert.match(text, /class="ti-segment" id="t=0" data-start="0"/)
  assert.match(text, /class="ti-segment" id="t=60" data-start="60"/)
  assert.match(text, /\[0:00\]/)
  assert.match(text, /\[1:00\]/)
  assert.match(text, /https:\/\/youtu\.be\/webtest0001\?t=60/)

  // 段落与标题里的标签必须转义
  assert.ok(!text.includes('<script>alert'), '转录页不应出现未转义 <script>')
  assert.ok(text.includes('&lt;script&gt;alert'))
  assert.ok(text.includes('&lt;b&gt;bold&lt;/b&gt;'), '章节标题里的 <b> 应被转义')
  assert.ok(!/<script[\s>]/i.test(text))
})

test('404 / 405 / HEAD / 损坏缓存', async (t) => {
  setup(t)
  writeFixtures()
  const base = await startServer(t)

  assert.equal((await request(base, `/tube-insight/v/aaaaaaaaaaa`)).response.status, 404, '未缓存的合法 id → 404')
  assert.equal((await request(base, `/tube-insight/v/invalid-id`)).response.status, 404, '非法 id → 404')
  assert.equal((await request(base, `/tube-insight/v/${ID_CORRUPT}`)).response.status, 404, '损坏缓存 → 404')
  assert.equal((await request(base, '/tube-insight/unknown')).response.status, 404)
  assert.equal((await request(base, '/tube-insight/v/webtest00001/extra')).response.status, 404)

  const post = await request(base, '/tube-insight/', { method: 'POST' })
  assert.equal(post.response.status, 405)
  assert.match(post.response.headers.get('allow') || '', /GET/)
  assert.match(post.text, /只读/)

  const put = await request(base, `/tube-insight/v/${ID_A}`, { method: 'PUT' })
  assert.equal(put.response.status, 405)
  const del = await request(base, '/tube-insight/', { method: 'DELETE' })
  assert.equal(del.response.status, 405)

  const head = await request(base, '/tube-insight/', { method: 'HEAD' })
  assert.equal(head.response.status, 200)
  assert.equal(head.text, '', 'HEAD 不应返回 body')
  assert.match(head.response.headers.get('content-type') || '', /text\/html/)
})

test('空缓存：首页给出引导（抓取后刷新）', async (t) => {
  setup(t)
  const base = await startServer(t)

  const { response, text } = await request(base, '/tube-insight/')
  assert.equal(response.status, 200)
  assert.match(text, /本地还没有缓存的视频转录/)
  assert.match(text, /tube_transcript/)
  assert.equal((text.match(/class="ti-video-row"/g) || []).length, 0)
  assert.match(text, /id="ti-search"/)

  const withQuery = await request(base, '/tube-insight/?q=alpha')
  assert.equal(withQuery.response.status, 200)
  assert.match(withQuery.text, /本地还没有缓存的视频转录/)
})

test('只有损坏缓存时：首页不崩、显示引导并提示跳过的损坏缓存', async (t) => {
  setup(t)
  writeRawCacheFile(`${ID_CORRUPT}.json`, '{"oops":')
  const base = await startServer(t)
  const { response, text } = await request(base, '/tube-insight/')
  assert.equal(response.status, 200)
  assert.match(text, /本地还没有缓存的视频转录/)
  assert.match(text, /跳过 1 个损坏缓存/)
})

test('检索结果受 limit 20 限制', async (t) => {
  setup(t)
  writeCacheFixture({
    videoId: 'webtest0010',
    title: 'Many Hits',
    segments: Array.from({ length: 30 }, (_unused, index) => ({ start: index * 5, text: `topic item ${index}` })),
  })
  const base = await startServer(t)
  const { response, text } = await request(base, '/tube-insight/?q=topic')
  assert.equal(response.status, 200)
  assert.equal((text.match(/class="ti-result"/g) || []).length, 20, '检索结果最多 20 条')
  assert.match(text, /命中 <strong>20<\/strong> 条/)
})

test('超长转录：单页 HTML ≤2MB 并截断说明', async (t) => {
  setup(t)
  const chunk = 'x'.repeat(600)
  writeCacheFixture({
    videoId: 'webhuge0001',
    title: 'Huge Transcript',
    segments: Array.from({ length: 5000 }, (_unused, index) => ({ start: index * 2, text: chunk })),
  })
  const base = await startServer(t)
  const { response, text } = await request(base, '/tube-insight/v/webhuge0001')
  assert.equal(response.status, 200)
  const bytes = Buffer.byteLength(text, 'utf8')
  assert.ok(bytes <= MAX_PAGE_BYTES, `单页应 ≤2MB，实际 ${bytes} bytes`)
  assert.match(text, /本页已截断显示前 \d+ \/ 5000 段/)
  assert.match(text, /class="ti-segment"/)
})
