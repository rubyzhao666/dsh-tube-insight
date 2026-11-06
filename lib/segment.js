// 把 YouTube 逐条字幕合并成可读的语义段落。
// 逻辑移植自上游 TubeInsight（sidepanel.js 的 TRANSCRIPT_GROUPING，MIT），
// 目标是：重建跨字幕边界的完整句子；每段保留起始秒；段落长度适合模型阅读与引用。

export const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
  /** 相邻字幕之间停顿超过这么多秒就切开（GUIDE §8.1 的时间间隔 >2s 规则）。 */
  maxGapSeconds: 2,
})

/**
 * 清理字幕文本：合并空白、去掉自动字幕的说话人切换标记 ">>"、
 * 修复中文逐字之间被 YouTube 插入的空格。
 */
export function normalizeCaptionText(text) {
  return String(text || '')
    .replace(/>> ?/g, '')
    .replace(/\s+/g, ' ')
    .replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '')
    .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, '$1')
    .replace(/\s+([,.;:!?，。；：！？])/g, '$1')
    .trim()
}

/** 在最近的强标点处切开一条超长文本；没有标点时退回按空格/硬切。 */
export function splitOversizedThought(text, maxChars = TRANSCRIPT_SEGMENT_LIMITS.maxChars) {
  const parts = []
  let rest = normalizeCaptionText(text)

  while (rest.length > maxChars) {
    const windowText = rest.slice(0, maxChars + 1)
    const lowerBound = Math.floor(maxChars * 0.55)
    let cut = -1

    for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + match[0].length
      }
      if (cut > 0) break
    }

    if (cut <= 0) cut = maxChars
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }

  if (rest) parts.push(rest)
  return parts
}

/**
 * 把原始字幕条目（{start, duration, text}）合并成语义段落。
 * @param {Array<{start:number,duration?:number,text:string}>} entries
 * @param {typeof TRANSCRIPT_SEGMENT_LIMITS} [limits]
 * @returns {Array<{start:number,text:string}>} start 为该段第一个字幕的起始秒（保留 1 位小数）
 */
export function groupTranscriptEntries(entries, limits = TRANSCRIPT_SEGMENT_LIMITS) {
  if (!Array.isArray(entries) || entries.length === 0) return []

  const pieces = []
  entries.forEach((entry, entryIndex) => {
    const text = normalizeCaptionText(entry?.text)
    if (!text) return
    const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0
    const duration = Math.max(0, Number(entry.duration) || 0)
    const sentenceParts =
      text.match(/[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) || [text]
    let consumedChars = 0

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart)
      if (!cleanPart) return
      const oversizedParts = splitOversizedThought(cleanPart, limits.maxChars)
      oversizedParts.forEach((part) => {
        const startRatio = text.length ? Math.min(1, consumedChars / text.length) : 0
        const consumedAfter = Math.min(text.length, consumedChars + part.length)
        const endRatio = text.length ? Math.min(1, consumedAfter / text.length) : 0
        pieces.push({
          text: part,
          start: start + duration * startRatio,
          duration: Math.max(0, duration * (endRatio - startRatio)),
          semanticEnd: /[.!?。！？]["')\]”’）】」』]*$/.test(part) || oversizedParts.length > 1,
          clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
          sourceOrder: `${entryIndex}:${consumedChars}`,
        })
        consumedChars += part.length + 1
      })
    })
  })

  const grouped = []
  let current = null
  let lastPieceEnd = null

  const flush = () => {
    if (!current || !current.text.trim()) {
      current = null
      return
    }
    grouped.push({
      start: Math.round(current.start * 10) / 10,
      text: normalizeCaptionText(current.text),
    })
    current = null
  }

  pieces.forEach((piece) => {
    // 停顿超过 maxGapSeconds 时先结束上一段，保证新段起始秒就是这句的起始秒。
    if (current && lastPieceEnd !== null && piece.start - lastPieceEnd > limits.maxGapSeconds) {
      flush()
    }
    if (!current) current = { start: piece.start, text: '' }
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`)
    lastPieceEnd = Math.max(piece.start, piece.start + piece.duration)
    const elapsed = Math.max(0, piece.start - current.start)
    const comfortablySized = current.text.length >= limits.minChars
    const reachedIdeal = current.text.length >= limits.idealChars
    const atNaturalBoundary =
      piece.semanticEnd ||
      (piece.clauseEnd && (reachedIdeal || current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds))
    const reachedGuardrail =
      atNaturalBoundary && (current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds)
    const reachedHardGuardrail =
      current.text.length >= Math.round(limits.maxChars * 1.2) || elapsed >= limits.maxSeconds + 5

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedGuardrail ||
      reachedHardGuardrail
    ) {
      flush()
    }
  })
  flush()

  return grouped
}

/** 秒 -> [MM:SS]（分钟累计，超过 60 分钟显示 [65:04]）。 */
export function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

/** 秒 -> 人类可读时长（1:02:03 / 12:34）。 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const mm = hours ? String(minutes).padStart(2, '0') : String(minutes)
  return `${hours ? `${hours}:` : ''}${mm}:${String(secs).padStart(2, '0')}`
}
