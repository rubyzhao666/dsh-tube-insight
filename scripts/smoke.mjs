#!/usr/bin/env node
// 真实抓取冒烟脚本（需要网络；不会写仓库，只写 $DSH_HOME/tube-insight/ 下）。
//
// 用法：
//   node scripts/smoke.mjs                 # 默认抓 zjkBMFhNj_g（Karpathy 的 LLM 入门）
//   node scripts/smoke.mjs <url-or-id>     # 指定视频
//   node scripts/smoke.mjs <url-or-id> --refresh   # 忽略缓存重抓
//
// 验证内容：InnerTube 抓字幕 → 语义分段 → 缓存 JSON/MD → tube_export 落盘 + index.md。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOOLS } from '../lib/tools.js'
import { dataRoot } from '../lib/paths.js'

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log('用法: node scripts/smoke.mjs [YouTube URL 或 11 位 videoId] [--refresh]')
  process.exit(0)
}
const video = args.find((arg) => !arg.startsWith('--')) || 'zjkBMFhNj_g'
const refresh = args.includes('--refresh')

const transcriptTool = TOOLS.find((tool) => tool.name === 'tube_transcript')
const exportTool = TOOLS.find((tool) => tool.name === 'tube_export')
const requiredTranscriptKeys = [
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
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function line(char = '-') {
  console.log(char.repeat(64))
}

try {
  line('=')
  console.log('TubeInsight smoke test')
  console.log(`DSH_HOME: ${process.env.DSH_HOME || '(未设置，使用 ~/.dsh)'}`)
  console.log(`数据目录: ${dataRoot()}`)
  console.log(`视频: ${video}${refresh ? '（refresh=true）' : ''}`)
  line('=')

  const startedAt = Date.now()
  const transcript = await transcriptTool.execute({ video, refresh }, {})
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)

  for (const key of requiredTranscriptKeys) assert(key in transcript, `返回值缺少字段 ${key}`)
  assert(transcript.segmentCount > 0, 'segmentCount 应大于 0')
  assert(transcript.charCount > 0, 'charCount 应大于 0')
  assert(existsSync(transcript.transcriptPath), `缓存 Markdown 不存在：${transcript.transcriptPath}`)
  assert(existsSync(transcript.cacheJsonPath), `缓存 JSON 不存在：${transcript.cacheJsonPath}`)
  const md = readFileSync(transcript.transcriptPath, 'utf8')
  assert(/\[\d+:\d{2}\]/.test(md), '缓存 Markdown 里应有 [MM:SS] 时间戳')

  console.log(`[1/2] tube_transcript 通过（${elapsed}s，${transcript.cached ? '命中缓存' : `来源 ${transcript.source}`}）`)
  console.log(`      标题: ${transcript.title || '(未取到)'}`)
  console.log(`      频道: ${transcript.channel || '(未取到)'} · 时长 ${transcript.durationSeconds}s`)
  console.log(`      字幕: ${transcript.language}（${transcript.captionKind === 'asr' ? '自动生成' : '原生'}）`)
  console.log(`      段落: ${transcript.segmentCount} · 字符: ${transcript.charCount} · 章节: ${transcript.chapters.length}`)
  console.log(`      Markdown: ${transcript.transcriptPath}`)
  console.log(`      JSON: ${transcript.cacheJsonPath}`)
  console.log('      预览:')
  for (const previewLine of transcript.preview.head.split('\n')) console.log(`        ${previewLine}`)

  line()
  const exportDir = join(dataRoot(), 'exports')
  const exported = await exportTool.execute(
    {
      videos: [transcript.videoId],
      module: 'overview',
      title: `${transcript.title || transcript.videoId} 冒烟测试`,
      markdown: [
        `# ${transcript.title || transcript.videoId}（冒烟测试）`,
        '',
        '这是 scripts/smoke.mjs 自动生成的正文，只用于验证导出链路；正式分析由会话模型按 skill 工作流生成。',
        '',
        `- [0:00] 视频开头（章节数：${transcript.chapters.length}）`,
        `- 抓取来源：${transcript.source}`,
      ].join('\n'),
      dir: exportDir,
      notes: ['smoke.mjs 自动生成，可删除'],
    },
    {},
  )
  assert(existsSync(exported.path), `导出文件不存在：${exported.path}`)
  assert(existsSync(exported.indexpath), `index.md 不存在：${exported.indexpath}`)
  const exportedMd = readFileSync(exported.path, 'utf8')
  assert(exportedMd.startsWith('---\n'), '导出文件应以 YAML frontmatter 开头')
  assert(exportedMd.includes('## 来源'), '导出文件应包含「## 来源」区块')
  assert(exportedMd.includes('youtu.be/'), '来源区块应包含 youtu.be 链接')
  assert(readFileSync(exported.indexpath, 'utf8').includes('# TubeInsight 导出索引'), 'index.md 内容不符合预期')

  console.log('[2/2] tube_export 通过')
  console.log(`      文件: ${exported.path}（${(exported.bytes / 1024).toFixed(1)} KB）`)
  console.log(`      索引: ${exported.indexpath}`)
  line('=')
  console.log('SMOKE PASS')
} catch (error) {
  line('=')
  console.error(`SMOKE FAIL: ${error.message}`)
  if (error.cause) console.error(error.cause)
  process.exitCode = 1
}
