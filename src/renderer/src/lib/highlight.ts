import hljs from 'highlight.js/lib/common'

/** Above this size the file is shown as plain text. */
export const MAX_HIGHLIGHT_BYTES = 200_000
/** Language auto-detection tries every grammar, so it only runs on smaller files. */
const MAX_AUTO_BYTES = 50_000

const BY_NAME: Record<string, string> = {
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  gemfile: 'ruby',
  rakefile: 'ruby',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
}
const BY_EXT: Record<string, string> = {
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  h: 'c',
  hpp: 'cpp',
  toml: 'ini',
  env: 'ini',
  svg: 'xml',
  vue: 'xml',
  htm: 'xml',
  zsh: 'bash',
  jsonc: 'json',
  json5: 'json',
}
const PLAIN_EXT = new Set(['txt', 'log', 'csv', 'tsv', 'lock'])

/** The highlight.js language for a path, 'plaintext' for known plain files, or undefined to auto-detect. */
export function languageFor(path: string): string | undefined {
  const name = (path.split('/').pop() ?? path).toLowerCase()
  const known = (lang: string | undefined): string | undefined => (lang && hljs.getLanguage(lang) ? lang : undefined)
  const byName = known(BY_NAME[name])
  if (byName) return byName
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  const ext = name.slice(dot + 1)
  if (PLAIN_EXT.has(ext)) return 'plaintext'
  return known(BY_EXT[ext]) ?? known(ext)
}

/** hljs HTML for the content, or null to show it as plain text. hljs escapes its input. */
export function highlight(path: string, content: string): string | null {
  if (content.length > MAX_HIGHLIGHT_BYTES) return null
  const lang = languageFor(path)
  try {
    if (lang === 'plaintext') return null
    if (lang) return hljs.highlight(content, { language: lang, ignoreIllegals: true }).value
    if (content.length > MAX_AUTO_BYTES) return null
    return hljs.highlightAuto(content).value
  } catch {
    return null
  }
}

export function lineCount(content: string): number {
  if (content === '') return 1
  const lines = content.split('\n').length
  return content.endsWith('\n') ? lines - 1 : lines
}
