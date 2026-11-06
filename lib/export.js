// 导出：YAML frontmatter + 正文 + 我的笔记 + 来源区块，写入 <slug>_<YYYY-MM-DD>.md，
// 并维护同目录 index.md（按 module 分组）。索引的机器可读元数据存在 $DSH_HOME/tube-insight/indexes/ 下，
// 不往用户导出目录塞隐藏文件。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { defaultExportDir, ensureDir, indexesDir } from './paths.js'
import { formatDuration } from './segment.js'
import { timestampUrl, watchUrl } from './yt/url.js'

export const MODULES = Object.freeze([
  'overview',
  'intel',
  'insights',
  'prd',
  'compare',
  'knowledge',
  'translation',
])

export const MODULE_LABELS = Object.freeze({
  overview: '视频概览',
  intel: '产品情报',
  insights: '行业洞察',
  prd: 'PRD 草稿',
  compare: '多视频对比',
  knowledge: '知识卡片',
  translation: '双语翻译',
})

/** 文件名 slug：保留中文与英文数字，空格转 -，截断 60 字符。 */
export function slugify(title, maxLen = 60) {
  const cleaned = String(title || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/[^\p{L}\p{N}_\-\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ /g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const truncated = cleaned.slice(0, maxLen).replace(/[-.]+$/g, '')
  return truncated || 'tube-insight'
}

/** 本地日期 YYYY-MM-DD。 */
export function localDateStamp(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** YAML 双引号标量：JSON 字符串本身就是合法 YAML。 */
function yamlString(value) {
  return JSON.stringify(String(value ?? ''))
}

function mdLinkText(text) {
  return String(text || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
}

function uniqueFilePath(dir, slug, date) {
  let candidate = join(dir, `${slug}_${date}.md`)
  let index = 2
  while (existsSync(candidate) && index < 1000) {
    candidate = join(dir, `${slug}-${index}_${date}.md`)
    index += 1
  }
  return candidate
}

/** 组装最终 Markdown。 */
export function composeExportMarkdown({ records, module, markdown, title, notes = [], pluginVersion = '0.0.0', generatedAt = new Date() }) {
  const lines = []
  lines.push('---')
  lines.push(`title: ${yamlString(title)}`)
  lines.push(`module: ${yamlString(module)}`)
  lines.push(`generated_at: ${yamlString(generatedAt.toISOString())}`)
  lines.push(`generator: ${yamlString(`dsh-tube-insight@${pluginVersion}`)}`)
  lines.push('source:')
  for (const record of records) {
    lines.push(`  - title: ${yamlString(record.title || '')}`)
    lines.push(`    channel: ${yamlString(record.channel || '')}`)
    lines.push(`    url: ${yamlString(watchUrl(record.videoId))}`)
    lines.push(`    videoId: ${yamlString(record.videoId)}`)
    lines.push(`    durationSeconds: ${Math.max(0, Math.floor(Number(record.durationSeconds) || 0))}`)
  }
  lines.push('---')
  lines.push('')
  lines.push(String(markdown || '').trim())

  const cleanNotes = notes.map((note) => String(note).trim()).filter(Boolean)
  if (cleanNotes.length) {
    lines.push('', '## 我的笔记', '')
    for (const note of cleanNotes) lines.push(`- ${note}`)
  }

  lines.push('', '## 来源', '')
  for (const record of records) {
    const label = mdLinkText(record.title || record.videoId)
    lines.push(
      `- [${label}](${timestampUrl(record.videoId, 0)}) · ${record.channel || '未知频道'} · ${formatDuration(record.durationSeconds)}`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

function indexBookkeepingPath(dir) {
  const hash = createHash('sha1').update(resolve(dir)).digest('hex').slice(0, 16)
  return join(indexesDir(), `${hash}.json`)
}

function readIndexEntries(dir) {
  const file = indexBookkeepingPath(dir)
  if (!existsSync(file)) return []
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const entries = Array.isArray(data?.entries) ? data.entries : []
    return entries.filter((entry) => entry && typeof entry.file === 'string' && existsSync(join(dir, entry.file)))
  } catch {
    return []
  }
}

function saveIndexEntries(dir, entries) {
  ensureDir(indexesDir())
  writeFileSync(indexBookkeepingPath(dir), JSON.stringify({ dir: resolve(dir), entries }, null, 2), 'utf8')
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

function renderIndexMarkdown(dir, entries) {
  const sorted = [...entries].sort((a, b) => {
    const byDate = String(b.date || '').localeCompare(String(a.date || ''))
    if (byDate !== 0) return byDate
    return String(a.title || '').localeCompare(String(b.title || ''))
  })
  const lines = ['# TubeInsight 导出索引', '']
  lines.push(`> 共 ${sorted.length} 篇 · 更新于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`)
  const known = MODULES.filter((module) => sorted.some((entry) => entry.module === module))
  const unknown = [...new Set(sorted.map((entry) => entry.module).filter((module) => !MODULES.includes(module)))]
  for (const module of [...known, ...unknown]) {
    const label = MODULE_LABELS[module] ? `（${MODULE_LABELS[module]}）` : ''
    lines.push('', `## ${module}${label}`, '')
    for (const entry of sorted.filter((item) => item.module === module)) {
      lines.push(
        `- ${entry.date} · [${mdLinkText(entry.title)}](./${mdLinkText(entry.file)}) · ${entry.videos} 个视频 · ${formatBytes(entry.bytes)}`,
      )
    }
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * 更新同目录 index.md（按 module 分组）。返回索引文件绝对路径。
 */
export function updateIndex(dir, entry) {
  const outDir = resolve(dir)
  const entries = readIndexEntries(outDir).filter((item) => item.file !== entry.file)
  entries.push(entry)
  saveIndexEntries(outDir, entries)
  const indexpath = join(outDir, 'index.md')
  writeFileSync(indexpath, renderIndexMarkdown(outDir, entries), 'utf8')
  return indexpath
}

/**
 * 写出一份导出文件并更新 index.md。
 * @param {{records: object[], module: string, markdown: string, title?: string, dir?: string, notes?: string[], pluginVersion?: string}} options
 */
export function writeExport({ records, module, markdown, title, dir, notes = [], pluginVersion = '0.0.0' }) {
  const outDir = ensureDir(dir ? resolve(dir) : defaultExportDir())
  const date = localDateStamp()
  const resolvedTitle = (typeof title === 'string' && title.trim()) || records[0]?.title || `TubeInsight ${date}`
  const slug = slugify(resolvedTitle)
  const path = uniqueFilePath(outDir, slug, date)
  const generatedAt = new Date()
  const content = composeExportMarkdown({ records, module, markdown, title: resolvedTitle, notes, pluginVersion, generatedAt })
  writeFileSync(path, content, 'utf8')
  const bytes = Buffer.byteLength(content, 'utf8')
  const entry = {
    file: basename(path),
    title: resolvedTitle,
    module,
    date,
    videos: records.length,
    bytes,
    chars: content.length,
    generatedAt: generatedAt.toISOString(),
  }
  const indexpath = updateIndex(outDir, entry)
  return {
    path,
    indexpath,
    bytes,
    title: resolvedTitle,
    module,
    videos: records.map((record) => ({
      videoId: record.videoId,
      title: record.title || '',
      channel: record.channel || '',
      durationSeconds: Math.max(0, Math.floor(Number(record.durationSeconds) || 0)),
      url: watchUrl(record.videoId),
    })),
  }
}
