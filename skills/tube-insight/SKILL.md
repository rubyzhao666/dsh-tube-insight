---
name: tube-insight
description: 处理 YouTube 视频（贴链接或 11 位 ID）：看视频讲了什么、视频洞察、视频转笔记、产品情报、竞品/多视频对比、视频转 PRD、字幕翻译与双语，以及在用户以前抓过的视频里回忆/检索和做主题综述，产出带 [MM:SS] 可跳转引用、可存档的 Markdown。
---

# TubeInsight：把 YouTube 视频变成知识资产

> 移植自 TubeInsight Chrome 扩展（MIT，rubyzhao666/tube-insight）。原版用 Supadata 抓字幕、用 DeepSeek API 做分析；在 DSH 里，抓字幕由 `tube_transcript` 完成，跨视频回忆/检索由 `tube_search` 完成，主题综述的证据底稿由 `tube_synthesis` 生成，分析由**你**完成，所以不需要第二个 API key，也不额外计费。

这个 skill 解决两件事：用户扔来一条或多条 YouTube 视频，你把它变成用户想要的形态——概览、产品情报、行业洞察、PRD 草稿、横向对比、知识卡片、翻译、笔记；或者用户问「我以前看过的视频里关于 X 都怎么说的」，你在本地缓存的视频库检索、核实并写成主题综述。**核心纪律：每条结论都能回到视频原文的具体时间点。** 做不到这一点，这个 skill 视为不合格。

## 何时触发

用户做出下面任一动作时，使用本 skill：

- 贴出 YouTube 链接（`youtube.com/watch?v=...`、`youtu.be/...`、`youtube.com/shorts/...`）或 11 位视频 ID，让你看/总结/分析/翻译这条视频；
- 说「这条视频讲了什么」「帮我看看这个视频」「视频字幕」「视频转笔记」「视频洞察」；
- 说「我以前看过的视频里…」「我记得有个视频说…」「把看过的视频里关于 X 的观点汇总」「主题综述」「把看过的视频整理成文章」「存成文章」「搜一下我抓过的视频」——用户指的是**以前抓过、看过**的视频，不是新链接（走模式 0）；
- 说「产品情报」「竞品视频分析」「这个产品怎么样」「提炼一下方法论」；
- 说「多视频对比」「这几条视频有什么共同点/差异」；
- 说「把视频做成 PRD」「从视频里出产品方案」；
- 说「整理成知识卡片」「导出到 Obsidian / Notion / 知识库」；
- 说「字幕翻译成中文」「双语字幕」「把视频内容翻成英文」。

不触发（直接说明并给替代方案，不要硬套）：用户只要下载视频/音频文件、要视频截图、要分析封面图片、要抓取非 YouTube 平台视频。

## 边界

- 只处理 YouTube 标准 watch 页视频。Shorts、直播、私密、会员、年龄/地区受限、完全无字幕的视频可能抓不到——见「失败兜底」。
- **转录是唯一事实来源。** 视频没说的不要替它说；术语/行业背景可以补充，但必须标「（背景补充）」或「（我的判断）」。
- 检索（`tube_search`）只覆盖本地缓存里**已经抓过**的视频，不是全网搜索；要搜全网用 `web_search`，并说明这是全网结果。
- 一次分析最多 10 个视频（`tube_export` 的硬上限），更多要分批。
- 导出时目录用绝对路径。

## 模式 0：回忆 / 检索（先判断是不是这一类）

用户给的是**新链接** → 走下面「工作流（四步）」。用户指的是**以前抓过、看过的视频**（「我记得有个视频……」「看过的视频里关于 X 怎么说……」）→ 走检索分支：

1. 读 `references/recall.md`，把用户的口语整理成检索词（同义词、中英各一轮；视频里怎么说就怎么搜）。
2. 调 `tube_search`（`query` 必填；可带 `video` / `since` / `limit` / `context`）——它只搜本地缓存，不是全网。
2.5. **第 2.5 步：底稿**——用户要存档 / 发文章 / 做主题综述时，先调 `tube_synthesis({ query, queries: [2–4 个中英/同义检索词], limitPerVideo, maxVideos, dir })`：一次完成多轮检索，返回按视频分组的证据底稿 `markdown` 与 `coverage`；要落盘就把绝对路径传给 `dir`。**底稿里的 `[MM:SS]` 与 youtu.be 链接必须原样使用，不得改写/重拼**；无命中且给了 `dir` 会报错（换词或去掉 dir 重试），无命中且没给 dir 返回空底稿 + `zeroHitVideos`。
3. 读结果里的 `link` / `timestamp` / `text` / `before` / `after`；要当金句或明确结论引用时，用 `tube_transcript` 拿 `transcriptPath` 再 `read` 核实上下文（缓存命中，秒回）。
4. 输出：找回某条视频 → 视频卡片；观点汇总 / 主题综述 → 带双引用的综述（写明扫描范围与检索词；主题综述基于底稿**重写**，不直接贴底稿原文）。
5. 结果不足先换词/换语言再下结论；用户要存档：底稿要落盘用 `tube_synthesis` 的 `dir`，最终成稿用 `tube_export`（`module=insights` 或 `knowledge`；`videos` 只放实际引用到的视频，≤10）。

## 工作流（四步）

### 第 1 步：抓字幕 —— 调用 `tube_transcript`

| 参数 | 怎么传 |
|---|---|
| `video` | 必填。YouTube URL 或 11 位视频 ID。多条视频逐个调用，每次一个 |
| `languages` | 可选。字幕语言优先级，默认 `["en","zh-Hans","zh","ja"]`：先按顺序找原生字幕，找不到再按顺序找自动字幕。中文视频直接命中，一般不用改 |
| `refresh` | 可选，默认 `false`。缓存永久有效；只有用户明确要最新内容、或你确认缓存内容不对时才传 `true` |
| `format` | 可选。只影响 `inline=true` 时返回的正文：`segments`（默认，每段带 `[MM:SS]`）或 `text`（无时间戳纯文本）。要引用时间就用默认值 |
| `inline` | 可选，默认 `false`。`true` 时把转录正文直接放进返回值，上限 6 万字符，超出会截断并返回 `truncated: true`。短转录可以省一次 `read`；长视频别用，截断会丢掉后半段 |

返回给你的是**摘要不是全文**：`videoId`、标题、频道、时长、字幕语言、`captionKind`（`native` 原生 / `asr` 自动生成）、抓取来源、段落数、字数、章节列表（可能为空）、`transcriptPath`（本地缓存 md 的绝对路径）、`cacheJsonPath`、是否命中缓存、`preview.head/tail`。

记住两样东西：`videoId`（拼引用链接用）和 `transcriptPath`（读全文用）。工具幂等，同一视频重复调用走缓存，不会重复抓。

### 第 2 步：需要全文时读缓存 —— 调用 `read`

- **必须读全文的情况**：做 overview / intel / insights / prd / compare / knowledge / translation 中任何实质分析。
- **可以不读的情况**：只回答「这条视频大概讲什么」「值不值得看」这类一句话问题，可以直接用返回值里的标题、预览和章节回答。
- **怎么读**：`read` 的 `file_path` 传 `transcriptPath`。转录 md 的结构是：`# 标题` + 元信息（频道 / 时长 / 视频链接 / 字幕）→「## 视频描述」（可能没有）→「## 章节」（可能没有）→「## 转录」，转录部分每段一行、行首是 `[分:秒]` 时间戳（分钟累计、分钟不补零，超过 1 小时是 `[65:04]` 这种写法），时间戳是该段**起始**时间。引用时**原样照抄行首时间戳**，不要自己补零、去零或改写成 `1:05:04`。
- **长视频**：一次读不完就用 `offset` / `limit` 分页读完，不要只读开头就下结论；边读边记每章要点，避免读完后面忘了前面。
- **定位片段**：用户问某个具体话题或时间点时，先用 `grep` 工具在 `transcriptPath` 里搜关键词或时间戳前缀（如 `\[12:3`），再用 `read` 读前后几十行。为了一句原话重读全文不值得。
- **专有名词与 ASR**：`captionKind=asr` 会有同音错字、人名/术语拼错。转录 md 的「## 视频描述」和标题就是校正依据，用它修正人名、公司名、技术术语；拿不准的保留原文或标注「（疑似 ASR 错误）」。

### 第 3 步：选定模式并产出

| 用户意图 | 模式 | 产出前必读 |
|---|---|---|
| 回忆 / 检索 / 主题综述（用户指的是**以前抓过、看过**的视频，不是新链接） | recall（模式 0） | `references/recall.md`；要存档再看 `references/insights.md` / `references/knowledge.md` |
| 讲了什么 / 章节 / 要点 / 金句 / 值不值得看（默认模式） | overview | `references/overview.md` |
| 产品情报：功能、痛点、竞品、商业模式；非产品视频的方法论 | intel | `references/intel.md` |
| 行业术语解释、核心观点、技术边界、PM 视角 | insights | `references/insights.md` |
| 把视频做成 PRD / 产品方案 | prd | `references/prd.md`（先按 `references/intel.md` 判定内容类型） |
| 2–10 条视频横向对比 | compare | `references/compare.md` |
| 整理成知识卡片 / 导出到知识库 | knowledge | `references/knowledge.md` |
| 翻译 / 双语（可叠加在任一模式上，纯字幕翻译也走这里） | translation | `references/translation.md` |
| 把某个时间点的话整理成笔记 | notes | `references/notes.md` |
| 只要字幕原文 / 逐字稿 | transcript（不算分析模式） | 不用读 reference：直接按 `read` 到的原文输出，保留 `[MM:SS]` 行首（用户要纯文本再去掉），并说明是视频原字幕、可能有 ASR 错误 |

补充：用户只问「某个词/某句话什么意思」时，不进入任何模式——结合上下文用 1–3 句话解释，规则是极简、不套话、不展开成报告（上游 explain 提示词的能力）。

先问自己一句：用户要的是**对话里看**还是**存成文件**。默认先给对话里的 Markdown，满意后再导出（第 4 步）。

#### 引用铁律（违反即返工）

1. 每条关键结论、每个金句、每条功能/痛点/洞察，都要带**双引用**：`[2:14](https://youtu.be/<videoId>?t=134)`——看得见时间，点得开视频。
2. `[MM:SS]` 必须原样来自转录行首真实存在的时间戳；格式与转录一致——分钟不补零（`[2:14]`、`[12:30]`、`[65:04]`），链接里的秒数 = 分×60 + 秒。**禁止编造、估算或用 `0:00` 兜底**（除非内容确实在第 0 秒）。
3. 所有时间戳必须落在 `0` 到 `durationSeconds` 之间。
4. 章节必须覆盖全片：不能全堆在开头，**最后一章起点必须晚于全片 75% 处**（短视频也一样）。
5. 视频没讲的内容不许写成视频的观点；需要补充时明确标「（背景补充）」「（我的判断）」。
6. **videoId 只能来自工具返回字段**：`tube_search` 返回的 `url` / `link`，或 `tube_transcript` 返回的 `videoId`。禁止凭记忆手打——YouTube ID 大小写敏感，错一个字符链接就失效；补充清单里没有工具字段支撑的视频，只写标题 + 频道，不给链接（宁缺勿错）。

#### 语言策略

- 默认中文输出。标题、频道名、产品名、专有名词和约定俗成的技术词（AI、API、GitHub、Claude Code、skill 等）保留原文。
- 金句引用默认保留视频原话（清理后）；中文正文里需要时在下面附一行译文，不要把译文冒充原话。
- 用户要英文、双语对照，或要翻译字幕/输出 → 必须先读 `references/translation.md`，按那里的规则做，不要自由发挥。
- 翻译、转述都不得改动时间戳数值，转录与译文逐段对应。

#### 模式速览（模式 0 + 六种分析模式，完整格式见对应 reference）

| 模式 | 输出骨架（对话里给 Markdown） | 引用要求 |
|---|---|---|
| recall（模式 0） | 检索范围与检索词 → 找回的视频卡片 / 按主题分组的观点汇总 → 共识与分歧 → 覆盖不到的地方（主题综述先用 `tube_synthesis` 拿证据底稿） | 每条结论双引用且 `videoId` 与内容对应；`tube_synthesis` 底稿里的链接**原样使用、不重拼**；写清扫描了 N 个视频、M 个段落；无命中时换词后再如实说没有 |
| overview | 一句话总结 → 章节（时间 + 标题 + 1–2 句）→ 3–5 条金句 → 关键时刻 → 值不值得看 | 每章起始、每条金句必须双引用；章节覆盖到片尾（最后一章 > 75%） |
| intel | 内容类型判断（product / methodology）→ 一句话 → 功能 / 痛点 / 竞品 / 商业关键词（方法论类则换核心方法论 / 原则 / 可迁移场景 / 关键词） | 每条来自视频的条目带双引用；视频未提及就写「未提及」 |
| insights | 术语表（术语 / 分类 / 解释 / 首次出现）→ 按发言人的核心观点 → PM 最有价值的三点 → 技术边界表 | 每条观点双引用；术语表每行给首次出现链接；技术边界只取视频原话 |
| prd | 六章：背景与目标 / 目标用户 / 用户故事 / 核心功能（P0–P2 + 视频依据）/ 验收标准 / 待确认问题 | 功能表每行给视频依据；背景里的视频事实带引用；推断标「（推断）」 |
| compare | 视频清单 → 视频概览表 → 核心功能/观点对比矩阵 → 共同趋势 → 差异化亮点 → PM 行动建议 → 延伸阅读 | 矩阵每格至少一处对应视频的双引用；共同趋势至少 2 个视频有证据 |
| knowledge | 标题 / 来源 / 日期 / 标签 → 核心价值一句话 → 内容摘要 → 产品情报（或核心方法论）→ 关键洞察（+ 技术边界）→ PRD 要点 → 我的笔记 → 下一步行动 | 摘要、功能、洞察、PRD 要点每条双引用；用户笔记原样保留、不强行加引用 |

`recall` 是模式 0（跨视频找回证据），不是分析模式；`translation` 与 `notes` 也不是分析模式：`translation` 是叠加在任一模式上的语言层（也可纯翻译字幕），`notes` 是单点笔记润色；两者都保留原有时间戳与双引用格式。

### 第 4 步：存档 —— 调用 `tube_export`

触发时机：用户说「保存 / 导出 / 存档 / 整理成文件 / 放进 Obsidian / 发我一份」，或一轮分析结束且用户明显要长期留存。只聊不存时不要调。

| 参数 | 怎么传 |
|---|---|
| `videos` | 必填 string[]，1–10 个 URL 或 ID；compare 模式传全部参与对比的视频 |
| `module` | 必填。`overview` / `intel` / `insights` / `prd` / `compare` / `knowledge` / `translation`，与本次产出一致 |
| `markdown` | 必填。你写好的正文。**不要再包 YAML frontmatter、不要自己写「## 我的笔记」或「## 来源」区块**——工具会自动加 |
| `title` | 可选。自定义标题（也用于文件名）；不传就用第一个视频的标题 |
| `dir` | 可选。导出目录**绝对路径**（相对路径会被拒绝）：用户指定了用用户的；没指定就传用户当前工作区下的 `TubeInsight/`，并在交付时告诉用户文件在哪。不传则落到 `~/TubeInsight` |
| `notes` | 可选 string[]。用户的原始笔记，原样传，不要改写；工具会追加成「## 我的笔记」。正文里已经写了「我的笔记」章节时不要再传，避免重复 |

工具行为：补齐 YAML frontmatter（来源视频元数据、module、生成时间、generator）→ 写入正文 → 有 `notes` 时追加「## 我的笔记」→ 文末自动追加「## 来源」区块（每个视频一行可跳转链接）→ 文件名 `<标题slug>_<YYYY-MM-DD>.md`（重名自动加序号）→ 更新同目录 `index.md`（按 module 分组）。返回 `path` / `indexpath` / `bytes`。

规则：

- `markdown` 里的双引用要靠你自己写对；工具不会替你补引用、也不会改写正文，写错了就是错。
- 导出前这些视频最好都已经 `tube_transcript` 过；工具会对不在缓存里的视频补抓，补抓失败会直接报错并让你先抓或从 `videos` 里移除。
- 导出成功后，把返回的 `path` 告诉用户；需要时再 `read` 回来核对关键段落。
- **不要**自己用 `write` / bash 往导出目录塞 Markdown 冒充导出——会丢 frontmatter、笔记、来源区块和 index.md。

## 三个走通的例子

**例 1：用户贴一条链接说「这条视频讲了什么」**

1. `tube_transcript({ video: "https://youtu.be/<id>" })` → 拿到标题、时长、章节、`transcriptPath`；
2. `read` 传 `transcriptPath` 读全文；
3. 读 `references/overview.md`，按契约产出章节 + 金句，全部双引用；
4. 用户说「存下来」→ `tube_export({ videos: ["<id>"], module: "overview", markdown: "…", dir: "<用户工作区绝对路径>/TubeInsight" })`，把返回的 `path` 告诉用户。

**例 2：用户给 3 条竞品视频说「对比一下」**

1. 逐个 `tube_transcript` + `read`，每读完一条就记一份对比摘要（含 3 个左右带时间戳的证据）；
2. 读 `references/compare.md`，按六节模板写报告，矩阵每个单元格带对应视频的双引用；
3. 用户要导出 → `tube_export({ videos: [3 个 id], module: "compare", markdown: "…" })`。

**例 3：用户说「我记得以前有个视频讲过 token 定价不合理，帮我找出来」**

1. 读 `references/recall.md`：用户中文、视频可能是英文，检索词准备 `token pricing`、`pricing`（第二轮再换 `billing` / `token 收费`）。
2. `tube_search({ query: "token pricing" })` → 看 `timestamp` / `link` / `text`；命中少就换词再搜一轮。
3. 锁定视频后 `tube_transcript` + `read` 核实上下文 → 给视频卡片（标题 / 频道 / 链接 / 命中片段）。
4. 用户说「把相关观点整理成综述 / 存成文章」→ 先 `tube_synthesis({ query: "token pricing", queries: ["pricing model", "billing"], dir: "<工作区绝对路径>/TubeInsight" })` 拿证据底稿（带 `dir` 会落盘）；基于底稿按 `references/insights.md` 的结构重写成综述，链接原样沿用；需要最终成稿再 `tube_export({ module: "insights", videos: [底稿里实际引用的 id…] })`。

## 失败兜底

| 现象 / 报错 | 你该做什么 |
|---|---|
| 工具报「没有可用字幕」 | 明说该视频没有原生或自动字幕；给三个选项：① 用户把字幕/转录文本贴进对话，你照常分析；② 换同一内容的另一条有字幕视频；③ 只基于标题、描述和章节做**有限概览**，并显式标注「无字幕降级」 |
| 地区/年龄/私密/会员/直播/Shorts 限制 | 说明是视频侧限制，不是工具故障；建议换公开标准视频或让用户提供转录 |
| 风控（如 no INNERTUBE_API_KEY）或网络失败 | 先重试一次；仍失败则说明可能是临时风控，建议稍后再试，或由用户自行配置兜底（`SUPADATA_API_KEY` 环境变量、安装 `yt-dlp`）。**不要擅自安装系统软件** |
| 调用超时但可能已写缓存 | 用 `refresh=false` 再调一次，先看 `transcriptPath` 是否存在，再决定要不要重抓 |
| 视频超长（1 小时以上） | 用 `offset` / `limit` 分段读完；产出可分「上半场 / 下半场」两段再合并，避免漏掉后段 |
| 用户一次给超过 10 个视频 | 分批抓取分析；导出时按主题拆成多份（每份 ≤10 个来源），或与用户确认只保留最相关的 10 个 |
| 转录质量差 | 标注不确定性；关键人名/数字标「（疑似 ASR 错误）」；不要为了通顺硬编 |
| 检索结果为空，或 `tube_search` / `tube_synthesis` 报「缓存为空」/「本次检索无命中，未导出」 | 按 `references/recall.md` 换同义词/换语言再搜（2–3 轮）；缓存为空就说明还没有抓过视频，请用户给链接先用 `tube_transcript` 抓；`tube_synthesis` 无命中 + `dir` 时去掉 dir 或换词重试；仍需全网答案就用 `web_search` 并注明是全网结果 |

## 交付前自查

1. 每条关键结论/金句都有 `[MM:SS]` + `https://youtu.be/<videoId>?t=<sec>` 双引用吗？方括号里的时间和链接里的秒数一致吗？
2. 每个时间戳都在转录里真实出现过吗？有没有为了「看起来完整」编一个？
3. 章节覆盖到视频结尾了吗（最后一章起点 > 75%）？有没有全堆在开头？
4. 标题、频道、时长与工具返回一致吗？视频没讲的内容是否标成了「背景补充 / 我的判断」？
5. 对应模式的 reference 读了吗、模板用对了吗（六章 PRD、六节对比报告、知识卡片结构不能缺）？
6. 用户要存档时，调了 `tube_export` 并把返回路径告诉他了吗？
7. 输出语言对吗（默认中文；英文/双语按 `references/translation.md`）？
8. 检索类回答写清「检索的是本地缓存的 N 个视频、M 个段落」和用过的检索词了吗？`resultCount=0` 时是先换词、再如实说没有，而不是直接说「你没看过」？

## references 索引

| 文件 | 什么时候读 | 移植自上游 |
|---|---|---|
| `references/recall.md` | 回忆 / 检索 / 主题综述（模式 0，含 `tube_synthesis` 底稿） | 0.2.0 新增、0.3.0 扩展（无上游对应；契约见 0.2.0 F1 / 0.3.0 G1） |
| `references/overview.md` | 概览 / 章节 / 金句（默认模式） | `prompts/analysis.md` |
| `references/intel.md` | 产品情报 / 方法论提炼 | `prompts/product-intelligence.prompt.js` |
| `references/insights.md` | 行业术语 / 观点 / 技术边界 | `prompts/insight-extractor.prompt.js` |
| `references/prd.md` | 视频转 PRD 草稿 | `prompts/prd-generator.prompt.js` |
| `references/compare.md` | 多视频横向对比 | `prompts/multi-video-compare.prompt.js` |
| `references/knowledge.md` | 知识卡片 / 知识库导出 | `prompts/knowledge-export.prompt.js` |
| `references/translation.md` | 翻译 / 双语 / 英文输出 | `prompts/translation.md` |
| `references/notes.md` | 笔记润色 / 时间戳笔记 | `prompts/note-cleanup.md` |
