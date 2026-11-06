# Intel：产品情报 / 方法论提炼

> **何时读我**：用户说「产品情报」「这个产品是什么 / 有什么功能 / 解决什么痛点 / 竞品是谁 / 商业模式」「提炼一下视频里的方法论」「这条视频值得产品经理看吗」。做 PRD 之前也必须先过我判断内容类型。
>
> **移植自**：TubeInsight `prompts/product-intelligence.prompt.js`（产品情报雷达）。原版把视频判成 product / methodology 两类并输出固定 JSON；这里改成**你自己判断、自己按 schema 输出**。JSON 字段与产品/方法论双分支规则原样保留。

## 前置

已用 `read` 读完 `transcriptPath` 全文。只凭标题和预览判断 content_type 极易误判。

## 第一步：判断内容类型

| 类型 | 判定标准 |
|---|---|
| `product` | 视频主要在介绍、演示、评测、对比某个具体产品、工具、服务或商业项目；或在讨论产品设计、产品策略、商业模式 |
| `methodology` | 视频主要是人物访谈、经验分享、训练/学习方法、行业观点、人生思考等，没有以某个具体产品为主题 |

- 只在视频里**顺带**提到某个产品（片头赞助、配音工具说明、广告口播）不能判成 `product`。
- 判不准时看「视频大部分时长在讲什么」，不是看它提了什么词。
- 用一句话写清判断依据 `content_type_reason`。

## 第二步：按类型产出（JSON 契约）

```json
{
  "content_type": "product 或 methodology",
  "content_type_reason": "一句话说明判断依据",
  "one_line_summary": "product 类：一句话总结核心产品价值；methodology 类：一句话总结核心方法论",

  "product_features": ["功能点（一句话描述）"],
  "user_pain_points": ["用户痛点（一句话描述）"],
  "competitor_info": ["竞品信息（竞品名 + 关键信息）"],
  "business_model_keywords": ["商业模式关键词"],

  "core_methodologies": ["方法论名称：一句话说明它是什么、怎么做"],
  "key_principles": ["关键原则或执行要点（一句话描述）"],
  "application_scenarios": ["可迁移的应用场景"],
  "methodology_keywords": ["方法论关键词"]
}
```

字段规则：

- `product` 时只填 `product_features` / `user_pain_points` / `competitor_info` / `business_model_keywords`，四个方法论字段返回空数组 `[]`；
- `methodology` 时只填四个方法论字段，四个产品字段返回空数组 `[]`；
- 每个数组最多 5 条，优先留最有价值的；
- 某个维度视频里没有就返回空数组 `[]`，不要硬凑；
- **方法论必须来自视频中人物实际的讲述或做法**，不要套用通用道理；
- 不要编造视频没提的信息；
- 用户要机读时输出合法 JSON（无 Markdown 围栏、无多余文字）。

## 第三步：渲染成 Markdown（默认输出）

### product 类型

```markdown
# 产品情报｜{视频标题}
**类型**：product（判断依据：{content_type_reason}） ｜ **频道**：{频道} ｜ **时长**：{mm:ss}

## 一句话
> {one_line_summary}

## 核心功能点
- **{功能名}**：{一句话说明} — [2:14](https://youtu.be/<videoId>?t=134)
- ……

## 用户痛点
- {痛点} — [5:40](https://youtu.be/<videoId>?t=340)
- ……

## 竞品信息
- **{竞品名}**：{视频里提到的关键信息} — [8:12](https://youtu.be/<videoId>?t=492)
- ……（没有就写「视频未提及竞品」）

## 商业模式关键词
`#SaaS` `#订阅制` `#B2B` `#按量计费`

## 我的判断（可选）
{2–3 条基于视频信息 + 你自己的行业理解的判断，标题里已标明是判断，允许超出视频但不要冒充事实。}
```

### methodology 类型

```markdown
# 方法论提炼｜{视频标题}
**类型**：methodology（判断依据：{content_type_reason}） ｜ 频道：{频道} ｜ 时长：{mm:ss}

## 一句话
> {one_line_summary}

## 核心方法论
- **{方法论名称}**：{它是什么 + 怎么做} — [12:30](https://youtu.be/<videoId>?t=750)
- ……

## 关键原则
- {原则/执行要点} — [MM:SS](链接)
- ……

## 可迁移场景
- {怎么借鉴到产品、团队或个人成长中}（可标「（我的推断）」，如果视频没直接说）
- ……

## 方法论关键词
`#长期主义` `#复盘` `#杠杆`
```

## 引用与真实性

- 每一条来自视频的功能、痛点、竞品、方法论、原则，都要带 `[MM:SS](https://youtu.be/<videoId>?t=<sec>)`。
- 关键词是标签不是结论，可以只在一行里挑一处最有代表性的出处给一个链接。
- 视频没说的写「视频未提及」，不要补成常识；确实需要补时标「（背景补充）」。
- `methodology` 类型的产品字段已经置空，不要在正文里自己再编一组「功能点」。

## 交付前自查

- content_type 判断有依据吗？有没有因为片头赞助就判成 product？
- 产品/方法论两组字段是不是只有一边有内容，另一边是 `[]`？
- 每个数组是否 ≤5 条、每条都能在转录里找到出处？
- 方法论是不是视频里人物真讲过、真做过的，而不是我自己的通用经验？
