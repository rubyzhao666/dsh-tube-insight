// 跨视频检索：把本地已缓存的视频转录变成可检索的证据库。
// 只读 $DSH_HOME/tube-insight/cache/*.json，不发网络请求、不写数据目录。
//
// 打分：BM25（k1=1.2, b=0.75）+ query 连续短语 ×1.8 加成；同分按 startSeconds 升序。
// 分词：英文/数字按词（小写、去标点）；CJK 连续片段转字符 bigram（单字查询用单字）；最小停用词表。
// 性能：按「文件路径 + mtime + size」缓存解析与统计结果，避免重复 JSON.parse / 重复统计长度。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { cacheDir } from './paths.js'
import { formatTimestamp } from './segment.js'
import { parseVideoId, timestampUrl, watchUrl } from './yt/url.js'

export const SEARCH_DEFAULTS = Object.freeze({
  limit: 8,
  context: 1,
  maxLimit: 20,
  maxContext: 2,
  maxQueryChars: 200,
  maxScanVideos: 500,
})

const BM25_K1 = 1.2
const BM25_B = 0.75
const PHRASE_BOOST = 1.8
const RESULT_TEXT_MAX = 400
const CONTEXT_TEXT_MAX = 200

const EN_STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'it', 'this', 'that'])
const ZH_STOPWORDS = new Set(['的', '了', '是', '在', '和', '就', '都', '也', '我', '你'])

const EMPTY_CACHE_MESSAGE =
  '本地还没有缓存的视频转录。tube_search 只搜你以前抓过的视频（不是全网搜索）：请先抓取视频 —— 调用 tube_transcript({ video: "<YouTube URL 或 11 位 videoId>" }) 抓取至少一个视频，再回来检索。'

/** 模块级解析缓存：cache 文件路径 -> { mtimeMs, size, broken, video }。 */
const parsedCache = new Map()

/** 测试/调试用：清空模块级缓存。 */
export function clearSearchCache() {
  parsedCache.clear()
}

function isCjkCode(code) {
  return (
    (code >= 0x3400 && code <= 0x9fff) || // CJK 统一表意文字（含扩展 A）
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意文字
    (code >= 0x3040 && code <= 0x30ff) || // 日文假名
    (code >= 0xac00 && code <= 0xd7af) // 韩文音节
  )
}

function isAsciiAlnum(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

/**
 * 查询分词：英文/数字按词（小写、去停用词）；CJK 连续片段转 bigram，单字时用单字。
 * @param {string} query
 * @returns {string[]} 去重后的检索词
 */
export function tokenizeQuery(query) {
  const source = String(query || '').toLowerCase()
  const tokens = []
  let i = 0
  while (i < source.length) {
    const code = source.codePointAt(i)
    if (isCjkCode(code)) {
      const chars = []
      let j = i
      while (j < source.length) {
        const next = source.codePointAt(j)
        if (!isCjkCode(next)) break
        chars.push(String.fromCodePoint(next))
        j += next > 0xffff ? 2 : 1
      }
      if (chars.length === 1) {
        if (!ZH_STOPWORDS.has(chars[0])) tokens.push(chars[0])
      } else {
        for (let k = 0; k < chars.length - 1; k += 1) {
          const bigram = chars[k] + chars[k + 1]
          if (!(ZH_STOPWORDS.has(chars[k]) && ZH_STOPWORDS.has(chars[k + 1]))) tokens.push(bigram)
        }
      }
      i = j
      continue
    }
    if (isAsciiAlnum(code)) {
      let j = i + 1
      while (j < source.length && isAsciiAlnum(source.codePointAt(j))) j += 1
      const word = source.slice(i, j)
      if (!EN_STOPWORDS.has(word)) tokens.push(word)
      i = j
      continue
    }
    i += code > 0xffff ? 2 : 1
  }
  return [...new Set(tokens)]
}

/**
 * 段落长度（词数）：英文/数字按词；CJK 连续片段按 bigram 计（单字片段计 1）。
 * 只用于 BM25 的长度归一化，不做停用词过滤。
 */
export function countDocumentTokens(text) {
  const source = String(text || '').toLowerCase()
  let count = 0
  let i = 0
  while (i < source.length) {
    const code = source.codePointAt(i)
    if (isCjkCode(code)) {
      let runLength = 0
      let j = i
      while (j < source.length) {
        const next = source.codePointAt(j)
        if (!isCjkCode(next)) break
        runLength += 1
        j += next > 0xffff ? 2 : 1
      }
      count += runLength >= 2 ? runLength - 1 : runLength
      i = j
      continue
    }
    if (isAsciiAlnum(code)) {
      count += 1
      let j = i + 1
      while (j < source.length && isAsciiAlnum(source.codePointAt(j))) j += 1
      i = j
      continue
    }
    i += code > 0xffff ? 2 : 1
  }
  return count
}

function normalizePhrase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function isCjkToken(token) {
  if (!token) return false
  const code = token.codePointAt(0)
  return isCjkCode(code)
}

/** 统计 token 在段落里出现的次数：CJK 用子串计数；英文/数字按 alnum 边界。 */
export function countTerm(textLower, token) {
  if (!token) return 0
  let count = 0
  let from = 0
  if (isCjkToken(token)) {
    let index = textLower.indexOf(token, from)
    while (index !== -1) {
      count += 1
      from = index + token.length
      index = textLower.indexOf(token, from)
    }
    return count
  }
  let index = textLower.indexOf(token, from)
  while (index !== -1) {
    const beforeOk = index === 0 || !isAsciiAlnum(textLower.charCodeAt(index - 1))
    const afterIndex = index + token.length
    const afterOk = afterIndex >= textLower.length || !isAsciiAlnum(textLower.charCodeAt(afterIndex))
    if (beforeOk && afterOk) count += 1
    from = index + token.length
    index = textLower.indexOf(token, from)
  }
  return count
}

function loadOneCacheFile(file, videoId) {
  let record
  try {
    record = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { broken: true, video: null }
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { broken: true, video: null }
  if (typeof record.videoId === 'string' && record.videoId !== videoId) return { broken: true, video: null }
  if (!Array.isArray(record.segments) || record.segments.length === 0) return { broken: true, video: null }

  const segments = []
  let totalTokens = 0
  for (const segment of record.segments) {
    if (!segment || typeof segment.text !== 'string') continue
    const text = segment.text
    if (!text.trim()) continue
    const start = Number(segment.start)
    if (!Number.isFinite(start) || start < 0) continue
    const tokens = countDocumentTokens(text)
    segments.push({ start, text, textLower: text.toLowerCase(), dl: tokens })
    totalTokens += tokens
  }
  if (segments.length === 0) return { broken: true, video: null }

  const fetchedAt = typeof record.fetchedAt === 'string' ? record.fetchedAt : ''
  const fetchedAtMs = fetchedAt ? Date.parse(fetchedAt) : Number.NaN
  return {
    broken: false,
    video: {
      videoId,
      title: typeof record.title === 'string' ? record.title : '',
      channel: typeof record.channel === 'string' ? record.channel : '',
      durationSeconds: Number(record.durationSeconds) || 0,
      fetchedAt,
      fetchedAtMs: Number.isFinite(fetchedAtMs) ? fetchedAtMs : null,
      segments,
      avgdl: totalTokens / segments.length,
    },
  }
}

/**
 * 扫描缓存目录，返回可用视频列表（带 mtime 缓存）。
 * @returns {{videos: object[], skipped: number, total: number}}
 */
export function loadCachedVideos() {
  const dir = cacheDir()
  if (!existsSync(dir)) return { videos: [], skipped: 0, total: 0 }

  let files
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return { videos: [], skipped: 0, total: 0 }
  }

  const seen = new Set()
  const videos = []
  let skipped = 0
  for (const name of files) {
    const file = join(dir, name)
    seen.add(file)
    let stat
    try {
      stat = statSync(file)
    } catch {
      continue
    }
    const videoId = name.slice(0, -'.json'.length)
    let cached = parsedCache.get(file)
    if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      cached = { ...loadOneCacheFile(file, videoId), mtimeMs: stat.mtimeMs, size: stat.size }
      parsedCache.set(file, cached)
    }
    if (cached.broken || !cached.video) {
      skipped += 1
      continue
    }
    videos.push(cached.video)
  }

  for (const key of parsedCache.keys()) {
    if (!seen.has(key)) parsedCache.delete(key)
  }
  return { videos, skipped, total: files.length }
}

function validateQuery(query) {
  if (typeof query !== 'string') {
    throw new Error('query 必须是字符串（1–200 字符），例如 query: "model training"。')
  }
  const trimmed = query.trim()
  if (!trimmed) throw new Error('query 不能为空：请传 1–200 字符的检索词。')
  if (trimmed.length > SEARCH_DEFAULTS.maxQueryChars) {
    throw new Error(`query 过长（${trimmed.length} 字符），最多 ${SEARCH_DEFAULTS.maxQueryChars} 字符。请缩短检索词。`)
  }
  return trimmed
}

function validateLimit(limit) {
  if (limit === undefined || limit === null) return SEARCH_DEFAULTS.limit
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new Error(`limit 必须是 1–${SEARCH_DEFAULTS.maxLimit} 的数字，收到 ${JSON.stringify(limit)}。不传时默认 ${SEARCH_DEFAULTS.limit}。`)
  }
  const rounded = Math.floor(limit)
  if (rounded < 1) {
    throw new Error(`limit 必须 ≥ 1，收到 ${limit}。不传时默认 ${SEARCH_DEFAULTS.limit}。`)
  }
  return Math.min(rounded, SEARCH_DEFAULTS.maxLimit)
}

function validateContext(context) {
  if (context === undefined || context === null) return SEARCH_DEFAULTS.context
  if (typeof context !== 'number' || !Number.isFinite(context)) {
    throw new Error(`context 必须是 0–${SEARCH_DEFAULTS.maxContext} 的数字，收到 ${JSON.stringify(context)}。不传时默认 ${SEARCH_DEFAULTS.context}。`)
  }
  const rounded = Math.floor(context)
  if (rounded < 0) {
    throw new Error(`context 必须 ≥ 0，收到 ${context}。不传时默认 1；传 0 表示不要前后文。`)
  }
  return Math.min(rounded, SEARCH_DEFAULTS.maxContext)
}

function validateSince(since) {
  if (since === undefined || since === null) return null
  if (typeof since !== 'string') {
    throw new Error('since 必须是 ISO 日期字符串（YYYY-MM-DD），例如 since: "2026-01-01"。')
  }
  const match = since.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) {
    throw new Error(`since 必须是 ISO 日期（YYYY-MM-DD），收到 "${since}"。例如 since: "2026-01-01"。`)
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const ms = Date.UTC(year, month - 1, day)
  const check = new Date(ms)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`since 不是合法日期："${since}"。请检查月份/日期，例如 "2026-01-01"。`)
  }
  return ms
}

function buildSnippet(text, matchedTerms, queryPhrase) {
  if (text.length <= RESULT_TEXT_MAX) return text
  const lower = text.toLowerCase()
  let position = queryPhrase.length >= 2 ? lower.indexOf(queryPhrase) : -1
  if (position < 0) {
    for (const term of matchedTerms) {
      const index = lower.indexOf(term)
      if (index >= 0 && (position < 0 || index < position)) position = index
    }
  }
  if (position < 0) position = 0

  const hasPrefix = position > 150
  let start = hasPrefix ? position - 150 : 0
  const suffixBudget = start + RESULT_TEXT_MAX < text.length ? 1 : 0
  const prefixBudget = hasPrefix ? 1 : 0
  const coreLength = RESULT_TEXT_MAX - prefixBudget - suffixBudget
  const end = Math.min(text.length, start + coreLength)
  return `${hasPrefix ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

function joinContext(segments, indices, { fromEnd }) {
  if (indices.length === 0) return undefined
  const joined = indices.map((index) => segments[index].text).join(' ')
  if (joined.length <= CONTEXT_TEXT_MAX) return joined
  return fromEnd ? `…${joined.slice(-CONTEXT_TEXT_MAX + 1)}` : `${joined.slice(0, CONTEXT_TEXT_MAX - 1)}…`
}

/**
 * 解析检索范围：加载缓存 → video/since 过滤 → >500 条按 fetchedAt 截断。
 * tube_search 与 tube_synthesis 共用，保证两者的「扫描范围」一致。
 * @returns {{videos: object[], scannedVideos: number, scannedSegments: number, truncated: boolean, skippedCacheFiles: number, cacheVideoCount: number}}
 */
export function resolveSearchScope(options = {}) {
  const sinceMs = validateSince(options.since)
  const { videos: loadedVideos, skipped: skippedCacheFiles, total: cacheFileCount } = loadCachedVideos()
  if (cacheFileCount === 0) throw new Error(EMPTY_CACHE_MESSAGE)
  if (loadedVideos.length === 0) {
    throw new Error(
      `缓存目录里没有可用的视频转录（${skippedCacheFiles} 个缓存文件损坏或格式不正确）：${cacheDir()}。` +
        '请重新抓取视频 —— 调用 tube_transcript({ video: "<URL 或 ID>", refresh: true }) 强制重抓；或者删掉损坏的缓存文件。',
    )
  }

  let videos = loadedVideos
  let truncated = false
  const targeted = options.video !== undefined && options.video !== null
  if (targeted) {
    const videoId = parseVideoId(options.video)
    const found = videos.find((video) => video.videoId === videoId)
    if (!found) {
      throw new Error(
        `视频 ${videoId} 不在本地缓存里（当前已缓存 ${videos.length} 个视频）。请先抓取视频：tube_transcript({ video: "${videoId}" })，然后再检索。`,
      )
    }
    videos = [found]
  } else if (videos.length > SEARCH_DEFAULTS.maxScanVideos) {
    videos = [...videos]
      .sort((a, b) => (b.fetchedAtMs ?? 0) - (a.fetchedAtMs ?? 0))
      .slice(0, SEARCH_DEFAULTS.maxScanVideos)
    truncated = true
  }

  if (sinceMs !== null) {
    videos = videos.filter((video) => video.fetchedAtMs === null || video.fetchedAtMs >= sinceMs)
  }

  return {
    videos,
    scannedVideos: videos.length,
    scannedSegments: videos.reduce((sum, video) => sum + video.segments.length, 0),
    truncated,
    skippedCacheFiles,
    cacheVideoCount: loadedVideos.length,
  }
}

/**
 * 跨视频检索（只读本地缓存）。
 * @param {{query: string, video?: string, since?: string, limit?: number, context?: number}} options
 * @returns {{query: string, scannedVideos: number, matchedVideos: number, resultCount: number, scannedSegments: number, elapsedMs: number, truncated?: boolean, skippedCacheFiles?: number, results: object[]}}
 */
export function searchCachedTranscripts(options = {}) {
  const started = performance.now()
  const query = validateQuery(options.query)
  const limit = validateLimit(options.limit)
  const context = validateContext(options.context)

  const scope = resolveSearchScope(options)
  const videos = scope.videos
  const scannedVideos = scope.scannedVideos
  const scannedSegments = scope.scannedSegments
  const truncated = scope.truncated
  const skippedCacheFiles = scope.skippedCacheFiles
  const queryPhrase = normalizePhrase(query)
  const tokens = tokenizeQuery(query)

  const results = []
  let matchedVideos = 0

  if (tokens.length > 0 && scannedSegments > 0) {
    const documentCount = scannedSegments
    const totalDl = videos.reduce((sum, video) => sum + video.avgdl * video.segments.length, 0)
    const avgdl = documentCount > 0 ? totalDl / documentCount : 0

    const documentFreq = new Array(tokens.length).fill(0)
    const candidates = []

    for (const video of videos) {
      for (let index = 0; index < video.segments.length; index += 1) {
        const segment = video.segments[index]
        if (!segment.textLower) continue
        const termFreq = new Array(tokens.length).fill(0)
        let anyTerm = false
        for (let t = 0; t < tokens.length; t += 1) {
          const count = countTerm(segment.textLower, tokens[t])
          if (count > 0) {
            termFreq[t] = count
            documentFreq[t] += 1
            anyTerm = true
          }
        }
        const phrase = queryPhrase.length >= 2 && segment.textLower.includes(queryPhrase)
        if (anyTerm || phrase) candidates.push({ video, index, segment, termFreq, phrase })
      }
    }

    const scored = []
    for (const candidate of candidates) {
      let score = 0
      for (let t = 0; t < tokens.length; t += 1) {
        const freq = candidate.termFreq[t]
        if (freq <= 0) continue
        const df = documentFreq[t]
        const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5))
        const lengthNorm = 1 - BM25_B + (BM25_B * candidate.segment.dl) / (avgdl || 1)
        score += (idf * (freq * (BM25_K1 + 1))) / (freq + BM25_K1 * lengthNorm)
      }
      if (candidate.phrase) score *= PHRASE_BOOST
      if (score <= 0) continue
      scored.push({ ...candidate, score })
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const startA = Math.floor(a.segment.start)
      const startB = Math.floor(b.segment.start)
      if (startA !== startB) return startA - startB
      if (a.video.videoId !== b.video.videoId) return a.video.videoId.localeCompare(b.video.videoId)
      return a.index - b.index
    })

    const matchedVideoIds = new Set()
    for (const item of scored.slice(0, limit)) {
      const startSeconds = Math.floor(item.segment.start)
      const matchedTerms = tokens.filter((_token, t) => item.termFreq[t] > 0)
      const result = {
        videoId: item.video.videoId,
        title: item.video.title,
        channel: item.video.channel,
        url: watchUrl(item.video.videoId),
        startSeconds,
        timestamp: formatTimestamp(startSeconds),
        link: timestampUrl(item.video.videoId, startSeconds),
        text: buildSnippet(item.segment.text, matchedTerms, queryPhrase),
        score: Math.round(item.score * 1000) / 1000,
        matchedTerms,
      }
      if (context > 0) {
        const beforeIndices = []
        for (let offset = context; offset >= 1; offset -= 1) {
          const beforeIndex = item.index - offset
          if (beforeIndex >= 0) beforeIndices.push(beforeIndex)
        }
        const afterIndices = []
        for (let offset = 1; offset <= context; offset += 1) {
          const afterIndex = item.index + offset
          if (afterIndex < item.video.segments.length) afterIndices.push(afterIndex)
        }
        const before = joinContext(item.video.segments, beforeIndices, { fromEnd: true })
        const after = joinContext(item.video.segments, afterIndices, { fromEnd: false })
        if (before !== undefined) result.before = before
        if (after !== undefined) result.after = after
      }
      results.push(result)
      matchedVideoIds.add(item.video.videoId)
    }
    matchedVideos = matchedVideoIds.size
  }

  const value = {
    query,
    scannedVideos,
    matchedVideos,
    resultCount: results.length,
    scannedSegments,
    elapsedMs: Math.round(performance.now() - started),
    results,
  }
  if (truncated) value.truncated = true
  if (skippedCacheFiles > 0) value.skippedCacheFiles = skippedCacheFiles
  return value
}
