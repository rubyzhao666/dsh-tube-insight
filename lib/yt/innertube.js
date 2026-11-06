// InnerTube 抓取路径（本机 2026-11-06 实测可用，见 templates/yt-probe/inner-tube-ios.mjs）。
// 链路：
//   1) 取 watch 页 → INNERTUBE_API_KEY / VISITOR_DATA
//   2) youtubei/v1/player 用 IOS client 取 videoDetails + captionTracks
//      （ANDROID client 返回 400、WEB 返回 UNPLAYABLE，不要用）
//   3) captionTracks[].baseUrl + &fmt=json3 取逐段字幕
//   4) 兜底：同一个 watch 页 HTML 里的 ytInitialPlayerResponse（可能被 pot 校验，作第 2 顺位）
import { request, readJson } from '../http.js'
import { normalizeCaptionText } from '../segment.js'
import { SourceError } from '../errors.js'
import { watchUrl } from './url.js'
import { baseLanguage, normalizeLanguages } from './languages.js'

const UA_WEB =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
const UA_IOS = 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X; en_US)'
const IOS_CLIENT = {
  hl: 'en',
  gl: 'US',
  utcOffsetMinutes: 0,
  clientName: 'IOS',
  clientVersion: '20.10.4',
  userAgent: UA_IOS,
  deviceMake: 'Apple',
  deviceModel: 'iPhone16,2',
  osName: 'iPhone',
  osVersion: '18.3.0.22D5054f',
  platform: 'MOBILE',
}

const PLAYABILITY_REASONS = {
  LOGIN_REQUIRED: '需要登录或确认年龄',
  AGE_VERIFICATION_REQUIRED: '有年龄限制',
  UNPLAYABLE: '不可播放（常见于地区/版权限制）',
  VIDEO_UNAVAILABLE: '视频不存在或已下架',
  CONTENT_CHECK_REQUIRED: '需要内容确认',
  LIVE_STREAM_OFFLINE: '直播已结束',
  ERROR: '视频不可用',
}

/** 从 watch 页 HTML 里找出 ytInitialPlayerResponse 并解析。 */
export function extractInitialPlayerResponse(html) {
  if (typeof html !== 'string') return null
  const marker = 'ytInitialPlayerResponse'
  let from = 0
  while (from < html.length) {
    const index = html.indexOf(marker, from)
    if (index < 0) return null
    from = index + marker.length
    let cursor = html.indexOf('{', from)
    if (cursor < 0) return null
    // marker 和对象之间不应该有另一个语句拐走 '{'（最多允许 = 与空白/括号）
    const between = html.slice(from, cursor)
    if (between.length > 40 || /[;\n]/.test(between.replace(/\s/g, ''))) continue
    const raw = scanBalancedObject(html, cursor)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // 继续找下一处（页面里可能有字符串/模板里的同名标记）
    }
  }
  return null
}

function scanBalancedObject(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 从 player 响应里读出元数据。 */
export function readMetadata(player) {
  const details = player?.videoDetails || {}
  const microformat = player?.microformat?.playerMicroformatRenderer || {}
  const duration = Number(details.lengthSeconds) || 0
  const publishedAt =
    typeof microformat.publishDate === 'string' && microformat.publishDate
      ? microformat.publishDate
      : typeof microformat.uploadDate === 'string' && microformat.uploadDate
        ? microformat.uploadDate
        : undefined
  return {
    title: typeof details.title === 'string' ? details.title.trim() : '',
    channel:
      (typeof details.author === 'string' && details.author.trim()) ||
      (typeof microformat.ownerChannelName === 'string' && microformat.ownerChannelName.trim()) ||
      '',
    durationSeconds: Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : 0,
    description: normalizeDescription(
      (typeof details.shortDescription === 'string' && details.shortDescription) ||
        (typeof microformat.description?.simpleText === 'string' && microformat.description.simpleText) ||
        '',
    ),
    publishedAt,
    isLive: details.isLiveContent === true,
  }
}

function normalizeDescription(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}

function assertPlayable(player, source) {
  const status = player?.playabilityStatus?.status
  if (!status || status === 'OK') return
  const reason = player?.playabilityStatus?.reason
  const hint = PLAYABILITY_REASONS[status] || '视频不可播放'
  throw new SourceError(
    `PLAYABILITY_${status}`,
    `该视频无法抓取：${hint}（playabilityStatus: ${status}${reason ? ` · ${reason}` : ''}）。`,
    { source, status },
  )
}

function normalizeTrack(track) {
  if (!track || typeof track.baseUrl !== 'string' || !track.baseUrl) return null
  return {
    baseUrl: track.baseUrl,
    languageCode: typeof track.languageCode === 'string' ? track.languageCode : '',
    kind: track.kind === 'asr' ? 'asr' : 'native',
    name: track.name?.simpleText || track.name?.runs?.map((r) => r?.text).join('') || '',
  }
}

/**
 * 按语言优先级挑一条字幕轨道：优先精确语言匹配，同语言优先原生字幕而非自动生成。
 * @returns {{track:{baseUrl:string,languageCode:string,kind:'native'|'asr'}, language:string, captionKind:'native'|'asr'}|null}
 */
export function pickCaptionTrack(player, languages) {
  const rawTracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks
  const tracks = Array.isArray(rawTracks) ? rawTracks.map(normalizeTrack).filter(Boolean) : []
  if (tracks.length === 0) return null
  const wanted = normalizeLanguages(languages)

  for (const lang of wanted) {
    const exact = tracks.filter((track) => track.languageCode.toLowerCase() === lang.toLowerCase())
    const loose = tracks.filter(
      (track) => !exact.includes(track) && baseLanguage(track.languageCode) === baseLanguage(lang),
    )
    const candidates = exact.length ? exact : loose
    if (candidates.length === 0) continue
    const native = candidates.find((track) => track.kind === 'native')
    const chosen = native || candidates[0]
    return toPicked(chosen)
  }

  const firstNative = tracks.find((track) => track.kind === 'native')
  return toPicked(firstNative || tracks[0])
}

function toPicked(track) {
  return {
    track,
    language: track.languageCode || 'unknown',
    captionKind: track.kind,
  }
}

function withJson3(baseUrl) {
  if (baseUrl.includes('fmt=')) return baseUrl
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}fmt=json3`
}

/** json3 字幕 -> 逐段 {start, duration, text}。 */
export function parseCaptionJson3(json) {
  const events = Array.isArray(json?.events) ? json.events : []
  const segments = []
  for (const event of events) {
    if (!Array.isArray(event?.segs)) continue
    const text = normalizeCaptionText(event.segs.map((seg) => seg?.utf8 || '').join(''))
    if (!text) continue
    const start = Number(event.tStartMs) / 1000
    if (!Number.isFinite(start) || start < 0) continue
    const duration = Number(event.dDurationMs) / 1000
    segments.push({
      start: Math.round(start * 1000) / 1000,
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
      text,
    })
  }
  return segments
}

async function fetchWatchPageHtml(videoId, { fetchImpl, signal } = {}) {
  const response = await request(
    `${watchUrl(videoId)}&hl=en`,
    {
      headers: {
        'User-Agent': UA_WEB,
        'Accept-Language': 'en-US,en;q=0.9',
      },
    },
    { fetchImpl, signal, timeoutMs: 20_000, label: '抓取 YouTube 播放页' },
  )
  if (!response.ok && response.status >= 500) {
    throw new SourceError('WATCH_PAGE_HTTP', `YouTube 播放页返回 HTTP ${response.status}，稍后重试。`, {
      source: 'innertube',
    })
  }
  return response.text()
}

async function requestPlayer(videoId, apiKey, visitorData, { fetchImpl, signal } = {}) {
  const body = {
    context: { client: { ...IOS_CLIENT, visitorData } },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  }
  const response = await request(
    `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA_IOS,
        'X-YouTube-Client-Name': '5',
        'X-YouTube-Client-Version': '20.10.4',
        Origin: 'https://www.youtube.com',
        Referer: watchUrl(videoId),
      },
      body: JSON.stringify(body),
    },
    { fetchImpl, signal, timeoutMs: 25_000, label: '请求 YouTube 播放器接口' },
  )
  if (!response.ok) {
    const preview = await response.text().catch(() => '')
    throw new SourceError(
      `PLAYER_HTTP_${response.status}`,
      `YouTube 播放器接口返回 HTTP ${response.status}（${preview.slice(0, 120).replace(/\s+/g, ' ').trim() || '无内容'}），InnerTube 路径可能已失效。`,
      { source: 'innertube', status: String(response.status) },
    )
  }
  return readJson(response, 'YouTube 播放器接口')
}

/**
 * 拿 player 响应（元数据 + 字幕轨）。先走 InnerTube IOS，失败时退回 watch 页里的 ytInitialPlayerResponse。
 * @returns {Promise<{player: object, source: 'innertube-ios' | 'watch-page'}>}
 */
export async function fetchPlayerResponse(videoId, { fetchImpl, signal } = {}) {
  const html = await fetchWatchPageHtml(videoId, { fetchImpl, signal })
  const apiKey = html.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/)?.[1] || ''
  const visitorData = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] || ''
  const fallback = extractInitialPlayerResponse(html)

  if (apiKey) {
    try {
      const player = await requestPlayer(videoId, apiKey, visitorData, { fetchImpl, signal })
      assertPlayable(player, 'innertube-ios')
      return { player, source: 'innertube-ios' }
    } catch (error) {
      if (fallback) {
        try {
          assertPlayable(fallback, 'watch-page')
          return { player: fallback, source: 'watch-page' }
        } catch {
          throw error
        }
      }
      throw error
    }
  }

  if (fallback) {
    assertPlayable(fallback, 'watch-page')
    return { player: fallback, source: 'watch-page' }
  }

  throw new SourceError(
    'WATCH_PAGE_CHANGED',
    'YouTube 播放页里既没有 INNERTUBE_API_KEY 也没有 ytInitialPlayerResponse（页面结构变化或被风控）。',
    { source: 'innertube', retryable: true },
  )
}

/**
 * 从 player 响应抓字幕并解析成逐段数据。
 * @returns {Promise<{segments: Array<{start:number,duration:number,text:string}>, language: string, captionKind: 'native'|'asr', trackUrl: string}>}
 */
export async function fetchCaptionSegments(player, languages, { fetchImpl, signal } = {}) {
  const picked = pickCaptionTrack(player, languages)
  if (!picked) {
    throw new SourceError('NO_CAPTIONS', '该视频没有可用字幕（原生或自动生成都没有）。', { source: 'innertube' })
  }
  const url = withJson3(picked.track.baseUrl)
  const response = await request(
    url,
    { headers: { 'User-Agent': UA_IOS } },
    { fetchImpl, signal, timeoutMs: 20_000, label: '抓取字幕数据' },
  )
  if (!response.ok) {
    throw new SourceError(
      `CAPTION_HTTP_${response.status}`,
      `字幕数据请求返回 HTTP ${response.status}（YouTube 可能对 timedtext 做了 pot 校验）。`,
      { source: 'innertube', status: String(response.status) },
    )
  }
  const text = await response.text()
  if (!text.trim()) {
    throw new SourceError(
      'EMPTY_CAPTIONS',
      '字幕轨道存在但内容为空（YouTube 的 timedtext 被 pot 校验拦截）。',
      { source: 'innertube' },
    )
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new SourceError(
      'CAPTION_PARSE',
      '字幕数据不是合法 JSON（YouTube 可能改版或触发风控）。',
      { source: 'innertube' },
    )
  }
  const segments = parseCaptionJson3(json)
  if (segments.length === 0) {
    throw new SourceError(
      'EMPTY_CAPTIONS',
      '字幕轨道里没有可解析的逐段内容（可能是空字幕或格式变化）。',
      { source: 'innertube' },
    )
  }
  return {
    segments,
    language: picked.language,
    captionKind: picked.captionKind,
    trackUrl: url,
  }
}
