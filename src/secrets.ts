/** Bun quotes the bad input token in a JSON.parse message, and that token can be a secret: hide it. */
export const hideParseText = (m: string) => m.replace(/"[\s\S]*$/, '<hidden>')

/** the text, or `<hidden>` when it matches a token shape: for a value that a message echoes */
export const hideSecret = (s: string) => (SECRETS.some(p => p.test(s)) ? '<hidden>' : s)

/** token shapes that must not reach a stored file. A leaf module: no imports. */
export const SECRETS = [
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/,
  /secret_?access_?key["']?\s*[=:]\s*["']?[A-Za-z0-9/+]{40,}/i, // AWS secret key by its name
  /xox[bpsa]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/,
  /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/,
  /Authorization["']?\s*:\s*["']?(Basic|Bearer)\s+[A-Za-z0-9+/=._-]{20,}/i,
  /:\/\/[^\s/:@]*:[^\s/@]+@/, // URL userinfo
  /:\/\/[^\s/:@]{20,}@/, // URL token, no colon
  /(?<![A-Za-z0-9_-])(?=([A-Za-z0-9_-]*?eyJ))\1[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./, // JWT: one start per run, linear
  /sk-proj-[A-Za-z0-9_-]{20,}/,
  /lin_api_[A-Za-z0-9]{20,}/,
  /gl(?:pat|dt|rt|ptt)-[A-Za-z0-9_-]{20,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /ops_[A-Za-z0-9+/=_-]{30,}/,
  /npm_[A-Za-z0-9]{36}/,
  /xapp-[A-Za-z0-9-]{10,}/,
  /PRIVATE-TOKEN:\s*\S{16,}/i,
]
