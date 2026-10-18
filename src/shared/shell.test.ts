import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { joinShellWords, shellQuote, splitShellWords } from './shell'

/** What `sh` makes of `printf '%s\0' <quoted>`: the words it actually received. */
const shellWords = (quoted: string): string[] =>
  execFileSync('sh', ['-c', `printf '%s\\0' ${quoted}`], { encoding: 'utf8' })
    .split('\0')
    .slice(0, -1)

describe('shellQuote', () => {
  it('leaves safe words alone', () => {
    expect(shellQuote('--model')).toBe('--model')
    expect(shellQuote('opus')).toBe('opus')
    expect(shellQuote('--max-turns=5')).toBe('--max-turns=5')
    expect(shellQuote('/usr/bin/x')).toBe('/usr/bin/x')
  })
  it('quotes spaces, quotes, $() and other shell syntax', () => {
    expect(shellQuote('two words')).toBe("'two words'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('$(rm -rf ~)')).toBe("'$(rm -rf ~)'")
    expect(shellQuote('`id`')).toBe("'`id`'")
    expect(shellQuote('a;b|c&d')).toBe("'a;b|c&d'")
    expect(shellQuote('~')).toBe("'~'")
    expect(shellQuote('*')).toBe("'*'")
    expect(shellQuote('')).toBe("''")
  })
  it('round-trips through a real shell without expanding anything', () => {
    const args = ['two words', "it's", '$(touch /tmp/pwned)', '`id`', '$HOME', '"dq"', 'a\\b', '', '*', 'new\nline']
    expect(shellWords(args.map(shellQuote).join(' '))).toEqual(args)
  })
})

describe('splitShellWords', () => {
  it('splits on whitespace', () => {
    expect(splitShellWords('  --model   opus\t-v ')).toEqual(['--model', 'opus', '-v'])
    expect(splitShellWords('')).toEqual([])
    expect(splitShellWords('   ')).toEqual([])
  })
  it('supports single and double quotes and backslashes', () => {
    expect(splitShellWords(`--append-system-prompt 'be brief' "and \\"kind\\""`)).toEqual([
      '--append-system-prompt',
      'be brief',
      'and "kind"',
    ])
    expect(splitShellWords(`a'b c'd`)).toEqual(['ab cd'])
    expect(splitShellWords(`two\\ words`)).toEqual(['two words'])
    expect(splitShellWords(`"a\\b"`)).toEqual(['a\\b'])
    expect(splitShellWords(`'' ""`)).toEqual(['', ''])
  })
  it('never expands anything', () => {
    expect(splitShellWords('$HOME ~ * $(id)')).toEqual(['$HOME', '~', '*', '$(id)'])
  })
  it('rejects unmatched quotes and a trailing backslash', () => {
    expect(() => splitShellWords(`'open`)).toThrow(/single quote/)
    expect(() => splitShellWords(`"open`)).toThrow(/double quote/)
    expect(() => splitShellWords(`end\\`)).toThrow(/backslash/)
  })
  it('reads back what joinShellWords wrote', () => {
    const words = ['--model', 'opus', 'two words', "it's", '$(x)', '', 'a"b']
    expect(splitShellWords(joinShellWords(words))).toEqual(words)
  })
})
