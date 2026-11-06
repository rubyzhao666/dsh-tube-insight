// 模型工具：tube_transcript（抓字幕）/ tube_search（跨视频检索）/ tube_export（导出 Markdown）。
// 约定见 PLUGIN-DEV-GUIDE §3：原始 JSON Schema、execute 返回可序列化对象、render 是模型唯一观察面。
import { cacheDir, cachePaths } from './paths.js'
import { PLUGIN_VERSION } from './version.js'
import { writeExport, MODULES, MODULE_LABELS, slugify } from './export.js'
import { searchCachedTranscripts } from './search.js'
import { parseVideoId } from './yt/url.js'
import { DEFAULT_LANGUAGES } from './yt/languages.js'
import {
  MAX_INLINE_CHARS,
  buildInlineText,
  buildPreview,
  getTranscript,
} from './transcript.js'
import { formatDuration, formatTimestamp } from './segment.js'
import { isAbsolute } from 'node:path'

const text = (value) => [{ type: 'text', text: value }]

const VIDEO_ARG_DESC =
  'YouTube 视频 URL 或 11 位 videoId，例如 https://www.youtube.com/watch?v=zjkBMFhNj_g、https://youtu.be/zjkBMFhNj_g、zjkBMFhNj_g。'

function fail(message) {
  throw new Error(message)
}

function readArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('参数必须是对象。')
  return args
}

function requireString(value, name, { maxLength } = {}) {
  if (typeof value !== 'string') fail(`${name} 必须是字符串。`)
  const trimmed = value.trim()
  if (!trimmed) fail(`${name} 不能为空。`)
  if (maxLength && trimmed.length > maxLength) fail(`${name} 过长（最多 ${maxLength} 字符）。`)
  return trimmed
}

function optionalString(value, name, options = {}) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(`${name} 必须是字符串。`)
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (options.maxLength && trimmed.length > options.maxLength) {
    fail(`${name} 过长（最多 ${options.maxLength} 字符）。`)
  }
  return trimmed
}

function optionalBoolean(value, name, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') fail(`${name} 必须是 boolean（true/false）。`)
  return value
}

function optionalEnum(value, name, allowed, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(`${name} 必须是以下之一：${allowed.join(' | ')}。`)
  }
  return value
}

function optionalStringArray(value, name, { maxItems } = {}) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) fail(`${name} 必须是字符串数组。`)
  const items = value.map((item, index) => {
    if (typeof item !== 'string') fail(`${name}[${index}] 必须是字符串。`)
    const trimmed = item.trim()
    if (!trimmed) fail(`${name}[${index}] 不能为空。`)
    return trimmed
  })
  if (items.length === 0) return undefined
  if (maxItems && items.length > maxItems) fail(`${name} 最多 ${maxItems} 项（收到 ${items.length} 项）。`)
  return items
}

const transcriptOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'videoId',
    'title',
    'channel',
    'durationSeconds',
    'language',
    'captionKind',
    'source',
    'segmentCount',
    'charCount',
    'chapters',
    'transcriptPath',
    'cacheJsonPath',
    'fetchedAt',
    'cached',
    'preview',
  ],
  properties: {
    videoId: { type: 'string' },
    title: { type: 'string' },
    channel: { type: 'string' },
    durationSeconds: { type: 'number' },
    publishedAt: { type: 'string' },
    language: { type: 'string' },
    captionKind: { type: 'string', enum: ['native', 'asr'] },
    source: { type: 'string' },
    segmentCount: { type: 'number' },
    charCount: { type: 'number' },
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'startSeconds'],
        properties: {
          title: { type: 'string' },
          startSeconds: { type: 'number' },
        },
      },
    },
    transcriptPath: { type: 'string' },
    cacheJsonPath: { type: 'string' },
    fetchedAt: { type: 'string' },
    cached: { type: 'boolean' },
    preview: {
      type: 'object',
      additionalProperties: false,
      required: ['head', 'tail'],
      properties: { head: { type: 'string' }, tail: { type: 'string' } },
    },
    inlineText: { type: 'string' },
    truncated: { type: 'boolean' },
  },
}

export const tubeTranscript = {
  name: 'tube_transcript',
  description:
    '抓取 YouTube 视频的元数据与字幕（原生或自动生成），合并成带起始秒的语义段落并缓存到本地；返回标题/频道/时长/字幕语言/章节/缓存路径与预览。' +
    '需要全文时用 read 工具读返回的 transcriptPath，不要凭预览推断内容。用户给出 YouTube 链接、要视频字幕/视频转笔记/视频讲了什么时先调用它。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['video'],
    properties: {
      video: { type: 'string', description: VIDEO_ARG_DESC },
      languages: {
        type: 'array',
        items: { type: 'string' },
        description: `字幕语言优先级，默认 ${JSON.stringify(DEFAULT_LANGUAGES)}。按顺序找原生字幕，找不到再按顺序找自动字幕。注意：缓存按 videoId 存一份，语言偏好只在首次抓取时生效，要换语言用 refresh=true。`,
      },
      refresh: { type: 'boolean', description: 'true 时忽略本地缓存重新抓取；默认 false（命中缓存时秒回）。' },
      format: {
        type: 'string',
        enum: ['segments', 'text'],
        description: 'inlineText 的组织方式：segments 每段带 [MM:SS]（默认）；text 为无时间戳的纯文本段落。',
      },
      inline: {
        type: 'boolean',
        description: `true 时把完整转录正文放进返回值（上限约 ${MAX_INLINE_CHARS} 字符，超出会截断并注明）；默认 false，只返回预览和缓存路径。`,
      },
    },
  },
  timeoutMs: 300_000,
  output: {
    schema: transcriptOutputSchema,
    render(_args, value) {
      const args = _args || {}
      const title = value.title || '（未取到标题）'
      const caption = value.captionKind === 'asr' ? '自动生成' : '原生'
      const lines = []
      lines.push(`TubeInsight 已抓取：${title}`)
      lines.push(
        `频道：${value.channel || '未知'} · 时长 ${formatDuration(value.durationSeconds)} · 字幕 ${value.language}（${caption}） · 段落 ${value.segmentCount} · 字符 ${value.charCount} · 章节 ${value.chapters.length}`,
      )
      lines.push(`缓存：${value.transcriptPath}`)
      lines.push(`JSON：${value.cacheJsonPath}`)
      lines.push(
        value.cached
          ? '（本次命中本地缓存；需要重新抓取用 refresh=true）'
          : `（来源：${value.source}，已写入本地缓存）`,
      )
      if (value.cached && Array.isArray(args.languages) && args.languages.length && !args.languages.includes(value.language)) {
        lines.push(
          `（注意：本地缓存的是 ${value.language} 字幕，与你要求的 ${args.languages.join(' / ')} 不同。缓存按 videoId 存一份，要按语言优先级重抓请传 refresh=true。）`,
        )
      }
      if (value.preview.head) {
        lines.push('', '预览（开头）：', value.preview.head)
      }
      if (value.chapters.length) {
        const chapterLines = value.chapters
          .slice(0, 6)
          .map((chapter) => `- [${formatTimestamp(chapter.startSeconds)}] ${chapter.title}`)
          .join('\n')
        lines.push('', `章节（共 ${value.chapters.length} 个）：`, chapterLines)
      }
      lines.push(
        '',
        '下一步：',
        '- 需要完整内容：用 read 工具读 transcriptPath（不要根据预览编造细节）。',
        '- 要产出笔记/产品情报/洞察/PRD/对比并落盘：按 skill 工作流写好后调用 tube_export。',
      )
      if (value.inlineText !== undefined) {
        lines.push('', `转录正文（inline${value.truncated ? '，已截断' : ''}）：`, value.inlineText)
      }
      return text(lines.join('\n'))
    },
  },
  async execute(args, exec) {
    const input = readArgs(args)
    const video = requireString(input.video, 'video', { maxLength: 500 })
    const languages = optionalStringArray(input.languages, 'languages', { maxItems: 20 })
    const refresh = optionalBoolean(input.refresh, 'refresh', false)
    const format = optionalEnum(input.format, 'format', ['segments', 'text'], 'segments')
    const inline = optionalBoolean(input.inline, 'inline', false)

    const { record, cached } = await getTranscript({
      video,
      languages,
      refresh,
      signal: exec?.signal,
    })
    const paths = cachePaths(record.videoId)
    const preview = buildPreview(record)
    const value = {
      videoId: record.videoId,
      title: record.title || '',
      channel: record.channel || '',
      durationSeconds: Math.max(0, Math.floor(Number(record.durationSeconds) || 0)),
      language: record.language || 'unknown',
      captionKind: record.captionKind === 'asr' ? 'asr' : 'native',
      source: record.source || 'unknown',
      segmentCount: record.segments.length,
      charCount: record.charCount || record.segments.reduce((sum, segment) => sum + segment.text.length, 0),
      chapters: record.chapters.map((chapter) => ({
        title: chapter.title,
        startSeconds: Math.max(0, Math.floor(Number(chapter.startSeconds) || 0)),
      })),
      transcriptPath: paths.md,
      cacheJsonPath: paths.json,
      fetchedAt: record.fetchedAt,
      cached,
      preview,
    }
    if (record.publishedAt) value.publishedAt = record.publishedAt
    if (inline) {
      const inlineText = buildInlineText(record, format)
      value.inlineText = inlineText
      value.truncated = inlineText.includes('…（已截断：')
    }
    return value
  },
}

const exportOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'indexpath', 'bytes', 'title', 'module', 'videos'],
  properties: {
    path: { type: 'string' },
    indexpath: { type: 'string' },
    bytes: { type: 'number' },
    title: { type: 'string' },
    module: { type: 'string' },
    videos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['videoId', 'title', 'channel', 'durationSeconds', 'url'],
        properties: {
          videoId: { type: 'string' },
          title: { type: 'string' },
          channel: { type: 'string' },
          durationSeconds: { type: 'number' },
          url: { type: 'string' },
        },
      },
    },
  },
}

export const tubeExport = {
  name: 'tube_export',
  description:
    '把模型写好的 Markdown 正文与 1–10 个 YouTube 视频的元数据合成为一份归档笔记：自动加 YAML frontmatter、文末「来源」区块（含 youtu.be 时间戳链接）、' +
    '写入导出目录并更新同目录 index.md，返回文件路径。用户要把视频洞察/笔记/PRD/对比存档、导出 Markdown 时调用。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['videos', 'module', 'markdown'],
    properties: {
      videos: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 10,
        description: `1–10 个 YouTube URL 或 videoId。${VIDEO_ARG_DESC}`,
      },
      module: {
        type: 'string',
        enum: [...MODULES],
        description: `内容模块：${MODULES.map((module) => `${module}（${MODULE_LABELS[module]}）`).join('、')}。决定 frontmatter 里的 module 与 index.md 分组。`,
      },
      markdown: {
        type: 'string',
        description: '模型按 skill 工作流写好的正文（Markdown）。插件不改写正文，只拼 frontmatter、我的笔记与来源区块。',
      },
      title: { type: 'string', description: '导出标题；缺省时用第一个视频的标题。也用于生成文件名。' },
      dir: {
        type: 'string',
        description: '导出目录的绝对路径；缺省为 ~/TubeInsight。建议传用户工作区里的绝对路径。',
      },
      notes: {
        type: 'array',
        items: { type: 'string' },
        description: '用户笔记，原样追加为「## 我的笔记」列表。',
      },
    },
  },
  timeoutMs: 300_000,
  output: {
    schema: exportOutputSchema,
    render(_args, value) {
      const label = MODULE_LABELS[value.module] || value.module
      const lines = []
      lines.push(`已导出：${value.path}`)
      lines.push(`标题：${value.title} · 模块：${value.module}（${label}） · ${value.videos.length} 个视频 · ${(value.bytes / 1024).toFixed(1)} KB`)
      lines.push(`索引：${value.indexpath}（同目录按 module 分组，重复导出会更新）`)
      lines.push(
        '',
        '下一步：',
        '- 用 read 工具读导出文件，确认 frontmatter、[MM:SS] 引用与来源链接是否完整。',
        '- 把文件路径告诉用户（可直接用 Obsidian/Typora 打开），不要只回复成功。',
      )
      return text(lines.join('\n'))
    },
  },
  async execute(args, exec) {
    const input = readArgs(args)
    const rawVideos = input.videos
    if (!Array.isArray(rawVideos)) fail('videos 必须是字符串数组（1–10 个 YouTube URL 或 videoId）。')
    if (rawVideos.length === 0) fail('videos 至少有 1 个视频。')
    if (rawVideos.length > 10) fail(`videos 最多 10 个视频（收到 ${rawVideos.length} 个）。`)
    const module = optionalEnum(input.module, 'module', [...MODULES], undefined)
    if (!module) fail(`module 必填，取值：${MODULES.join(' | ')}。`)
    const markdown = requireString(input.markdown, 'markdown', { maxLength: 400_000 })
    const title = optionalString(input.title, 'title', { maxLength: 200 })
    const notes = optionalStringArray(input.notes, 'notes', { maxItems: 50 })
    const dir = optionalString(input.dir, 'dir', { maxLength: 500 })
    if (dir && !isAbsolute(dir)) {
      fail(`dir 必须是绝对路径（收到 "${dir}"）。例如 /Users/你的用户名/Documents/tube-insight-notes。`)
    }

    const videoIds = []
    for (const item of rawVideos) {
      const videoId = parseVideoId(item)
      if (!videoIds.includes(videoId)) videoIds.push(videoId)
    }

    const records = []
    for (const videoId of videoIds) {
      try {
        const { record } = await getTranscript({ video: videoId, signal: exec?.signal })
        records.push(record)
      } catch (error) {
        throw new Error(
          `导出失败：视频 ${videoId} 的元数据不在本地缓存，抓取也失败了。\n原因：${error.message}\n` +
            '建议：先用 tube_transcript 抓取该视频，或从 videos 参数里移除它后重试。',
        )
      }
    }

    try {
      return writeExport({ records, module, markdown, title, dir, notes, pluginVersion: PLUGIN_VERSION })
    } catch (error) {
      throw new Error(
        `导出失败：写文件时出错（${error.message}）。请检查 dir 是否有写权限、路径是否指向一个已存在的文件。`,
      )
    }
  },
}

const searchOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'query',
    'scannedVideos',
    'matchedVideos',
    'resultCount',
    'scannedSegments',
    'elapsedMs',
    'results',
  ],
  properties: {
    query: { type: 'string' },
    scannedVideos: { type: 'number' },
    matchedVideos: { type: 'number' },
    resultCount: { type: 'number' },
    scannedSegments: { type: 'number' },
    elapsedMs: { type: 'number' },
    truncated: { type: 'boolean' },
    skippedCacheFiles: { type: 'number' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['videoId', 'title', 'channel', 'url', 'startSeconds', 'timestamp', 'link', 'text', 'score', 'matchedTerms'],
        properties: {
          videoId: { type: 'string' },
          title: { type: 'string' },
          channel: { type: 'string' },
          url: { type: 'string' },
          startSeconds: { type: 'number' },
          timestamp: { type: 'string' },
          link: { type: 'string' },
          text: { type: 'string' },
          score: { type: 'number' },
          matchedTerms: { type: 'array', items: { type: 'string' } },
          before: { type: 'string' },
          after: { type: 'string' },
        },
      },
    },
  },
}

export const tubeSearch = {
  name: 'tube_search',
  description:
    '在用户以前抓取过的 YouTube 视频转录里做跨视频检索（只搜本机缓存 $DSH_HOME/tube-insight/cache，不是全网搜索）：返回命中段落原文、所属视频、[MM:SS] 时间戳和可跳转链接。' +
    '适合「我以前看过的视频里关于 X 是怎么说的」、找回忆、做主题综述与多视频对比取证。需要先用 tube_transcript 抓取过视频；空缓存会报错并提示先抓取视频。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: '检索词，1–200 字符，支持中英文混合。英文按词匹配，中文按连续片段（bigram）匹配。',
      },
      video: {
        type: 'string',
        description: '可选：只搜这一条视频（URL 或 11 位 videoId）。解析不了会报错；不在缓存里也会报错并提示先抓取。',
      },
      since: {
        type: 'string',
        description: '可选：只搜缓存时间（fetchedAt）不早于该日期的视频，ISO 日期 YYYY-MM-DD。',
      },
      limit: {
        type: 'number',
        description: '可选：返回多少条结果，1–20，默认 8（大于 20 按 20 处理）。',
      },
      context: {
        type: 'number',
        description: '可选：命中段前后各返回几段作为 before/after，0–2，默认 1；传 0 表示不要前后文。',
      },
    },
  },
  timeoutMs: 30_000,
  output: {
    schema: searchOutputSchema,
    render(_args, value) {
      const lines = []
      lines.push(`TubeInsight 跨视频检索：「${value.query}」`)
      const extras = []
      if (value.truncated) extras.push('缓存超过 500 条，只扫描最近 500 个视频')
      if (value.skippedCacheFiles) extras.push(`跳过 ${value.skippedCacheFiles} 个损坏缓存文件`)
      lines.push(
        `扫描 ${value.scannedVideos} 个视频 / ${value.scannedSegments} 个段落 · 命中 ${value.matchedVideos} 个视频 / ${value.resultCount} 条 · 用时 ${value.elapsedMs}ms${extras.length ? `（${extras.join('；')}）` : ''}`,
      )
      if (value.results.length === 0) {
        lines.push('', '没有命中。可以换更短/更具体的关键词，或去掉 video/since 等过滤条件再试。')
      } else {
        lines.push('')
        value.results.forEach((result, index) => {
          lines.push(`${index + 1}. [${result.timestamp}] ${result.title || result.videoId}（${result.channel || '未知频道'}）`)
          lines.push(`   ${result.text}`)
          lines.push(`   链接：${result.link}`)
          if (result.before) lines.push(`   前文：${result.before}`)
          if (result.after) lines.push(`   后文：${result.after}`)
        })
      }
      lines.push('', `缓存目录：${cacheDir()}`)
      lines.push(
        '下一步：需要展开某条就用 read 工具读缓存目录里对应 <videoId>.md 的全文；要把多个视频的观点整理成文章，用 tube_export（module=knowledge 或 insights）。',
      )
      return text(lines.join('\n'))
    },
  },
  async execute(args) {
    const input = readArgs(args)
    return searchCachedTranscripts({
      query: input.query,
      video: input.video,
      since: input.since,
      limit: input.limit,
      context: input.context,
    })
  },
}

export const TOOLS = [tubeTranscript, tubeSearch, tubeExport]

// 供测试/调试用
export { slugify }
