// TubeInsight · DeepSeek Harness 插件：浏览器半边
//   - 左侧栏「TubeInsight」入口；主区域 iframe 加载 Host 的视频工作台（/tube-insight/）
//   - 主题桥：iframe onLoad / 页面 ready / DSH 主题变化时把 scheme 推给页面
//   - 动作桥：页面 postMessage start-session → 开新会话并填入提示词，回执 started/failed
window.__ModuleLoader__.load({
  id: 'dsh-tube-insight',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const PANEL = 'tube-insight'
    const SRC = '/tube-insight/'
    const READY = 'tube-insight:ready'
    const THEME = 'tube-insight:theme'
    const START = 'tube-insight:start-session'
    const STARTED = 'tube-insight:session-started'
    const FAILED = 'tube-insight:session-failed'
    const MAX_PROMPT = 4000

    const frames = new Set()
    let scheme = null

    function postToFrame(frame, payload) {
      try {
        if (frame && frame.contentWindow) frame.contentWindow.postMessage(payload, location.origin)
      } catch (error) {
        // 页面已销毁，忽略
      }
    }

    function pushTheme(frame) {
      if (!frame || !scheme) return
      postToFrame(frame, { type: THEME, scheme })
    }

    function broadcastTheme() {
      frames.forEach((frame) => pushTheme(frame))
    }

    function frameFromSource(source) {
      for (const frame of frames) {
        if (frame.contentWindow === source) return frame
      }
      return null
    }

    function handleMessage(event) {
      const frame = frameFromSource(event.source)
      if (!frame) return
      if (event.origin !== location.origin) return
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === READY) {
        pushTheme(frame)
        return
      }
      if (data.type !== START) return
      const prompt = data.prompt
      if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > MAX_PROMPT) {
        postToFrame(frame, { type: FAILED, message: '提示词无效（需要 1–4000 字符）' })
        return
      }
      try {
        ctx.uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'replace' })
        postToFrame(frame, { type: STARTED })
      } catch (error) {
        postToFrame(frame, { type: FAILED, message: String((error && error.message) || error) })
      }
    }

    // 侧栏图标：胶片 + 播放三角
    function VideoIcon(props) {
      const s = (props && props.size) || 18
      return h(
        'svg',
        {
          width: s,
          height: s,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }),
        h('path', { d: 'M10 9.5l5 2.5-5 2.5z', fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M7 5v14' }),
        h('path', { d: 'M17 5v14' })
      )
    }

    // 主区域面板：铺满的 iframe（视频工作台由 Host 的 /tube-insight/ 提供）
    function VideoPanel() {
      return h('iframe', {
        src: SRC,
        title: 'TubeInsight 视频工作台',
        allow: 'fullscreen',
        onLoad: (event) => {
          const frame = event.currentTarget
          if (!frame) return
          frames.add(frame)
          pushTheme(frame)
        },
        style: { width: '100%', height: '100%', border: 0, display: 'block' },
      })
    }

    let ctx = null

    function apply(pluginCtx) {
      ctx = pluginCtx
      pluginCtx.slots.inject('sidebar.panellist', () =>
        pluginCtx.slots.register(
          { name: 'sidebar.panellist', id: PANEL, order: 7, label: () => 'TubeInsight' },
          VideoIcon
        )
      )
      pluginCtx.slots.inject('main', () => pluginCtx.slots.register({ name: 'main', key: PANEL }, VideoPanel))

      // 主题同步：拿到当前 scheme，并在 DSH 切换主题时继续推给所有已加载的 iframe。
      pluginCtx.inject(['theme'], (c) => {
        const push = (snapshot) => {
          try {
            const next = snapshot && snapshot.active && snapshot.active.colorScheme
            if (next === 'dark' || next === 'light') scheme = next
          } catch (error) {
            // 主题快照结构异常时保持原 scheme
          }
          broadcastTheme()
        }
        try {
          push(c.theme.getTheme())
        } catch (error) {
          // 拿不到主题就等 change 事件
        }
        c.on('theme/change', push)
      })

      addEventListener('message', handleMessage)
    }

    exports.isPlugin = true
    exports.inject = ['slots', 'uiWorkspace']
    exports.apply = apply
    return module.exports
  },
})
