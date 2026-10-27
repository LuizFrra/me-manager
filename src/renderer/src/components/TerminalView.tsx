import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import '@xterm/xterm/css/xterm.css'
import type { MeManagerApi, ResolvedAppearance } from '../../../shared/types'
import { createWriteOnlyClipboard } from '../lib/clipboardProvider'
import { isMac, matchShortcut } from '../lib/shortcuts'
import { debounceSettled } from '../lib/settledResize'
import { TERMINAL_MIN_CONTRAST, TERMINAL_THEMES } from '../lib/terminalTheme'
import { createLinkProvider, type LinkFiles } from '../lib/terminalLinkProvider'
import type { TextLink } from '../lib/terminalLinks'
import { NEWLINE_SEQUENCE, PASTE_IMAGE_SEQUENCE, terminalKeyAction } from '../lib/terminalKeys'
import { PopupMenu, type MenuItem } from './PopupMenu'

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
  /** Claude's tab is the one shown: Shift+Enter then starts a new line in its prompt instead of submitting. */
  claudeTab?: boolean
  /** Opens an http(s) URL clicked in the terminal (Ctrl+click, Cmd+click on macOS). */
  onOpenUrl?: (url: string) => void
  /** Opens one of the shown task's files clicked in the terminal; `line` when the text gave one. */
  onOpenFile?: (path: string, line?: number) => void
  /** The shown task's root and files, so paths to them in the output become links. */
  loadLinkFiles?: () => Promise<LinkFiles | null>
}

/** Resizes (e.g. dragging the panel splitter) are applied once this long after the movement stops. */
const RESIZE_SETTLE_MS = 100
/** How long "Copied" stays up. */
const NOTICE_MS = 1200
/** The task's file list for path links is listed again after this long, so new files become links too. */
const LINK_FILES_TTL_MS = 30_000
const MOD = isMac ? 'Cmd' : 'Ctrl'
const COPY_KEY = isMac ? '⌘C' : 'Ctrl+C'

/** Following a link takes Ctrl+click (Cmd+click on macOS), so a plain click still focuses or selects. */
const followsLink = (e: MouseEvent): boolean => (isMac ? e.metaKey : e.ctrlKey)
const isHttp = (url: string): boolean => /^https?:\/\//i.test(url)

export function TerminalView({
  api,
  sessionKey,
  fontSize,
  appearance = 'dark',
  modalOpen = false,
  focusSeq = 0,
  claudeTab = false,
  onOpenUrl,
  onOpenFile,
  loadLinkFiles,
}: TerminalViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  // Read by the handlers, which are attached once with the terminal.
  const modalOpenRef = useRef(modalOpen)
  const claudeTabRef = useRef(claudeTab)
  const handlersRef = useRef({ onOpenUrl, onOpenFile, loadLinkFiles })
  useEffect(() => {
    modalOpenRef.current = modalOpen
    claudeTabRef.current = claudeTab
    handlersRef.current = { onOpenUrl, onOpenFile, loadLinkFiles }
  }, [modalOpen, claudeTab, onOpenUrl, onOpenFile, loadLinkFiles])
  const termRef = useRef<Terminal | null>(null)
  // The last mouse selection tmux copied; it reaches the clipboard only on an explicit copy.
  const heldRef = useRef('')
  // Whether that selection was made since the last input, so Ctrl+C copies it rather than interrupting.
  const [heldFresh, setHeldFresh] = useState(false)
  const heldFreshRef = useRef(false)
  const fitRef = useRef<FitAddon | null>(null)
  // The size and palette to create the terminal with; later changes are applied by the effects below, without
  // recreating it.
  const [initialFontSize] = useState(fontSize)
  const [initialAppearance] = useState(appearance)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The link under the pointer (for the hint and the context menu).
  const [hovered, setHovered] = useState<{ link: TextLink; x: number; y: number } | null>(null)
  const hoveredRef = useRef<TextLink | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; trigger: HTMLElement; items: MenuItem[] } | null>(null)
  // The task's files for path links, listed once per loader and refreshed after LINK_FILES_TTL_MS.
  const linkFilesCache = useRef<{ load: unknown; at: number; files: Promise<LinkFiles | null> } | null>(null)

  const setFresh = useCallback((fresh: boolean): void => {
    if (heldFreshRef.current === fresh) return
    heldFreshRef.current = fresh
    setHeldFresh(fresh)
  }, [])

  const showNotice = useCallback((text: string): void => {
    clearTimeout(noticeTimer.current)
    setNotice(text)
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS)
  }, [])
  useEffect(() => () => clearTimeout(noticeTimer.current), [])

  const openLink = useCallback((link: TextLink): void => {
    const { onOpenUrl: openUrl, onOpenFile: openFile } = handlersRef.current
    if (link.kind === 'url') openUrl?.(link.url)
    else openFile?.(link.path, link.line)
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const leaveLink = (): void => {
      hoveredRef.current = null
      setHovered(null)
    }
    const hoverLink = (event: MouseEvent, link: TextLink): void => {
      hoveredRef.current = link
      setHovered({ link, x: event.clientX, y: event.clientY })
    }
    const term = new Terminal({
      fontFamily: 'Menlo, "DejaVu Sans Mono", "Ubuntu Mono", monospace',
      fontSize: initialFontSize,
      cursorBlink: true,
      macOptionClickForcesSelection: true,
      theme: TERMINAL_THEMES[initialAppearance],
      minimumContrastRatio: TERMINAL_MIN_CONTRAST[initialAppearance],
      // OSC 8 hyperlinks (tmux passes them on): followed like the links found in the text. Without a handler xterm
      // would ask with a blocking confirm() and then open a window the app refuses.
      linkHandler: {
        activate: (event, text) => {
          if (followsLink(event) && isHttp(text)) handlersRef.current.onOpenUrl?.(text)
        },
        hover: (event, text) => {
          if (isHttp(text)) hoverLink(event, { kind: 'url', start: 0, end: text.length, url: text })
        },
        leave: leaveLink,
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // OSC 52 is write-only: programs in the pty may set the clipboard but never read it. tmux's mouse selections
    // are held for an explicit copy.
    const clipboard = createWriteOnlyClipboard({
      write: (text) => navigator.clipboard.writeText(text),
      hold: (text) => {
        heldRef.current = text
        setFresh(text !== '')
      },
    })
    term.loadAddon(new ClipboardAddon(undefined, clipboard))
    term.open(host)
    term.registerLinkProvider(
      createLinkProvider({
        buffer: () => term.buffer.active,
        files: () => {
          const load = handlersRef.current.loadLinkFiles
          if (!load) return Promise.resolve(null)
          const cached = linkFilesCache.current
          if (cached && cached.load === load && Date.now() - cached.at < LINK_FILES_TTL_MS) return cached.files
          const files = load().catch(() => null)
          linkFilesCache.current = { load, at: Date.now(), files }
          return files
        },
        activate: (event, link) => {
          if (followsLink(event)) openLink(link)
        },
        hover: hoverLink,
        leave: leaveLink,
      }),
    )

    // What an explicit copy takes: xterm's own selection (Shift/Option+drag), else the last tmux mouse selection.
    const copyText = (): string => (term.hasSelection() ? term.getSelection() : heldRef.current)
    const copy = (text: string): void => {
      void navigator.clipboard.writeText(text).then(
        () => showNotice('Copied'),
        () => showNotice('Could not copy'),
      )
      term.clearSelection()
      setFresh(false)
    }
    // macOS: the Edit menu's Copy (Cmd+C) fires a copy event; xterm handles it only for its own selection.
    const onCopy = (e: ClipboardEvent): void => {
      if (term.hasSelection()) {
        showNotice('Copied')
        return
      }
      if (!heldRef.current) return
      e.clipboardData?.setData('text/plain', heldRef.current)
      e.preventDefault()
      setFresh(false)
      showNotice('Copied')
    }
    host.addEventListener('copy', onCopy)
    const pasteClipboard = (orImage: boolean): void => {
      void navigator.clipboard
        .readText()
        .catch(() => '')
        .then((text) => {
          if (text) term.paste(text)
          // Nothing to paste as text: maybe an image, which Claude Code reads from the clipboard itself on ^V.
          else if (orImage) api.ptyWrite(PASTE_IMAGE_SEQUENCE)
        })
    }
    const menuItems = (link: TextLink | null): MenuItem[] => {
      const items: MenuItem[] = []
      if (link?.kind === 'url')
        items.push(
          { label: 'Open link', run: () => openLink(link) },
          {
            label: 'Copy link',
            run: () => void navigator.clipboard.writeText(link.url).then(() => showNotice('Copied')),
          },
        )
      if (link?.kind === 'file') items.push({ label: 'Open file', run: () => openLink(link) })
      if (term.hasSelection() || heldFreshRef.current)
        items.push({
          label: 'Copy',
          run: () => {
            const text = copyText()
            if (text) copy(text)
          },
        })
      items.push({ label: 'Paste', run: () => pasteClipboard(false) })
      return items
    }
    // The right button opens our menu; tmux's own (with "Kill pane") is replaced in tmux.conf.
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      const items = menuItems(hoveredRef.current)
      setMenu({ x: e.clientX, y: e.clientY, trigger: term.textarea ?? host, items })
    }
    host.addEventListener('contextmenu', onContextMenu)
    // A new click or drag replaces the selection; tmux reports a drag's text once the button is released.
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button === 0) setFresh(false)
    }
    host.addEventListener('mousedown', onMouseDown)

    term.attachCustomKeyEventHandler((e) => {
      if (modalOpenRef.current) return false
      // App shortcuts (palette, panel, …) are handled by App's window listener: never send them to tmux.
      if (matchShortcut(e)) return false
      const action = terminalKeyAction(e, isMac)
      if (!action || (action === 'newline' && !claudeTabRef.current)) return true
      if (action === 'copyOrInterrupt' && !term.hasSelection() && !heldFreshRef.current) return true // ^C
      // Handled here, on keydown; the keypress (and Chromium's native paste) must not act on it too.
      e.preventDefault()
      if (e.type !== 'keydown') return false
      if (action === 'newline') api.ptyWrite(NEWLINE_SEQUENCE)
      else if (action === 'copy' || action === 'copyOrInterrupt') {
        const text = copyText()
        if (text) copy(text)
      } else pasteClipboard(action === 'pasteOrImage')
      return false
    })

    const offData = api.onPtyData((data) => term.write(data))
    const input = term.onData((data) => {
      // Typing (not a mouse report) ends the moment when Ctrl+C copies the tmux selection.
      if (!data.startsWith('\x1b[<')) setFresh(false)
      api.ptyWrite(data)
    })
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
      host.removeEventListener('contextmenu', onContextMenu)
      host.removeEventListener('mousedown', onMouseDown)
      settled.cancel()
      offData()
      input.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [api, initialFontSize, initialAppearance, setFresh, showNotice, openLink])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.reset() // the new tmux client redraws the whole screen on attach
    heldRef.current = ''
    setFresh(false)
    linkFilesCache.current = null
    fitRef.current?.fit()
    api.ptyResize(term.cols, term.rows)
    term.focus()
  }, [sessionKey, api, setFresh])

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

  const closeMenu = useCallback(() => setMenu(null), [])
  const linkHint = hovered ? `${MOD}+click to ${hovered.link.kind === 'url' ? 'open link' : 'open file'}` : null
  return (
    <>
      <div className="terminal-host" ref={hostRef} />
      {hovered && linkHint && (
        <div className="terminal-hint" style={{ left: hovered.x + 12, top: hovered.y + 18 }} aria-hidden="true">
          {linkHint}
        </div>
      )}
      {(notice || heldFresh) && (
        <div className="terminal-notice" role="status">
          {notice ?? `Selected · ${COPY_KEY} to copy`}
        </div>
      )}
      {menu && (
        <PopupMenu
          label="Terminal"
          x={menu.x}
          y={menu.y}
          trigger={menu.trigger}
          items={menu.items}
          onClose={closeMenu}
        />
      )}
    </>
  )
}
