// Supadata 兜底路径。仅在配置了 SUPADATA_API_KEY（环境变量或 config.json）时启用。
// 实现与上游 TubeInsight background.js:714 一致：native 模式，>20 分钟的视频走异步 job 轮询。
import { request, readJson, sleep } from '../http.js'
import { normalizeCaptionText } from '../segment.js'
import { SourceError } from '../errors.js'
import { watchUrl } from './url.js'

const BASE = 'https://api.supadata.ai/v1'
const MAX_POLL_ATTEMPTS = 60

function pollIntervalMs() {
  const fromEnv = Number(process.env.DSH_TUBE_INSIGHT_POLL_MS)
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv
  return 1000
}

function friendlyHttpError(status, body) {
  const preview = String(body || '')
    .slice(0, 160)
    .replace(/\s+/g, ' ')
    .trim()
  if (status === 401) {
    return new SourceError('SUPADATA_INVALID_KEY', 'SUPADATA_API_KEY 无效（401）。请检查环境变量或 $DSH_HOME/tube-insight/config.json。', {
      source: 'supadata',
      status: String(status),
      retryable: false,
    })
  }
  if (status === 429) {
    return new SourceError('SUPADATA_RATE_LIMITED', 'Supadata 触发限流（429），等一分钟再试，或避免同时抓多个视频。', {
      source: 'supadata',
      status: String(status),
    })
  }
  return new SourceError(
    'SUPADATA_HTTP',
    `Supadata 接口返回 HTTP ${status}${preview ? `（${preview}）` : ''}。`,
    { source: 'supadata', status: String(status) },
  )
}

function parseContent(content, fallbackLanguage) {
  if (!Array.isArray(content)) {
    throw new SourceError(
      'SUPADATA_FORMAT',
      'Supadata 返回的内容不是带时间戳的分段（可能返回了纯文本），无法生成可引用的时间戳。',
      { source: 'supadata' },
    )
  }
  const segments = []
  let language = ''
  for (const chunk of content) {
    if (!chunk || typeof chunk.text !== 'string') continue
    const text = normalizeCaptionText(chunk.text)
    if (!text) continue
    const startMs = Number(chunk.offset)
    const durationMs = Number(chunk.duration)
    segments.push({
      start: Number.isFinite(startMs) && startMs >= 0 ? startMs / 1000 : 0,
      duration: Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : 0,
      text,
    })
    if (!language && typeof chunk.lang === 'string' && chunk.lang) language = chunk.lang
  }
  if (segments.length === 0) {
    throw new SourceError('SUPADATA_EMPTY', 'Supadata 返回了空转录（该视频可能没有原生字幕）。', {
      source: 'supadata',
    })
  }
  return { segments, language: language || fallbackLanguage || 'unknown' }
}

async function readResponseBody(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

async function fetchJob(jobId, apiKey, { fetchImpl, signal }) {
  const response = await request(
    `${BASE}/transcript/${encodeURIComponent(jobId)}`,
    { headers: { 'x-api-key': apiKey } },
    { fetchImpl, signal, timeoutMs: 30_000, label: '轮询 Supadata 转录任务' },
  )
  if (!response.ok) throw friendlyHttpError(response.status, await readResponseBody(response))
  return readJson(response, 'Supadata 任务响应')
}

async function pollJob(jobId, apiKey, { fetchImpl, signal }) {
  const interval = pollIntervalMs()
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    await sleep(interval, signal)
    const data = await fetchJob(jobId, apiKey, { fetchImpl, signal })
    if (data?.status === 'completed') return data
    if (data?.status === 'failed') {
      throw new SourceError('SUPADATA_JOB_FAILED', 'Supadata 异步转录任务失败（该视频可能没有原生字幕）。', {
        source: 'supadata',
      })
    }
  }
  throw new SourceError(
    'SUPADATA_TIMEOUT',
    `Supadata 异步任务超时（${MAX_POLL_ATTEMPTS} 次轮询仍未完成）。稍后重试，或换更短的视频。`,
    { source: 'supadata' },
  )
}

/**
 * 用 Supadata 抓字幕。
 * @param {string} videoId
 * @param {{apiKey: string, language?: string, fetchImpl?: Function, signal?: AbortSignal}} options
 */
export async function fetchViaSupadata(videoId, { apiKey, language = 'en', fetchImpl, signal } = {}) {
  if (!apiKey) {
    throw new SourceError('SUPADATA_NO_KEY', '没有配置 SUPADATA_API_KEY。', { source: 'supadata', retryable: false })
  }
  const url = new URL(`${BASE}/transcript`)
  url.searchParams.set('url', watchUrl(videoId))
  url.searchParams.set('text', 'false')
  url.searchParams.set('lang', language || 'en')
  url.searchParams.set('mode', 'native')

  const response = await request(
    url.toString(),
    { headers: { 'x-api-key': apiKey } },
    { fetchImpl, signal, timeoutMs: 60_000, label: '请求 Supadata 转录接口' },
  )

  if (response.status === 202) {
    const jobData = await readJson(response, 'Supadata 任务响应')
    const jobId = jobData?.jobId || jobData?.job_id
    if (!jobId) {
      throw new SourceError('SUPADATA_JOB', 'Supadata 返回了异步任务但没有 jobId。', { source: 'supadata' })
    }
    const completed = await pollJob(jobId, apiKey, { fetchImpl, signal })
    const parsed = parseContent(completed?.content, completed?.lang)
    return { ...parsed, source: 'supadata', captionKind: 'native' }
  }

  if (response.status === 206 || response.status === 404) {
    throw new SourceError('NO_CAPTIONS', '该视频没有可用字幕（原生或自动生成都没有）。', {
      source: 'supadata',
      status: String(response.status),
    })
  }

  if (!response.ok) throw friendlyHttpError(response.status, await readResponseBody(response))

  const data = await readJson(response, 'Supadata 转录响应')
  const parsed = parseContent(data?.content, data?.lang)
  return { ...parsed, source: 'supadata', captionKind: 'native' }
}
