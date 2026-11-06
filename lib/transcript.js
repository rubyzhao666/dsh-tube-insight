// 抓取编排 + 本地缓存 + 转录 Markdown 渲染。
// 降级链：① InnerTube IOS → ② watch 页 ytInitialPlayerResponse → ③ Supadata（有 key 时）→ ④ yt-dlp（系统里有才用）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { cachePaths, ensureDir, resolveSupadataKey, safeReadConfig } from './paths.js'
import { SourceError } from './errors.js'
import { fetchCaptionSegments, fetchPlayerResponse, readMetadata } from './yt/innertube.js'
import { fetchViaSupadata } from './yt/supadata.js'
import { fetchViaYtDlp, hasYtDlp } from './yt/ytdlp.js'
import { parseVideoId, timestampUrl, watchUrl } from './yt/url.js'
import { normalizeLanguages } from './yt/languages.js'
import { formatDuration, formatTimestamp, groupTranscriptEntries } from './segment.js'
import { parseChaptersFromDescription } from './chapters.js'

export const CACHE_VERSION = 1
export const MAX_INLINE_CHARS = 60_000

const CAPTION_ERROR_CODES = new Set([
  'NO_CAPTIONS',
  'EMPTY_CAPTIONS',
  'CAPTION_PARSE',
  'SUPADATA_EMPTY',
  'SUPADATA_FORMAT',
  'SUPADATA_JOB_FAILED',
  'YTDLP_FAILED',
  'YTDLP_PARSE',
])

/** 兼容旧缓存/损坏缓存：读失败或格式不符时视为没有缓存。 */
export function readCache(videoId) {
  const paths = cachePaths(videoId)
  if (!existsSync(paths.json)) return null
  try {
    const data = JSON.parse(readFileSync(paths.json, 'utf8'))
    if (!data || data.version !== CACHE_VERSION) return null
    if (!Array.isArray(data.segments) || data.segments.length === 0) return null
    if (typeof data.videoId !== 'string' || data.videoId !== videoId) return null
    return data
  } catch {
    return null
  }
}

export function writeCache(record) {
  const paths = cachePaths(record.videoId)
  try {
    ensureDir(paths.dir)
    const json = JSON.stringify(record, null, 2)
    writeFileSync(paths.json, json, 'utf8')
    writeFileSync(paths.md, renderTranscriptMarkdown(record), 'utf8')
  } catch (error) {
    throw new Error(`写入本地缓存失败：${paths.dir}（${error.message}）。请检查 $DSH_HOME 是否存在且可写。`)
  }
  return paths
}

/** 转录 Markdown：人/模型都可直接 read，每条段落带 [MM:SS]。 */
export function renderTranscriptMarkdown(record) {
  const lines = []
  const title = record.title || `YouTube ${record.videoId}`
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`- 频道：${record.channel || '未知'}`)
  lines.push(`- 时长：${formatDuration(record.durationSeconds)}`)
  lines.push(`- 视频：${watchUrl(record.videoId)}`)
  lines.push(`- 字幕：${record.language || 'unknown'}${record.captionKind === 'asr' ? '（自动生成）' : '（原生）'}`)
  lines.push(`- 抓取：${record.fetchedAt} · 来源：${record.source}`)
  lines.push('')
  if (record.description && record.description.trim()) {
    lines.push('## 视频描述')
    lines.push('')
    lines.push(record.description.trim())
    lines.push('')
  }
  if (Array.isArray(record.chapters) && record.chapters.length) {
    lines.push('## 章节')
    lines.push('')
    for (const chapter of record.chapters) {
      lines.push(`- [${formatTimestamp(chapter.startSeconds)}] ${chapter.title}`)
    }
    lines.push('')
  }
  lines.push('## 转录')
  lines.push('')
  for (const segment of record.segments) {
    lines.push(`[${formatTimestamp(segment.start)}] ${segment.text}`)
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** inline=true 时放进工具返回值的正文（超长截断）。 */
export function buildInlineText(record, format = 'segments') {
  const full =
    format === 'text'
      ? record.segments.map((segment) => segment.text).join('\n\n')
      : record.segments.map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`).join('\n')
  if (full.length <= MAX_INLINE_CHARS) return full
  return `${full.slice(0, MAX_INLINE_CHARS)}\n\n…（已截断：正文共 ${full.length} 个字符；完整内容见缓存 Markdown，用 read 工具读取）`
}

/** 工具返回里的短预览：head 前几段、tail 最后两段。 */
export function buildPreview(record, { headLines = 3, tailLines = 2, maxChars = 160 } = {}) {
  const clip = (text) => (text.length > maxChars ? `${text.slice(0, maxChars)}…` : text)
  const line = (segment) => `[${formatTimestamp(segment.start)}] ${clip(segment.text)}`
  const all = record.segments
  return {
    head: all.slice(0, headLines).map(line).join('\n'),
    tail: all.slice(Math.max(0, all.length - tailLines)).map(line).join('\n'),
  }
}

async function bestEffortMetadata(videoId, { fetchImpl, signal } = {}) {
  try {
    const playerResult = await fetchPlayerResponse(videoId, { fetchImpl, signal })
    return readMetadata(playerResult.player)
  } catch {
    return { title: '', channel: '', durationSeconds: 0, description: '', publishedAt: undefined }
  }
}

function skippedError(stage, message) {
  return { stage, skipped: true, message }
}

function buildFetchError(videoId, errors, { configError, supadataConfigured }) {
  const failures = errors.filter((item) => item.error)
  const skipped = errors.filter((item) => item.skipped)
  const codes = failures.map((item) => String(item.error?.code || ''))
  const playability = failures.find((item) => codes.length && String(item.error?.code || '').startsWith('PLAYABILITY_'))
  const captionOnly =
    failures.length > 0 &&
    failures.every((item) => {
      const code = String(item.error?.code || '')
      return CAPTION_ERROR_CODES.has(code) || code.startsWith('CAPTION_HTTP_') || code === 'YTDLP_FAILED' || code === 'YTDLP_PARSE'
    })

  let headline = `抓取视频 ${videoId} 的字幕失败。`
  if (playability) headline = playability.error.message
  else if (captionOnly && failures.some((item) => String(item.error?.code || '').startsWith('NO_CAPTIONS') || String(item.error?.code || '').startsWith('EMPTY_CAPTIONS'))) {
    headline = '该视频没有可用字幕（原生或自动生成都没有）。'
  }

  const lines = [headline, '', '尝试结果：']
  for (const item of failures) lines.push(`- ${item.stage}：${item.error.message}`)
  for (const item of skipped) lines.push(`- ${item.stage}：已跳过（${item.message}）`)
  if (configError) lines.push(`- 配置文件：${configError}`)

  lines.push('', '下一步：')
  lines.push('1. 重试一次（YouTube 偶发风控或网络抖动）。')
  if (!supadataConfigured) {
    lines.push(
      '2. 配置 Supadata 兜底：设置环境变量 SUPADATA_API_KEY，或写入 $DSH_HOME/tube-insight/config.json（{"supadataApiKey":"..."}）后重试。',
    )
  } else {
    lines.push('2. 检查 SUPADATA_API_KEY 是否有效、是否还有额度。')
  }
  lines.push('3. 可选安装 yt-dlp 作为最后兜底：`brew install yt-dlp`（重启 Host 后生效）。')
  if (playability) lines.push('4. 该视频有访问限制（地区/年龄/登录），换一个视频或先在浏览器里确认能播放。')
  else if (captionOnly) lines.push('4. 视频本身没有字幕：换一个有字幕的视频；本插件不做语音转写（ASR）。')
  return new Error(lines.join('\n'))
}

/**
 * 抓取（或读缓存）一个视频的元数据 + 语义分段字幕，并写入缓存。
 * @param {{video: string, languages?: string[], refresh?: boolean, fetchImpl?: Function, signal?: AbortSignal}} options
 * @returns {Promise<{record: object, cached: boolean}>}
 */
export async function getTranscript(options = {}) {
  const { video, languages, refresh = false, fetchImpl, signal } = options
  const videoId = parseVideoId(video)
  const wantedLanguages = normalizeLanguages(languages)

  if (!refresh) {
    const cached = readCache(videoId)
    if (cached) return { record: cached, cached: true }
  }

  const { config, configError } = safeReadConfig()
  const supadataKey = resolveSupadataKey(config)
  const errors = []

  let playerResult = null
  let metadata = null
  try {
    playerResult = await fetchPlayerResponse(videoId, { fetchImpl, signal })
    metadata = readMetadata(playerResult.player)
  } catch (error) {
    errors.push({ stage: 'InnerTube（IOS）/ watch 页', error })
  }

  let payload = null
  if (playerResult) {
    try {
      const captions = await fetchCaptionSegments(playerResult.player, wantedLanguages, { fetchImpl, signal })
      payload = { ...captions, source: playerResult.source }
    } catch (error) {
      errors.push({ stage: '字幕数据', error })
    }
  }

  if (!payload && supadataKey) {
    if (signal?.aborted) throw new Error('操作已取消。')
    try {
      const captions = await fetchViaSupadata(videoId, {
        apiKey: supadataKey,
        language: wantedLanguages[0],
        fetchImpl,
        signal,
      })
      metadata = metadata || (await bestEffortMetadata(videoId, { fetchImpl, signal }))
      payload = captions
    } catch (error) {
      errors.push({ stage: 'Supadata', error })
    }
  }

  if (!payload) {
    if (signal?.aborted) throw new Error('操作已取消。')
    const ytDlpReady = await hasYtDlp()
    if (ytDlpReady) {
      try {
        const captions = await fetchViaYtDlp(videoId, wantedLanguages, { signal })
        metadata = metadata || (await bestEffortMetadata(videoId, { fetchImpl, signal }))
        payload = captions
      } catch (error) {
        errors.push({ stage: 'yt-dlp', error })
      }
    } else {
      errors.push(skippedError('yt-dlp', '未安装 yt-dlp（可选兜底）'))
    }
  }

  if (!payload) {
    throw buildFetchError(videoId, errors, {
      configError,
      supadataConfigured: Boolean(supadataKey),
    })
  }

  const segments = groupTranscriptEntries(payload.segments)
  const chapters = parseChaptersFromDescription(metadata?.description || '')
  const record = {
    version: CACHE_VERSION,
    videoId,
    title: metadata?.title || '',
    channel: metadata?.channel || '',
    durationSeconds: metadata?.durationSeconds || 0,
    description: metadata?.description || '',
    language: payload.language || 'unknown',
    captionKind: payload.captionKind === 'asr' ? 'asr' : 'native',
    source: payload.source || 'unknown',
    fetchedAt: new Date().toISOString(),
    segmentCount: segments.length,
    charCount: segments.reduce((sum, segment) => sum + segment.text.length, 0),
    chapters,
    segments,
  }
  if (metadata?.publishedAt) record.publishedAt = metadata.publishedAt

  writeCache(record)
  return { record, cached: false }
}

export { SourceError, timestampUrl, watchUrl }
