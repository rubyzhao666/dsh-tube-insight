// tube_synthesis：把「多轮 tube_search + 人工整理引用」变成一次确定性调用。
// 输入主题/多个检索词 → 复用 lib/search.js 各跑一次检索 → 合并去重（(videoId,startSeconds)，
// 重复命中保留高分者）→ 按视频分组、组内按时间升序、截断 → 生成固定结构的证据底稿 Markdown；
// 可选 dir 落盘（复用 lib/export.js 的 frontmatter/来源/index.md 管线）。
import { isAbsolute } from 'node:path'
import { PLUGIN_VERSION } from './version.js'
import { writeExport } from './export.js'
import { SEARCH_DEFAULTS, resolveSearchScope, searchCachedTranscripts } from './search.js'
import { formatDuration } from './segment.js'
import { watchUrl } from './yt/url.js'

export const SYNTHESIS_DEFAULTS = Object.freeze({
  limitPerVideo: 4,
  maxVideos: 10,
  maxQueries: 6,
  maxQueryChars: 200,
  maxLimitPerVideo: 8,
  maxMaxVideos: 10,
})

function requireTerm(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} 必须是字符串（1–${SYNTHESIS_DEFAULTS.maxQueryChars} 字符）。`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${name} 不能为空：请传 1–${SYNTHESIS_DEFAULTS.maxQueryChars} 字符的主题/检索词。`)
  if (trimmed.length > SYNTHESIS_DEFAULTS.maxQueryChars) {
    throw new Error(`${name} 过长（${trimmed.length} 字符），最多 ${SYNTHESIS_DEFAULTS.maxQueryChars} 字符。`)
  }
  return trimmed
}

function validateExtraQueries(queries) {
  if (queries === undefined || queries === null) return []
  if (!Array.isArray(queries)) {
    throw new Error(`queries 必须是字符串数组（0–${SYNTHESIS_DEFAULTS.maxQueries} 个额外检索词）。`)
  }
  if (queries.length > SYNTHESIS_DEFAULTS.maxQueries) {
    throw new Error(`queries 最多 ${SYNTHESIS_DEFAULTS.maxQueries} 个额外检索词（收到 ${queries.length} 个）。`)
  }
  return queries.map((term, index) => {
    if (typeof term !== 'string') throw new Error(`queries[${index}] 必须是字符串。`)
    const trimmed = term.trim()
    if (!trimmed) throw new Error(`queries[${index}] 不能为空。`)
    if (trimmed.length > SYNTHESIS_DEFAULTS.maxQueryChars) {
      throw new Error(`queries[${index}] 过长（${trimmed.length} 字符），最多 ${SYNTHESIS_DEFAULTS.maxQueryChars} 字符。`)
    }
    return trimmed
  })
}

function validateInt(value, name, min, max, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} 必须是 ${min}–${max} 的数字，收到 ${JSON.stringify(value)}。不传时默认 ${fallback}。`)
  }
  const rounded = Math.floor(value)
  if (rounded < min || rounded > max) {
    throw new Error(`${name} 必须在 ${min}–${max} 之间，收到 ${value}。不传时默认 ${fallback}。`)
  }
  return rounded
}

function validateDir(dir) {
  if (dir === undefined || dir === null) return ''
  if (typeof dir !== 'string') {
    throw new Error('dir 必须是绝对路径字符串（例如 /Users/你/Documents/tube-insight-notes）；不传则不落盘。')
  }
  const trimmed = dir.trim()
  if (!trimmed) return ''
  if (!isAbsolute(trimmed)) {
    throw new Error(`dir 必须是绝对路径（收到 "${trimmed}"）。例如 /Users/你的用户名/Documents/tube-insight-notes。`)
  }
  return trimmed
}

function validateTitle(title) {
  if (title === undefined || title === null) return ''
  if (typeof title !== 'string') throw new Error('title 必须是字符串。')
  const trimmed = title.trim()
  if (!trimmed) return ''
  if (trimmed.length > 200) throw new Error('title 过长（最多 200 字符）。')
  return trimmed
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 固定结构的证据底稿 Markdown（不含 frontmatter，确定性输出）。 */
function renderDraft({ query, terms, scope, selectedVideos, zeroHitVideos }) {
  const totalHits = selectedVideos.reduce((sum, item) => sum + item.hits.length, 0)
  const lines = []
  lines.push(`# 主题检索底稿：${query}`)
  lines.push(
    `> 检索范围：本地缓存 ${scope.scannedVideos} 个视频 / ${scope.scannedSegments} 个段落 · 检索词：${terms.join('、')}`,
  )
  lines.push('', '## 证据（按视频分组）')
  if (selectedVideos.length === 0) {
    lines.push('', '- （无命中）')
  } else {
    for (const item of selectedVideos) {
      const video = item.video
      lines.push(
        '',
        `### ${video.title || video.videoId} · ${video.channel || '未知频道'} · ${formatDuration(video.durationSeconds)}`,
      )
      for (const hit of item.hits) lines.push(`- [${hit.timestamp}](${hit.link}) ${hit.text}`)
    }
  }
  lines.push('', '## 未命中的缓存视频')
  if (zeroHitVideos.length === 0) {
    lines.push('', '- （无）')
  } else {
    for (const video of zeroHitVideos) {
      lines.push(`- ${video.title || video.videoId}（${video.channel || '未知频道'}）— 本主题无命中`)
    }
  }
  lines.push('', '## 检索覆盖')
  lines.push(
    `- 命中 ${selectedVideos.length} 个视频 / ${totalHits} 条证据；扫描 ${scope.scannedVideos} 个视频；缓存 ${scope.cacheVideoCount} 个视频`,
  )
  lines.push('', '## 下一步')
  lines.push('- 基于底稿写综述（共识/分歧/覆盖缺口），引用直接沿用底稿链接；要存档用 tube_export。')
  lines.push('')
  return lines.join('\n')
}

/**
 * 生成主题综述证据底稿（可落盘）。
 * @param {{query: string, queries?: string[], video?: string, since?: string, limitPerVideo?: number, maxVideos?: number, dir?: string, title?: string}} options
 */
export function synthesize(options = {}) {
  const query = requireTerm(options.query, 'query')
  const extraTerms = validateExtraQueries(options.queries)
  const limitPerVideo = validateInt(
    options.limitPerVideo,
    'limitPerVideo',
    1,
    SYNTHESIS_DEFAULTS.maxLimitPerVideo,
    SYNTHESIS_DEFAULTS.limitPerVideo,
  )
  const maxVideos = validateInt(options.maxVideos, 'maxVideos', 1, SYNTHESIS_DEFAULTS.maxMaxVideos, SYNTHESIS_DEFAULTS.maxVideos)
  const dir = validateDir(options.dir)
  const title = validateTitle(options.title)

  // 检索词去重（大小写不敏感），保持首次出现顺序
  const queriedTerms = []
  const seenTerms = new Set()
  for (const term of [query, ...extraTerms]) {
    const key = term.toLowerCase()
    if (seenTerms.has(key)) continue
    seenTerms.add(key)
    queriedTerms.push(term)
  }
  const queries = queriedTerms.slice(1)

  const scope = resolveSearchScope({ video: options.video, since: options.since })
  const videoById = new Map(scope.videos.map((video) => [video.videoId, video]))

  // 多轮检索：每个词各跑一次；按 (videoId,startSeconds) 合并去重，重复命中保留分高者。
  const mergedHits = new Map()
  for (const term of queriedTerms) {
    const result = searchCachedTranscripts({
      query: term,
      video: options.video,
      since: options.since,
      limit: SEARCH_DEFAULTS.maxLimit,
      context: 0,
    })
    for (const hit of result.results) {
      const key = `${hit.videoId}:${hit.startSeconds}`
      const previous = mergedHits.get(key)
      if (!previous || hit.score > previous.score) {
        mergedHits.set(key, {
          videoId: hit.videoId,
          timestamp: hit.timestamp,
          startSeconds: hit.startSeconds,
          link: hit.link,
          text: hit.text,
          score: hit.score,
        })
      }
    }
  }

  // 按视频分组：组内 startSeconds 升序，取前 limitPerVideo
  const hitsByVideo = new Map()
  for (const hit of mergedHits.values()) {
    let list = hitsByVideo.get(hit.videoId)
    if (!list) {
      list = []
      hitsByVideo.set(hit.videoId, list)
    }
    list.push(hit)
  }

  const hitVideos = []
  for (const [videoId, list] of hitsByVideo) {
    const video = videoById.get(videoId)
    if (!video) continue
    list.sort((a, b) => a.startSeconds - b.startSeconds || b.score - a.score || compareText(a.link, b.link))
    const hits = list.slice(0, limitPerVideo).map((hit) => ({
      timestamp: hit.timestamp,
      startSeconds: hit.startSeconds,
      link: hit.link,
      text: hit.text,
    }))
    if (hits.length > 0) hitVideos.push({ video, hits })
  }

  // 视频排序：命中数降序 → 标题（同标题用 videoId 兜底，保证确定性）；取前 maxVideos
  hitVideos.sort(
    (a, b) =>
      b.hits.length - a.hits.length ||
      compareText(a.video.title || a.video.videoId, b.video.title || b.video.videoId) ||
      compareText(a.video.videoId, b.video.videoId),
  )
  const selectedVideos = hitVideos.slice(0, maxVideos)

  // 未命中视频 = 扫描范围内完全没有命中的视频（与 maxVideos 截断无关），按标题排序
  const hitVideoIds = new Set(hitVideos.map((item) => item.video.videoId))
  const zeroHitVideos = scope.videos
    .filter((video) => !hitVideoIds.has(video.videoId))
    .map((video) => ({
      videoId: video.videoId,
      title: video.title || video.videoId,
      channel: video.channel || '',
    }))
    .sort((a, b) => compareText(a.title, b.title) || compareText(a.videoId, b.videoId))

  const markdown = renderDraft({ query, terms: queriedTerms, scope, selectedVideos, zeroHitVideos })
  const totalHits = selectedVideos.reduce((sum, item) => sum + item.hits.length, 0)

  const result = {
    query,
    queries,
    scannedVideos: scope.scannedVideos,
    scannedSegments: scope.scannedSegments,
    videos: selectedVideos.map((item) => ({
      videoId: item.video.videoId,
      title: item.video.title || '',
      channel: item.video.channel || '',
      url: watchUrl(item.video.videoId),
      durationSeconds: Math.max(0, Math.floor(Number(item.video.durationSeconds) || 0)),
      hits: item.hits,
    })),
    coverage: {
      hitVideos: selectedVideos.length,
      zeroHitVideos: zeroHitVideos.map((video) => ({ videoId: video.videoId, title: video.title })),
      totalHits,
      queriedTerms,
    },
    markdown,
  }

  if (!dir) return result

  if (selectedVideos.length === 0) {
    throw new Error('本次检索无命中，未导出；请换检索词（或去掉 dir 只拿空底稿）。')
  }

  // 复用导出管线：frontmatter（module=knowledge + sources=命中视频）+ 文末来源 + index.md + 重名加序号。
  const records = selectedVideos.map((item) => ({
    videoId: item.video.videoId,
    title: item.video.title || '',
    channel: item.video.channel || '',
    durationSeconds: item.video.durationSeconds || 0,
  }))
  const exportTitle = title || `主题综述：${query}`
  try {
    const written = writeExport({
      records,
      module: 'knowledge',
      markdown,
      title: exportTitle,
      dir,
      notes: [],
      pluginVersion: PLUGIN_VERSION,
      slugText: query,
    })
    return { ...result, path: written.path, indexpath: written.indexpath, bytes: written.bytes }
  } catch (error) {
    throw new Error(
      `导出失败：写文件时出错（${error.message}）。请检查 dir 是否存在、是否有写权限，或换一个目录后重试。`,
    )
  }
}
