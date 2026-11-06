// 网络请求小工具：统一超时 / 取消 / 错误信息。
// 只在 Node 内置能力上实现，不引入任何依赖。

export const DEFAULT_TIMEOUT_MS = 20_000

/** 给一次请求组合出可取消 + 带超时的 AbortSignal（Node >= 20 的 AbortSignal.any）。 */
export function requestSignal(timeoutMs = DEFAULT_TIMEOUT_MS, signal) {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (signal) signals.push(signal)
  return AbortSignal.any(signals)
}

/**
 * fetch 包装：失败时抛出可操作的中文错误（区分超时 / 取消 / 网络错误）。
 * fetchImpl 可注入，测试里用 mock 替换 globalThis.fetch。
 */
export async function request(url, init = {}, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    label = '网络请求',
  } = options
  try {
    return await fetchImpl(url, { ...init, signal: requestSignal(timeoutMs, signal) })
  } catch (error) {
    throw describeFetchError(error, label)
  }
}

export function describeFetchError(error, label = '网络请求') {
  if (error?.name === 'AbortError') return new Error(`${label}被取消。`)
  if (error?.name === 'TimeoutError') return new Error(`${label}超时，请检查网络/代理后重试。`)
  const reason = error?.cause?.code || error?.code || error?.message || String(error)
  return new Error(`${label}失败（${reason}），请检查网络或代理后重试。`)
}

/** 读取 JSON，非 JSON 时给出可操作的错误。 */
export async function readJson(response, label = '响应') {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    const preview = text.slice(0, 160).replace(/\s+/g, ' ').trim()
    throw new Error(`${label}不是合法 JSON（HTTP ${response.status}，开头：${preview || '空'}）。YouTube 可能改版或触发了风控。`)
  }
}

/** 可被 AbortSignal 打断的 sleep。 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('操作已取消。'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('操作已取消。'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}
