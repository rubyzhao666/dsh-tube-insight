// 工具端到端测试：用假 YouTube / Supadata 网络层（globalThis.fetch 注入）验证
// tube_transcript 与 tube_export 的 happy path、缓存行为与错误路径。不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOOLS } from '../lib/tools.js'
import { cachePaths } from '../lib/paths.js'
import { PLUGIN_VERSION } from '../lib/version.js'
import {
  assertMatchesSchema,
  createYouTubeMock,
  fixture,
  makeTempDir,
  makeTempDshHome,
} from './_helpers.mjs'

const originalFetch = globalThis.fetch

const transcriptTool = TOOLS.find((tool) => tool.name === 'tube_transcript')
const exportTool = TOOLS.find((tool) => tool.name === 'tube_export')

function installMock(t, videos) {
  const mock = createYouTubeMock(videos)
  globalThis.fetch = mock.fetchImpl
  process.env.DSH_TUBE_INSIGHT_NO_YTDLP = '1'
  t.after(() => {
    globalThis.fetch = originalFetch
    delete process.env.DSH_TUBE_INSIGHT_NO_YTDLP
  })
  return mock
}

function setup(t) {
  const home = makeTempDshHome()
  t.after(() => home.restore())
  return home
}

function readCacheFile(videoId) {
  const paths = cachePaths(videoId)
  return {
    paths,
    json: existsSync(paths.json) ? JSON.parse(readFileSync(paths.json, 'utf8')) : null,
    md: existsSync(paths.md) ? readFileSync(paths.md, 'utf8') : null,
  }
}

const VIDEO_ID = 'zjkBMFhNj_g'

test('tube_transcript happy path：InnerTube 抓取、语义分段、缓存与返回 schema', async (t) => {
  setup(t)
  const mock = installMock(t, { [VIDEO_ID]: fixture(VIDEO_ID) })

  const value = await transcriptTool.execute({ video: `https://www.youtube.com/watch?v=${VIDEO_ID}` }, {})
  assertMatchesSchema(value, transcriptTool.output.schema)

  assert.equal(value.videoId, VIDEO_ID)
  assert.equal(value.title, 'Large Language Models Introduction')
  assert.equal(value.channel, 'Andrej Karpathy')
  assert.equal(value.durationSeconds, 125)
  assert.equal(value.language, 'en')
  assert.equal(value.captionKind, 'asr')
  assert.equal(value.source, 'innertube-ios')
  assert.equal(value.cached, false)
  assert.ok(value.segmentCount >= 2)
  assert.ok(value.charCount > 100)
  assert.deepEqual(
    value.chapters.map((chapter) => [chapter.startSeconds, chapter.title]),
    [
      [0, 'Introduction'],
      [45, 'Training'],
      [90, 'Limits'],
    ],
  )
  assert.match(value.preview.head, /^\[0:00\]/)
  assert.match(value.preview.tail, /^\[\d+:\d{2}\]/)

  const cache = readCacheFile(VIDEO_ID)
  assert.ok(cache.json, '应写出缓存 JSON')
  assert.equal(cache.json.version, 1)
  assert.equal(cache.json.title, value.title)
  assert.ok(cache.json.segments.length >= 2)
  assert.ok(cache.md, '应写出人可读的 Markdown')
  assert.match(cache.md, /^# Large Language Models Introduction/m)
  assert.match(cache.md, /\[0:00\]/)
  assert.match(cache.md, /\[0:45\] Training/)

  const render = transcriptTool.output.render({ video: VIDEO_ID }, value)
  assert.match(render[0].text, /Large Language Models Introduction/)
  assert.match(render[0].text, /read/)
  assert.ok(render[0].text.length < 4000, '工具返回/渲染文本应保持短小')

  // 第二次命中缓存，不再请求网络
  const callsAfterFirst = mock.calls.length
  const second = await transcriptTool.execute({ video: VIDEO_ID }, {})
  assert.equal(second.cached, true)
  assert.equal(mock.calls.length, callsAfterFirst, '缓存命中时不应再发请求')

  // refresh=true 强制重抓
  const refreshed = await transcriptTool.execute({ video: VIDEO_ID, refresh: true }, {})
  assert.equal(refreshed.cached, false)
  assert.ok(mock.calls.length > callsAfterFirst, 'refresh=true 应重新请求')
})

test('tube_transcript inline=true 返回正文、format=text 不带时间戳', async (t) => {
  setup(t)
  installMock(t, { [VIDEO_ID]: fixture(VIDEO_ID) })

  const segments = await transcriptTool.execute({ video: VIDEO_ID, inline: true }, {})
  assertMatchesSchema(segments, transcriptTool.output.schema)
  assert.equal(typeof segments.inlineText, 'string')
  assert.match(segments.inlineText, /\[\d+:\d{2}\] Welcome back/)
  assert.equal(segments.truncated, false)

  const plain = await transcriptTool.execute({ video: VIDEO_ID, inline: true, format: 'text' }, {})
  assert.equal(typeof plain.inlineText, 'string')
  assert.ok(!/\[\d+:\d{2}\]/.test(plain.inlineText), 'text 模式不应带时间戳')
  assert.match(plain.inlineText, /Welcome back to the channel/)

  const noInline = await transcriptTool.execute({ video: VIDEO_ID }, {})
  assert.equal(noInline.inlineText, undefined)
})

test('tube_transcript watch 页 ytInitialPlayerResponse 兜底路径', async (t) => {
  setup(t)
  installMock(t, { [VIDEO_ID]: fixture(VIDEO_ID, { withApiKey: false }) })

  const value = await transcriptTool.execute({ video: VIDEO_ID }, {})
  assert.equal(value.source, 'watch-page')
  assert.equal(value.cached, false)
  assert.ok(value.segmentCount >= 2)
  assert.match(value.preview.head, /^\[0:00\]/)
})

test('tube_transcript Supadata 同步兜底（InnerTube 无字幕）', async (t) => {
  setup(t)
  process.env.SUPADATA_API_KEY = 'test-supadata-key'
  t.after(() => delete process.env.SUPADATA_API_KEY)
  installMock(t, {
    [VIDEO_ID]: fixture(VIDEO_ID, {
      noCaptions: true,
      supadata: {
        lang: 'en',
        content: [
          { text: 'Supadata first chunk.', offset: 0, duration: 1500, lang: 'en' },
          { text: 'Supadata second chunk about models.', offset: 1500, duration: 1500, lang: 'en' },
          { text: 'Supadata third chunk with more detail.', offset: 3000, duration: 1500, lang: 'en' },
        ],
      },
    }),
  })

  const value = await transcriptTool.execute({ video: VIDEO_ID }, {})
  assertMatchesSchema(value, transcriptTool.output.schema)
  assert.equal(value.source, 'supadata')
  assert.equal(value.captionKind, 'native')
  assert.equal(value.title, 'Large Language Models Introduction', 'Supadata 路径也应带上 InnerTube 元数据')
  assert.ok(value.segmentCount >= 1)
  const cache = readCacheFile(VIDEO_ID)
  assert.equal(cache.json.source, 'supadata')
})

test('tube_transcript Supadata 异步 job 轮询（202 → completed）', async (t) => {
  setup(t)
  process.env.SUPADATA_API_KEY = 'test-supadata-key'
  process.env.DSH_TUBE_INSIGHT_POLL_MS = '1'
  t.after(() => {
    delete process.env.SUPADATA_API_KEY
    delete process.env.DSH_TUBE_INSIGHT_POLL_MS
  })
  const mock = installMock(t, {
    [VIDEO_ID]: fixture(VIDEO_ID, {
      noCaptions: true,
      supadata: {
        status: 202,
        lang: 'en',
        content: [
          { text: 'Job completed first chunk.', offset: 0, duration: 1500, lang: 'en' },
          { text: 'Job completed second chunk.', offset: 1500, duration: 1500, lang: 'en' },
        ],
      },
    }),
  })

  const value = await transcriptTool.execute({ video: VIDEO_ID }, {})
  assert.equal(value.source, 'supadata')
  assert.ok(mock.supadataJobs.get('job-1').polls >= 2)
})

test('tube_transcript 错误路径：无字幕', async (t) => {
  setup(t)
  installMock(t, { [VIDEO_ID]: fixture(VIDEO_ID, { noCaptions: true }) })

  await assert.rejects(
    () => transcriptTool.execute({ video: VIDEO_ID }, {}),
    (error) => {
      assert.match(error.message, /没有可用字幕/)
      assert.match(error.message, /下一步/)
      assert.match(error.message, /SUPADATA_API_KEY/)
      return true
    },
  )
})

test('tube_transcript 错误路径：年龄/地区限制带 playabilityStatus 原因', async (t) => {
  setup(t)
  installMock(t, {
    [VIDEO_ID]: fixture(VIDEO_ID, {
      playerOverride: {
        playabilityStatus: { status: 'AGE_VERIFICATION_REQUIRED', reason: 'Sign in to confirm your age' },
        videoDetails: { title: 'restricted', lengthSeconds: '10' },
      },
    }),
  })

  await assert.rejects(
    () => transcriptTool.execute({ video: VIDEO_ID }, {}),
    (error) => {
      assert.match(error.message, /年龄限制/)
      assert.match(error.message, /AGE_VERIFICATION_REQUIRED/)
      return true
    },
  )
})

test('tube_transcript 错误路径：网络失败给出可操作建议', async (t) => {
  setup(t)
  installMock(t, { [VIDEO_ID]: fixture(VIDEO_ID, { failWatch: true }) })

  await assert.rejects(
    () => transcriptTool.execute({ video: VIDEO_ID }, {}),
    (error) => {
      assert.match(error.message, /抓取 YouTube 播放页失败/)
      assert.match(error.message, /重试/)
      assert.match(error.message, /yt-dlp/)
      return true
    },
  )
})

test('tube_transcript 错误路径：Supadata key 无效', async (t) => {
  setup(t)
  process.env.SUPADATA_API_KEY = 'bad-key'
  t.after(() => delete process.env.SUPADATA_API_KEY)
  installMock(t, {
    [VIDEO_ID]: fixture(VIDEO_ID, { noCaptions: true, supadata: { status: 401, error: 'invalid api key' } }),
  })

  await assert.rejects(
    () => transcriptTool.execute({ video: VIDEO_ID }, {}),
    (error) => {
      assert.match(error.message, /无效/)
      return true
    },
  )
})

test('tube_transcript 参数校验错误', async (t) => {
  setup(t)
  installMock(t, { [VIDEO_ID]: fixture(VIDEO_ID) })

  await assert.rejects(() => transcriptTool.execute({}, {}), /video 必须是字符串/)
  await assert.rejects(() => transcriptTool.execute({ video: '   ' }, {}), /video 不能为空/)
  await assert.rejects(() => transcriptTool.execute({ video: 'not a video' }, {}), /YouTube/)
  await assert.rejects(() => transcriptTool.execute({ video: VIDEO_ID, refresh: 'yes' }, {}), /refresh 必须是 boolean/)
  await assert.rejects(() => transcriptTool.execute({ video: VIDEO_ID, languages: 'en' }, {}), /languages 必须是字符串数组/)
  await assert.rejects(() => transcriptTool.execute({ video: VIDEO_ID, format: 'xml' }, {}), /format 必须是以下之一/)
})

test('tube_export happy path：frontmatter、来源区块、index.md、缓存自动补齐', async (t) => {
  setup(t)
  const secondId = 'jNQXAC9IVRw'
  const mock = installMock(t, {
    [VIDEO_ID]: fixture(VIDEO_ID),
    [secondId]: fixture(secondId, { title: 'Me at the zoo', channel: 'jawed', lengthSeconds: 19 }),
  })
  const out = makeTempDir()
  t.after(() => out.restore())

  const value = await exportTool.execute(
    {
      videos: [`https://youtu.be/${VIDEO_ID}?t=30`, secondId],
      module: 'overview',
      title: 'LLM 视频概览',
      markdown: '# 视频概览\n\n- [0:00] 开场：模型训练概述\n- [0:45] 训练阶段\n\n结论：值得一看。',
      dir: out.dir,
      notes: ['第一遍看训练部分', '后续补对比'],
    },
    {},
  )
  assertMatchesSchema(value, exportTool.output.schema)
  assert.ok(existsSync(value.path), '导出文件应存在')
  assert.ok(existsSync(value.indexpath), 'index.md 应存在')
  assert.ok(value.bytes > 0)
  assert.equal(value.title, 'LLM 视频概览')
  assert.equal(value.module, 'overview')
  assert.equal(value.videos.length, 2)
  assert.ok(mock.calls.some((call) => call.url.includes('/watch?v=')), '不在缓存里的视频应先抓元数据')

  const content = readFileSync(value.path, 'utf8')
  assert.ok(content.startsWith('---\n'))
  assert.match(content, /title: "LLM 视频概览"/)
  assert.match(content, /module: "overview"/)
  assert.ok(content.includes(`generator: "dsh-tube-insight@${PLUGIN_VERSION}"`), `generator 应为当前包版本 ${PLUGIN_VERSION}`)
  assert.match(content, /videoId: "zjkBMFhNj_g"/)
  assert.match(content, /videoId: "jNQXAC9IVRw"/)
  assert.match(content, /## 我的笔记\n\n- 第一遍看训练部分\n- 后续补对比/)
  assert.match(content, /## 来源/)
  assert.match(content, /- \[Large Language Models Introduction\]\(https:\/\/youtu\.be\/zjkBMFhNj_g\?t=0\) · Andrej Karpathy · 2:05/)
  assert.match(content, /- \[Me at the zoo\]\(https:\/\/youtu\.be\/jNQXAC9IVRw\?t=0\) · jawed · 0:19/)

  const index = readFileSync(value.indexpath, 'utf8')
  assert.match(index, /## overview（视频概览）/)
  assert.match(index, /LLM 视频概览/)

  // 再导出一次同名：文件名加 -2，index 更新为 2 篇；已缓存视频不再重复抓
  const callsBeforeSecond = mock.calls.length
  const second = await exportTool.execute(
    { videos: [VIDEO_ID], module: 'insights', title: 'LLM 视频概览', markdown: '# 洞察\n\n内容。', dir: out.dir },
    {},
  )
  assert.notEqual(second.path, value.path)
  assert.ok(existsSync(second.path))
  assert.match(readFileSync(second.indexpath, 'utf8'), /共 2 篇/)
  assert.equal(mock.calls.length, callsBeforeSecond, '已缓存视频导出时不应重复抓取')
})

test('tube_export 去重 videos、默认 dir 为 ~/TubeInsight 时不实际写用户目录（用 dir 覆盖）', async (t) => {
  setup(t)
  installMock(t, { [VIDEO_ID]: fixture(VIDEO_ID) })
  const out = makeTempDir()
  t.after(() => out.restore())

  const value = await exportTool.execute(
    {
      videos: [VIDEO_ID, `https://www.youtube.com/watch?v=${VIDEO_ID}`],
      module: 'knowledge',
      markdown: '# 知识卡片\n\n内容。',
      dir: out.dir,
    },
    {},
  )
  assert.equal(value.videos.length, 1)
  assert.match(readFileSync(value.path, 'utf8'), /## 知识卡片|知识卡片/)
})

test('tube_export 错误路径：参数与抓取失败', async (t) => {
  setup(t)
  installMock(t, { [VIDEO_ID]: fixture(VIDEO_ID) })

  await assert.rejects(
    () => exportTool.execute({ videos: [VIDEO_ID], module: 'nope', markdown: '# x' }, {}),
    /module 必须是以下之一/,
  )
  await assert.rejects(
    () => exportTool.execute({ videos: [], module: 'overview', markdown: '# x' }, {}),
    /至少有 1 个视频/,
  )
  await assert.rejects(
    () => exportTool.execute({ videos: Array.from({ length: 11 }, () => VIDEO_ID), module: 'overview', markdown: '# x' }, {}),
    /最多 10 个/,
  )
  await assert.rejects(
    () => exportTool.execute({ videos: [VIDEO_ID], module: 'overview', markdown: '   ' }, {}),
    /markdown 不能为空/,
  )
  await assert.rejects(
    () => exportTool.execute({ videos: [VIDEO_ID], module: 'overview', markdown: '# x', dir: './relative' }, {}),
    /dir 必须是绝对路径/,
  )
  await assert.rejects(
    () => exportTool.execute({ videos: ['aaaaaaaaaaa'], module: 'overview', markdown: '# x' }, {}),
    (error) => {
      assert.match(error.message, /导出失败/)
      assert.match(error.message, /tube_transcript/)
      return true
    },
  )
})
