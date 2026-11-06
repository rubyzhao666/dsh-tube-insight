// tube-insight · Host 半边：注册模型工具（transcript / search / synthesis / export）、随包 skill，
// 以及 /tube-insight/ 只读视频库页面（供左侧栏「视频库」iframe 使用）。
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createSkillProvider } from './skills.js'
import { TOOLS } from './tools.js'
import { BASE, createHandler } from './web.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

export const name = 'tube-insight'
export const inject = ['tools', 'skills', 'webServer']

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

  // 只读视频库页面：GET/HEAD /tube-insight/（?q= 检索）与 /tube-insight/v/<videoId>；
  // 数据来自本机缓存，不写盘、不发起外部请求。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: BASE,
      handler: createHandler(),
    }),
  )
}
