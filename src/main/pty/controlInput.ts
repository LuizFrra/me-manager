const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
/** The paste buffer a paste into `pane` goes through (one per pane); paste-buffer -d deletes it once pasted. */
const pasteBuffer = (pane: string): string => `mm-paste-${pane.slice(1)}`
/** Most bytes in one send-keys command. */
const KEYS_MAX = 256
/** Most characters (UTF-16 units) of a paste in one set-buffer command. */
const PASTE_CHUNK = 4096

/**
 * tmux commands (one per line to write) that deliver `data` — what the terminal sends — to `pane` ('%3'). A
 * bracketed paste goes through a paste buffer so tmux brackets it only if the program asked; anything else is
 * raw bytes.
 */
export function inputCommands(pane: string, data: string): string[] {
  if (!/^%\d+$/.test(pane)) throw new Error(`Bad tmux pane: ${JSON.stringify(pane)}`)
  if (data.length >= PASTE_START.length + PASTE_END.length && data.startsWith(PASTE_START) && data.endsWith(PASTE_END))
    return pasteCommands(pane, data.slice(PASTE_START.length, -PASTE_END.length))
  // send-keys -H writes each byte as is, so a character split between two commands still arrives whole.
  const bytes = Buffer.from(data)
  const cmds: string[] = []
  for (let i = 0; i < bytes.length; i += KEYS_MAX) {
    const hex = [...bytes.subarray(i, i + KEYS_MAX)].map((b) => b.toString(16).padStart(2, '0'))
    cmds.push(`send-keys -t ${pane} -H ${hex.join(' ')}`)
  }
  return cmds
}

function pasteCommands(pane: string, raw: string): string[] {
  // Terminals send a newline as CR; the buffer holds LF, which paste-buffer turns back into CR. A tmux string
  // can't hold NUL. A bracket marker inside the text would end the paste early and run the rest as typed
  // (paste-jacking), so remove them, again until none is left, as removing one can join the pieces of another.
  let text = raw.replace(/\r\n?/g, '\n').replace(/\0/g, '')
  for (let prev = ''; prev !== text;) {
    prev = text
    text = text.replaceAll(PASTE_START, '').replaceAll(PASTE_END, '')
  }
  if (!text) return []
  const buffer = pasteBuffer(pane)
  const cmds: string[] = []
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + PASTE_CHUNK, text.length)
    // Don't cut a surrogate pair: the half on each side would be lost.
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
    cmds.push(`set-buffer ${i === 0 ? '' : '-a '}-b ${buffer} ${tmuxQuote(text.slice(i, end))}`)
    i = end
  }
  // -p: tmux adds the brackets only if the pane's program turned bracketed paste on.
  cmds.push(`paste-buffer -p -d -b ${buffer} -t ${pane}`)
  return cmds
}

/** `text` in tmux double quotes, read back unchanged by tmux's parser. */
export function tmuxQuote(text: string): string {
  if (text.includes('\0')) throw new Error('A tmux string cannot hold NUL')
  // Inside double quotes tmux reads `\` escapes, expands `$VAR` and, at the start of a word, `~`. Control
  // characters go as octal (`\033`), which also keeps a newline from ending the command line.
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is matched
  const quoted = text.replace(/[\\"$~]|[\x01-\x1f\x7f]/g, (c) =>
    /[\\"$~]/.test(c) ? `\\${c}` : `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`,
  )
  return `"${quoted}"`
}
