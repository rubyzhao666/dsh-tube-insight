// tube_search 跨视频检索测试：覆盖 FEATURE-SPECS-0.2.0 F1 验收标准 1–8。
// 全部用临时 DSH_HOME + fixture 缓存隔离，不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TOOLS } from '../lib/tools.js'
import {
  clearSearchCache,
  countDocumentTokens,
  searchCachedTranscripts,
  tokenizeQuery,
} from '../lib/search.js'
import { cacheDir } from '../lib/paths.js'
import { formatTimestamp } from '../lib/segment.js'
import {
  assertMatchesSchema,
  makeTempDshHome,
  writeCacheFixture,
  writeRawCacheFile,
} from './_helpers.mjs'

const searchTool = TOOLS.find((tool) => tool.name === 'tube_search')
const ORIGINAL_DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

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
  assertMatchesSchema(value, searchTool.output.schema)
  assert.equal(value.resultCount, value.results.length)
  for (const result of value.results) {
    assert.equal(result.timestamp, formatTimestamp(result.startSeconds))
    assert.equal(result.link, `https://youtu.be/${result.videoId}?t=${result.startSeconds}`)
    assert.equal(result.url, `https://www.youtube.com/watch?v=${result.videoId}`)
    assert.ok(result.text.length <= 400, `text 应 ≤400 字符，实际 ${result.text.length}`)
    if (result.before) assert.ok(result.before.length <= 200)
    if (result.after) assert.ok(result.after.length <= 200)
    assert.ok(result.score > 0)
    assert.ok(Array.isArray(result.matchedTerms) && result.matchedTerms.length > 0)
  }
}

// ---------------------------------------------------------------- 分词

test('分词：英文/数字按词、CJK bigram、单字、停用词', () => {
  assert.deepEqual(tokenizeQuery('Large Language Models'), ['large', 'language', 'models'])
  assert.deepEqual(tokenizeQuery('the model and the data'), ['model', 'data'])
  assert.deepEqual(tokenizeQuery('大语言模型'), ['大语', '语言', '言模', '模型'])
  assert.deepEqual(tokenizeQuery('猫'), ['猫'])
  assert.deepEqual(tokenizeQuery('模型 training'), ['模型', 'training'])
  assert.deepEqual(tokenizeQuery('的'), [])
  assert.deepEqual(tokenizeQuery('GPT-4 vs 模型'), ['gpt', '4', 'vs', '模型'])
  assert.deepEqual(tokenizeQuery('大语言模型 训练'), ['大语', '语言', '言模', '模型', '训练'])
  assert.deepEqual(tokenizeQuery('  '), [])

  assert.equal(countDocumentTokens('hello world test'), 3)
  assert.equal(countDocumentTokens('大语言模型'), 4) // 5 字 -> 4 个 bigram
  assert.equal(countDocumentTokens('猫'), 1)
  assert.equal(countDocumentTokens('hello 大语言模型'), 5)
  assert.equal(countDocumentTokens(''), 0)
})

// ---------------------------------------------------------------- 验收 1

test('验收 1：缓存为空 → 可操作错误（提示先抓取视频 + 指出 tube_transcript）', async (t) => {
  setup(t)
  await assert.rejects(
    () => searchTool.execute({ query: '模型' }, {}),
    (error) => {
      assert.match(error.message, /先抓取视频/)
      assert.match(error.message, /tube_transcript/)
      assert.match(error.message, /不是全网搜索/)
      return true
    },
  )
  assert.throws(() => searchCachedTranscripts({ query: 'model' }), /先抓取视频/)
})

// ---------------------------------------------------------------- 验收 2

test('验收 2：中英各一 + 损坏缓存；中文查询命中中文、英文查询命中英文、坏文件不影响', async (t) => {
  setup(t)
  const zhId = 'zhvideo0001'
  const enId = 'envideo0001'
  writeCacheFixture({
    videoId: zhId,
    title: '中文视频',
    channel: '中文频道',
    segments: segments([
      [0, '今天我们来聊聊大语言模型的训练过程。'],
      [30, '模型训练需要大量数据和算力，这部分很关键。'],
      [90, '最后我们看一下模型的推理和部署。'],
    ]),
  })
  writeCacheFixture({
    videoId: enId,
    title: 'English Video',
    channel: 'English Channel',
    segments: segments([
      [10, 'In this video we cover the language model and how training works.'],
      [60, 'Training a language model needs a lot of data and compute.'],
    ]),
  })
  writeRawCacheFile('broken00001.json', '{not valid json')
  writeRawCacheFile('broken00002.json', JSON.stringify({ version: 1, videoId: 'broken00002', segments: 'oops' }))

  const chinese = searchCachedTranscripts({ query: '大语言模型', limit: 8 })
  assertResultShape(chinese)
  assert.ok(chinese.resultCount >= 1, '中文查询应命中中文视频')
  assert.ok(chinese.results.every((result) => result.videoId === zhId))
  assert.equal(chinese.scannedVideos, 2, '损坏缓存不计入可扫描视频')
  assert.equal(chinese.skippedCacheFiles, 2, '应统计跳过的损坏缓存数')

  const english = searchCachedTranscripts({ query: 'language model', limit: 8 })
  assertResultShape(english)
  assert.ok(english.resultCount >= 1, '英文查询应命中英文视频')
  assert.ok(english.results.every((result) => result.videoId === enId))

  const merged = searchCachedTranscripts({ query: 'training', limit: 8 })
  assert.ok(merged.resultCount >= 1)
  assert.ok(merged.results.some((result) => result.videoId === enId))
})

test('验收 2 补充：缓存全是坏文件 → 明确报错而不是静默', async (t) => {
  setup(t)
  writeRawCacheFile('badcv000001.json', 'not json at all')
  writeRawCacheFile('badcv000002.json', JSON.stringify({ version: 1, segments: [] }))
  assert.throws(
    () => searchCachedTranscripts({ query: 'model' }),
    (error) => {
      assert.match(error.message, /损坏|没有可用/)
      assert.match(error.message, /tube_transcript/)
      return true
    },
  )
})

// ---------------------------------------------------------------- 验收 3

test('验收 3：video 限定只搜该视频；不存在/无法解析 → 可操作错误', async (t) => {
  setup(t)
  const idA = 'filtervid01'
  const idB = 'filtervid02'
  writeCacheFixture({
    videoId: idA,
    title: 'A',
    segments: segments([[0, 'machine learning is fun and useful']]),
  })
  writeCacheFixture({
    videoId: idB,
    title: 'B',
    segments: segments([[0, 'machine learning is also fun here']]),
  })

  const all = searchCachedTranscripts({ query: 'learning', limit: 8 })
  assert.equal(all.matchedVideos, 2)

  const onlyA = searchCachedTranscripts({ query: 'learning', video: idA, limit: 8 })
  assertResultShape(onlyA)
  assert.equal(onlyA.scannedVideos, 1)
  assert.ok(onlyA.results.length >= 1)
  assert.ok(onlyA.results.every((result) => result.videoId === idA))

  const byUrl = searchCachedTranscripts({ query: 'learning', video: `https://youtu.be/${idB}?t=10`, limit: 8 })
  assert.ok(byUrl.results.every((result) => result.videoId === idB))

  assert.throws(
    () => searchCachedTranscripts({ query: 'learning', video: 'missingvid1' }),
    (error) => {
      assert.match(error.message, /不在本地缓存/)
      assert.match(error.message, /先抓取视频/)
      assert.match(error.message, /tube_transcript/)
      return true
    },
  )
  assert.throws(() => searchCachedTranscripts({ query: 'learning', video: 'nope' }), /只支持 YouTube/)
})

// ---------------------------------------------------------------- 验收 4

test('验收 4：since 过滤掉旧视频；fetchedAt 缺失视为不过滤', async (t) => {
  setup(t)
  writeCacheFixture({
    videoId: 'oldvideo001',
    fetchedAt: '2020-01-01T00:00:00.000Z',
    segments: segments([[0, 'neural network basics from long ago']]),
  })
  writeCacheFixture({
    videoId: 'newvideo001',
    fetchedAt: '2026-06-01T00:00:00.000Z',
    segments: segments([[0, 'neural network modern advances']]),
  })
  writeCacheFixture({
    videoId: 'nodate00001',
    fetchedAt: '',
    segments: segments([[0, 'neural network without fetched time']]),
  })

  const filtered = searchCachedTranscripts({ query: 'neural network', since: '2025-01-01', limit: 8 })
  assertResultShape(filtered)
  const ids = new Set(filtered.results.map((result) => result.videoId))
  assert.ok(!ids.has('oldvideo001'), '旧视频应被 since 排除')
  assert.ok(ids.has('newvideo001'))
  // fetchedAt 缺失的缓存不参与过滤
  assert.ok(filtered.scannedVideos === 2)

  assert.throws(() => searchCachedTranscripts({ query: 'x', since: '2026-13-01' }), /since/)
  assert.throws(() => searchCachedTranscripts({ query: 'x', since: 'yesterday' }), /since/)
})

// ---------------------------------------------------------------- 验收 5

test('验收 5：limit 截断（>20 按 20）与非法值报错', async (t) => {
  setup(t)
  const id = 'limitvid001'
  writeCacheFixture({
    videoId: id,
    segments: Array.from({ length: 30 }, (_unused, index) => ({ start: index * 10, text: `topic number ${index}` })),
  })

  const clamped = searchCachedTranscripts({ query: 'topic', limit: 50 })
  assertResultShape(clamped)
  assert.equal(clamped.resultCount, 20, 'limit 传 50 应按 20 截断')

  const two = searchCachedTranscripts({ query: 'topic', limit: 2 })
  assert.equal(two.resultCount, 2)

  const three = searchCachedTranscripts({ query: 'topic', limit: 3.7 })
  assert.equal(three.resultCount, 3, '小数 limit 向下取整')

  assert.throws(() => searchCachedTranscripts({ query: 'topic', limit: 0 }), /limit/)
  assert.throws(() => searchCachedTranscripts({ query: 'topic', limit: -1 }), /limit/)
  assert.throws(() => searchCachedTranscripts({ query: 'topic', limit: 'abc' }), /limit/)
})

// ---------------------------------------------------------------- 验收 6

test('验收 6：context=0 无前后文；context=2 前后各 2 段且长度受限', async (t) => {
  setup(t)
  writeCacheFixture({
    videoId: 'contextvid1',
    segments: segments([
      [0, 'intro paragraph about nothing much'],
      [30, 'context before the target sentence'],
      [60, 'here we mention needle in the middle'],
      [90, 'context after one sentence'],
      [120, 'context after two sentence'],
    ]),
  })

  const none = searchCachedTranscripts({ query: 'needle', context: 0 })
  assertResultShape(none)
  assert.equal(none.resultCount, 1)
  assert.equal('before' in none.results[0], false, 'context=0 不应有 before')
  assert.equal('after' in none.results[0], false, 'context=0 不应有 after')

  const one = searchCachedTranscripts({ query: 'needle', context: 1 })
  assert.equal(one.results[0].before, 'context before the target sentence')
  assert.equal(one.results[0].after, 'context after one sentence')

  const two = searchCachedTranscripts({ query: 'needle', context: 2 })
  assertResultShape(two)
  assert.match(two.results[0].before, /intro paragraph/)
  assert.match(two.results[0].before, /context before/)
  assert.match(two.results[0].after, /context after one/)
  assert.match(two.results[0].after, /context after two/)
  assert.ok(two.results[0].before.length <= 200)
  assert.ok(two.results[0].after.length <= 200)

  assert.throws(() => searchCachedTranscripts({ query: 'needle', context: -1 }), /context/)
  assert.throws(() => searchCachedTranscripts({ query: 'needle', context: 'big' }), /context/)
})

// ---------------------------------------------------------------- 验收 7

test('验收 7：link/timestamp/startSeconds 完全一致（含跨分钟与小数秒）', async (t) => {
  setup(t)
  writeCacheFixture({
    videoId: 'linktest001',
    segments: segments([
      [754.9, 'deep learning breakthrough moment'],
      [65.2, 'deep learning basics at one minute'],
    ]),
  })
  const value = searchCachedTranscripts({ query: 'deep learning', limit: 8, context: 0 })
  assertResultShape(value)
  assert.equal(value.resultCount, 2)
  const byStart = new Map(value.results.map((result) => [result.startSeconds, result]))
  const first = byStart.get(754)
  assert.ok(first, '754.9 应取整为 754')
  assert.equal(first.timestamp, '12:34')
  assert.equal(first.link, 'https://youtu.be/linktest001?t=754')
  const second = byStart.get(65)
  assert.equal(second.timestamp, '1:05')
  assert.equal(second.link, 'https://youtu.be/linktest001?t=65')
})

// ---------------------------------------------------------------- 排序

test('排序：BM25 词频高者在前', async (t) => {
  setup(t)
  writeCacheFixture({
    videoId: 'bm25vid0001',
    segments: segments([
      [0, 'model model model appears here'],
      [60, 'model appears once'],
    ]),
  })
  const value = searchCachedTranscripts({ query: 'model', context: 0 })
  assert.equal(value.resultCount, 2)
  assert.equal(value.results[0].startSeconds, 0)
  assert.ok(value.results[0].score > value.results[1].score, '词频高的段落 BM25 分数应更高')
})

test('排序：连续短语 ×1.8 加成（同等词频时短语命中排前）', async (t) => {
  setup(t)
  writeCacheFixture({
    videoId: 'phrasevid01',
    segments: segments([[0, 'the large language model is a breakthrough']]),
  })
  writeCacheFixture({
    videoId: 'phrasevid02',
    segments: segments([[0, 'language is large and the model is small']]),
  })
  const value = searchCachedTranscripts({ query: 'large language model', context: 0, limit: 5 })
  assert.equal(value.resultCount, 2)
  assert.equal(value.results[0].videoId, 'phrasevid01', '连续短语命中的视频应排第一')
  assert.ok(value.results[0].score > value.results[1].score, 'phrase 命中应有 ×1.8 加成')
  assert.deepEqual([...value.results[0].matchedTerms].sort(), ['language', 'large', 'model'])
})

// ---------------------------------------------------------------- 健壮性 / 截断

test('mtime 缓存：缓存文件内容变化后能重新解析', async (t) => {
  setup(t)
  writeCacheFixture({ videoId: 'mtimevid001', segments: segments([[0, 'alpha only words here']]) })
  const before = searchCachedTranscripts({ query: 'beta' })
  assert.equal(before.resultCount, 0)

  // 内容长度变化，确保 mtime/size 检测触发重新解析
  writeCacheFixture({ videoId: 'mtimevid001', segments: segments([[0, 'beta appears now and the text is longer']]) })
  const after = searchCachedTranscripts({ query: 'beta' })
  assert.equal(after.resultCount, 1)
  assert.match(after.results[0].text, /beta/)
})

test('健壮性：>500 条缓存时只扫最近 500 条（按 fetchedAt）并返回 truncated', async (t) => {
  setup(t)
  const total = 505
  const baseMs = Date.UTC(2026, 0, 1)
  for (let index = 0; index < total; index += 1) {
    const videoId = String(index).padStart(11, '0')
    writeCacheFixture({
      videoId,
      fetchedAt: new Date(baseMs + index * 86_400_000).toISOString(),
      segments: segments([[0, `marker${index} unique token here`]]),
    })
  }

  const oldest = searchCachedTranscripts({ query: 'marker0' })
  assert.equal(oldest.truncated, true, '超过 500 条应标记 truncated')
  assert.equal(oldest.scannedVideos, 500, '只扫最近 500 条')
  assert.equal(oldest.resultCount, 0, '最旧的（被截断的）视频不应命中')

  const newest = searchCachedTranscripts({ query: 'marker504' })
  assert.equal(newest.truncated, true)
  assert.equal(newest.scannedVideos, 500)
  assert.ok(newest.resultCount >= 1)
  assert.equal(newest.results[0].videoId, String(504).padStart(11, '0'))

  const render = searchTool.output.render({ query: 'marker504' }, newest)
  assert.match(render[0].text, /500/)
})

test('无命中 → 空结果 + 渲染提示换关键词', async (t) => {
  setup(t)
  writeCacheFixture({ videoId: 'nomatchvid1', segments: segments([[0, 'alpha beta gamma']]) })
  const value = await searchTool.execute({ query: 'zebra' }, {})
  assertResultShape(value)
  assert.equal(value.resultCount, 0)
  assert.equal(value.matchedVideos, 0)
  const render = searchTool.output.render({ query: 'zebra' }, value)
  assert.match(render[0].text, /没有命中/)
  assert.match(render[0].text, /tube_export/)
  assert.match(render[0].text, /read/)
})

test('query 参数校验：空/超长/非字符串', async (t) => {
  setup(t)
  writeCacheFixture({ videoId: 'qvalid00001', segments: segments([[0, 'some content']]) })
  assert.throws(() => searchCachedTranscripts({ query: '' }), /不能为空/)
  assert.throws(() => searchCachedTranscripts({ query: '   ' }), /不能为空/)
  assert.throws(() => searchCachedTranscripts({ query: 'x'.repeat(201) }), /过长/)
  assert.throws(() => searchCachedTranscripts({ query: 123 }), /必须是字符串/)
  await assert.rejects(() => searchTool.execute({}, {}), /必须是字符串/)
})

// ---------------------------------------------------------------- 性能目标

test('性能：100 视频 / 5 万段落单次检索 < 2s（首次含 JSON 解析，二跑命中 mtime 缓存）', async (t) => {
  setup(t)
  const videos = 100
  const perVideo = 500
  for (let videoIndex = 0; videoIndex < videos; videoIndex += 1) {
    const videoId = `perf${String(videoIndex).padStart(7, '0')}`
    const segments = []
    for (let segmentIndex = 0; segmentIndex < perVideo; segmentIndex += 1) {
      segments.push({
        start: segmentIndex * 12,
        text: `Segment ${segmentIndex} of video ${videoIndex} discusses language model training data and evaluation methods.`,
      })
    }
    writeCacheFixture({ videoId, segments })
  }

  const startedAt = Date.now()
  const first = searchCachedTranscripts({ query: 'language model training', limit: 8 })
  const firstWallMs = Date.now() - startedAt
  assert.equal(first.scannedVideos, videos)
  assert.equal(first.scannedSegments, videos * perVideo)
  assert.equal(first.resultCount, 8)
  assert.ok(firstWallMs < 2000, `100 视频/5 万段首次检索应 <2s，实际 ${firstWallMs}ms`)
  assert.ok(first.elapsedMs < 2000)

  const secondStartedAt = Date.now()
  const second = searchCachedTranscripts({ query: 'language model training', limit: 8 })
  const secondWallMs = Date.now() - secondStartedAt
  assert.equal(second.scannedVideos, videos)
  assert.ok(secondWallMs < 2000, `二次检索应 <2s，实际 ${secondWallMs}ms`)
})

// ---------------------------------------------------------------- 验收 8（真实缓存）

test('验收 8：本机真实缓存检索（无真实缓存时跳过）', async (t) => {
  const realCacheDir = join(ORIGINAL_DSH_HOME, 'tube-insight', 'cache')
  const realFiles = existsSync(realCacheDir) ? readdirSync(realCacheDir).filter((name) => name.endsWith('.json')) : []
  if (realFiles.length === 0) {
    t.skip('本机 $DSH_HOME/tube-insight/cache 没有真实缓存，跳过验收 8')
    return
  }

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = ORIGINAL_DSH_HOME
  clearSearchCache()
  try {
    for (const query of ['large language model', 'neural', '模型']) {
      const value = searchCachedTranscripts({ query, limit: 5, context: 1 })
      assertMatchesSchema(value, searchTool.output.schema)
      assert.ok(value.scannedVideos >= 1, `真实缓存应至少扫到 1 个视频（query=${query}）`)
      for (const result of value.results) {
        assert.equal(result.timestamp, formatTimestamp(result.startSeconds))
        assert.equal(result.link, `https://youtu.be/${result.videoId}?t=${result.startSeconds}`)
      }
    }
    const llm = searchCachedTranscripts({ query: 'large language model', limit: 5 })
    assert.ok(llm.resultCount > 0, '真实缓存里应能检索到 large language model 相关内容')
    assert.ok(llm.results.some((result) => /language model/i.test(result.text)))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    clearSearchCache()
  }
})

// ---------------------------------------------------------------- 数据目录

test('只读缓存：检索不写任何文件、不新增数据目录', async (t) => {
  setup(t)
  writeCacheFixture({ videoId: 'readonly001', segments: segments([[0, 'read only content here']]) })
  const before = readdirSync(cacheDir()).sort()
  searchCachedTranscripts({ query: 'read only' })
  const after = readdirSync(cacheDir()).sort()
  assert.deepEqual(after, before)
})
