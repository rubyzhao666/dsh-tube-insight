// 包版本号：导出 Markdown 的 frontmatter 里会写 generator: dsh-tube-insight@<version>。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function readVersion() {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const PLUGIN_VERSION = readVersion()
