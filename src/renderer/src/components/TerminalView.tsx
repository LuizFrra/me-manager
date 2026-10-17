import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ClipboardAddon, type IClipboardProvider } from '@xterm/addon-clipboard'
import '@xterm/xterm/css/xterm.css'
import type { MeManagerApi } from '../../../shared/types'

export interface TerminalViewProps {
  api: Pick<MeManagerApi, 'ptyWrite' | 'ptyResize' | 'onPtyData'>
  /** Changes whenever the attached session changes; the terminal resets. */
  sessionKey: string
}

const isMac = navigator.userAgent.includes('Mac')

// OSC 52 is write-only: programs in the pty may set the clipboard but never read it.
const writeOnlyClipboard: IClipboardProvider = {
  readText: () => '',
  writeText: async (selection, text) => {
    if ((selection as string) === 'c') await navigator.clipboard.writeText(text)
  }
}

export function TerminalView({ api, sessionKey }: TerminalViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: 'Menlo, "DejaVu Sans Mono", "Ubuntu Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      macOptionClickForcesSelection: true,
      theme: { background: '#1e1e1e' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new ClipboardAddon(undefined, writeOnlyClipboard)) // tmux copy-mode -> OSC 52 -> system clipboard
    term.open(host)

    // Linux has no app menu (it would steal Ctrl+C), so handle Ctrl+Shift+C/V here.
    // On macOS the Edit menu handles Cmd+C/V.
    term.attachCustomKeyEventHandler((e) => {
      if (isMac || e.type !== 'keydown' || !(e.ctrlKey && e.shiftKey)) return true
      const key = e.key.toLowerCase()
      if (key === 'c') {
        e.preventDefault()
        if (term.hasSelection()) void navigator.clipboard.writeText(term.getSelection())
        return false
      }
      if (key === 'v') {
        e.preventDefault() // otherwise Chromium's native paste-as-plain-text pastes a second time
        void navigator.clipboard
          .readText()
          .then((text) => term.paste(text))
          .catch(() => undefined)
        return false
      }
      return true
    })

    const offData = api.onPtyData((data) => term.write(data))
    const input = term.onData((data) => api.ptyWrite(data))
    const doFit = (): void => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      fit.fit()
      api.ptyResize(term.cols, term.rows)
    }
    const observer = new ResizeObserver(doFit)
    observer.observe(host)
    termRef.current = term
    fitRef.current = fit
    doFit()

    return () => {
      observer.disconnect()
      offData()
      input.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [api])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.reset() // the new tmux client redraws the whole screen on attach
    fitRef.current?.fit()
    api.ptyResize(term.cols, term.rows)
    term.focus()
  }, [sessionKey, api])

  return <div className="terminal-host" ref={hostRef} />
}
