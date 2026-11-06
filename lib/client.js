// TubeInsight · DeepSeek Harness 插件：浏览器半边
//   - 左侧栏加一个「视频库」入口；主区域显示插件页面（/tube-insight/，iframe，服务端渲染，无构建）
//   - 页面本身只读：看缓存视频列表、搜索字幕、读单视频转录；分析/写作仍在对话里用 tube-insight skill
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

    // 主区域面板：一个铺满的 iframe（页面由 Host 的 /tube-insight/ 提供）
    function VideoPanel() {
      return h('iframe', {
        src: SRC,
        title: 'TubeInsight 视频库',
        allow: 'fullscreen',
        style: { width: '100%', height: '100%', border: 0, display: 'block' },
      })
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 7, label: () => '视频库' }, VideoIcon)
      )
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, VideoPanel))
    }

    exports.isPlugin = true
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
