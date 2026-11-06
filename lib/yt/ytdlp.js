// yt-dlp 兜底路径。系统里装了 yt-dlp 才会启用（可选，第 4 顺位）。
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { cacheDir, ensureDir } from '../paths.js'
import { SourceError } from '../errors.js'
import { watchUrl } from './url.js'
import { baseLanguage, normalizeLanguages } from './languages.js'
import { parseCaptionJson3 } from './innertube.js'

const execFileAsync = promisify(execFile)
const SUB_LANGS = 'en.*,zh.*,ja.*'

/** 允许用环境变量强制指定 yt-dlp 路径（便于测试/特殊安装）。 */
function ytDlpBin() {
  const custom = process.env.DSH_TUBE_INSIGHT_YTDLP
  return typeof custom === 'string' && custom.trim() ? custom.trim() : 'yt-dlp'
}

/**
 * 系统里是否有可用的 yt-dlp。
 * 测试可用 DSH_TUBE_INSIGHT_NO_YTDLP=1 禁用，避免误跑外部进程。
 */
export async function hasYtDlp() {
  if (process.env.DSH_TUBE_INSIGHT_NO_YTDLP === '1') return false
  try {
    await execFileAsync(ytDlpBin(), ['--version'], { timeout: 5000, maxBuffer: 1024 * 1024 })
    return true
  } catch {
    return false
  }
}

function pickSubtitleFile(files, languages) {
  const wanted = normalizeLanguages(languages)
  const parsed = files.map((file) => {
    const base = file.replace(/\.json3$/i, '')
    const parts = base.split('.')
    return { file, language: parts.length > 1 ? parts.slice(1).join('.') : '' }
  })
  for (const lang of wanted) {
    const exact = parsed.find((item) => item.language.toLowerCase() === lang.toLowerCase())
    if (exact) return exact
    const loose = parsed.find((item) => baseLanguage(item.language) === baseLanguage(lang))
    if (loose) return loose
  }
  return parsed[0] || null
}

function classifyCaptionKind(log, file) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const autoRe = new RegExp(`Writing video automatic captions to:.*${escaped}`)
  return autoRe.test(log) ? 'asr' : 'native'
}

/**
 * 用 yt-dlp 下载字幕（json3）并解析。
 * @returns {Promise<{segments:Array<{start:number,duration:number,text:string}>, language:string, captionKind:'native'|'asr', source:'yt-dlp'}>}
 */
export async function fetchViaYtDlp(videoId, languages, { signal } = {}) {
  const tmpDir = mkdtempSync(join(ensureDir(cacheDir()), 'ytdlp-'))
  try {
    const args = [
      '--write-auto-subs',
      '--write-subs',
      '--sub-format',
      'json3',
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      '--sub-langs',
      SUB_LANGS,
      '-o',
      join(tmpDir, '%(id)s.%(ext)s'),
      watchUrl(videoId),
    ]
    let log = ''
    try {
      const result = await execFileAsync(ytDlpBin(), args, {
        timeout: 180_000,
        maxBuffer: 20 * 1024 * 1024,
        signal,
      })
      log = `${result.stdout || ''}\n${result.stderr || ''}`
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw new Error('操作已取消。')
      const stderr = String(error?.stderr || error?.message || error)
        .split(/\r?\n/)
        .slice(-6)
        .join(' ')
        .trim()
      if (error?.code === 'ENOENT') {
        throw new SourceError('YTDLP_MISSING', '系统里没有 yt-dlp。可用 `brew install yt-dlp` 安装后重试（可选兜底）。', {
          source: 'yt-dlp',
          retryable: false,
        })
      }
      throw new SourceError('YTDLP_FAILED', `yt-dlp 抓取失败：${stderr || '未知错误'}。`, {
        source: 'yt-dlp',
      })
    }

    const files = readdirSync(tmpDir).filter((file) => file.toLowerCase().endsWith('.json3'))
    if (files.length === 0) {
      throw new SourceError('NO_CAPTIONS', '该视频没有可用字幕（原生或自动生成都没有）。', { source: 'yt-dlp' })
    }
    const picked = pickSubtitleFile(files, languages)
    if (!picked) throw new SourceError('NO_CAPTIONS', 'yt-dlp 没有下载到匹配语言的字幕。', { source: 'yt-dlp' })

    const fullPath = join(tmpDir, picked.file)
    if (!existsSync(fullPath)) {
      throw new SourceError('YTDLP_FAILED', 'yt-dlp 报告成功但没有找到字幕文件。', { source: 'yt-dlp' })
    }
    let json
    try {
      json = JSON.parse(readFileSync(fullPath, 'utf8'))
    } catch {
      throw new SourceError('YTDLP_PARSE', 'yt-dlp 下载的字幕不是合法 JSON。', { source: 'yt-dlp' })
    }
    const segments = parseCaptionJson3(json)
    if (segments.length === 0) {
      throw new SourceError('EMPTY_CAPTIONS', 'yt-dlp 下载的字幕文件里没有可解析内容。', { source: 'yt-dlp' })
    }
    return {
      segments,
      language: picked.language || 'unknown',
      captionKind: classifyCaptionKind(log, picked.file),
      source: 'yt-dlp',
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}
