// 从视频描述里解析章节时间戳（YouTube 描述的常见写法）：
//   0:00 开场 / 00:00 开场 / 00:00 - 开场 / [00:00] 开场
// 解析不到（或只有孤零零一条，噪声太大）就返回空数组。

const MAX_CHAPTERS = 100
const TIMESTAMP_LINE_RE =
  /^\s*(?:[-*•·]\s*)?\[?(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\]?\s*(?:[-–—~～至]\s*\d{1,2}:[0-5]\d(?::[0-5]\d)?)?\s*(?:[|·:：—–]|[-–—]\s)?\s*(.+?)\s*$/

/**
 * @param {string} description 视频描述
 * @param {{maxChapters?: number, minChapters?: number}} [options]
 * @returns {Array<{title:string,startSeconds:number}>}
 */
export function parseChaptersFromDescription(description, options = {}) {
  const maxChapters = options.maxChapters ?? MAX_CHAPTERS
  const minChapters = options.minChapters ?? 2
  if (typeof description !== 'string' || !description.trim()) return []

  const byStart = new Map()
  for (const line of description.split(/\r?\n/)) {
    const match = line.match(TIMESTAMP_LINE_RE)
    if (!match) continue
    const startSeconds = toSeconds(match[1], match[2], match[3])
    if (!Number.isFinite(startSeconds) || startSeconds < 0) continue
    const title = cleanTitle(match[4])
    if (!title || isBareUrl(title)) continue
    if (!byStart.has(startSeconds)) byStart.set(startSeconds, { title, startSeconds })
  }

  const chapters = [...byStart.values()]
    .sort((a, b) => a.startSeconds - b.startSeconds)
    .slice(0, maxChapters)
  if (chapters.length < minChapters) return []
  return chapters
}

function toSeconds(first, second, third) {
  const a = Number(first)
  const b = Number(second)
  if (third === undefined) return a * 60 + b
  return a * 3600 + b * 60 + Number(third)
}

function cleanTitle(raw) {
  const title = String(raw || '')
    .replace(/^[\s\-–—:：|·]+/, '')
    .replace(/[\s\-–—]+$/, '')
    .trim()
  if (!title) return ''
  if (title.length > 200) return title.slice(0, 200).trim()
  return title
}

function isBareUrl(title) {
  return /^https?:\/\/\S+$/i.test(title)
}
