// YouTube URL / videoId 解析。

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/
const PATH_ID_RE = /\/(?:shorts|embed|live|v|e)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/

const EXAMPLES =
  '请传 YouTube 链接或 11 位 videoId，例如：https://www.youtube.com/watch?v=zjkBMFhNj_g、https://youtu.be/zjkBMFhNj_g、zjkBMFhNj_g。'

export function isVideoId(value) {
  return typeof value === 'string' && VIDEO_ID_RE.test(value.trim())
}

/**
 * 从 URL / 裸 ID 中解析 11 位 YouTube videoId。
 * 支持 watch?v=、youtu.be、shorts、embed、live、music.youtube.com 等常见形式。
 * @param {string} input
 * @returns {string}
 */
export function parseVideoId(input) {
  if (typeof input !== 'string') throw new Error(`video 参数必须是字符串。${EXAMPLES}`)
  const raw = input.trim()
  if (!raw) throw new Error(`video 参数不能为空。${EXAMPLES}`)
  if (VIDEO_ID_RE.test(raw)) return raw

  const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`
  let url
  try {
    url = new URL(withProtocol)
  } catch {
    throw new Error(`无法解析 video 参数："${raw}"。${EXAMPLES}`)
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const isYoutube = host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be' || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')
  if (!isYoutube) {
    throw new Error(`只支持 YouTube 链接，收到的是：${url.hostname}。${EXAMPLES}`)
  }

  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] || ''
    if (VIDEO_ID_RE.test(id)) return id
    throw new Error(`youtu.be 链接里没有合法的 11 位 videoId："${raw}"。${EXAMPLES}`)
  }

  const fromQuery = url.searchParams.get('v') || url.searchParams.get('video_id') || ''
  if (VIDEO_ID_RE.test(fromQuery.trim())) return fromQuery.trim()

  const fromPath = url.pathname.match(PATH_ID_RE)
  if (fromPath && VIDEO_ID_RE.test(fromPath[1])) return fromPath[1]

  throw new Error(`这个 YouTube 链接里没有 videoId（可能是频道/播放列表页）："${raw}"。${EXAMPLES}`)
}

/** 规范化 URL 形式的视频链接（用于 YouTube 播放）。 */
export function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`
}

/** 带时间戳的短链接，用于 Markdown 引用。 */
export function timestampUrl(videoId, seconds = 0) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  return `https://youtu.be/${videoId}?t=${s}`
}
