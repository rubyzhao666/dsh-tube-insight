// tube_synthesis 测试：覆盖 FEATURE-SPECS-0.3.0 G1 验收标准 1–8。
// 全部用临时 DSH_HOME + fixture 缓存隔离，不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { TOOLS } from '../lib/tools.js'
import { SYNTHESIS_DEFAULTS, synthesize } from '../lib/synthesis.js'
import { localDateStamp, slugify } from '../lib/export.js'
import { clearSearchCache, searchCachedTranscripts } from '../lib/search.js'
import { formatTimestamp } from '../lib/segment.js'
import {
  assertMatchesSchema,
  makeTempDshHome,
  makeTempDir,
  writeCacheFixture,
} from './_helpers.mjs'

const synthesisTool = TOOLS.find((tool) => tool.name === 'tube_synthesis')

const ID_A = 'synthvid001'
const ID_B = 'synthvid002'
const ID_C = 'synthvid003'

function setup(t) {
  const home = makeTempDshHome()
  clearSearchCache()
  t.after(() => home.restore())
  return home
}

function segments(pairs) {
  return pairs.map(([start, text]) => ({ start, text }))
}

function assertResultShape(value) {
  assertMatchesSchema(value, synthesisTool.output.schema)
  assert.equal(value.coverage.totalHits, value.videos.reduce((sum, video) => sum + video.hits.length, 0))
  assert.equal(value.coverage.hitVideos, value.videos.length)
  for (const video of value.videos) {
    const starts = video.hits.map((hit) => hit.startSeconds)
    const sorted = [...starts].sort((a, b) => a - b)
    assert.deepEqual(starts, sorted, '组内 hits 应按 startSeconds 升序')
    for (const hit of video.hits) {
      assert.equal(hit.timestamp, formatTimestamp(hit.startSeconds))
      assert.equal(hit.link, `https://youtu.be/${video.videoId}?t=${hit.startSeconds}`)
    }
  }
}

function writeCoreFixtures() {
  writeCacheFixture({
    videoId: ID_A,
    title: 'LLM 基础',
    channel: '频道甲',
    durationSeconds: 600,
    fetchedAt: '2026-06-01T00:00:00.000Z',
    segments: segments([
      [0, 'alpha beta introduction to models'],
      [30, 'alpha appears again in the middle'],
      [60, 'beta and alpha together later'],
      [120, 'gamma unrelated content here'],
    ]),
  })
  writeCacheFixture({
    videoId: ID_B,
    title: '产品情报',
    channel: '频道乙',
    durationSeconds: 300,
    fetchedAt: '2026-06-02T00:00:00.000Z',
    segments: segments([
      [10, 'alpha in another video about products'],
      [40, 'delta only content'],
    ]),
  })
  writeCacheFixture({
    videoId: ID_C,
    title: 'Zero Hit Video',
    channel: '频道丙',
    durationSeconds: 100,
    fetchedAt: '2026-06-03T00:00:00.000Z',
    segments: segments([[0, 'nothing relevant here at all']]),
  })
}

// ---------------------------------------------------------------- 验收 1 + 3

test('验收 1：多检索词合并去重、按视频分组、组内时间升序', async (t) => {
  setup(t)
  writeCoreFixtures()

  const value = synthesize({ query: 'alpha', queries: ['beta'] })
  assertResultShape(value)

  assert.deepEqual(value.videos.map((video) => video.videoId), [ID_A, ID_B])
  assert.deepEqual(value.videos[0].hits.map((hit) => hit.startSeconds), [0, 30, 60])
  assert.deepEqual(value.videos[1].hits.map((hit) => hit.startSeconds), [10])
  assert.equal(value.coverage.totalHits, 4)
  assert.equal(value.coverage.hitVideos, 2)
  assert.deepEqual(value.coverage.zeroHitVideos.map((video) => video.videoId), [ID_C])
  assert.deepEqual(value.coverage.queriedTerms, ['alpha', 'beta'])
  assert.deepEqual(value.queries, ['beta'])
  assert.equal(value.scannedVideos, 3)
  assert.ok(value.scannedSegments >= 7)

  // (videoId, startSeconds) 去重：没有任何重复证据
  const keys = value.videos.flatMap((video) => video.hits.map((hit) => `${video.videoId}:${hit.startSeconds}`))
  assert.equal(new Set(keys).size, keys.length)

  // 链接必须直接来自 tube_search 返回（不允许重拼）
  const searchLinks = new Set()
  for (const term of ['alpha', 'beta']) {
    for (const hit of searchCachedTranscripts({ query: term, limit: 20, context: 0 }).results) {
      searchLinks.add(hit.link)
    }
  }
  for (const video of value.videos) {
    for (const hit of video.hits) assert.ok(searchLinks.has(hit.link), `底稿链接应来自 search 返回：${hit.link}`)
  }
})

test('验收 3：底稿固定结构、每条 [MM:SS] + link、未命中视频、覆盖统计', async (t) => {
  setup(t)
  writeCoreFixtures()
  const value = synthesize({ query: 'alpha', queries: ['beta'] })
  const markdown = value.markdown

  assert.ok(!markdown.startsWith('---'), 'markdown 字段是正文，不应含 frontmatter')
  assert.match(markdown, /^# 主题检索底稿：alpha$/m)
  assert.match(markdown, /^> 检索范围：本地缓存 3 个视频 \/ \d+ 个段落 · 检索词：alpha、beta$/m)
  assert.match(markdown, /^## 证据（按视频分组）$/m)
  assert.match(markdown, /^### LLM 基础 · 频道甲 · 10:00$/m)
  assert.match(markdown, /^### 产品情报 · 频道乙 · 5:00$/m)
  assert.match(markdown, /^## 未命中的缓存视频$/m)
  assert.match(markdown, /^- Zero Hit Video（频道丙）— 本主题无命中$/m)
  assert.match(markdown, /^## 检索覆盖$/m)
  assert.match(markdown, /^- 命中 2 个视频 \/ 4 条证据；扫描 3 个视频；缓存 3 个视频$/m)
  assert.match(markdown, /^## 下一步$/m)
  assert.match(markdown, /tube_export/)

  const hitLines = [...markdown.matchAll(/^- \[(\d+):(\d{2})\]\((https:\/\/youtu\.be\/([A-Za-z0-9_-]{11})\?t=(\d+))\) (.+)$/gm)]
  assert.equal(hitLines.length, 4)
  for (const [, minutes, seconds, link, videoId, linkSeconds] of hitLines) {
    const expectedSeconds = Number(minutes) * 60 + Number(seconds)
    assert.equal(Number(linkSeconds), expectedSeconds, 'link 秒数必须与 [MM:SS] 一致')
    assert.equal(link, `https://youtu.be/${videoId}?t=${linkSeconds}`)
  }
})

// ---------------------------------------------------------------- 验收 2

test('验收 2：limitPerVideo 截断与非法值报错', async (t) => {
  setup(t)
  writeCacheFixture({
    videoId: 'truncvid001',
    title: 'Many Hits',
    channel: '频道',
    segments: segments([
      [0, 'alpha item zero'],
      [10, 'alpha item one'],
      [20, 'alpha item two'],
      [30, 'alpha item three'],
      [40, 'alpha item four'],
    ]),
  })

  const limited = synthesize({ query: 'alpha', limitPerVideo: 2 })
  assertResultShape(limited)
  assert.deepEqual(limited.videos[0].hits.map((hit) => hit.startSeconds), [0, 10])

  assert.throws(() => synthesize({ query: 'alpha', limitPerVideo: 0 }), /limitPerVideo/)
  assert.throws(() => synthesize({ query: 'alpha', limitPerVideo: 9 }), /limitPerVideo/)
  assert.throws(() => synthesize({ query: 'alpha', limitPerVideo: 'x' }), /limitPerVideo/)
  assert.equal(SYNTHESIS_DEFAULTS.limitPerVideo, 4)
})

test('验收 2：maxVideos 截断与非法值报错', async (t) => {
  setup(t)
  writeCoreFixtures()

  const topOne = synthesize({ query: 'alpha', queries: ['beta'], maxVideos: 1 })
  assertResultShape(topOne)
  assert.deepEqual(topOne.videos.map((video) => video.videoId), [ID_A])
  assert.equal(topOne.coverage.hitVideos, 1)
  const topTwo = synthesize({ query: 'alpha', queries: ['beta'], maxVideos: 2 })
  assert.deepEqual(topTwo.videos.map((video) => video.videoId), [ID_A, ID_B])

  assert.throws(() => synthesize({ query: 'alpha', maxVideos: 0 }), /maxVideos/)
  assert.throws(() => synthesize({ query: 'alpha', maxVideos: 11 }), /maxVideos/)
  assert.throws(() => synthesize({ query: 'alpha', maxVideos: 'x' }), /maxVideos/)
  assert.equal(SYNTHESIS_DEFAULTS.maxVideos, 10)
})

// ---------------------------------------------------------------- 验收 4

test('验收 4：dir 落盘（frontmatter module=knowledge/sources、来源、index.md、重名序号）', async (t) => {
  setup(t)
  writeCoreFixtures()
  const out = makeTempDir()
  t.after(() => out.restore())

  const value = synthesize({ query: 'alpha', queries: ['beta'], dir: out.dir })
  assertResultShape(value)
  assert.ok(value.path && existsSync(value.path), '应写出底稿文件')
  assert.ok(value.indexpath && existsSync(value.indexpath), '应更新 index.md')
  assert.ok(value.bytes > 0)

  const expectedName = `${slugify('alpha')}_${localDateStamp()}.md`
  assert.equal(basename(value.path), expectedName, '文件名应为 <slug(query)>_<YYYY-MM-DD>.md')

  const content = readFileSync(value.path, 'utf8')
  assert.ok(content.startsWith('---\n'))
  assert.match(content, /^title: "主题综述：alpha"$/m)
  assert.match(content, /^module: "knowledge"$/m)
  assert.match(content, /^generator: "dsh-tube-insight@/m)
  assert.match(content, /^source:$/m)
  assert.match(content, /videoId: "synthvid001"/)
  assert.match(content, /videoId: "synthvid002"/)
  assert.ok(!content.includes('videoId: "synthvid003"'), '来源只应包含命中视频')
  assert.match(content, /^## 来源$/m)
  assert.match(content, /https:\/\/youtu\.be\/synthvid001\?t=0/)
  assert.match(content, /^## 检索覆盖$/m)
  assert.ok(content.includes(value.markdown.trim()), '落盘文件应包含底稿正文')

  const index = readFileSync(value.indexpath, 'utf8')
  assert.match(index, /# TubeInsight 导出索引/)
  assert.match(index, /## knowledge（知识卡片）/)
  assert.match(index, /主题综述：alpha/)

  // 重名加序号
  const again = synthesize({ query: 'alpha', queries: ['beta'], dir: out.dir })
  assert.notEqual(again.path, value.path)
  assert.equal(basename(again.path), `${slugify('alpha')}-2_${localDateStamp()}.md`)
  assert.match(readFileSync(again.indexpath, 'utf8'), /共 2 篇/)

  // title 参数只影响 frontmatter 标题，文件名仍用 query
  const titled = synthesize({ query: 'alpha', dir: out.dir, title: '自定义综述标题' })
  assert.match(readFileSync(titled.path, 'utf8'), /^title: "自定义综述标题"$/m)
  assert.ok(basename(titled.path).startsWith('alpha'))
})

// ---------------------------------------------------------------- 验收 5

test('验收 5：无命中 + dir → 报错且不落盘；无命中 + 无 dir → 正常空底稿', async (t) => {
  setup(t)
  writeCoreFixtures()
  const out = makeTempDir()
  t.after(() => out.restore())

  await assert.rejects(
    () => synthesisTool.execute({ query: 'zzzz-none', dir: out.dir }, {}),
    (error) => {
      assert.match(error.message, /无命中/)
      assert.match(error.message, /未导出/)
      assert.match(error.message, /换检索词|去掉 dir/)
      return true
    },
  )
  assert.deepEqual(readdirSync(out.dir), [], '无命中时不应落盘任何文件')

  const empty = synthesize({ query: 'zzzz-none' })
  assertResultShape(empty)
  assert.deepEqual(empty.videos, [])
  assert.equal(empty.coverage.totalHits, 0)
  assert.equal(empty.coverage.hitVideos, 0)
  assert.equal(empty.coverage.zeroHitVideos.length, 3, '无命中时 zeroHitVideos 应为全部扫描视频')
  assert.match(empty.markdown, /- （无命中）/)
  assert.match(empty.markdown, /本主题无命中/)
  assert.match(empty.markdown, /- 命中 0 个视频 \/ 0 条证据；扫描 3 个视频；缓存 3 个视频/)
})

// ---------------------------------------------------------------- 验收 6

test('验收 6：空缓存 / dir 非绝对路径 / dir 不可写 → 可操作错误', async (t) => {
  const home = setup(t)

  await assert.rejects(
    () => synthesisTool.execute({ query: 'alpha' }, {}),
    (error) => {
      assert.match(error.message, /先抓取视频/)
      assert.match(error.message, /tube_transcript/)
      return true
    },
  )

  await assert.rejects(
    () => synthesisTool.execute({ query: 'alpha', dir: './relative-out' }, {}),
    /绝对路径/,
  )

  writeCoreFixtures()
  const notADir = join(home.dir, 'not-a-dir')
  writeFileSync(notADir, 'this is a file, not a directory')
  await assert.rejects(
    () => synthesisTool.execute({ query: 'alpha', dir: notADir }, {}),
    (error) => {
      assert.match(error.message, /导出失败|写文件|dir/)
      return true
    },
  )
})

// ---------------------------------------------------------------- 验收 7

test('验收 7：相同输入重复调用输出一致（确定性）', async (t) => {
  setup(t)
  writeCoreFixtures()
  const first = synthesize({ query: 'alpha', queries: ['beta'] })
  const second = synthesize({ query: 'alpha', queries: ['beta'] })
  assert.deepEqual(second, first)

  const out = makeTempDir()
  t.after(() => out.restore())
  const writtenA = synthesize({ query: 'alpha', queries: ['beta'], dir: out.dir })
  const writtenB = synthesize({ query: 'alpha', queries: ['beta'], dir: out.dir })
  assert.equal(writtenB.markdown, writtenA.markdown)
  assert.deepEqual(writtenB.videos, writtenA.videos)
  assert.deepEqual(writtenB.coverage, writtenA.coverage)
  assert.equal(writtenB.query, writtenA.query)
  assert.equal(writtenB.queries.join('|'), writtenA.queries.join('|'))
})

// ---------------------------------------------------------------- 验收 8 + 过滤

test('验收 8：现有工具仍注册（tube_transcript / tube_search / tube_export 不回归）', () => {
  const names = TOOLS.map((tool) => tool.name)
  for (const name of ['tube_transcript', 'tube_search', 'tube_export']) assert.ok(names.includes(name))
  for (const tool of TOOLS) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
})

test('过滤：video 限定单视频；since 按 fetchedAt 过滤；queries 大小写去重', async (t) => {
  setup(t)
  writeCoreFixtures()

  const single = synthesize({ query: 'alpha', video: `https://youtu.be/${ID_B}` })
  assertResultShape(single)
  assert.equal(single.scannedVideos, 1)
  assert.deepEqual(single.videos.map((video) => video.videoId), [ID_B])
  assert.deepEqual(single.coverage.zeroHitVideos, [])

  const filtered = synthesize({ query: 'alpha', since: '2026-06-02' })
  assert.equal(filtered.scannedVideos, 2)
  assert.deepEqual(filtered.videos.map((video) => video.videoId), [ID_B])
  assert.deepEqual(filtered.coverage.zeroHitVideos.map((video) => video.videoId), [ID_C])

  const deduped = synthesize({ query: 'Alpha', queries: ['alpha', 'beta', 'BETA'] })
  assert.deepEqual(deduped.queries, ['beta'])
  assert.deepEqual(deduped.coverage.queriedTerms, ['Alpha', 'beta'])

  assert.throws(() => synthesize({ query: 'alpha', video: 'missingvid1' }), /不在本地缓存/)
})

test('参数校验：query/queries 非法值报错', async (t) => {
  setup(t)
  writeCoreFixtures()

  assert.throws(() => synthesize({ query: '' }), /不能为空/)
  assert.throws(() => synthesize({ query: '   ' }), /不能为空/)
  assert.throws(() => synthesize({ query: 'x'.repeat(201) }), /过长/)
  assert.throws(() => synthesize({ query: 123 }), /必须是字符串/)
  assert.throws(() => synthesize({ query: 'alpha', queries: 'beta' }), /queries 必须是字符串数组/)
  assert.throws(() => synthesize({ query: 'alpha', queries: Array.from({ length: 7 }, () => 'x') }), /最多 6 个/)
  assert.throws(() => synthesize({ query: 'alpha', queries: [''] }), /不能为空/)
  assert.throws(() => synthesize({ query: 'alpha', queries: [123] }), /必须是字符串/)
  await assert.rejects(() => synthesisTool.execute({}, {}), /必须是字符串/)
})

test('工具 execute + render：返回底稿正文、落盘信息与 tube_export 提示', async (t) => {
  setup(t)
  writeCoreFixtures()
  const out = makeTempDir()
  t.after(() => out.restore())

  const fromTool = await synthesisTool.execute({ query: 'alpha', queries: ['beta'], dir: out.dir }, {})
  assertMatchesSchema(fromTool, synthesisTool.output.schema)

  const render = synthesisTool.output.render({ query: 'alpha' }, fromTool)
  assert.match(render[0].text, /TubeInsight 主题检索底稿/)
  assert.match(render[0].text, /主题检索底稿：alpha/)
  assert.match(render[0].text, /底稿正文开始/)
  assert.match(render[0].text, /\[0:00\]\(https:\/\/youtu\.be\/synthvid001\?t=0\)/)
  assert.match(render[0].text, /已落盘：/)
  assert.match(render[0].text, /tube_export/)
})
