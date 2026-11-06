// 侧栏入口 client 半边测试（H1）：package.json 声明、语法、静态契约、模拟 __ModuleLoader__ 装载。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = join(ROOT, 'lib', 'client.js')

test('package.json 声明了 client 半边与 ./client 导出', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.dsh, 'package.json 应有 dsh 字段')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject, [])
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.ok(pkg.files.includes('lib'), 'files 应包含 lib（含 client.js / web.js）')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml', '不应改动 bundle.patch')
})

test('client.js 通过 node --check', () => {
  execFileSync(process.execPath, ['--check', CLIENT], { stdio: 'pipe' })
})

test('client.js 静态契约：ModuleLoader 格式 / 侧栏 / iframe', () => {
  const source = readFileSync(CLIENT, 'utf8')
  const needles = [
    'window.__ModuleLoader__.load(',
    "id: 'dsh-tube-insight'",
    'sidebar.panellist',
    "const PANEL = 'tube-insight'",
    "const SRC = '/tube-insight/'",
    'order: 7',
    "label: () => '视频库'",
    'ctx.slots.register({ name: \'main\', key: PANEL }, VideoPanel)',
    "'iframe'",
    "title: 'TubeInsight 视频库'",
    "width: '100%'",
    "height: '100%'",
    'border: 0',
    'exports.isPlugin = true',
    "exports.inject = ['slots']",
    'exports.apply = apply',
    "'svg'",
  ]
  for (const needle of needles) assert.ok(source.includes(needle), `client.js 缺少：${needle}`)
})

test('client.js 用 __ModuleLoader__ 装载后注册侧栏图标与 iframe 面板', async () => {
  let loaded = null
  const previousWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        loaded = spec
      },
    },
  }
  try {
    await import(`${pathToFileURL(CLIENT).href}?v=${Date.now()}`)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }

  assert.ok(loaded, '应调用 window.__ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-tube-insight')
  assert.equal(typeof loaded.factory, 'function')

  // 假 React：只需 createElement（client 只用 h，不用 hooks）
  const React = {
    createElement(type, props, ...children) {
      return { type, props, children }
    },
  }
  const mod = loaded.factory(() => React)
  assert.equal(mod.isPlugin, true)
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.apply, 'function')

  const injected = []
  const registered = []
  const ctx = {
    slots: {
      inject(name, factory) {
        injected.push(name)
        return factory()
      },
      register(spec, component) {
        registered.push({ spec, component })
        return () => {}
      },
    },
  }
  mod.apply(ctx)

  assert.deepEqual(injected, ['sidebar.panellist', 'main'])
  assert.equal(registered.length, 2)

  const sidebar = registered[0]
  assert.equal(sidebar.spec.name, 'sidebar.panellist')
  assert.equal(sidebar.spec.id, 'tube-insight')
  assert.equal(sidebar.spec.order, 7)
  assert.equal(typeof sidebar.spec.label, 'function')
  assert.equal(sidebar.spec.label(), '视频库')
  const icon = sidebar.component({ size: 20 })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 20)
  assert.equal(icon.props.height, 20)
  assert.equal(icon.props.stroke, 'currentColor')

  const main = registered[1]
  assert.equal(main.spec.name, 'main')
  assert.equal(main.spec.key, 'tube-insight')
  const panel = main.component()
  assert.equal(panel.type, 'iframe')
  assert.equal(panel.props.src, '/tube-insight/')
  assert.equal(panel.props.title, 'TubeInsight 视频库')
  assert.equal(panel.props.style.width, '100%')
  assert.equal(panel.props.style.height, '100%')
  assert.equal(panel.props.style.border, 0)
  assert.equal(panel.props.style.display, 'block')
})

test('client.js 不引用外部资源', () => {
  const source = readFileSync(CLIENT, 'utf8')
  assert.ok(!/https?:\/\//.test(source), 'client 不应引用外部 URL')
  assert.ok(!source.includes('document.createElement'), '图标应使用 React 内联 SVG')
})
