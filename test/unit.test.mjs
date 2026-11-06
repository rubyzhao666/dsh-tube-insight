// 纯函数 / 本地文件测试：URL 解析、语义分段、章节解析、缓存、导出格式。
// 不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseVideoId, timestampUrl, watchUrl } from '../lib/yt/url.js'
import { parseCaptionJson3, pickCaptionTrack, extractInitialPlayerResponse } from '../lib/yt/innertube.js'
import { formatDuration, formatTimestamp, groupTranscriptEntries, normalizeCaptionText } from '../lib/segment.js'
import { parseChaptersFromDescription } from '../lib/chapters.js'
import {
  MODULES,
  composeExportMarkdown,
  localDateStamp,
  slugify,
  writeExport,
} from '../lib/export.js'
import {
  buildInlineText,
  buildPreview,
  readCache,
  renderTranscriptMarkdown,
  writeCache,
} from '../lib/transcript.js'
import { cacheDir } from '../lib/paths.js'
import { makeTempDir, makeTempDshHome } from './_helpers.mjs'

function sampleRecord(overrides = {}) {
  return {
    version: 1,
    videoId: 'zjkBMFhNj_g',
    title: 'Intro to Large Language Models',
    channel: 'Andrej Karpathy',
    durationSeconds: 3588,
    description: 'A one hour intro.\n\n0:00 Introduction\n12:00 Training\n30:00 Limits',
    language: 'en',
    captionKind: 'asr',
    source: 'innertube-ios',
    fetchedAt: '2026-11-06T01:00:00.000Z',
    segmentCount: 3,
    charCount: 120,
    chapters: [
      { title: 'Introduction', startSeconds: 0 },
      { title: 'Training', startSeconds: 720 },
    ],
    segments: [
      { start: 0.2, text: 'This is the first paragraph about large language models.' },
      { start: 12.6, text: 'This is the second paragraph about training data.' },
      { start: 3601.4, text: 'This is the last paragraph, over one hour in.' },
    ],
    ...overrides,
  }
}

function sampleFetchRecord(overrides = {}) {
  return {
    videoId: 'zjkBMFhNj_g',
    title: 'Intro to Large Language Models',
    channel: 'Andrej Karpathy',
    durationSeconds: 3588,
    ...overrides,
  }
}

// ---------------------------------------------------------------- URL 解析

test('parseVideoId 支持常见 YouTube 链接形式', () => {
  const id = 'zjkBMFhNj_g'
  const good = [
    id,
    `https://www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/watch?v=${id}&list=PL123&t=42s`,
    `https://youtu.be/${id}?t=42`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/live/${id}?feature=share`,
    `https://music.youtube.com/watch?v=${id}`,
    `www.youtube.com/watch?v=${id}`,
    `  ${id}  `,
  ]
  for (const input of good) assert.equal(parseVideoId(input), id, input)
})

test('parseVideoId 对坏输入给出可操作错误', () => {
  assert.throws(() => parseVideoId(''), /不能为空/)
  assert.throws(() => parseVideoId(123), /必须是字符串/)
  assert.throws(() => parseVideoId('https://vimeo.com/12345'), /只支持 YouTube/)
  assert.throws(() => parseVideoId('https://www.youtube.com/playlist?list=PL123'), /没有 videoId/)
  assert.throws(() => parseVideoId('https://youtu.be/short'), /11 位/)
  assert.throws(() => parseVideoId('abc$defghij'), /只支持 YouTube|无法解析/)
})

test('watchUrl / timestampUrl', () => {
  assert.equal(watchUrl('zjkBMFhNj_g'), 'https://www.youtube.com/watch?v=zjkBMFhNj_g')
  assert.equal(timestampUrl('zjkBMFhNj_g', 150.9), 'https://youtu.be/zjkBMFhNj_g?t=150')
  assert.equal(timestampUrl('zjkBMFhNj_g', -5), 'https://youtu.be/zjkBMFhNj_g?t=0')
  assert.equal(timestampUrl('zjkBMFhNj_g'), 'https://youtu.be/zjkBMFhNj_g?t=0')
})

// ---------------------------------------------------------------- 时间格式

test('formatTimestamp 用累计分钟（[MM:SS]）', () => {
  assert.equal(formatTimestamp(0), '0:00')
  assert.equal(formatTimestamp(65), '1:05')
  assert.equal(formatTimestamp(3600), '60:00')
  assert.equal(formatTimestamp(7299.9), '121:39')
  assert.equal(formatTimestamp(-1), '0:00')
})

test('formatDuration 区分是否跨小时', () => {
  assert.equal(formatDuration(65), '1:05')
  assert.equal(formatDuration(3588), '59:48')
  assert.equal(formatDuration(3661), '1:01:01')
  assert.equal(formatDuration(0), '0:00')
})

// ---------------------------------------------------------------- 语义分段

test('normalizeCaptionText 清理字幕噪声', () => {
  assert.equal(normalizeCaptionText('>>  Hello   world.'), 'Hello world.')
  assert.equal(normalizeCaptionText('这 是 中文 字幕'), '这是中文字幕')
  assert.equal(normalizeCaptionText('你好 ，世界'), '你好，世界')
  assert.equal(normalizeCaptionText(''), '')
})

test('groupTranscriptEntries 合并字幕并保留段落起始秒', () => {
  const entries = [
    { start: 0, duration: 2, text: '>> Welcome to the video.' },
    { start: 2, duration: 2, text: 'Today we will talk about large language models and how they work.' },
    { start: 4, duration: 2, text: 'The first idea is training on a huge amount of text data.' },
    { start: 6, duration: 2, text: 'The second idea is that predicting the next token is surprisingly powerful.' },
    { start: 8, duration: 2, text: 'The third idea is that human feedback shapes how the model behaves.' },
    { start: 10, duration: 2, text: 'Let us look at each of these in a bit more detail now.' },
    { start: 120, duration: 2, text: 'This later segment starts two minutes in.' },
  ]
  const grouped = groupTranscriptEntries(entries)
  assert.ok(grouped.length >= 2, `应至少分成 2 段，实际 ${grouped.length}`)
  for (const segment of grouped) {
    assert.equal(typeof segment.start, 'number')
    assert.ok(segment.start >= 0)
    assert.ok(segment.text.length > 0)
    assert.ok(!segment.text.includes('>>'))
  }
  // 起始秒单调不减，且第一个是 0
  assert.equal(grouped[0].start, 0)
  for (let i = 1; i < grouped.length; i += 1) {
    assert.ok(grouped[i].start >= grouped[i - 1].start)
  }
  // 长间隔处应断开
  assert.ok(grouped.some((segment) => segment.start === 120), '120 秒处的字幕应开启新段')
})

test('groupTranscriptEntries 对空输入与中文/超长文本稳健', () => {
  assert.deepEqual(groupTranscriptEntries([]), [])
  assert.deepEqual(groupTranscriptEntries(null), [])
  assert.deepEqual(groupTranscriptEntries([{ start: 0, text: '   ' }]), [])

  const chinese = groupTranscriptEntries([
    { start: 0, duration: 1, text: '这是第一句话。' },
    { start: 1, duration: 1, text: '这是第二句话。' },
  ])
  assert.equal(chinese.length, 1)
  assert.equal(chinese[0].text, '这是第一句话。这是第二句话。')

  const long = 'a'.repeat(1000)
  const chunks = groupTranscriptEntries([{ start: 0, duration: 30, text: long }])
  assert.ok(chunks.length >= 3)
  for (const chunk of chunks) assert.ok(chunk.text.length <= 400, `段落过长：${chunk.text.length}`)
})

// ---------------------------------------------------------------- InnerTube 解析

test('parseCaptionJson3 解析逐段字幕并跳过空事件', () => {
  const segments = parseCaptionJson3({
    events: [
      { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: '>> ' }, { utf8: 'Hello' }] },
      { tStartMs: 1500, dDurationMs: 1500, segs: [{ utf8: ' world.' }] },
      { tStartMs: 3000, dDurationMs: 0 },
      { tStartMs: 4500, dDurationMs: 1000, segs: [{ utf8: '   ' }] },
    ],
  })
  assert.equal(segments.length, 2)
  assert.equal(segments[0].start, 0)
  assert.equal(segments[0].text, 'Hello')
  assert.equal(segments[1].start, 1.5)
  assert.equal(segments[1].duration, 1.5)
})

test('pickCaptionTrack 按语言优先级并优先原生字幕', () => {
  const player = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { baseUrl: 'https://x/zh-Hans', languageCode: 'zh-Hans' },
          { baseUrl: 'https://x/en-asr', languageCode: 'en', kind: 'asr' },
        ],
      },
    },
  }
  assert.equal(pickCaptionTrack(player, ['en', 'zh-Hans']).language, 'en')
  assert.equal(pickCaptionTrack(player, ['en', 'zh-Hans']).captionKind, 'asr')
  assert.equal(pickCaptionTrack(player, ['zh-Hans', 'en']).captionKind, 'native')

  // 没有匹配语言时退回第一条可用轨道，而不是报错
  const korean = {
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://x/ko', languageCode: 'ko' }] } },
  }
  assert.equal(pickCaptionTrack(korean, ['en']).language, 'ko')
  // 没有字幕轨
  assert.equal(pickCaptionTrack({}, ['en']), null)
})

test('extractInitialPlayerResponse 从页面 HTML 里提取 JSON', () => {
  const payload = { playabilityStatus: { status: 'OK' }, videoDetails: { title: 'A "quoted" {title}', lengthSeconds: '10' } }
  const html = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(payload)}; var x = 1;</script></html>`
  const parsed = extractInitialPlayerResponse(html)
  assert.equal(parsed.videoDetails.title, 'A "quoted" {title}')
  assert.equal(extractInitialPlayerResponse('<html>nothing here</html>'), null)
})

// ---------------------------------------------------------------- 章节

test('parseChaptersFromDescription 解析描述里的章节时间戳', () => {
  const chapters = parseChaptersFromDescription(
    'A talk about LLMs.\n\nChapters:\n0:00 Introduction\n2:30 - Training\n12:00: The limits\n[1:02:03] Later on',
  )
  assert.deepEqual(
    chapters.map((chapter) => [chapter.startSeconds, chapter.title]),
    [
      [0, 'Introduction'],
      [150, 'Training'],
      [720, 'The limits'],
      [3723, 'Later on'],
    ],
  )
})

test('parseChaptersFromDescription 对噪声/不足两条返回空数组', () => {
  assert.deepEqual(parseChaptersFromDescription(''), [])
  assert.deepEqual(parseChaptersFromDescription(undefined), [])
  assert.deepEqual(parseChaptersFromDescription('0:00 only one chapter'), [])
  assert.deepEqual(
    parseChaptersFromDescription('Recorded 10:30 AM · no chapters here\nsee https://example.com'),
    [],
  )
  const two = parseChaptersFromDescription('0:00 Intro\n1:00 https://example.com')
  assert.equal(two.length, 0, '纯 URL 的“标题”应被过滤，只剩 1 条时整体返回空数组')
})

// ---------------------------------------------------------------- slug / 导出格式

test('slugify 保留中文与英文数字、空格转 -、截断 60', () => {
  assert.equal(slugify('GPT-4 vs Claude：谁更强？'), 'GPT-4-vs-Claude-谁更强')
  assert.equal(slugify('  hello   world  '), 'hello-world')
  assert.equal(slugify('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j')
  assert.equal(slugify('   '), 'tube-insight')
  assert.equal(slugify('はじめての動画'), 'はじめての動画')
  const long = slugify('x'.repeat(120))
  assert.equal(long.length, 60)
  assert.equal(slugify(`${'y'.repeat(59)}-tail`), 'y'.repeat(59))
})

test('composeExportMarkdown 生成 frontmatter、我的笔记与来源区块', () => {
  const records = [sampleFetchRecord(), sampleFetchRecord({ videoId: 'jNQXAC9IVRw', title: 'Me at the zoo', channel: 'jawed', durationSeconds: 19 })]
  const content = composeExportMarkdown({
    records,
    module: 'overview',
    markdown: '# 视频概览\n\n正文内容。',
    title: 'LLM 视频概览',
    notes: ['第一条笔记', '  '],
    pluginVersion: '0.1.0',
    generatedAt: new Date('2026-11-06T01:02:03.000Z'),
  })
  assert.ok(content.startsWith('---\n'))
  assert.match(content, /title: "LLM 视频概览"/)
  assert.match(content, /module: "overview"/)
  assert.match(content, /generated_at: "2026-11-06T01:02:03\.000Z"/)
  assert.match(content, /generator: "dsh-tube-insight@0\.1\.0"/)
  assert.match(content, /videoId: "zjkBMFhNj_g"/)
  assert.match(content, /durationSeconds: 3588/)
  assert.match(content, /## 我的笔记\n\n- 第一条笔记/)
  assert.match(content, /## 来源\n\n- \[Intro to Large Language Models\]\(https:\/\/youtu\.be\/zjkBMFhNj_g\?t=0\) · Andrej Karpathy · 59:48/)
  assert.match(content, /- \[Me at the zoo\]\(https:\/\/youtu\.be\/jNQXAC9IVRw\?t=0\)/)
  assert.ok(!content.includes('-   \n'), '空笔记应被过滤')
})

test('writeExport 落盘、重名加 -2、index.md 按 module 分组', () => {
  const home = makeTempDshHome()
  const out = makeTempDir()
  try {
    const records = [sampleFetchRecord()]
    const first = writeExport({
      records,
      module: 'overview',
      markdown: '# 概览\n\n第一份。',
      title: '视频概览',
      dir: out.dir,
      pluginVersion: '0.1.0',
    })
    assert.ok(existsSync(first.path))
    assert.equal(first.indexpath, join(out.dir, 'index.md'))
    assert.ok(existsSync(first.indexpath))
    assert.ok(first.path.endsWith(`视频概览_${localDateStamp()}.md`))
    assert.ok(first.bytes > 0)
    assert.equal(first.videos.length, 1)

    const second = writeExport({
      records,
      module: 'intel',
      markdown: '# 情报\n\n第二份。',
      title: '视频概览',
      dir: out.dir,
      pluginVersion: '0.1.0',
    })
    assert.notEqual(second.path, first.path)
    assert.ok(existsSync(second.path))

    const third = writeExport({
      records,
      module: 'overview',
      markdown: '# 概览 2\n\n第三份。',
      title: '视频概览',
      dir: out.dir,
      notes: ['用户笔记'],
    })
    assert.ok(existsSync(third.path))
    assert.ok(existsSync(first.path) && existsSync(second.path))
    assert.ok(readFileSync(third.path, 'utf8').includes('- 用户笔记'))

    const index = readFileSync(first.indexpath, 'utf8')
    assert.match(index, /# TubeInsight 导出索引/)
    assert.match(index, /共 3 篇/)
    assert.match(index, /## overview（视频概览）/)
    assert.match(index, /## intel（产品情报）/)
    assert.match(index, /\[视频概览\]\(\.\//)
    // 同一 module 下三条都在
    const overviewSection = index.split('## overview（视频概览）')[1].split('## intel')[0]
    assert.equal((overviewSection.match(/- 20\d\d-\d\d-\d\d ·/g) || []).length, 2)
  } finally {
    home.restore()
    out.restore()
  }
})

test('MODULES 覆盖 GUIDE §8.1 的七个模块', () => {
  assert.deepEqual([...MODULES], ['overview', 'intel', 'insights', 'prd', 'compare', 'knowledge', 'translation'])
})

// ---------------------------------------------------------------- 缓存

test('writeCache/readCache 往返 + Markdown 带 [MM:SS] 时间戳', () => {
  const home = makeTempDshHome()
  try {
    const record = sampleRecord()
    const paths = writeCache(record)
    assert.equal(paths.json, join(cacheDir(), 'zjkBMFhNj_g.json'))
    assert.ok(existsSync(paths.json))
    assert.ok(existsSync(paths.md))
    const loaded = readCache('zjkBMFhNj_g')
    assert.equal(loaded.title, record.title)
    assert.equal(loaded.segments.length, 3)

    const md = readFileSync(paths.md, 'utf8')
    assert.match(md, /^# Intro to Large Language Models/m)
    assert.match(md, /\[0:00\] This is the first paragraph/)
    assert.match(md, /\[0:12\] This is the second paragraph/)
    assert.match(md, /\[60:01\] This is the last paragraph/)
    assert.match(md, /## 章节/)
    assert.match(md, /- \[12:00\] Training/)
    assert.match(md, /## 转录/)

    assert.equal(readCache('unknown-video-id'), null)
  } finally {
    home.restore()
  }
})

test('readCache 忽略损坏/旧版本缓存', () => {
  const home = makeTempDshHome()
  try {
    const record = sampleRecord()
    const paths = writeCache(record)
    writeFileSync(paths.json, '{ not json', 'utf8')
    assert.equal(readCache(record.videoId), null)
    writeFileSync(paths.json, JSON.stringify({ version: 999, videoId: record.videoId, segments: [{ start: 0, text: 'x' }] }), 'utf8')
    assert.equal(readCache(record.videoId), null)
    writeFileSync(paths.json, JSON.stringify({ version: 1, videoId: 'other', segments: [{ start: 0, text: 'x' }] }), 'utf8')
    assert.equal(readCache(record.videoId), null)
  } finally {
    home.restore()
  }
})

test('buildInlineText 默认带时间戳、text 模式不带、超长截断', () => {
  const record = sampleRecord()
  assert.match(buildInlineText(record), /^\[0:00\] This is the first paragraph/)
  const plain = buildInlineText(record, 'text')
  assert.ok(!/\[\d+:\d{2}\]/.test(plain))
  assert.ok(plain.includes('This is the second paragraph'))

  const huge = sampleRecord({ segments: [{ start: 0, text: 'z'.repeat(70_000) }] })
  const truncated = buildInlineText(huge)
  assert.ok(truncated.length < 70_000)
  assert.match(truncated, /已截断/)
})

test('buildPreview 返回开头/结尾短预览并截断单段', () => {
  const record = sampleRecord()
  const preview = buildPreview(record)
  assert.match(preview.head, /\[0:00\] This is the first paragraph/)
  assert.match(preview.tail, /\[60:01\]/)
  const longRecord = sampleRecord({ segments: [{ start: 0, text: 'q'.repeat(500) }] })
  const longPreview = buildPreview(longRecord)
  assert.ok(longPreview.head.length < 200)
  assert.ok(longPreview.head.endsWith('…'))
})

test('renderTranscriptMarkdown 处理标题/频道缺失与无章节', () => {
  const md = renderTranscriptMarkdown(sampleRecord({ title: '', channel: '', description: '', chapters: [] }))
  assert.match(md, /^# YouTube zjkBMFhNj_g/m)
  assert.match(md, /频道：未知/)
  assert.ok(!md.includes('## 章节'))
})
