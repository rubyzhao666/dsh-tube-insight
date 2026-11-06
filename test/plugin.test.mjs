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
    assert.ok(Number.isFinite(tool.timeoutMs) && tool.timeoutMs >= 120_000, `${tool.name} timeoutMs 应给足长任务时间`)
  }
  assert.deepEqual([...names].sort(), ['tube_export', 'tube_transcript'])
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
