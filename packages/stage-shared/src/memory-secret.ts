const SECRET_PATTERNS = [
  /(?:password|passwd|pwd|secret|api[\s_-]?key|access[\s_-]?token|private[\s_-]?key)\s*[:=]\s*\S+/i,
  /(?:密码|口令|密钥|令牌|验证码)\s*[是为:：]\s*\S+/,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /\bsk-[\w-]{16,}\b/,
  /\b\d{16,19}\b/,
  /\b\d{17}[\dX]\b/i,
]

/**
 * A last line of defense for background memory writes. The extraction prompt already
 * asks the model to skip secrets, but a user can state one directly.
 */
export function containsLikelySecret(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(text))
}
