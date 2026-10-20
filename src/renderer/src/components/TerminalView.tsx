import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import '@xterm/xterm/css/xterm.css'
import type { MeManagerApi, ResolvedAppearance } from '../../../shared/types'
import { createWriteOnlyClipboard } from '../lib/clipboardProvider'
import { isMac, matchShortcut } from '../lib/shortcuts'
import { debounceSettled } from '../lib/settledResize'
import { TERMINAL_MIN_CONTRAST, TERMINAL_THEMES } from '../lib/terminalTheme'

export interface TerminalViewProps {
  api: Pick<MeManagerApi, 'ptyWrite' | 'ptyResize' | 'onPtyData'>
  /** Changes whenever the attached session changes; the terminal resets. */
  sessionKey: string
  /** Applied live: the terminal refits and the pty is resized to the new rows and columns. */
  fontSize: number
  /** The palette (see TERMINAL_THEMES), switched live. Dark by default. */
  appearance?: ResolvedAppearance
  /**
   * A dialog or overlay is open: no key reaches the terminal (App also makes it inert, but a key event already on
   * its way, or focus that never left, must not type into Claude behind the modal).
   */
  modalOpen?: boolean
  /** Bumped to move keyboard focus to the terminal (e.g. after text was pasted into Claude's tab). */
  focusSeq?: number
}

/** Resizes (e.g. dragging the panel splitter) are applied once this long after the movement stops. */
const RESIZE_SETTLE_MS = 100

export function TerminalView({
  api,
  sessionKey,
  fontSize,
  appearance = 'dark',
  modalOpen = false,
  focusSeq = 0,
}: TerminalViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  // Read by the key handler, which is attached once with the terminal.
  const modalOpenRef = useRef(modalOpen)
  useEffect(() => {
    modalOpenRef.current = modalOpen
  }, [modalOpen])
  const termRef = useRef<Terminal | null>(null)
  // The last mouse selection tmux copied; it reaches the clipboard only on an explicit copy.
  const heldRef = useRef('')
  const fitRef = useRef<FitAddon | null>(null)
  // The size and palette to create the terminal with; later changes are applied by the effects below, without
  // recreating it.
  const [initialFontSize] = useState(fontSize)
  const [initialAppearance] = useState(appearance)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: 'Menlo, "DejaVu Sans Mono", "Ubuntu Mono", monospace',
      fontSize: initialFontSize,
      cursorBlink: true,
      macOptionClickForcesSelection: true,
      theme: TERMINAL_THEMES[initialAppearance],
      minimumContrastRatio: TERMINAL_MIN_CONTRAST[initialAppearance],
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // OSC 52 is write-only: programs in the pty may set the clipboard but never read it. tmux's mouse selections
    // are held for an explicit copy.
    const clipboard = createWriteOnlyClipboard({
      write: (text) => navigator.clipboard.writeText(text),
      hold: (text) => {
        heldRef.current = text
      },
    })
    term.loadAddon(new ClipboardAddon(undefined, clipboard))
    term.open(host)
    // What an explicit copy takes: xterm's own selection (Option/Shift+drag), else the last tmux mouse selection.
    const copyText = (): string => (term.hasSelection() ? term.getSelection() : heldRef.current)
    // macOS: the Edit menu's Copy (Cmd+C) fires a copy event; xterm handles it only for its own selection.
    const onCopy = (e: ClipboardEvent): void => {
      if (term.hasSelection() || !heldRef.current) return
      e.clipboardData?.setData('text/plain', heldRef.current)
      e.preventDefault()
    }
    host.addEventListener('copy', onCopy)

    // Linux has no app menu (it would steal Ctrl+C), so handle Ctrl+Shift+C/V here.
    // On macOS the Edit menu handles Cmd+C/V.
    term.attachCustomKeyEventHandler((e) => {
      if (modalOpenRef.current) return false
      // App shortcuts (palette, panel, …) are handled by App's window listener: never send them to tmux.
      if (matchShortcut(e)) return false
      if (isMac || e.type !== 'keydown' || !(e.ctrlKey && e.shiftKey)) return true
      const key = e.key.toLowerCase()
      if (key === 'c') {
        e.preventDefault()
        const text = copyText()
        if (text) void navigator.clipboard.writeText(text)
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
    // One fit + pty resize after the size settles, not one SIGWINCH per pixel of a drag.
    const settled = debounceSettled(doFit, RESIZE_SETTLE_MS)
    const observer = new ResizeObserver(() => settled.schedule())
    observer.observe(host)
    termRef.current = term
    fitRef.current = fit
    doFit()

    return () => {
      observer.disconnect()
      host.removeEventListener('copy', onCopy)
      settled.cancel()
      offData()
      input.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [api, initialFontSize, initialAppearance])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.reset() // the new tmux client redraws the whole screen on attach
    heldRef.current = ''
    fitRef.current?.fit()
    api.ptyResize(term.cols, term.rows)
    term.focus()
  }, [sessionKey, api])

  useEffect(() => {
    if (focusSeq > 0) termRef.current?.focus()
  }, [focusSeq])

  useEffect(() => {
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    fitRef.current?.fit() // same pixels, different cell size: new cols and rows
    api.ptyResize(term.cols, term.rows)
  }, [fontSize, api])

  useEffect(() => {
    const term = termRef.current
    if (!term || term.options.theme === TERMINAL_THEMES[appearance]) return
    term.options.theme = TERMINAL_THEMES[appearance] // xterm repaints with it; the buffer and the pty stay
    term.options.minimumContrastRatio = TERMINAL_MIN_CONTRAST[appearance]
  }, [appearance])

  return <div className="terminal-host" ref={hostRef} />
}
