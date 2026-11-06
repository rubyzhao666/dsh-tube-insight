# dsh-tube-insight

> 在 DeepSeek Harness 里把 YouTube 视频变成**可引用、可归档、可检索的中文知识**：抓字幕 → 语义分段 → 跨视频检索 → 主题综述证据底稿 → 带 `[MM:SS]` 时间戳的分析 → 导出 Markdown。

基于 [rubyzhao666/tube-insight](https://github.com/rubyzhao666/tube-insight)（MIT，作者 Zara Zhang）改造成 DSH 插件。上游是 Chrome 扩展（侧边栏 + Supabase/Supadata + 另配大模型 API key）；本插件把「确定性重活」搬到 Host（抓字幕、分段、落盘、导出），**分析/写作交给当前会话的模型本身**——不需要第二个 API key，也不会双份计费。

## 能力

- **抓字幕**：`tube_transcript` 给一个 YouTube URL/ID，返回标题、频道、时长、字幕语言（原生/自动生成）、语义段落数、章节、缓存路径和开头/结尾预览。不需要 Chrome 扩展、不需要打开浏览器。
- **可读分段**：把逐条自动字幕合并成完整句子和可读段落（按停顿 >2 秒或句末标点 + 长度上限切段），每段保留起始秒；同时写一份带 `[MM:SS]` 的 Markdown 供模型 `read`。
- **章节解析**：从视频描述的 `00:00 标题` 时间戳解析章节（≥2 条才采用）。
- **导出归档**：`tube_export` 把模型写好的正文变成带 YAML frontmatter、文末「来源」时间戳链接的 Markdown，落盘并维护同目录 `index.md`（按 module 分组）。
- **跨视频检索**（0.2.0）：`tube_search` 在**你以前抓取过的所有视频**的转录里检索关键词（BM25 + 连续短语加成，中英文/CJK 分词），返回视频、`[MM:SS]` 时间戳、原文片段和可跳转链接，适合「我以前看过的视频里关于 X 是怎么说的」和主题综述。只搜本机缓存，不是全网搜索。
- **主题综述底稿**（0.3.0）：`tube_synthesis` 一次对 1–7 个检索词（`query` + `queries`）分别检索已缓存视频，按「视频 + 时间戳」合并去重、按视频分组截断，直接产出固定结构的**证据底稿**（每条带 `[MM:SS]` 与可跳转链接、未命中视频、覆盖统计）；给了 `dir` 还能一键落盘为带 frontmatter（module=knowledge）、来源区块和 `index.md` 的 Markdown。模型基于底稿写综述，引用不用手抄。
- **随包 skill**：`tube-insight` skill 提供 overview / intel / insights / prd / compare / knowledge / translation 七种工作流与引用铁律，模型按需加载。
- **左侧栏「视频库」**（0.4.0）：DSH Web 左侧栏多一个「视频库」入口，主区域是只读页面 `/tube-insight/`——缓存视频列表（标题/频道/时长/段数/抓取时间）、服务端字幕检索 `?q=`（`[MM:SS]` + 原文片段 + 跳转链接）、单视频转录页 `/tube-insight/v/<videoId>`（元数据、章节、完整 `[MM:SS]` 转录）。页面由 Host 直接渲染，无前端构建、无外部资源、不写盘；重启 DSH App 后入口才会出现。

边界：只处理**有字幕（原生或自动生成）**的视频，不做语音转写（ASR）；不做登录后才能看的私享视频。

## 安装

本插件是纯 ESM、零运行时依赖的 DSH bundle 包。在 DeepSeek Harness 里安装本地目录：

```
plugin_manager { action: "install_bundle", target: "<本目录绝对路径>" }
```

或使用 DSH 的 Plugins 界面添加本地目录。安装后应能看到四个工具 `tube_transcript`、`tube_search`、`tube_synthesis`、`tube_export` 和 `tube-insight` skill。

前置条件：Node.js `^22.19.0 || >=24.0.0`，DSH `>=0.2.1-rc.2 <0.3.0`。**不需要** Chrome 扩展、不需要 Supadata/Supabase 才能抓原生字幕（Supadata 只是可选兜底）。

## 使用

对话里直接说：

- 「看看这个视频讲了什么：https://www.youtube.com/watch?v=zjkBMFhNj_g」
- 「把这个视频整理成产品情报 / 洞察笔记 / PRD 草稿」
- 「对比这两个视频的差异，存到我的笔记目录」
- 「把上面内容导出成 Markdown，放到 <工作区绝对路径>」
- **找回忆**：「我以前看过的视频里，关于 LLM 训练数据是怎么说的？」→ 模型调用 `tube_search` 拿回带时间戳的原话，再把有用片段整理给你；需要展开某条时它会 `read` 对应缓存全文。
- **主题综述**：「把我缓存里所有视频里关于 pricing / 模型评估的内容找出来，整理成一篇知识卡片」→ `tube_search` 取证 → 按 skill 汇总 → `tube_export`（module=knowledge 或 insights）存档。
- **整理成主题综述**：「把我看过的视频里关于 AI 产品的说法整理成一篇综述」→ `tube_synthesis` 一次多词检索拿到底稿（可选一键落盘）→ 模型基于底稿写综述（共识/分歧/覆盖缺口），引用直接沿用底稿链接。


> **不用记工具名**：本节提到的 `tube_transcript` / `tube_search` / `tube_synthesis` / `tube_export` 是模型内部调用的函数名，不是你要说的话。你只需要用自然语言说出目的，模型会根据随包 skill 自动选对动作；叫它「TubeInsight」或「看视频那个功能」都可以。

模型会先调用工具拿字幕，再按 skill 的工作流产出内容。`tube_search` **只搜你以前用 `tube_transcript` 抓过的视频**：缓存为空时会报错并提示先抓取视频，不会去搜全网。

### 视频库页面（0.4.0）

安装并**重启 DSH App** 后，左侧栏出现「视频库」入口，主区域打开 `/tube-insight/`：

- 首页：缓存统计 + 视频列表（按抓取时间倒序）+ 搜索框；搜索走 `GET /tube-insight/?q=<关键词>`（服务端词法检索，最多 20 条结果）。
- 转录页：`GET /tube-insight/v/<11 位 videoId>`，含标题/频道/时长/字幕语言/章节/完整转录，每段 `[MM:SS]` 可直接跳到 YouTube 对应时间。
- 只读：仅支持 `GET/HEAD`（其它方法 405）；未知路径/非法 videoId/未缓存视频 404；损坏缓存自动跳过；所有缓存文本与 query 都做 HTML 转义；页面不加载任何外部资源（YouTube 只是跳转链接）。

> 页面是「看和翻」用的；抓取/检索/分析仍在对话里由模型调用工具与 skill 完成。

### 工具签名

`tube_transcript`

| 参数 | 类型 | 说明 |
|---|---|---|
| `video` | string，必填 | YouTube URL 或 11 位 videoId |
| `languages` | string[]，可选 | 字幕语言优先级，默认 `["en","zh-Hans","zh","ja"]` |
| `refresh` | boolean，默认 false | true 时忽略缓存重抓 |
| `format` | `segments` \| `text`，默认 segments | inline 正文的格式：带时间戳 / 纯文本 |
| `inline` | boolean，默认 false | true 时把全文放进返回值（约 60k 字符上限，超出截断）；默认只回预览 + 路径 |

返回：`videoId, title, channel, durationSeconds, publishedAt?, language, captionKind(native|asr), source, segmentCount, charCount, chapters[], transcriptPath, cacheJsonPath, fetchedAt, cached, preview{head,tail}, inlineText?, truncated?`。

`tube_search`（0.2.0，跨视频检索）

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string，必填 | 检索词，1–200 字符，支持中英文混合 |
| `video` | string，可选 | 只搜这一条视频（URL 或 11 位 ID）；解析不了/不在缓存里会报错 |
| `since` | string，可选 | 只搜缓存时间（`fetchedAt`）不早于该日期的视频，ISO 日期 `YYYY-MM-DD` |
| `limit` | number，可选 | 1–20，默认 8（>20 按 20 处理） |
| `context` | number，可选 | 0–2，默认 1：命中段前后各返回几段作为 `before`/`after` |

返回：`query, scannedVideos, matchedVideos, resultCount, scannedSegments, elapsedMs, results[], truncated?, skippedCacheFiles?`；
每条结果含 `videoId, title, channel, url, startSeconds, timestamp, link, text, score, matchedTerms, before?, after?`。
打分用 BM25（k1=1.2、b=0.75）+ query 连续短语 ×1.8；English 按词匹配，中文连续片段按 bigram 匹配。缓存超过 500 条时只扫最近 500 个视频（`truncated: true`）；损坏的缓存文件自动跳过、不影响检索。

`tube_synthesis`（0.3.0，检索 → 综述证据底稿）

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string，必填 | 主题/主检索词，1–200 字符；也用作底稿标题与文件名 |
| `queries` | string[]，可选 | 额外检索词 0–6 个（与 query 合并去重后各检索一次） |
| `video` | string，可选 | 只检索这一条视频（URL 或 11 位 ID） |
| `since` | string，可选 | 只检索缓存时间不早于该日期的视频，ISO `YYYY-MM-DD` |
| `limitPerVideo` | number，可选 | 每个视频最多几条证据，1–8，默认 4 |
| `maxVideos` | number，可选 | 最多保留几个视频，1–10，默认 10 |
| `dir` | string，可选 | 导出目录绝对路径；给了就落盘，不传只返回底稿 |
| `title` | string，可选 | 落盘文件 frontmatter 标题（默认「主题综述：<query>」），文件名仍用 query |

返回：`query, queries, scannedVideos, scannedSegments, videos[{videoId,title,channel,url,durationSeconds,hits[{timestamp,startSeconds,link,text}]}], coverage{hitVideos,zeroHitVideos,totalHits,queriedTerms}, markdown, path?, indexpath?, bytes?`。
多词结果按「视频 + 时间戳」合并去重（重复命中保留分高者），视频按命中数降序、组内按时间升序；无命中且传了 `dir` 会报错且不落盘，无命中不传 `dir` 则返回空底稿。底稿链接直接来自 `tube_search` 返回，写综述时原样使用，不要重拼。

`tube_export`

| 参数 | 类型 | 说明 |
|---|---|---|
| `videos` | string[]，必填 | 1–10 个 YouTube URL/ID |
| `module` | enum，必填 | `overview` / `intel` / `insights` / `prd` / `compare` / `knowledge` / `translation` |
| `markdown` | string，必填 | 模型写好的正文（插件不改写正文） |
| `title` | string，可选 | 标题，兼作文件名；缺省用第一个视频标题 |
| `dir` | string，可选 | 导出目录**绝对路径**，默认 `~/TubeInsight` |
| `notes` | string[]，可选 | 用户笔记，原样追加为「## 我的笔记」 |

返回：`path, indexpath, bytes, title, module, videos[]`。

## 字幕来源与降级链

按顺序尝试，前一条失败才走下一跳：

1. **InnerTube IOS**（主路径，实测可用）：取 watch 页的 `INNERTUBE_API_KEY`/`VISITOR_DATA` → `youtubei/v1/player`（IOS client）→ `captionTracks[].baseUrl + &fmt=json3`。
2. **watch 页 `ytInitialPlayerResponse`**：同一份页面 HTML 里的播放器响应，作为 InnerTube 播放器接口失败时的兜底（可能遇到 pot 校验）。
3. **Supadata**（可选，需 key）：`/v1/transcript?mode=native`，>20 分钟的视频自动走异步 job 轮询。
4. **yt-dlp**（可选，系统里有才用）：`--write-auto-subs --write-subs --sub-format json3 --skip-download`。

全部失败时错误信息会列出每一步的原因和下一步操作（重试 / 配 Supadata / 装 yt-dlp / 换视频），不会静默返回空。

注意：Android/Web client 与老式 `/api/timedtext` 直连目前不可用（实测 400 / UNPLAYABLE / 0 字节），插件不使用它们。

## 配置

**无需配置即可抓原生字幕。** 可选配置（密钥只从环境变量或配置文件读，插件不会自动写密钥）：

| 方式 | 键 | 说明 |
|---|---|---|
| 环境变量 | `SUPADATA_API_KEY` | Supadata 兜底路径的 key（优先级高于配置文件） |
| 配置文件 | `$DSH_HOME/tube-insight/config.json` | `{"supadataApiKey": "..."}` |
| 环境变量 | `DSH_TUBE_INSIGHT_YTDLP` | 自定义 yt-dlp 可执行文件路径（默认 `yt-dlp`） |

`$DSH_HOME` 默认 `~/.dsh`。

## 数据位置

```
$DSH_HOME/tube-insight/
├── config.json          # 可选，手工放配置/密钥
├── cache/
│   ├── <videoId>.json   # 元数据 + 语义段落 + 章节（机器可读，可删可重建）
│   └── <videoId>.md     # 人/模型可读的 [MM:SS] 转录（用 read 工具读）
├── indexes/<hash>.json  # 导出目录的索引元数据（index.md 的机器可读副本）
└── exports/             # scripts/smoke.mjs 的验证产物（正常导出由 dir 参数决定）
```

用户导出目录由 `tube_export` 的 `dir` 参数指定（默认 `~/TubeInsight`）。缓存永久有效，`refresh=true` 重抓；重复调用先查缓存（幂等）。

`tube_search` **只读** `cache/` 目录：不写任何文件、不发网络请求、不新增数据目录。缓存超过 500 条时只扫描最近 500 个视频（按 `fetchedAt`），并在返回里标记 `truncated: true`。想搜最新内容前，先用 `tube_transcript` 抓取/刷新对应视频。

视频库页面（`/tube-insight/`）同样只读 `cache/`，不新增任何数据目录；页面 HTML 由 Host 现渲染，不落盘。

`tube_synthesis` 默认也只读缓存；只有传 `dir` 时才写导出目录（复用 `tube_export` 的导出管线：frontmatter module=knowledge、文末来源、`index.md`，重名自动加序号）。

## 导出格式

```markdown
---
title: "…"
module: "overview"
generated_at: "2026-11-06T01:43:44.724Z"
generator: "dsh-tube-insight@0.2.0"
source:
  - title: "…"
    channel: "…"
    url: "https://www.youtube.com/watch?v=<id>"
    videoId: "<id>"
    durationSeconds: 3588
---

<模型写的正文>

## 我的笔记
- …

## 来源

- [标题](https://youtu.be/<id>?t=0) · 频道 · 59:48
```

文件名规则：标题保留中文与英文数字、空格转 `-`、截断 60 字符，再加 `_<YYYY-MM-DD>.md`；重名自动加 `-2`、`-3`。同目录 `index.md` 按 module 分组汇总，重复导出会更新。

## 本地开发与测试

```bash
cd plugins/dsh-tube-insight
node --check lib/index.js
node --test test/*.test.mjs      # 全部不联网：用假 ctx + mock fetch
npm pack --dry-run               # 检查 files 完整性
node scripts/smoke.mjs           # 真实抓一个视频（需要网络），产物写 $DSH_HOME/tube-insight/
```

测试覆盖：插件形状、工具注册、skill provider（`skills/` 不存在也不报错）、URL 解析、语义分段、章节解析、缓存往返、导出格式、跨视频检索（分词/BM25/短语加成/video·since·limit·context 过滤/坏缓存跳过/500 条截断/性能 100 视频 5 万段 <2s）、综述底稿（多词合并去重/分组截断/固定结构/落盘 frontmatter+index/确定性/错误路径）、视频库页面（HTML 契约/XSS 转义/404·405·HEAD/损坏缓存/空缓存引导/检索 limit 20/单页 ≤2MB 截断）、侧栏 client 半边（package.json 声明/`node --check`/`__ModuleLoader__` 装载模拟/iframe 与图标）、工具 happy path + 各种错误路径（无字幕 / 年龄限制 / 网络失败 / Supadata key 无效 / 参数错误）。

## 隐私与许可

- 插件只访问 YouTube / Supadata（可选）网络接口，不收集、不上传用户数据，无遥测。
- 所有持久数据写在 `$DSH_HOME/tube-insight/` 与用户指定的导出目录。
- 字幕抓取依赖 YouTube 内部接口，可能随 YouTube 改版失效；插件会给出可操作的错误与降级建议。

MIT。上游 [rubyzhao666/tube-insight](https://github.com/rubyzhao666/tube-insight) © 2026 Zara Zhang；DSH 插件改造 © 2026 rubyzhao666。详见 [LICENSE](./LICENSE)。
