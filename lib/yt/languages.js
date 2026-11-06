// 字幕语言偏好：默认优先英文原生，其次简体中文、通用中文、日文。
export const DEFAULT_LANGUAGES = Object.freeze(['en', 'zh-Hans', 'zh', 'ja'])

/** @returns {string[]} 清洗后的语言列表；空数组时回退默认值。 */
export function normalizeLanguages(languages) {
  if (!Array.isArray(languages)) return [...DEFAULT_LANGUAGES]
  const cleaned = languages
    .filter((lang) => typeof lang === 'string')
    .map((lang) => lang.trim())
    .filter(Boolean)
  return cleaned.length ? cleaned : [...DEFAULT_LANGUAGES]
}

/** "zh-Hans" -> "zh"，用于宽松匹配。 */
export function baseLanguage(code) {
  return String(code || '')
    .split('-')[0]
    .toLowerCase()
}
