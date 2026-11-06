// 数据位置与配置读取。所有持久数据只写 $DSH_HOME/tube-insight/ 下。
// DSH_HOME 在每次调用时读取（不缓存），便于测试与宿主环境变化。
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const ROW_ID = 'tube-insight'

export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 插件私有数据根目录：$DSH_HOME/tube-insight/ */
export function dataRoot() {
  return join(dshHome(), ROW_ID)
}

export function cacheDir() {
  return join(dataRoot(), 'cache')
}

export function indexesDir() {
  return join(dataRoot(), 'indexes')
}

export function configPath() {
  return join(dataRoot(), 'config.json')
}

export function cachePaths(videoId) {
  const dir = cacheDir()
  return {
    dir,
    json: join(dir, `${videoId}.json`),
    md: join(dir, `${videoId}.md`),
  }
}

/** 用户指定的导出目录默认值。 */
export function defaultExportDir() {
  return join(homedir(), 'TubeInsight')
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 读取可选配置文件 $DSH_HOME/tube-insight/config.json。
 * - 文件不存在：返回 {}
 * - 文件存在但不是合法 JSON：抛错（错误信息给修复路径，由调用方决定是否降级）
 * 密钥只从这里或环境变量读，插件不会自动写这个文件。
 */
export function readConfig() {
  const file = configPath()
  if (!existsSync(file)) return {}
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`读取配置文件失败：${file}（${error.message}）`)
  }
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('顶层必须是 JSON 对象')
    }
    return parsed
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON：${file}（${error.message}）。请修正或删掉该文件后重试。`)
  }
}

/**
 * 读取配置，永不抛错：配置损坏时返回空对象并记住错误，供最终失败信息使用。
 * @returns {{config: Record<string, unknown>, configError: string | null}}
 */
export function safeReadConfig() {
  try {
    return { config: readConfig(), configError: null }
  } catch (error) {
    return { config: {}, configError: error.message }
  }
}

/** Supadata key：环境变量优先，其次 config.json 的 supadataApiKey。 */
export function resolveSupadataKey(config = {}) {
  const fromEnv = process.env.SUPADATA_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  const fromConfig = config?.supadataApiKey
  if (typeof fromConfig === 'string' && fromConfig.trim()) return fromConfig.trim()
  return ''
}
