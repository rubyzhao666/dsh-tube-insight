// tube-insight · Host 半边：注册模型工具（tube_transcript / tube_export）和随包 skill。
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createSkillProvider } from './skills.js'
import { TOOLS } from './tools.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

export const name = 'tube-insight'
export const inject = ['tools', 'skills']

export function apply(ctx) {
  // 工具在 Host 进程里执行，不受模型 bash 沙箱限制；持久数据只写 $DSH_HOME/tube-insight/。
  for (const tool of TOOLS) ctx.effect(() => ctx.tools.register(tool))

  // 随包 skill：skills/ 目录由包内容提供；目录不存在时 provider 返回空数组，不报错。
  ctx.effect(() =>
    ctx.skills.registerProvider(() =>
      createSkillProvider({
        providerName: 'tube-insight',
        dirs: [join(ROOT, 'skills')],
        pluginRoot: ROOT,
      }),
    ),
  )
}
