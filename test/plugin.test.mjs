// 插件形状与注册测试：用假 ctx 验证 DSH Host API 契约（不启动 DSH 进程）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { apply, inject, name } from '../lib/index.js'
import { TOOLS } from '../lib/tools.js'
import { PLUGIN_VERSION } from '../lib/version.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function fakeCtx() {
  const tools = new Map()
  const providers = []
  const effects = []
  const ctx = {
    effect(fn) {
      const cleanup = fn()
      effects.push(cleanup)
      return () => {}
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    skills: {
      registerProvider(factory) {
        providers.push(factory())
        return () => {}
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, tools, providers, effects }
}

test('exports the host plugin shape', () => {
  assert.equal(name, 'tube-insight')
  assert.deepEqual(inject, ['tools', 'skills'])
  assert.equal(typeof apply, 'function')
})

test('cordis.patch.yml id 与插件 name 一致', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*tube-insight/)
  assert.match(patch, /name:\s*'dsh-tube-insight'/)
})

test('package.json 符合硬规则（ESM、零依赖、files 完整）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-tube-insight')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'dependencies 必须为空')
  assert.ok(!pkg.peerDependencies || !Object.keys(pkg.peerDependencies).some((dep) => dep.startsWith('@deepseek-ai/')), '不应依赖 @deepseek-ai/*')
  assert.ok(pkg.engines.dsh.includes('0.2.1'))
  for (const expected of ['lib', 'skills', 'locale/*.json', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.en.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(expected), `files 缺少 ${expected}`)
  }
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(PLUGIN_VERSION, pkg.version)
})

test('apply 注册全部工具与一个 skill provider', () => {
  const { ctx, tools, providers, effects } = fakeCtx()
  apply(ctx)
  assert.equal(tools.size, TOOLS.length)
  assert.equal(providers.length, 1)
  assert.equal(providers[0].name, 'tube-insight')
  assert.ok(effects.length >= TOOLS.length + 1)
  for (const tool of TOOLS) assert.ok(tools.get(tool.name), `missing tool ${tool.name}`)
})

test('工具定义符合 Host API 契约', () => {
  const names = new Set()
  for (const tool of TOOLS) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/)
    assert.ok(!names.has(tool.name), `工具名重复：${tool.name}`)
    names.add(tool.name)
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 20, `${tool.name} description 太短（模型靠它判断是否调用）`)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.ok(Array.isArray(tool.parameters.required))
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(tool.output.schema.additionalProperties, false)
    assert.ok(Array.isArray(tool.output.schema.required))
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
    assert.ok(Number.isFinite(tool.timeoutMs) && tool.timeoutMs >= 10_000, `${tool.name} timeoutMs 应给出合理超时`)
  }
  // 网络类工具的超时给足；本地检索类工具只需覆盖性能目标
  for (const networkTool of ['tube_transcript', 'tube_export']) {
    const tool = TOOLS.find((item) => item.name === networkTool)
    assert.ok(tool.timeoutMs >= 120_000, `${networkTool} 应给足长任务超时`)
  }
  assert.deepEqual([...names].sort(), ['tube_export', 'tube_search', 'tube_synthesis', 'tube_transcript'])
})

test('tube_search 工具描述写明只搜已缓存视频', () => {
  const searchTool = TOOLS.find((tool) => tool.name === 'tube_search')
  assert.ok(searchTool, '应注册 tube_search')
  assert.match(searchTool.description, /以前抓取过|已缓存/)
  assert.match(searchTool.description, /不是全网搜索/)
  assert.deepEqual(searchTool.parameters.required, ['query'])
  assert.equal(searchTool.parameters.properties.query.maxLength, 200)
})

test('tube_synthesis 工具描述写明证据底稿/引用来自工具返回/可落盘', () => {
  const synthesisTool = TOOLS.find((tool) => tool.name === 'tube_synthesis')
  assert.ok(synthesisTool, '应注册 tube_synthesis')
  assert.match(synthesisTool.description, /底稿/)
  assert.match(synthesisTool.description, /引用来自工具返回|来自工具返回/)
  assert.match(synthesisTool.description, /落盘|导出/)
  assert.deepEqual(synthesisTool.parameters.required, ['query'])
  assert.equal(synthesisTool.parameters.properties.queries.maxItems, 6)
  assert.equal(synthesisTool.parameters.properties.limitPerVideo.type, 'number')
  assert.equal(synthesisTool.parameters.properties.maxVideos.type, 'number')
})

test('render 返回非空 text 且不抛错（模型观察面）', () => {
  for (const tool of TOOLS) {
    assert.equal(tool.output.render.length, 2, `${tool.name} render 应为 (args, value)`)
  }
  const transcriptTool = TOOLS.find((tool) => tool.name === 'tube_transcript')
  const transcriptValue = {
    videoId: 'zjkBMFhNj_g',
    title: 'Intro to LLMs',
    channel: 'Andrej Karpathy',
    durationSeconds: 3588,
    language: 'en',
    captionKind: 'asr',
    source: 'innertube-ios',
    segmentCount: 412,
    charCount: 62649,
    chapters: [{ title: 'Intro', startSeconds: 0 }],
    transcriptPath: '/tmp/cache/zjkBMFhNj_g.md',
    cacheJsonPath: '/tmp/cache/zjkBMFhNj_g.json',
    fetchedAt: '2026-11-06T01:00:00.000Z',
    cached: false,
    preview: { head: '[0:00] hi', tail: '[59:00] bye' },
  }
  const transcriptRender = transcriptTool.output.render({ video: 'zjkBMFhNj_g' }, transcriptValue)
  assert.ok(Array.isArray(transcriptRender) && transcriptRender.length >= 1)
  assert.equal(transcriptRender[0].type, 'text')
  assert.match(transcriptRender[0].text, /Intro to LLMs/)
  assert.match(transcriptRender[0].text, /transcriptPath|缓存/)
  assert.match(transcriptRender[0].text, /read/)

  const exportTool = TOOLS.find((tool) => tool.name === 'tube_export')
  const exportRender = exportTool.output.render(
    {},
    {
      path: '/tmp/out/note.md',
      indexpath: '/tmp/out/index.md',
      bytes: 2048,
      title: 'Note',
      module: 'overview',
      videos: [{ videoId: 'zjkBMFhNj_g', title: 'Intro', channel: 'Karpathy', durationSeconds: 3588, url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g' }],
    },
  )
  assert.ok(Array.isArray(exportRender) && exportRender[0].text.includes('/tmp/out/note.md'))

  const searchTool = TOOLS.find((tool) => tool.name === 'tube_search')
  const searchRender = searchTool.output.render(
    { query: '模型' },
    {
      query: '模型',
      scannedVideos: 3,
      matchedVideos: 1,
      resultCount: 1,
      scannedSegments: 500,
      elapsedMs: 12,
      results: [
        {
          videoId: 'zjkBMFhNj_g',
          title: 'Intro',
          channel: 'Karpathy',
          url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
          startSeconds: 754,
          timestamp: '12:34',
          link: 'https://youtu.be/zjkBMFhNj_g?t=754',
          text: '这里提到了模型训练。',
          score: 1.23,
          matchedTerms: ['模型'],
          before: '前一段',
          after: '后一段',
        },
      ],
    },
  )
  assert.match(searchRender[0].text, /\[12:34\]/)
  assert.match(searchRender[0].text, /youtu\.be\/zjkBMFhNj_g\?t=754/)
  assert.match(searchRender[0].text, /tube_export/)
  assert.match(searchRender[0].text, /read/)

  const synthesisTool = TOOLS.find((tool) => tool.name === 'tube_synthesis')
  const synthesisMarkdown = '# 主题检索底稿：模型\n> 检索范围：本地缓存 1 个视频 / 10 个段落 · 检索词：模型\n## 证据（按视频分组）\n\n### Intro · Karpathy · 59:48\n- [12:34](https://youtu.be/zjkBMFhNj_g?t=754) 这里提到了模型训练。'
  const synthesisRender = synthesisTool.output.render(
    { query: '模型' },
    {
      query: '模型',
      queries: [],
      scannedVideos: 1,
      scannedSegments: 10,
      videos: [
        {
          videoId: 'zjkBMFhNj_g',
          title: 'Intro',
          channel: 'Karpathy',
          url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
          durationSeconds: 3588,
          hits: [
            {
              timestamp: '12:34',
              startSeconds: 754,
              link: 'https://youtu.be/zjkBMFhNj_g?t=754',
              text: '这里提到了模型训练。',
            },
          ],
        },
      ],
      coverage: { hitVideos: 1, zeroHitVideos: [], totalHits: 1, queriedTerms: ['模型'] },
      markdown: synthesisMarkdown,
      path: '/tmp/out/draft.md',
      indexpath: '/tmp/out/index.md',
      bytes: 1024,
    },
  )
  assert.match(synthesisRender[0].text, /主题检索底稿/)
  assert.match(synthesisRender[0].text, /\[12:34\]\(https:\/\/youtu\.be\/zjkBMFhNj_g\?t=754\)/)
  assert.match(synthesisRender[0].text, /\/tmp\/out\/draft\.md/)
  assert.match(synthesisRender[0].text, /tube_export/)
})

test('随包 skill provider：skills/ 目录不存在也不报错', async () => {
  const { ctx, providers } = fakeCtx()
  apply(ctx)
  const provider = providers[0]
  const listed = await provider.list()
  assert.ok(Array.isArray(listed), 'list() 必须返回数组')
  const skillsDir = join(ROOT, 'skills')
  if (!existsSync(skillsDir)) {
    assert.equal(listed.length, 0, 'skills/ 不存在时 list() 应为空数组')
    return
  }
  // tube-skill 成员可能正在写这个目录：有内容时校验结构，没有内容也允许（不报错）。
  for (const skill of listed) {
    assert.match(skill.name, /^[a-z0-9-]+$/)
    assert.ok(skill.description.length > 8)
    assert.equal(skill.provider, 'tube-insight')
    const detail = await provider.get({ name: skill.name, locator: skill.locator })
    assert.ok(detail && typeof detail.content === 'string')
  }
})

test('locale 文件有真实标题与描述', () => {
  for (const locale of ['zh', 'en']) {
    const data = JSON.parse(readFileSync(join(ROOT, 'locale', `${locale}.json`), 'utf8'))
    assert.ok(data.meta.title.length > 2)
    assert.ok(data.meta.description.length > 10)
    assert.ok(!data.meta.title.includes('CHANGE-ME'))
  }
})
