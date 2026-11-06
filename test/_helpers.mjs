// 测试辅助：临时 DSH_HOME、假 YouTube 网络、JSON Schema 断言。
// 注意：文件名以 _ 开头，不会被 `node --test test/*.test.mjs` 当成测试文件。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheDir, cachePaths } from '../lib/paths.js'

/** 建一个临时 $DSH_HOME，返回 { dir, restore }；restore 会清理环境变量与目录。 */
export function makeTempDshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'tube-insight-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  return {
    dir,
    restore() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function makeTempDir(prefix = 'tube-insight-export-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, restore: () => rmSync(dir, { recursive: true, force: true }) }
}

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function textResponse(value, status = 200) {
  return new Response(value, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

/** 生成 json3 字幕事件；每句一句，按 1.6 秒递增。 */
export function captionEvents(sentences) {
  return sentences.map((text, index) => ({
    tStartMs: index * 1600,
    dDurationMs: 1500,
    segs: [{ utf8: text }],
  }))
}

const DEFAULT_SENTENCES = [
  'Welcome back to the channel, today we are going to talk about large language models.',
  'The first thing to understand is that these models are trained on a huge amount of text.',
  'They learn to predict the next token, and that simple objective turns out to be very powerful.',
  'In this video I want to cover three ideas: how training works, how the model is used, and what limits exist.',
  'Let us start with the training stage and the data that goes into it.',
  'The model is exposed to billions of documents from the web, books, and other sources.',
  'After pretraining, there is a second stage called fine tuning with human feedback.',
  'This stage teaches the model to follow instructions and to refuse harmful requests.',
  'But there are still many failure modes that we need to understand and measure carefully.',
  'For example, the model can hallucinate facts that sound very convincing but are simply wrong.',
  'It can also be sensitive to the way a question is phrased, which is a real limitation.',
  'Finally, I will share a few practical tips for using these models in your own work.',
  'Start with a clear task description and give the model enough context to succeed.',
  'Then evaluate the output with a fixed rubric instead of trusting your first impression.',
  'Thanks for watching, and I will see you in the next video.',
]

/**
 * 假 YouTube 网络层。返回 { fetchImpl, calls }；calls 记录每次请求的 URL 便于断言缓存行为。
 * videos: { [videoId]: fixture }
 * fixture 支持：
 *   title/channel/lengthSeconds/description/languageCode/kind/captionSentences/captionEvents
 *   withApiKey=false      页面里不含 INNERTUBE_API_KEY（走 watch 页兜底）
 *   withoutInitialPlayer=false 页面里不含 ytInitialPlayerResponse
 *   playerOverride        覆盖整个 player 响应
 *   captionStatus         字幕请求返回的 HTTP 状态（默认 200）
 *   captionRaw            字幕响应正文覆盖
 *   supadata              { content, lang, status, job } 供 Supadata 路径使用
 *   failWatch             watch 页请求直接抛网络错误
 */
export function createYouTubeMock(videos) {
  const calls = []
  const supadataJobs = new Map()

  function buildPlayer(video) {
    if (video.playerOverride) return video.playerOverride
    const tracks = video.noCaptions
      ? []
      : [
          {
            baseUrl: `https://www.youtube.com/api/timedtext?v=${video.id}&lang=${video.languageCode || 'en'}${video.kind === 'asr' ? '&kind=asr' : ''}`,
            languageCode: video.languageCode || 'en',
            kind: video.kind === 'asr' ? 'asr' : undefined,
            name: { simpleText: 'English' },
          },
        ]
    return {
      playabilityStatus: { status: 'OK' },
      videoDetails: {
        title: video.title,
        author: video.channel,
        lengthSeconds: String(video.lengthSeconds),
        shortDescription: video.description || '',
        isLiveContent: false,
      },
      microformat: {
        playerMicroformatRenderer: {
          publishDate: '2024-01-02',
          uploadDate: '2024-01-02T03:04:05-08:00',
        },
      },
      captions: {
        playerCaptionsTracklistRenderer: { captionTracks: tracks },
      },
    }
  }

  function buildWatchHtml(video) {
    if (video.watchHtml) return video.watchHtml
    const scriptParts = []
    if (video.withApiKey !== false) {
      scriptParts.push('"INNERTUBE_API_KEY":"test-api-key","VISITOR_DATA":"test-visitor"')
    }
    if (video.withoutInitialPlayer !== true) {
      scriptParts.push(`var ytInitialPlayerResponse = ${JSON.stringify(buildPlayer(video))};`)
    }
    return `<!doctype html><html><head><title>${video.title}</title></head><body><script>var ytcfg = {${scriptParts.join(',')}};</script></body></html>`
  }

  function captionBody(video) {
    if (video.captionRaw !== undefined) return video.captionRaw
    const events = video.captionEvents || captionEvents(video.captionSentences || DEFAULT_SENTENCES)
    return JSON.stringify({ events })
  }

  async function fetchImpl(input, init = {}) {
    const url = String(input)
    calls.push({ url, init })
    if (url.includes('/watch?v=')) {
      const id = new URL(url).searchParams.get('v')
      const video = videos[id]
      if (!video) return textResponse('<html>not found</html>', 404)
      if (video.failWatch) throw new TypeError('fetch failed')
      return textResponse(buildWatchHtml(video))
    }
    if (url.includes('/youtubei/v1/player')) {
      const body = JSON.parse(init.body || '{}')
      const video = videos[body.videoId]
      if (!video) return jsonResponse({ playabilityStatus: { status: 'ERROR', reason: 'Video unavailable' } })
      return jsonResponse(buildPlayer(video))
    }
    if (url.includes('/api/timedtext')) {
      const id = new URL(url).searchParams.get('v')
      const video = videos[id]
      if (!video) return textResponse('', 404)
      if (video.captionStatus) return textResponse('', video.captionStatus)
      return new Response(captionBody(video), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('api.supadata.ai/v1/transcript')) {
      const parsed = new URL(url)
      const jobMatch = parsed.pathname.match(/\/v1\/transcript\/([^/]+)$/)
      if (jobMatch) {
        const job = supadataJobs.get(jobMatch[1])
        if (!job) return jsonResponse({ error: 'job not found' }, 404)
        job.polls += 1
        if (job.polls >= 2) {
          return jsonResponse({ status: 'completed', content: job.content, lang: job.lang })
        }
        return jsonResponse({ status: 'active' })
      }

      const target = parsed.searchParams.get('url') || ''
      const id = target.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1] || ''
      const video = videos[id]
      const supadata = video?.supadata
      if (!supadata) {
        return jsonResponse({ error: 'not found' }, 404)
      }
      if (supadata.status === 202) {
        const jobId = 'job-1'
        supadataJobs.set(jobId, { polls: 0, content: supadata.content, lang: supadata.lang || 'en' })
        return jsonResponse({ jobId }, 202)
      }
      if (supadata.status && supadata.status >= 400) {
        return jsonResponse({ error: supadata.error || 'error' }, supadata.status)
      }
      return jsonResponse({ content: supadata.content, lang: supadata.lang || 'en' })
    }
    return textResponse('Not found', 404)
  }

  return { fetchImpl, calls, supadataJobs }
}

/** 简易 JSON Schema 断言（覆盖插件用到的子集）。 */
export function assertMatchesSchema(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return
  if (schema.oneOf) {
    const errors = schema.oneOf.map((sub, index) => {
      try {
        assertMatchesSchema(value, sub, `${path}<oneOf:${index}>`)
        return null
      } catch (error) {
        return error
      }
    })
    if (errors.every(Boolean)) throw new Error(`${path} 不匹配 schema.oneOf`)
    return
  }
  const type = schema.type
  if (type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${path} 应为 object，收到 ${typeof value}`)
    for (const key of schema.required || []) {
      assert.ok(key in value, `${path} 缺少必填字段 ${key}`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(key in (schema.properties || {}), `${path} 出现未声明字段 ${key}`)
      }
    }
    for (const [key, subSchema] of Object.entries(schema.properties || {})) {
      if (key in value) assertMatchesSchema(value[key], subSchema, `${path}.${key}`)
    }
    return
  }
  if (type === 'array') {
    assert.ok(Array.isArray(value), `${path} 应为 array`)
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${path} 至少 ${schema.minItems} 项`)
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, `${path} 最多 ${schema.maxItems} 项`)
    value.forEach((item, index) => assertMatchesSchema(item, schema.items, `${path}[${index}]`))
    return
  }
  if (type === 'string') {
    assert.equal(typeof value, 'string', `${path} 应为 string，收到 ${typeof value}`)
  } else if (type === 'number') {
    assert.equal(typeof value, 'number', `${path} 应为 number，收到 ${typeof value}`)
    assert.ok(Number.isFinite(value), `${path} 应为有限数字`)
  } else if (type === 'boolean') {
    assert.equal(typeof value, 'boolean', `${path} 应为 boolean`)
  }
  if (schema.enum) {
    assert.ok(schema.enum.includes(value), `${path} 取值 ${JSON.stringify(value)} 不在 enum 中`)
  }
}

/** 断言一个 URL/ID 的视频 fixture 的 id 与缓存路径。 */
export function fixture(id, overrides = {}) {
  return {
    id,
    title: 'Large Language Models Introduction',
    channel: 'Andrej Karpathy',
    lengthSeconds: 125,
    description:
      'A short introduction to large language models.\n\nChapters:\n0:00 Introduction\n0:45 Training\n1:30 Limits\n',
    languageCode: 'en',
    kind: 'asr',
    ...overrides,
  }
}

/**
 * 写一条 tube_search 用的缓存 fixture（结构与 lib/transcript.js 写出的记录一致）。
 * @param {{videoId: string, title?: string, channel?: string, durationSeconds?: number, fetchedAt?: string, segments: Array<{start:number,text:string}>}} options
 */
export function writeCacheFixture(options) {
  const {
    videoId,
    title = 'Fixture Video',
    channel = 'Fixture Channel',
    durationSeconds = 600,
    fetchedAt = '2026-01-01T00:00:00.000Z',
    segments,
  } = options
  const paths = cachePaths(videoId)
  mkdirSync(paths.dir, { recursive: true })
  const record = {
    version: 1,
    videoId,
    title,
    channel,
    durationSeconds,
    description: '',
    language: 'en',
    captionKind: 'asr',
    source: 'fixture',
    fetchedAt,
    segmentCount: segments.length,
    charCount: segments.reduce((sum, segment) => sum + segment.text.length, 0),
    chapters: [],
    segments,
  }
  writeFileSync(paths.json, JSON.stringify(record), 'utf8')
  return record
}

/** 在缓存目录写一个任意内容的 .json 文件（用于损坏缓存测试）。 */
export function writeRawCacheFile(fileName, content) {
  const dir = cacheDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, fileName)
  writeFileSync(file, content, 'utf8')
  return file
}
