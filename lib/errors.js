// 抓取源的可分类错误。降级链根据 code 决定是否继续尝试、以及给模型什么建议。
export class SourceError extends Error {
  /**
   * @param {string} code 机器可读的错误码，如 NO_CAPTIONS / PLAYABILITY_LOGIN_REQUIRED
   * @param {string} message 可操作的中文错误信息
   * @param {{source?: string, status?: string, retryable?: boolean, details?: string}} [options]
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'SourceError'
    this.code = code
    this.source = options.source || ''
    this.status = options.status || ''
    this.retryable = options.retryable ?? true
    this.details = options.details || ''
  }
}
