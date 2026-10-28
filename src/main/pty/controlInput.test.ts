import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../exec'
import { ControlParser, type ControlEvent } from './controlProtocol'
import { inputCommands, tmuxQuote } from './controlInput'

const ESC = '\x1b'
const paste = (text: string): string => `${ESC}[200~${text}${ESC}[201~`
const hex = (s: string): string => [...Buffer.from(s)].map((b) => b.toString(16).padStart(2, '0')).join(' ')

describe('inputCommands: raw bytes', () => {
  it('sends what was typed as hex bytes', () => {
    expect(inputCommands('%3', 'hi\r')).toEqual(['send-keys -t %3 -H 68 69 0d'])
  })

  it('sends Escape alone and a CSI arrow as their bytes', () => {
    expect(inputCommands('%3', ESC)).toEqual(['send-keys -t %3 -H 1b'])
    expect(inputCommands('%12', `${ESC}[A`)).toEqual(['send-keys -t %12 -H 1b 5b 41'])
  })

  it('sends a character as its UTF-8 bytes', () => {
    expect(inputCommands('%3', 'é😀')).toEqual(['send-keys -t %3 -H c3 a9 f0 9f 98 80'])
  })

  it('splits more than 256 bytes into commands of 256, even inside a character', () => {
    const data = `${'a'.repeat(255)}é${'b'.repeat(300)}`
    const cmds = inputCommands('%3', data)
    expect(cmds).toHaveLength(3)
    const bytes = cmds.map((c) => c.replace(/^send-keys -t %3 -H /, '').split(' '))
    expect(bytes.map((b) => b.length)).toEqual([256, 256, 45])
    expect(bytes[0]?.at(-1)).toBe('c3')
    expect(bytes[1]?.[0]).toBe('a9')
    expect(Buffer.from(bytes.flat().join(''), 'hex').toString()).toBe(data)
  })

  it('sends nothing for nothing', () => {
    expect(inputCommands('%3', '')).toEqual([])
  })

  it('treats a paste with anything around the brackets as typed bytes', () => {
    for (const data of [`x${paste('a')}`, `${paste('a')}x`, `${ESC}[200~a`, `a${ESC}[201~`]) {
      expect(inputCommands('%3', data)).toEqual([`send-keys -t %3 -H ${hex(data)}`])
    }
  })

  it('refuses a pane that is not a pane id', () => {
    for (const bad of ['3', '%', '%3 ', '%3;', '=s:', '%3\n', '']) expect(() => inputCommands(bad, 'a')).toThrow()
  })
})

describe('inputCommands: pastes', () => {
  it('pastes through a buffer that tmux brackets only if the program asked', () => {
    expect(inputCommands('%3', paste('hello'))).toEqual([
      'set-buffer -b mm-paste "hello"',
      'paste-buffer -p -d -b mm-paste -t %3',
    ])
  })

  it('turns CRLF and lone CR into LF (tmux turns LF into CR when pasting)', () => {
    expect(inputCommands('%3', paste('a\r\nb\rc\nd'))).toEqual([
      'set-buffer -b mm-paste "a\\012b\\012c\\012d"',
      'paste-buffer -p -d -b mm-paste -t %3',
    ])
  })

  it('sends nothing for an empty paste', () => {
    expect(inputCommands('%3', paste(''))).toEqual([])
  })

  it('drops NUL, which a tmux string cannot hold', () => {
    expect(inputCommands('%3', paste('a\0b'))).toEqual([
      'set-buffer -b mm-paste "ab"',
      'paste-buffer -p -d -b mm-paste -t %3',
    ])
    expect(inputCommands('%3', paste('\0'))).toEqual([])
  })

  it('sends a long paste in chunks of at most 4096 characters, appended in order', () => {
    const text = Array.from({ length: 10 * 1024 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
    const cmds = inputCommands('%3', paste(text))
    expect(cmds).toHaveLength(4)
    expect(cmds[0]).toMatch(/^set-buffer -b mm-paste "/)
    expect(cmds[1]).toMatch(/^set-buffer -a -b mm-paste "/)
    expect(cmds[2]).toMatch(/^set-buffer -a -b mm-paste "/)
    expect(cmds[3]).toBe('paste-buffer -p -d -b mm-paste -t %3')
    const chunks = cmds.slice(0, 3).map((c) => c.slice(c.indexOf('"') + 1, -1))
    expect(chunks.map((c) => c.length)).toEqual([4096, 4096, 2048])
    expect(chunks.join('')).toBe(text)
  })

  it('does not split a surrogate pair between chunks', () => {
    const text = `${'a'.repeat(4095)}😀b`
    const chunks = inputCommands('%3', paste(text))
      .slice(0, 2)
      .map((c) => c.slice(c.indexOf('"') + 1, -1))
    expect(chunks).toEqual(['a'.repeat(4095), '😀b'])
  })
})

describe('tmuxQuote', () => {
  it('quotes plain text as is, characters tmux leaves alone included', () => {
    expect(tmuxQuote("a é #{pane_id} ; {x} %1 ' `")).toBe('"a é #{pane_id} ; {x} %1 \' `"')
  })

  it('escapes what tmux reads inside double quotes: quote, backslash, $ and ~', () => {
    expect(tmuxQuote('"')).toBe('"\\""')
    expect(tmuxQuote('\\')).toBe('"\\\\"')
    expect(tmuxQuote('$HOME ${HOME}')).toBe('"\\$HOME \\${HOME}"')
    // ~ is the home directory at the start of a word, even quoted; escape it everywhere, as a chunk may start with it.
    expect(tmuxQuote('~/a~')).toBe('"\\~/a\\~"')
  })

  it('writes control characters as octal escapes, so the line has no newline', () => {
    expect(tmuxQuote('\t\n\r\x1b\x01\x7f')).toBe('"\\011\\012\\015\\033\\001\\177"')
  })

  it('refuses NUL', () => {
    expect(() => tmuxQuote('a\0b')).toThrow()
  })
})

const hasTmux = await run('tmux', ['-V']).then(
  () => true,
  () => false,
)
const hasPython = await run('python3', ['--version']).then(
  () => true,
  () => false,
)
const socket = `mm-test-input-${process.pid}-${Date.now()}`

/** Polls `check` until it is true, failing after `ms`. */
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const tmux = (...args: string[]): Promise<string> => run('tmux', ['-L', socket, ...args])

/**
 * A program that appends every byte it reads, unchanged (raw tty), to the file in argv[1]. With argv[2] = '1' it
 * first asks for bracketed paste. Prints 'ready' once raw, as bytes typed before that would be cooked.
 */
const DUMPER = `import os, sys, tty
if sys.argv[2] == '1':
    os.write(1, b'\\x1b[?2004h')
tty.setraw(0)
os.write(1, b'ready\\r\\n')
with open(sys.argv[1], 'ab', buffering=0) as f:
    while True:
        data = os.read(0, 65536)
        if not data:
            break
        f.write(data)
`

describe.skipIf(!hasTmux || !hasPython)('input to a real tmux pane', () => {
  let dir = ''
  let proc: ReturnType<typeof spawn> | undefined
  const replies: Extract<ControlEvent, { kind: 'reply' }>[] = []
  /** Pane ids of the dumper that asked for bracketed paste and of the one that didn't. */
  let bracketed = ''
  let plain = ''

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mm-input-'))
    await writeFile(join(dir, 'dump.py'), DUMPER)
    const dumper = (name: string, bracket: 0 | 1): string =>
      `exec python3 -I ${join(dir, 'dump.py')} ${join(dir, name)} ${bracket}`
    await tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'mminput', '-x', '80', '-y', '10', dumper('b', 1))
    await tmux('new-window', '-d', '-t', '=mminput:', dumper('p', 0))
    const panes = (await tmux('list-panes', '-s', '-t', '=mminput', '-F', '#{window_index} #{pane_id}')).trim()
    const ids = new Map(panes.split('\n').map((l) => l.split(' ') as [string, string]))
    bracketed = ids.get('0') ?? ''
    plain = ids.get('1') ?? ''
    for (const pane of [bracketed, plain]) {
      await until(async () => (await tmux('capture-pane', '-p', '-t', pane)).includes('ready'), `${pane} ready`)
    }

    const env = { ...process.env }
    delete env.TMUX
    proc = spawn('tmux', ['-L', socket, '-C', 'attach', '-t', '=mminput'], { stdio: 'pipe', env })
    const p = new ControlParser((e) => {
      if (e.kind === 'reply') replies.push(e)
    })
    proc.stdout?.on('data', (chunk: Buffer) => p.feed(chunk))
    await until(() => replies.some((r) => !r.ours), 'the attach block')
  })

  afterAll(async () => {
    proc?.kill()
    await tmux('kill-server').catch(() => {})
    // tmux leaves the socket file behind when the server exits; remove it too.
    const uid = process.getuid?.()
    if (uid !== undefined) await rm(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`, socket), { force: true })
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  /** Writes the commands for `data` a line each, and waits for all their replies to be ok. */
  async function send(pane: string, data: string): Promise<void> {
    const ours = (): typeof replies => replies.filter((r) => r.ours)
    const before = ours().length
    const cmds = inputCommands(pane, data)
    for (const cmd of cmds) proc?.stdin?.write(`${cmd}\n`)
    await until(() => ours().length >= before + cmds.length, 'the replies')
    expect(
      ours()
        .slice(before)
        .map((r) => [r.ok, r.lines]),
    ).toEqual(cmds.map(() => [true, []]))
  }

  /** Waits until the dumper's file holds `length` bytes, then returns them all and empties it. */
  async function received(pane: string, length: number): Promise<Buffer> {
    const file = join(dir, pane === bracketed ? 'b' : 'p')
    const read = (): Promise<Buffer> => readFile(file).catch(() => Buffer.alloc(0))
    await until(async () => (await read()).length >= length, `${length} bytes in ${pane}`)
    const data = await read()
    await writeFile(file, '')
    return data
  }

  it('delivers typed bytes exactly, a character split across commands included', async () => {
    const typed = `hé${ESC}[A${'a'.repeat(250)}é\x7f\x03\t`
    await send(plain, typed)
    expect((await received(plain, Buffer.byteLength(typed))).toString()).toBe(typed)
  })

  it('brackets a paste only for the program that asked, with quoting intact and LF as CR', async () => {
    const text = 'a "q" $HOME \\ é~#;{}\nline2\ttab'
    const pasted = 'a "q" $HOME \\ é~#;{}\rline2\ttab'
    await send(bracketed, paste(text))
    expect((await received(bracketed, Buffer.byteLength(paste(pasted)))).toString()).toBe(paste(pasted))
    await send(plain, paste(text))
    expect((await received(plain, Buffer.byteLength(pasted))).toString()).toBe(pasted)
  })

  it('pastes control characters and a text starting with ~ unchanged', async () => {
    const text = `~/x ${ESC}[31m\x01\x7f$`
    await send(plain, paste(text))
    expect((await received(plain, Buffer.byteLength(text))).toString()).toBe(text)
  })

  it('delivers a 10 KB paste whole and in order', async () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(45)}`).join('\n')
    expect(text.length).toBeGreaterThan(10 * 1024)
    await send(bracketed, paste(text))
    const want = paste(text.replace(/\n/g, '\r'))
    expect((await received(bracketed, Buffer.byteLength(want))).toString()).toBe(want)
  })
})
