// 侧栏入口 client 半边测试（0.5.0）：声明/语法/静态契约 + 模拟 __ModuleLoader__ 装载，
// 断言主题推送、start-session → uiWorkspace.startSession、回执与非法消息忽略。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = join(ROOT, 'lib', 'client.js')
const ORIGIN = 'http://127.0.0.1:1234'

test('package.json 声明了 client 半边与 ./client 导出', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.dsh, 'package.json 应有 dsh 字段')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject, [])
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.ok(pkg.files.includes('lib'), 'files 应包含 lib（含 client.js / web.js / app.js / app.css）')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml', '不应改动 bundle.patch')
})

test('client.js 通过 node --check', () => {
  execFileSync(process.execPath, ['--check', CLIENT], { stdio: 'pipe' })
})

test('client.js 静态契约：slot 不变 + 主题桥 + 动作桥', () => {
  const source = readFileSync(CLIENT, 'utf8')
  const needles = [
    'window.__ModuleLoader__.load(',
    "id: 'dsh-tube-insight'",
    'sidebar.panellist',
    "const PANEL = 'tube-insight'",
    "order: 7",
    "label: () => 'TubeInsight'",
    "const SRC = '/tube-insight/'",
    'src: SRC',
    "title: 'TubeInsight 视频工作台'",
    'exports.isPlugin = true',
    "exports.inject = ['slots', 'uiWorkspace']",
    'exports.apply = apply',
    "inject(['theme']",
    'getTheme()',
    "on('theme/change'",
    'tube-insight:ready',
    'tube-insight:theme',
    'tube-insight:start-session',
    'tube-insight:session-started',
    'tube-insight:session-failed',
    'uiWorkspace.startSession',
    "whenDraftExists: 'replace'",
    'event.source',
    'event.origin',
    'MAX_PROMPT',
    'postMessage',
  ]
  for (const needle of needles) assert.ok(source.includes(needle), `client.js 缺少：${needle}`)
  assert.ok(!/https?:\/\//.test(source), 'client.js 不应引用外部 URL')
})

// 用模拟的 __ModuleLoader__ / window / addEventListener 装载 client.js，
// 模拟 iframe onLoad 与页面消息，断言主题推送与动作桥。
test('client.js 装载后：主题推送、start-session 动作桥与回执、非法消息忽略', async () => {
  const listeners = []
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    location: Object.getOwnPropertyDescriptor(globalThis, 'location'),
    addEventListener: Object.getOwnPropertyDescriptor(globalThis, 'addEventListener'),
    removeEventListener: Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener'),
  }
  let loaded = null
  const themeHandlers = []
  const sessionCalls = []
  const messages = []
  try {
    globalThis.window = {
      __ModuleLoader__: {
        load(spec) {
          loaded = spec
        },
      },
    }
    globalThis.location = { origin: ORIGIN }
    globalThis.addEventListener = (type, handler) => {
      if (type === 'message') listeners.push(handler)
    }
    globalThis.removeEventListener = () => {}

    await import(`${pathToFileURL(CLIENT).href}?v=${Date.now()}`)

  assert.ok(loaded, '应调用 window.__ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-tube-insight')
  assert.equal(typeof loaded.factory, 'function')

  const React = {
    createElement(type, props, ...children) {
      return { type, props, children }
    },
  }
  const mod = loaded.factory(() => React)
  assert.equal(mod.isPlugin, true)
  assert.deepEqual(mod.inject, ['slots', 'uiWorkspace'])
  assert.equal(typeof mod.apply, 'function')

  const registered = []
  const injectCalls = []
  const themeCtx = {
    theme: { getTheme: () => ({ active: { colorScheme: 'dark' } }) },
    on: (eventName, handler) => themeHandlers.push({ eventName, handler }),
  }
  const ctx = {
    slots: {
      inject(name, factory) {
        return factory()
      },
      register(spec, component) {
        registered.push({ spec, component })
        return () => {}
      },
    },
    inject(deps, callback) {
      injectCalls.push(deps)
      callback(themeCtx)
    },
    uiWorkspace: {
      startSession(...args) {
        sessionCalls.push(args)
        if (args[1] && args[1].prompt === 'BOOM') throw new Error('workspace unavailable')
      },
    },
  }

  mod.apply(ctx)
  assert.deepEqual(injectCalls, [['theme']], '应注入 theme 服务')
  assert.equal(registered.length, 2)

  const sidebar = registered[0]
  assert.equal(sidebar.spec.name, 'sidebar.panellist')
  assert.equal(sidebar.spec.id, 'tube-insight')
  assert.equal(sidebar.spec.order, 7)
  assert.equal(sidebar.spec.label(), 'TubeInsight')
  const icon = sidebar.component({ size: 20 })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 20)
  assert.equal(icon.props.stroke, 'currentColor')

  const main = registered[1]
  assert.equal(main.spec.name, 'main')
  assert.equal(main.spec.key, 'tube-insight')
  const panel = main.component()
  assert.equal(panel.type, 'iframe')
  assert.equal(panel.props.src, '/tube-insight/')
  assert.equal(panel.props.title, 'TubeInsight 视频工作台')

  const frameWindow = {
    postMessage(payload, origin) {
      messages.push({ payload, origin })
    },
  }
  const frame = { contentWindow: frameWindow }
  panel.props.onLoad({ currentTarget: frame })

  const lastPayload = () => messages[messages.length - 1] && messages[messages.length - 1].payload

  // iframe onLoad 后会立刻推当前主题（dark）
  assert.deepEqual(lastPayload(), { type: 'tube-insight:theme', scheme: 'dark' })
  assert.equal(messages[messages.length - 1].origin, ORIGIN)

  // 主题变化继续推送
  assert.equal(themeHandlers.length, 1)
  assert.equal(themeHandlers[0].eventName, 'theme/change')
  themeHandlers[0].handler({ active: { colorScheme: 'light' } })
  assert.deepEqual(lastPayload(), { type: 'tube-insight:theme', scheme: 'light' })

  // 页面 ready → 回推当前主题
  assert.equal(listeners.length, 1)
  const dispatch = (data, overrides) =>
    listeners[0](Object.assign({ source: frameWindow, origin: ORIGIN, data }, overrides || {}))
  dispatch({ type: 'tube-insight:ready' })
  assert.deepEqual(lastPayload(), { type: 'tube-insight:theme', scheme: 'light' })

  // start-session → uiWorkspace.startSession + started 回执
  dispatch({ type: 'tube-insight:start-session', prompt: '给我生成概览', label: 'overview' })
  assert.equal(sessionCalls.length, 1)
  assert.equal(sessionCalls[0][0], undefined)
  assert.deepEqual(sessionCalls[0][1], { prompt: '给我生成概览', whenDraftExists: 'replace' })
  assert.deepEqual(lastPayload(), { type: 'tube-insight:session-started' })

  // 提示词非法（过长/非字符串）→ failed 回执，不调用 startSession
  dispatch({ type: 'tube-insight:start-session', prompt: 'x'.repeat(4001) })
  assert.equal(sessionCalls.length, 1, '过长提示词不应调用 startSession')
  assert.equal(lastPayload().type, 'tube-insight:session-failed')

  dispatch({ type: 'tube-insight:start-session', prompt: 42 })
  assert.equal(sessionCalls.length, 1, '非字符串提示词不应调用 startSession')
  assert.equal(lastPayload().type, 'tube-insight:session-failed')

  // 来源不是我们的 iframe / 跨源 / 垃圾消息 → 忽略
  dispatch({ type: 'tube-insight:start-session', prompt: 'hello' }, { source: { postMessage() {} } })
  dispatch({ type: 'tube-insight:start-session', prompt: 'hello' }, { origin: 'https://evil.example' })
  dispatch(null)
  dispatch({ type: 'unknown' })
  assert.equal(sessionCalls.length, 1, '非法消息不应触发 startSession')

  // startSession 抛错 → failed 回执带原因
  dispatch({ type: 'tube-insight:start-session', prompt: 'BOOM' })
  assert.equal(sessionCalls.length, 2)
  assert.equal(lastPayload().type, 'tube-insight:session-failed')
  assert.match(lastPayload().message, /workspace unavailable/)
  } finally {
    restoreGlobal('window', previous.window)
    restoreGlobal('location', previous.location)
    restoreGlobal('addEventListener', previous.addEventListener)
    restoreGlobal('removeEventListener', previous.removeEventListener)
  }
})

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  else delete globalThis[name]
}
