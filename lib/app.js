/* TubeInsight 视频工作台 · 单页应用（原生 JS，无构建、无外部资源、动态文本一律 textContent） */
(function () {
  'use strict'

  var API = '/tube-insight/api'
  var MSG_READY = 'tube-insight:ready'
  var MSG_THEME = 'tube-insight:theme'
  var MSG_START = 'tube-insight:start-session'
  var MSG_STARTED = 'tube-insight:session-started'
  var MSG_FAILED = 'tube-insight:session-failed'
  var NOTES_PREFIX = 'tube-insight:notes:'
  var SVG_NS = 'http://www.w3.org/2000/svg'
  var MAX_COMPARE = 10

  var state = {
    videos: [],
    stats: { videos: 0, segments: 0, skipped: 0 },
    query: '',
    selectedId: null,
    detail: null,
    youtubeUrl: '',
    loadingVideos: true,
    loadingDetail: false,
    videosError: '',
    detailError: '',
    compare: [],
    tab: 'transcript',
    transcriptQuery: '',
    matches: [],
    matchCount: 0,
    matchIndex: 0,
    notes: [],
    currentStart: 0,
    pending: null,
    embedded: false
  }

  var els = {}
  var toastTimer = null

  /* ---------------- DOM helpers ---------------- */
  function h(tag, props, children) {
    var node = document.createElement(tag)
    applyProps(node, props)
    appendChildren(node, children)
    return node
  }

  function applyProps(node, props) {
    if (!props) return
    Object.keys(props).forEach(function (key) {
      var value = props[key]
      if (value === null || value === undefined) return
      if (key === 'class') node.className = value
      else if (key === 'text') node.textContent = String(value)
      else if (key === 'dataset') {
        Object.keys(value).forEach(function (name) { node.dataset[name] = String(value[name]) })
      } else if (key === 'attrs') {
        Object.keys(value).forEach(function (name) { node.setAttribute(name, String(value[name])) })
      } else if (key.indexOf('on') === 0 && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value)
      } else if (value === true) {
        node.setAttribute(key, '')
      } else if (value !== false) {
        node.setAttribute(key, String(value))
      }
    })
  }

  function appendChildren(node, children) {
    if (children === null || children === undefined) return
    var list = Array.isArray(children) ? children : [children]
    list.forEach(function (child) {
      if (child === null || child === undefined || child === false) return
      node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)))
    })
  }

  function clear(node) {
    if (!node) return
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  function byId(id) { return document.getElementById(id) }

  /* ---------------- 内联图标 ---------------- */
  var ICONS = {
    play: ['M8 5.5v13l11-6.5z'],
    refresh: ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v5h-5'],
    search: ['M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z', 'M21 21l-4.35-4.35'],
    copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
    external: ['M14 4h6v6', 'M20 4l-9 9', 'M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5'],
    trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
    plus: ['M12 5v14', 'M5 12h14'],
    eye: ['M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
    spark: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z'],
    note: ['M5 4h14v16H5z', 'M8 8h8', 'M8 12h8', 'M8 16h5'],
    compare: ['M4 6h7', 'M4 12h7', 'M4 18h7', 'M14 4v16', 'M18 8h2', 'M18 12h2', 'M18 16h2'],
    up: ['M6 15l6-6 6 6'],
    down: ['M6 9l6 6 6-6'],
    file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4'],
    warn: ['M12 4l9 16H3z', 'M12 10v4', 'M12 17h.01'],
    check: ['M4 12.5l5 5L20 6.5'],
    video: ['M3 6h13v12H3z', 'M16 10l5-3v10l-5-3z']
  }

  function icon(name, size) {
    var svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', String(size || 16))
    svg.setAttribute('height', String(size || 16))
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.8')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    ;(ICONS[name] || []).forEach(function (d) {
      var path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', d)
      svg.appendChild(path)
    })
    return svg
  }

  /* ---------------- 格式化 ---------------- */
  function pad2(value) { return value < 10 ? '0' + value : String(value) }

  function fmtDuration(total) {
    var seconds = Math.max(0, Math.floor(Number(total) || 0))
    var hours = Math.floor(seconds / 3600)
    var minutes = Math.floor((seconds % 3600) / 60)
    var rest = seconds % 60
    return hours ? hours + ':' + pad2(minutes) + ':' + pad2(rest) : minutes + ':' + pad2(rest)
  }

  function fmtTime(total) {
    var seconds = Math.max(0, Math.floor(Number(total) || 0))
    return Math.floor(seconds / 60) + ':' + pad2(seconds % 60)
  }

  function fmtDate(iso) {
    if (!iso) return '未知时间'
    var date = new Date(iso)
    if (isNaN(date.getTime())) return String(iso)
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' +
      pad2(date.getHours()) + ':' + pad2(date.getMinutes())
  }

  function ytTimeLink(videoId, seconds) {
    return 'https://youtu.be/' + encodeURIComponent(videoId) + '?t=' + Math.max(0, Math.floor(Number(seconds) || 0))
  }

  function ytWatchLink(videoId) {
    return 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId)
  }

  function videoTitle(video) { return (video && video.title) || (video && video.videoId) || '未命名视频' }
  function videoRef(video) { return '《' + videoTitle(video) + '》 ' + ytTimeLink(video.videoId, 0) }
  function captionLabel(video) { return video && video.captionKind === 'asr' ? '自动字幕' : '原生字幕' }

  /* ---------------- toast ---------------- */
  function toast(message, options) {
    options = options || {}
    var container = els.toasts || byId('toast-container')
    if (!container) return
    var node = h('div', { class: 'toast' + (options.error ? ' error' : '') }, [
      icon(options.error ? 'warn' : 'check', 14),
      h('span', { text: String(message) })
    ])
    container.appendChild(node)
    if (toastTimer) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(function () {
      node.classList.add('is-hiding')
      window.setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node)
      }, 220)
    }, options.error ? 3800 : 2600)
  }

  /* ---------------- 复制 ---------------- */
  function copyText(value) {
    var textValue = String(value == null ? '' : value)
    return new Promise(function (resolve, reject) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(textValue).then(resolve).catch(fallback)
        return
      }
      fallback()
      function fallback() {
        try {
          var area = document.createElement('textarea')
          area.value = textValue
          area.setAttribute('readonly', '')
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          var ok = document.execCommand('copy')
          document.body.removeChild(area)
          if (ok) resolve()
          else reject(new Error('浏览器不允许复制'))
        } catch (error) {
          reject(error)
        }
      }
    })
  }

  function copyWithToast(value, message) {
    copyText(value).then(function () {
      toast(message)
    }).catch(function (error) {
      toast('复制失败：' + (error && error.message ? error.message : '未知错误'), { error: true })
    })
  }

  /* ---------------- 会话动作桥 ---------------- */
  function startSession(prompt, label) {
    if (typeof prompt !== 'string' || !prompt.trim()) return
    if (!state.embedded) {
      toast('请在 DSH 侧栏（TubeInsight）里使用动作按钮', { error: true })
      return
    }
    var clipped = prompt.length > 3900 ? prompt.slice(0, 3890) + '…' : prompt
    state.pending = label || 'action'
    markPending()
    try {
      parent.postMessage({ type: MSG_START, prompt: clipped, label: state.pending }, location.origin)
    } catch (error) {
      state.pending = null
      markPending()
      toast('无法请求新会话：' + error.message, { error: true })
      return
    }
    toast('正在请求新会话…')
    window.setTimeout(function () {
      if (state.pending) {
        state.pending = null
        markPending()
        toast('新会话请求超时，请确认 DSH 是否正常', { error: true })
      }
    }, 12000)
  }

  function markPending() {
    var nodes = document.querySelectorAll('[data-action].is-pending, #compare-btn.is-pending, .is-pending')
    Array.prototype.forEach.call(nodes, function (node) { node.classList.remove('is-pending') })
    if (state.pending) {
      var target = document.querySelector('[data-action="' + state.pending + '"]')
      if (target) target.classList.add('is-pending')
      if (state.pending === 'compare') {
        var compare = byId('compare-btn')
        if (compare) compare.classList.add('is-pending')
      }
    }
  }

  function clearPending() { state.pending = null; markPending() }

  /* ---------------- 主题 / 父窗口消息 ---------------- */
  function applyTheme(scheme) {
    if (scheme === 'dark' || scheme === 'light') document.documentElement.setAttribute('data-theme', scheme)
  }

  function initThemeBridge() {
    state.embedded = !!(window.parent && window.parent !== window)
    // 初始主题：优先系统偏好兜底，收到 client 推的 theme 后会覆盖。
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) applyTheme('dark')
    } catch (error) { /* ignore */ }
    try { parent.postMessage({ type: MSG_READY }, location.origin) } catch (error) { /* ignore */ }
    window.addEventListener('message', function (event) {
      if (event.source !== window.parent) return
      if (event.origin !== location.origin) return
      var data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === MSG_THEME) {
        applyTheme(data.scheme)
        return
      }
      if (data.type === MSG_STARTED) {
        clearPending()
        toast('已在新会话里填入提示词，补完发送即可')
        return
      }
      if (data.type === MSG_FAILED) {
        clearPending()
        toast('打开新会话失败：' + (data.message || '未知错误'), { error: true })
      }
    })
  }

  /* ---------------- HTTP ---------------- */
  function api(path) {
    return fetch(API + path, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin'
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json()
    })
  }

  /* ---------------- 笔记（localStorage） ---------------- */
  function notesKey(videoId) { return NOTES_PREFIX + videoId }

  function readNotes(videoId) {
    if (!videoId) return []
    try {
      var raw = window.localStorage.getItem(notesKey(videoId))
      if (!raw) return []
      var parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(function (note) {
        return note && typeof note.text === 'string' && note.text.trim()
      }).map(function (note) {
        return {
          time: Math.max(0, Math.floor(Number(note.time) || 0)),
          text: String(note.text),
          createdAt: typeof note.createdAt === 'string' ? note.createdAt : ''
        }
      })
    } catch (error) {
      return []
    }
  }

  function writeNotes(videoId, notes) {
    if (!videoId) return
    try {
      window.localStorage.setItem(notesKey(videoId), JSON.stringify(notes))
    } catch (error) {
      toast('笔记保存失败：' + (error && error.message ? error.message : '本地存储不可用'), { error: true })
    }
  }

  function parseTimeInput(raw, fallback) {
    var value = String(raw || '').trim()
    if (!value) return Math.max(0, Math.floor(fallback || 0))
    var parts = value.split(':').map(function (item) { return Number(item) })
    if (parts.some(function (item) { return !isFinite(item) || item < 0 })) return Math.max(0, Math.floor(fallback || 0))
    if (parts.length === 1) return Math.floor(parts[0])
    if (parts.length === 2) return Math.floor(parts[0] * 60 + parts[1])
    if (parts.length === 3) return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2])
    return Math.max(0, Math.floor(fallback || 0))
  }

  /* ---------------- 动作提示词 ---------------- */
  function actionPrompt(action, video) {
    var intro = '请用 tube-insight skill 处理这条 YouTube 视频：' + videoRef(video) + '。先调用 tube_transcript 获取字幕（已有缓存就直接用），'
    if (action === 'overview') {
      return intro + '然后生成「视频概览」：3–8 个章节（覆盖全片）、核心要点、值得看的部分；每条结论都带 [MM:SS] 与 youtu.be 时间戳链接。'
    }
    if (action === 'intel') {
      return intro + '然后做「产品情报」：产品功能、用户痛点、竞品、商业模式关键词；如果这是访谈/方法论类视频，改为提炼核心方法论、关键原则与可迁移场景。'
    }
    if (action === 'insights') {
      return intro + '然后做「行业洞察与观点提炼」：关键术语（简明解释）、观点（说话人 → 核心观点）、技术边界（能力/当前限制/预期突破）。'
    }
    if (action === 'prd') {
      return intro + '然后基于视频内容写一份「PRD 草稿」：目标、目标用户、用户故事、核心功能、验收标准。'
    }
    if (action === 'notes-zh') {
      return intro + '然后输出「中文笔记 / 双语翻译」：按 references/translation.md 的规则把关键段落翻成自然中文（保留专有名词与时间戳），并给出一份结构化中文笔记。'
    }
    if (action === 'export') {
      return intro + '然后把这条视频整理成知识卡片并落盘：用 tube_export（module=knowledge）导出到我的工作区，frontmatter 与文末来源要完整。'
    }
    return intro
  }

  function exportTranscriptPrompt(video) {
    return '请把这条视频的完整转录导出为 Markdown 到我的工作区：' + videoRef(video) +
      '。先用 tube_transcript 拿到 transcriptPath，然后用 read 读取并写一份以视频标题命名的 .md 文件（保留每行 [MM:SS] 时间戳，正文不要改动）。'
  }

  function comparePrompt(videos) {
    var lines = videos.map(function (video, index) {
      return (index + 1) + '. ' + videoRef(video)
    })
    return '请用 tube-insight skill 做「多视频对比」：\n' + lines.join('\n') +
      '\n先分别用 tube_transcript 拿字幕，再按 compare 工作流输出：共识、各自差异与优势、可行动建议；引用带 [MM:SS] 与 youtu.be 链接；最后用 tube_export（module=compare）导出到我的工作区。'
  }

  function organizeNotesPrompt(video, notes) {
    var markdown = notes.map(function (note) {
      return '- [' + fmtTime(note.time) + '] ' + note.text
    }).join('\n')
    return '请用 tube-insight skill 整理我的视频笔记：' + videoRef(video) +
      '\n\n我的笔记：\n' + markdown +
      '\n\n请合并重复、补全上下文（必要时用 tube_transcript 核对时间点），输出结构化的中文笔记，每条带时间戳引用。'
  }

  /* ---------------- 顶栏 ---------------- */
  function renderStats() {
    if (!els.stats) return
    var stats = state.stats || {}
    var parts = [
      (stats.videos || 0) + ' 个视频',
      (stats.segments || 0) + ' 个段落'
    ]
    if (stats.skipped) parts.push('跳过 ' + stats.skipped + ' 个损坏缓存')
    if (state.loadingVideos) parts = ['正在加载…']
    els.stats.textContent = parts.join(' · ')
  }

  /* ---------------- 列表 ---------------- */
  function filteredVideos() {
    var query = state.query.trim().toLowerCase()
    if (!query) return state.videos
    return state.videos.filter(function (video) {
      return (video.title || '').toLowerCase().indexOf(query) !== -1 ||
        (video.channel || '').toLowerCase().indexOf(query) !== -1 ||
        (video.videoId || '').toLowerCase().indexOf(query) !== -1
    })
  }

  function renderList() {
    if (!els.list) return
    clear(els.list)
    if (state.loadingVideos) {
      var skeleton = h('div', { class: 'skeleton' }, Array.from({ length: 7 }, function () {
        return h('div', { class: 'skeleton-row' })
      }))
      els.list.appendChild(skeleton)
      return
    }
    if (state.videosError) {
      els.list.appendChild(h('div', { class: 'empty' }, [
        h('strong', { text: '加载失败' }),
        h('span', { text: state.videosError }),
        h('button', { class: 'btn small', type: 'button', onclick: function () { loadVideos() } }, '重试')
      ]))
      return
    }
    if (state.videos.length === 0) {
      els.list.appendChild(h('div', { class: 'empty' }, [
        h('span', { class: 'empty-icon' }, icon('video', 26)),
        h('strong', { text: '还没有缓存的视频' }),
        h('span', { class: 'muted', text: '先在对话里让模型调用 tube_transcript 抓取一个视频，然后点右上角「刷新」。' })
      ]))
      return
    }
    var videos = filteredVideos()
    if (videos.length === 0) {
      els.list.appendChild(h('div', { class: 'empty' }, [
        h('strong', { text: '没有匹配的视频' }),
        h('span', { class: 'muted', text: '换个关键词，或清空搜索。' }),
        h('button', {
          class: 'btn small', type: 'button', onclick: function () {
            state.query = ''
            if (els.search) els.search.value = ''
            renderList()
          }
        }, '清空搜索')
      ]))
      return
    }
    videos.forEach(function (video) { els.list.appendChild(renderVideoRow(video)) })
  }

  function renderVideoRow(video) {
    var selected = state.selectedId === video.videoId
    var checked = state.compare.indexOf(video.videoId) !== -1
    var checkbox = h('input', {
      class: 'checkbox',
      type: 'checkbox',
      attrs: { 'aria-label': '选择对比：' + videoTitle(video) },
      dataset: { compareId: video.videoId }
    })
    checkbox.checked = checked
    checkbox.addEventListener('click', function (event) { event.stopPropagation() })
    checkbox.addEventListener('change', function () { toggleCompare(video.videoId, checkbox) })

    var openLink = h('a', {
      class: 'row-open',
      href: ytTimeLink(video.videoId, 0),
      target: '_blank',
      rel: 'noopener noreferrer',
      attrs: { title: '打开 YouTube', 'aria-label': '打开 YouTube' }
    }, icon('external', 14))
    openLink.addEventListener('click', function (event) { event.stopPropagation() })

    var row = h('div', {
      class: 'row video-row' + (selected ? ' is-selected' : ''),
      dataset: { videoId: video.videoId },
      attrs: { role: 'button', tabindex: '0', 'aria-label': videoTitle(video) }
    }, [
      checkbox,
      h('div', { class: 'row-main' }, [
        h('div', { class: 'row-title', text: videoTitle(video) }),
        h('div', { class: 'row-meta' }, [
          h('span', { text: video.channel || '未知频道' }),
          h('span', { class: 'dot muted', text: '·' }),
          h('span', { text: fmtDuration(video.durationSeconds) }),
          h('span', { class: 'dot muted', text: '·' }),
          h('span', { text: (video.segmentCount || 0) + ' 段' }),
          h('span', { class: 'dot muted', text: '·' }),
          h('span', { text: fmtDate(video.fetchedAt) })
        ])
      ]),
      openLink
    ])
    row.addEventListener('click', function () { selectVideo(video.videoId) })
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        selectVideo(video.videoId)
      }
    })
    return row
  }

  /* ---------------- 对比 ---------------- */
  function toggleCompare(videoId, checkbox) {
    var index = state.compare.indexOf(videoId)
    if (index >= 0) {
      state.compare.splice(index, 1)
    } else if (state.compare.length >= MAX_COMPARE) {
      if (checkbox) checkbox.checked = false
      toast('最多选择 ' + MAX_COMPARE + ' 个视频做对比', { error: true })
      renderCompareBar()
      return
    } else {
      state.compare.push(videoId)
    }
    renderCompareBar()
  }

  function renderCompareBar() {
    if (!els.compareBar) return
    var count = state.compare.length
    els.compareBar.hidden = count === 0
    if (els.compareCount) els.compareCount.textContent = '已选 ' + count + '/' + MAX_COMPARE
    if (els.compareBtn) els.compareBtn.disabled = count < 2
  }

  function compareSelected() {
    var videos = state.compare.map(function (videoId) {
      return state.videos.filter(function (item) { return item.videoId === videoId })[0]
    }).filter(Boolean)
    if (videos.length < 2) {
      toast('至少选择 2 个视频才能对比', { error: true })
      return
    }
    state.pending = 'compare'
    markPending()
    startSession(comparePrompt(videos), 'compare')
  }

  /* ---------------- 详情 ---------------- */
  function renderDetail() {
    if (!els.detail) return
    clear(els.detail)
    if (!state.selectedId) {
      els.detail.appendChild(h('div', { class: 'detail-scroll' }, [
        h('div', { class: 'empty' }, [
          h('span', { class: 'empty-icon' }, icon('play', 26)),
          h('strong', { text: '从左侧选择一个视频' }),
          h('span', { class: 'muted', text: '查看转录、章节，或用操作卡片让 AI 在新会话里处理它。' })
        ])
      ]))
      return
    }
    if (state.loadingDetail) {
      els.detail.appendChild(h('div', { class: 'detail-scroll' }, [
        h('div', { class: 'skeleton' }, [
          h('div', { class: 'skeleton-row skeleton-block' }),
          h('div', { class: 'skeleton-row' }),
          h('div', { class: 'skeleton-row' })
        ])
      ]))
      return
    }
    if (state.detailError || !state.detail) {
      els.detail.appendChild(h('div', { class: 'detail-scroll' }, [
        h('div', { class: 'empty' }, [
          h('strong', { text: '这条视频加载失败' }),
          h('span', { class: 'muted', text: state.detailError || '视频不在缓存里' }),
          h('button', {
            class: 'btn small', type: 'button', onclick: function () { loadDetail(state.selectedId, true) }
          }, '重试')
        ])
      ]))
      return
    }
    var video = state.detail
    var scroll = h('div', { class: 'detail-scroll' })
    scroll.appendChild(renderDetailHeader(video))
    scroll.appendChild(renderTabs())
    var panel = h('div', { class: 'tabpanel', dataset: { panel: state.tab }, attrs: { role: 'tabpanel' } })
    scroll.appendChild(panel)
    els.detail.appendChild(scroll)
    renderPanel(panel, video)
  }

  function renderDetailHeader(video) {
    var meta = h('div', { class: 'detail-meta' }, [
      h('span', { text: video.channel || '未知频道' }),
      h('span', { class: 'dot', text: '·' }),
      h('span', { text: '时长 ' + fmtDuration(video.durationSeconds) }),
      h('span', { class: 'dot', text: '·' }),
      h('span', { text: (video.segmentCount || 0) + ' 段' }),
      h('span', { class: 'dot', text: '·' }),
      h('span', { text: '抓取 ' + fmtDate(video.fetchedAt) }),
      h('span', { class: 'dot', text: '·' }),
      h('span', { class: 'badge muted', text: (video.language || '未知语言') + ' · ' + captionLabel(video) })
    ])
    return h('header', { class: 'detail-header' }, [
      h('div', { class: 'detail-title-row' }, [
        h('h2', { class: 'detail-title', text: videoTitle(video) }),
        h('div', { class: 'detail-actions' }, [
          h('a', {
            class: 'btn small primary',
            href: ytTimeLink(video.videoId, 0),
            target: '_blank',
            rel: 'noopener noreferrer'
          }, [icon('external', 14), 'YouTube 打开']),
          h('button', {
            class: 'btn small', type: 'button', onclick: function () {
              copyWithToast(ytWatchLink(video.videoId), '视频链接已复制')
            }
          }, [icon('copy', 14), '复制链接'])
        ])
      ]),
      meta
    ])
  }

  function renderTabs() {
    var tabs = [
      { id: 'transcript', label: '转录', icon: 'file' },
      { id: 'chapters', label: '章节', icon: 'compare' },
      { id: 'actions', label: '操作', icon: 'spark' },
      { id: 'notes', label: '笔记', icon: 'note' }
    ]
    var nav = h('nav', { class: 'tabs', attrs: { role: 'tablist', 'aria-label': '视频详情' } })
    tabs.forEach(function (tab) {
      var button = h('button', {
        class: 'tab',
        type: 'button',
        attrs: { role: 'tab', 'data-tab': tab.id, 'aria-selected': String(state.tab === tab.id) },
        onclick: function () {
          if (state.tab === tab.id) return
          state.tab = tab.id
          renderDetail()
        }
      }, [icon(tab.icon, 14), tab.label])
      nav.appendChild(button)
    })
    return nav
  }

  function renderPanel(panel, video) {
    if (state.tab === 'transcript') renderTranscriptPanel(panel, video)
    else if (state.tab === 'chapters') renderChaptersPanel(panel, video)
    else if (state.tab === 'actions') renderActionsPanel(panel, video)
    else renderNotesPanel(panel, video)
  }

  /* ---------------- 转录 ---------------- */
  function transcriptLines(video) {
    return (video.segments || []).map(function (segment) {
      return '[' + fmtTime(segment.start) + '] ' + segment.text
    })
  }

  function renderTranscriptPanel(panel, video) {
    state.matches = computeMatches(video, state.transcriptQuery)
    state.matchCount = countOccurrences(video, state.transcriptQuery)
    if (state.matchIndex >= state.matches.length) state.matchIndex = 0
    var search = h('input', {
      class: 'search',
      type: 'search',
      id: 'transcript-search',
      placeholder: '搜索转录（Enter 下一个 / Shift+Enter 上一个）',
      autocomplete: 'off'
    })
    search.value = state.transcriptQuery
    var count = h('span', { class: 'match-count', id: 'match-count', text: matchCountText() })
    var prev = h('button', { class: 'icon-btn', type: 'button', attrs: { title: '上一个命中', 'aria-label': '上一个命中' }, onclick: function () { jumpMatch(-1) } }, icon('up', 15))
    var next = h('button', { class: 'icon-btn', type: 'button', attrs: { title: '下一个命中', 'aria-label': '下一个命中' }, onclick: function () { jumpMatch(1) } }, icon('down', 15))
    var toolbar = h('div', { class: 'transcript-toolbar' }, [
      search,
      count,
      prev,
      next,
      h('button', {
        class: 'btn small', type: 'button', onclick: function () {
          copyWithToast(transcriptLines(video).join('\n'), '全文已复制')
        }
      }, [icon('copy', 13), '复制全文']),
      h('button', {
        class: 'btn small', type: 'button', onclick: function () { startSession(exportTranscriptPrompt(video), 'export-transcript') }
      }, [icon('file', 13), '导出 Markdown']),
      h('button', {
        class: 'btn small', type: 'button', title: '把完整转录保存为一条笔记', onclick: function () {
          state.notes.push({ time: 0, text: transcriptLines(video).join('\n'), createdAt: new Date().toISOString() })
          writeNotes(video.videoId, state.notes)
          toast('完整转录已保存为笔记')
        }
      }, [icon('note', 13), '存为笔记'])
    ])
    var list = h('div', { class: 'transcript-list', id: 'transcript-list' })
    panel.appendChild(h('div', { class: 'transcript' }, [toolbar, list]))

    function applyQuery() {
      state.transcriptQuery = search.value
      state.matches = computeMatches(video, state.transcriptQuery)
      state.matchCount = countOccurrences(video, state.transcriptQuery)
      state.matchIndex = state.matches.length ? Math.min(state.matchIndex, state.matches.length - 1) : 0
      count.textContent = matchCountText()
      count.classList.toggle('is-empty', !!state.transcriptQuery && state.matchCount === 0)
      renderTranscriptList(list, video)
    }

    search.addEventListener('input', applyQuery)
    search.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault()
        jumpMatch(event.shiftKey ? -1 : 1)
      }
    })
    renderTranscriptList(list, video)
  }

  function matchCountText() {
    if (!state.transcriptQuery) return '搜索高亮'
    return state.matchCount + ' 处 · ' + state.matches.length + ' 段'
  }

  function computeMatches(video, query) {
    var needle = String(query || '').toLowerCase()
    if (!needle) return []
    var matches = []
    ;(video.segments || []).forEach(function (segment, index) {
      if (String(segment.text || '').toLowerCase().indexOf(needle) !== -1) matches.push(index)
    })
    return matches
  }

  function countOccurrences(video, query) {
    var needle = String(query || '').toLowerCase()
    if (!needle) return 0
    var total = 0
    ;(video.segments || []).forEach(function (segment) {
      var text = String(segment.text || '').toLowerCase()
      var from = 0
      var index = text.indexOf(needle, from)
      while (index !== -1) {
        total += 1
        from = index + needle.length
        index = text.indexOf(needle, from)
      }
    })
    return total
  }

  function jumpMatch(direction) {
    if (!state.matches.length) {
      if (state.transcriptQuery) toast('没有命中', { error: true })
      return
    }
    state.matchIndex = (state.matchIndex + direction + state.matches.length) % state.matches.length
    focusSegment(state.matches[state.matchIndex], { smooth: true })
  }

  function focusSegment(index, options) {
    options = options || {}
    var list = byId('transcript-list')
    if (!list) return
    var nodes = list.querySelectorAll('.seg')
    Array.prototype.forEach.call(nodes, function (node) { node.classList.remove('is-active') })
    var target = nodes[index]
    if (!target) return
    target.classList.add('is-active')
    var segmentStart = Number(target.dataset.start) || 0
    state.currentStart = segmentStart
    try {
      target.scrollIntoView({ block: 'center', behavior: options.smooth ? 'smooth' : 'auto' })
    } catch (error) {
      target.scrollIntoView()
    }
  }

  function renderTranscriptList(list, video) {
    clear(list)
    var query = state.transcriptQuery
    var matched = computeMatches(video, query)
    ;(video.segments || []).forEach(function (segment, index) {
      var matchAnchor = null
      var textNode = h('p', { class: 'seg-text' })
      renderHighlightedText(textNode, segment.text, query)
      var body = h('div', {
        class: 'seg-body',
        onclick: function () {
          state.currentStart = segment.start
          toggleExpand(row)
        }
      }, [textNode])
      var timeLink = h('a', {
        class: 'time',
        href: ytTimeLink(video.videoId, segment.start),
        target: '_blank',
        rel: 'noopener noreferrer',
        attrs: { title: '在 YouTube 打开这个时间点' }
      }, '[' + fmtTime(segment.start) + ']')
      timeLink.addEventListener('click', function () { state.currentStart = segment.start })
      var actions = h('div', { class: 'seg-actions' }, [
        h('button', {
          class: 'icon-btn copy-citation', type: 'button', attrs: { title: '复制引用（[MM:SS] + 链接）' },
          onclick: function () {
            copyWithToast('[' + fmtTime(segment.start) + '](' + ytTimeLink(video.videoId, segment.start) + ')', '引用已复制')
          }
        }, icon('copy', 14)),
        h('button', {
          class: 'icon-btn copy-text', type: 'button', attrs: { title: '复制原文' },
          onclick: function () { copyWithToast(segment.text, '原文已复制') }
        }, icon('file', 14)),
        h('button', {
          class: 'icon-btn save-note', type: 'button', attrs: { title: '保存为笔记' },
          onclick: function () {
            state.notes.push({ time: segment.start, text: segment.text, createdAt: new Date().toISOString() })
            writeNotes(video.videoId, state.notes)
            toast('已保存为笔记（可用「让 AI 整理笔记」汇总）')
          }
        }, icon('note', 14))
      ])
      var row = h('div', {
        class: 'seg',
        dataset: { start: segment.start, index: index },
        attrs: { id: 'seg-' + segment.start }
      }, [timeLink, body, actions])
      if (query && matched.indexOf(index) !== -1) row.classList.add('is-hit')
      list.appendChild(row)
    })
    if (state.matches.length) {
      var first = list.querySelectorAll('.seg')[state.matches[0]]
      if (first && !state.matchIndex) {
        // 初始不自动滚动，避免页面跳动
      }
    }
  }

  function renderHighlightedText(container, text, query) {
    clear(container)
    var needle = String(query || '')
    if (!needle) {
      container.appendChild(document.createTextNode(String(text == null ? '' : text)))
      return
    }
    var lower = String(text == null ? '' : text).toLowerCase()
    var target = needle.toLowerCase()
    var from = 0
    var index = lower.indexOf(target, from)
    while (index !== -1) {
      if (index > from) container.appendChild(document.createTextNode(String(text).slice(from, index)))
      var mark = document.createElement('mark')
      mark.className = 'hl'
      mark.textContent = String(text).slice(index, index + target.length)
      container.appendChild(mark)
      from = index + target.length
      index = lower.indexOf(target, from)
    }
    if (from < String(text).length) container.appendChild(document.createTextNode(String(text).slice(from)))
  }

  function toggleExpand(row) {
    var seg = row.querySelector('.seg-body')
    if (seg) seg.classList.toggle('is-expanded')
    row.classList.toggle('is-expanded')
  }

  /* ---------------- 章节 ---------------- */
  function renderChaptersPanel(panel, video) {
    var chapters = video.chapters || []
    if (chapters.length === 0) {
      panel.appendChild(h('div', { class: 'empty' }, [
        h('strong', { text: '这条视频没有章节' }),
        h('span', { class: 'muted', text: '描述里没有时间戳章节；可以直接用转录搜索定位。' })
      ]))
      return
    }
    var list = h('div', { class: 'chapter-list' })
    chapters.forEach(function (chapter) {
      var button = h('button', {
        class: 'chapter', type: 'button', dataset: { start: chapter.start },
        onclick: function () { jumpToChapter(video, chapter.start) }
      }, [
        h('span', { class: 'time', text: '[' + fmtTime(chapter.start) + ']' }),
        h('span', { class: 'chapter-title', text: chapter.title || '' }),
        h('span', { class: 'badge muted' }, icon('external', 11))
      ])
      list.appendChild(button)
    })
    panel.appendChild(h('div', { class: 'chapters' }, [
      h('p', { class: 'muted', text: '点击章节会跳到转录对应位置并高亮。' }),
      list
    ]))
  }

  function jumpToChapter(video, startSeconds) {
    state.tab = 'transcript'
    var segments = video.segments || []
    var targetIndex = 0
    for (var i = 0; i < segments.length; i += 1) {
      if (Number(segments[i].start) >= Number(startSeconds)) { targetIndex = i; break }
      targetIndex = i
    }
    renderDetail()
    window.setTimeout(function () { focusSegment(targetIndex, { smooth: true }) }, 30)
  }

  /* ---------------- 操作 ---------------- */
  var ACTIONS = [
    { id: 'overview', title: '生成概览', desc: '章节结构、核心要点、值得看的部分', icon: 'file' },
    { id: 'intel', title: '产品情报', desc: '功能、用户痛点、竞品、商业模式', icon: 'spark' },
    { id: 'insights', title: '行业洞察', desc: '术语、观点、技术边界', icon: 'eye' },
    { id: 'prd', title: 'PRD 草稿', desc: '目标、用户故事、核心功能、验收标准', icon: 'note' },
    { id: 'notes-zh', title: '中文笔记 / 双语', desc: '按翻译规则产出中文笔记', icon: 'file' },
    { id: 'export', title: '导出 Markdown', desc: '整理成知识卡片落到工作区', icon: 'external' }
  ]

  function renderActionsPanel(panel, video) {
    var grid = h('div', { class: 'action-grid' })
    ACTIONS.forEach(function (action) {
      var card = h('button', {
        class: 'card action',
        type: 'button',
        attrs: { 'data-action': action.id },
        onclick: function () { startSession(actionPrompt(action.id, video), action.id) }
      }, [
        h('span', { class: 'action-icon' }, icon(action.icon, 16)),
        h('span', { class: 'action-title', text: action.title }),
        h('span', { class: 'action-desc', text: action.desc })
      ])
      grid.appendChild(card)
    })
    panel.appendChild(h('div', { class: 'actions' }, [
      h('p', { class: 'muted', text: '点卡片会在 DSH 里打开一个新会话并填入提示词（不会自动发送），确认后再发送。' }),
      grid
    ]))
  }

  /* ---------------- 笔记 ---------------- */
  function renderNotesPanel(panel, video) {
    state.notes = readNotes(video.videoId)
    var input = h('textarea', {
      class: 'notes-input',
      placeholder: '写一条笔记，例如：这段对 scaling laws 的解释很清楚，可引用到综述里',
      attrs: { 'aria-label': '笔记内容' }
    })
    var timeInput = h('input', {
      class: 'note-time-input',
      type: 'text',
      placeholder: '时间戳 如 ' + fmtTime(state.currentStart || 0),
      attrs: { 'aria-label': '笔记时间戳' }
    })
    var addButton = h('button', {
      class: 'btn small primary', type: 'button', onclick: function () {
        var text = input.value.trim()
        if (!text) { toast('笔记内容不能为空', { error: true }); return }
        var time = parseTimeInput(timeInput.value, state.currentStart || 0)
        state.notes.push({ time: time, text: text, createdAt: new Date().toISOString() })
        writeNotes(video.videoId, state.notes)
        input.value = ''
        timeInput.value = ''
        renderNotesList(video)
        toast('笔记已保存到本机浏览器')
      }
    }, [icon('plus', 13), '添加笔记'])
    var copyAll = h('button', {
      class: 'btn small', type: 'button', onclick: function () { copyNotes(video) }
    }, [icon('copy', 13), '复制全部'])
    var aiButton = h('button', {
      class: 'btn small', type: 'button', onclick: function () {
        state.notes = readNotes(video.videoId)
        if (state.notes.length === 0) { toast('还没有笔记，先添加一条', { error: true }); return }
        startSession(organizeNotesPrompt(video, state.notes), 'organize-notes')
      }
    }, [icon('spark', 13), '让 AI 整理笔记'])
    var list = h('div', { class: 'notes-list', id: 'notes-list' })
    panel.appendChild(h('div', { class: 'notes-panel' }, [
      h('p', { class: 'muted', text: '笔记只保存在本机浏览器（localStorage），默认时间戳取当前选中的转录段。' }),
      h('div', { class: 'notes-editor' }, [
        input,
        h('div', { class: 'notes-editor-row' }, [timeInput, addButton]),
        h('div', { class: 'notes-foot' }, [copyAll, aiButton])
      ]),
      list
    ]))
    renderNotesList(video, list)
  }

  function renderNotesList(video, listNode) {
    var list = listNode || byId('notes-list')
    if (!list) return
    clear(list)
    state.notes = readNotes(video.videoId)
    if (state.notes.length === 0) {
      list.appendChild(h('div', { class: 'empty' }, [
        h('strong', { text: '还没有笔记' }),
        h('span', { class: 'muted', text: '在转录里点「存为笔记」，或在上方直接写一条。' })
      ]))
      return
    }
    state.notes.forEach(function (note, index) {
      var item = h('div', { class: 'note', dataset: { index: index } }, [
        h('span', { class: 'time', text: '[' + fmtTime(note.time) + ']' }),
        h('div', { class: 'note-main' }, [
          h('p', { class: 'note-text', text: note.text }),
          h('div', { class: 'note-meta' }, [
            h('span', { text: note.createdAt ? '创建于 ' + fmtDate(note.createdAt) : '' })
          ])
        ]),
        h('div', { class: 'seg-actions' }, [
          h('button', {
            class: 'icon-btn', type: 'button', attrs: { title: '复制这条笔记' },
            onclick: function () { copyWithToast('[' + fmtTime(note.time) + '] ' + note.text, '笔记已复制') }
          }, icon('copy', 14)),
          h('button', {
            class: 'icon-btn delete-note', type: 'button', attrs: { title: '删除这条笔记' },
            onclick: function () {
              state.notes.splice(index, 1)
              writeNotes(video.videoId, state.notes)
              renderNotesList(video, list)
              toast('笔记已删除')
            }
          }, icon('trash', 14))
        ])
      ])
      list.appendChild(item)
    })
  }

  function copyNotes(video) {
    state.notes = readNotes(video.videoId)
    if (state.notes.length === 0) { toast('还没有笔记', { error: true }); return }
    var markdown = state.notes.map(function (note) {
      return '- [' + fmtTime(note.time) + '] ' + note.text
    }).join('\n')
    copyWithToast(markdown, '全部笔记已复制（Markdown）')
  }

  /* ---------------- 侧栏折叠（记住偏好） ---------------- */
  var SIDEBAR_KEY = 'tube-insight:sidebar'

  function readSidebarPreference() {
    try { return window.localStorage.getItem(SIDEBAR_KEY) === 'collapsed' } catch (error) { return false }
  }

  function setSidebarCollapsed(collapsed) {
    if (!els.sidebar) return
    els.sidebar.classList.toggle('is-collapsed', !!collapsed)
    if (els.sidebarToggle) els.sidebarToggle.setAttribute('aria-pressed', String(!!collapsed))
    try { window.localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'open') } catch (error) { /* ignore */ }
  }

  /* ---------------- 加载数据 ---------------- */
  function loadVideos(options) {
    options = options || {}
    state.loadingVideos = true
    state.videosError = ''
    renderStats()
    renderList()
    api('/videos').then(function (data) {
      state.videos = Array.isArray(data.videos) ? data.videos : []
      state.stats = data.stats || { videos: 0, segments: 0, skipped: 0 }
      state.loadingVideos = false
      renderStats()
      renderList()
      var hashId = readHashId()
      var known = state.videos.some(function (video) { return video.videoId === hashId })
      if (hashId && known) {
        if (state.selectedId !== hashId || options.forceDetail) selectVideo(hashId)
        else loadDetail(hashId, true)
        return
      }
      if (state.selectedId) {
        var stillThere = state.videos.some(function (video) { return video.videoId === state.selectedId })
        if (stillThere) {
          loadDetail(state.selectedId, true)
          return
        }
        clearSelection()
      }
      if (state.videos.length > 0) selectVideo(state.videos[0].videoId)
    }).catch(function (error) {
      state.loadingVideos = false
      state.videosError = error && error.message ? error.message : '请求失败'
      renderStats()
      renderList()
    })
  }

  function loadDetail(videoId, force) {
    if (!videoId) return
    if (!force && state.detail && state.detail.videoId === videoId) return
    state.loadingDetail = true
    state.detailError = ''
    state.detail = null
    renderDetail()
    api('/videos/' + encodeURIComponent(videoId)).then(function (data) {
      if (state.selectedId !== videoId) return
      var video = data && data.video ? data.video : null
      if (!video) throw new Error('返回数据缺少 video')
      video.chapters = (Array.isArray(video.chapters) ? video.chapters : []).filter(function (chapter) {
        return chapter && isFinite(Number(chapter.start))
      }).map(function (chapter) {
        return { start: Math.max(0, Math.floor(Number(chapter.start) || 0)), title: String(chapter.title || '') }
      })
      video.segments = (Array.isArray(video.segments) ? video.segments : []).filter(function (segment) {
        return segment && typeof segment.text === 'string' && isFinite(Number(segment.start))
      }).map(function (segment) {
        return { start: Math.max(0, Math.floor(Number(segment.start) || 0)), text: String(segment.text) }
      })
      state.detail = video
      state.youtubeUrl = data.youtubeUrl || ytWatchLink(videoId)
      state.notes = readNotes(videoId)
      state.loadingDetail = false
      renderDetail()
    }).catch(function (error) {
      if (state.selectedId !== videoId) return
      state.loadingDetail = false
      state.detailError = error && error.message ? error.message : '请求失败'
      renderDetail()
    })
  }

  function selectVideo(videoId) {
    if (!videoId) return
    if (state.selectedId === videoId && state.detail) return
    state.selectedId = videoId
    state.tab = 'transcript'
    state.transcriptQuery = ''
    state.matches = []
    state.matchCount = 0
    state.matchIndex = 0
    state.currentStart = 0
    state.notes = readNotes(videoId)
    writeHash(videoId)
    renderList()
    loadDetail(videoId, true)
  }

  function clearSelection() {
    state.selectedId = null
    state.detail = null
    state.detailError = ''
    state.notes = []
    writeHash(null)
    renderList()
    renderDetail()
  }

  /* ---------------- 路由 ---------------- */
  function readHashId() {
    var match = /^#\/v\/([A-Za-z0-9_-]{11})$/.exec(location.hash || '')
    return match ? match[1] : null
  }

  function writeHash(videoId) {
    var target = videoId ? '#/v/' + videoId : '#'
    if (location.hash === target) return
    try {
      history.replaceState(null, '', target)
    } catch (error) {
      location.hash = target
    }
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    if (els.refresh) {
      els.refresh.addEventListener('click', function () {
        toast('正在刷新…')
        loadVideos({ forceDetail: true })
      })
    }
    if (els.search) {
      els.search.addEventListener('input', function () {
        state.query = els.search.value
        renderList()
      })
      els.search.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
          els.search.value = ''
          state.query = ''
          renderList()
        }
      })
    }
    if (els.compareBtn) els.compareBtn.addEventListener('click', compareSelected)
    if (els.sidebarToggle) {
      els.sidebarToggle.addEventListener('click', function () {
        var collapsed = !els.sidebar.classList.contains('is-collapsed')
        setSidebarCollapsed(collapsed)
      })
    }
    setSidebarCollapsed(readSidebarPreference())
    if (els.compareClear) {
      els.compareClear.addEventListener('click', function () {
        state.compare = []
        renderCompareBar()
        renderList()
      })
    }
    window.addEventListener('hashchange', function () {
      var videoId = readHashId()
      if (videoId && videoId !== state.selectedId) selectVideo(videoId)
      else if (!videoId && state.selectedId) clearSelection()
    })
    window.addEventListener('keydown', function (event) {
      var tag = (event.target && event.target.tagName) || ''
      if (event.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        event.preventDefault()
        if (els.search) els.search.focus()
      }
    })
  }

  function cacheElements() {
    els.stats = byId('stats')
    els.refresh = byId('refresh-btn')
    els.list = byId('video-list')
    els.search = byId('video-search')
    els.compareBar = byId('compare-bar')
    els.compareCount = byId('compare-count')
    els.compareBtn = byId('compare-btn')
    els.compareClear = byId('compare-clear')
    els.sidebar = byId('sidebar')
    els.sidebarToggle = byId('sidebar-toggle')
    els.detail = byId('detail')
    els.toasts = byId('toast-container')
  }

  function init() {
    cacheElements()
    initThemeBridge()
    bindEvents()
    renderStats()
    renderList()
    renderDetail()
    renderCompareBar()
    loadVideos()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
