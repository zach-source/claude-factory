/** Cut `s` to at most `n` UTF-16 units. It never leaves a lone high surrogate at the end. */
export const cut = (s: string, n: number) =>
  s.length <= n ? s : s.slice(0, n > 0 && (s.charCodeAt(n - 1) & 0xfc00) === 0xd800 ? n - 1 : n)
