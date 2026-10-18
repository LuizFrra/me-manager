/** Characters that never need quoting in a POSIX shell word. */
const SAFE_WORD = /^[A-Za-z0-9_\-+=.,/:@%]+$/

/**
 * Quotes `arg` for a POSIX shell, so the shell reads it back as exactly one word, unchanged: no expansion of
 * `$`, `$()`, backticks, globs or `~`. Safe words stay as they are (`--model` → `--model`); anything else is put
 * in single quotes, where only `'` itself needs care: it becomes `'\''` (close, escaped quote, reopen).
 */
export function shellQuote(arg: string): string {
  if (arg === '') return "''"
  if (SAFE_WORD.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** The words as one shell string; `splitShellWords(joinShellWords(w))` gives `w` back. */
export const joinShellWords = (words: readonly string[]): string => words.map(shellQuote).join(' ')

/** Inside double quotes, a backslash escapes only these (as in POSIX sh); before anything else it is literal. */
const DOUBLE_QUOTE_ESCAPES = '"\\$`'

/**
 * Splits a command line into words the way a POSIX shell would, without running anything: whitespace separates
 * words, '…' is literal, "…" allows \" \\ \$ \` escapes, and a backslash outside quotes escapes the next
 * character. There is no expansion: `$HOME`, `*` and `~` stay as typed. Throws on an unmatched quote or a
 * trailing backslash, with a message fit for a form.
 */
export function splitShellWords(text: string): string[] {
  const words: string[] = []
  let word = ''
  let inWord = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      if (end === -1) throw new Error("A single quote (') is not closed")
      word += text.slice(i + 1, end)
      inWord = true
      i = end + 1
    } else if (c === '"') {
      inWord = true
      i++
      for (;;) {
        if (i >= text.length) throw new Error('A double quote (") is not closed')
        const d = text[i]
        if (d === '"') {
          i++
          break
        }
        if (d === '\\' && i + 1 < text.length && DOUBLE_QUOTE_ESCAPES.includes(text[i + 1])) {
          word += text[i + 1]
          i += 2
        } else {
          word += d
          i++
        }
      }
    } else if (c === '\\') {
      if (i + 1 >= text.length) throw new Error('The text ends with a backslash')
      word += text[i + 1]
      inWord = true
      i += 2
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word)
      word = ''
      inWord = false
      i++
    } else {
      word += c
      inWord = true
      i++
    }
  }
  if (inWord) words.push(word)
  return words
}
