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
import { editingKeySequence, NEWLINE_SEQUENCE, PASTE_IMAGE_SEQUENCE, terminalKeyAction } from '../lib/terminalKeys'
import { SYSTEM_UNICODE } from '../../../shared/unicodeWidths'
import { parseTmuxTitle } from '../../../shared/tmuxTitle'
import { cellAt, dragRange } from '../lib/dragSelection'
import { PopupMenu, type MenuItem } from './PopupMenu'
import { joinShellWords } from '../../../shared/shell'

export interface TerminalViewProps {
  api: Pick<MeManagerApi, 'ptyWrite' | 'ptyResize' | 'onPtyData'> & Partial<Pick<MeManagerApi, 'pathForFile'>>
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
  /** Leaves tmux's copy mode in the shown session (see MeManagerApi.leaveCopyMode). */
  onLeaveCopyMode?: () => Promise<boolean>
  /**
   * The pane's own output is shown (Settings.terminalMode `direct`), not a tmux client's screen: there is no copy mode,
   * and xterm's own scrollback, selection and mouse handling apply. A change starts a new terminal.
   */
  direct?: boolean
}

/** Resizes (e.g. dragging the panel splitter) are applied once this long after the movement stops. */
const RESIZE_SETTLE_MS = 100
/** How long "Copied" stays up. */
const NOTICE_MS = 1200
/** The task's file list for path links is listed again after this long, so new files become links too. */
const LINK_FILES_TTL_MS = 30_000
const MOD = isMac ? 'Cmd' : 'Ctrl'
/** Room kept for the "Ctrl+click to open link" hint at the window's right edge. */
const HINT_WIDTH = 180
const COPY_KEY = isMac ? '⌘C' : 'Ctrl+C'
/** How soon after a drag's release tmux's copy of it must arrive to be highlighted as that drag. */
const DRAG_COPY_MS = 1000
/** Direct mode's scrollback: a snapshot brings up to 10 000 lines of history, with room left for new output. */
const DIRECT_SCROLLBACK = 20_000

/** Following a link takes Ctrl+click (Cmd+click on macOS), so a plain click still focuses or selects. */
const followsLink = (e: MouseEvent): boolean => (isMac ? e.metaKey : e.ctrlKey)
const isHttp = (url: string): boolean => /^https?:\/\//i.test(url)
/** One cursor or paging key (arrows, Page Up/Down, Home/End): in copy mode tmux scrolls with these. */
// eslint-disable-next-line no-control-regex -- escape sequences are exactly what is matched
const FOCUS_REPORT = /^\x1b\[[IO]$/
// eslint-disable-next-line no-control-regex -- escape sequences are exactly what is matched
const NAVIGATION_KEY = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])$/

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
  onLeaveCopyMode,
  direct = false,
}: TerminalViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  // Read by the handlers, which are attached once with the terminal.
  const modalOpenRef = useRef(modalOpen)
  const claudeTabRef = useRef(claudeTab)
  const handlersRef = useRef({ onOpenUrl, onOpenFile, loadLinkFiles, onLeaveCopyMode })
  // The size and palette a new terminal starts with (the first one, or one of the other mode); later changes are
  // applied by the effects below, without recreating it.
  const createWithRef = useRef({ fontSize, appearance })
  useEffect(() => {
    modalOpenRef.current = modalOpen
    claudeTabRef.current = claudeTab
    handlersRef.current = { onOpenUrl, onOpenFile, loadLinkFiles, onLeaveCopyMode }
    createWithRef.current = { fontSize, appearance }
  }, [modalOpen, claudeTab, onOpenUrl, onOpenFile, loadLinkFiles, onLeaveCopyMode, fontSize, appearance])
  // The wheel scrolled back since the last key: tmux may be in copy mode before its title (below) says so.
  const wheelRef = useRef(false)
  // Input held while copy mode is left; it goes to the program once tmux is out of it.
  const pendingRef = useRef<string[] | null>(null)
  // tmux's title says whether it is in copy mode, where keys would go to tmux (see TMUX_TITLE). scrolledBack: the view
  // is above the bottom (tmux's, or xterm's own in direct mode), so "Jump to the bottom" is offered.
  const [scrolledBack, setScrolledBack] = useState(false)
  const inCopyModeRef = useRef(false)
  const viewScrolledRef = useRef(false)
  const termRef = useRef<Terminal | null>(null)
  // The last mouse selection tmux copied; it reaches the clipboard only on an explicit copy.
  const heldRef = useRef('')
  // Whether that selection was made since the last input, so Ctrl+C copies it rather than interrupting.
  const [heldFresh, setHeldFresh] = useState(false)
  const heldFreshRef = useRef(false)
  // tmux leaves copy mode once a drag on the live screen is copied (copy mode would freeze the screen), which takes its
  // highlight away: the terminal highlights the dragged cells itself (`drawn`) until the selection is no longer fresh.
  const dragRef = useRef<{ range: ReturnType<typeof dragRange>; at: number } | null>(null)
  const drawnRef = useRef(false)
  const fitRef = useRef<FitAddon | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The link under the pointer (for the hint and the context menu).
  const [hovered, setHovered] = useState<{ link: TextLink; x: number; y: number } | null>(null)
  const hoveredRef = useRef<TextLink | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; trigger: HTMLElement; items: MenuItem[] } | null>(null)
  // The task's files for path links, listed once per loader and refreshed after LINK_FILES_TTL_MS.
  const linkFilesCache = useRef<{ load: unknown; at: number; files: Promise<LinkFiles | null> } | null>(null)

  const setFresh = useCallback((fresh: boolean): void => {
    if (!fresh && drawnRef.current) {
      drawnRef.current = false
      termRef.current?.clearSelection()
    }
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

  // The terminal is made for one mode: `direct` is a dependency, so a mode switch disposes it and starts one of the
  // other mode (with its own scrollback and handlers) rather than every handler asking which mode it is in. The
  // session effect below then resets what the old one held, as for another session.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const { fontSize: initialFontSize, appearance: initialAppearance } = createWithRef.current
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
      allowProposedApi: true, // for term.unicode
      theme: TERMINAL_THEMES[initialAppearance],
      minimumContrastRatio: TERMINAL_MIN_CONTRAST[initialAppearance],
      ...(direct && { scrollback: DIRECT_SCROLLBACK }),
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
    // Emoji widths as tmux counts them (see SYSTEM_UNICODE), so lines with emoji stay aligned.
    term.unicode.register(SYSTEM_UNICODE)
    term.unicode.activeVersion = SYSTEM_UNICODE.version
    const fit = new FitAddon()
    term.loadAddon(fit)
    // OSC 52 is write-only: programs in the pty may set the clipboard but never read it. tmux's mouse selections
    // are held for an explicit copy. In direct mode tmux makes none (the mouse selects in xterm): a copy with no
    // selection name comes from a program, which means the default clipboard, so it is written too.
    // The last drag tmux copied, highlighted once tmux is out of copy mode (in it, tmux highlights it itself) while the
    // selection is still fresh.
    let toDraw: ReturnType<typeof dragRange> | null = null
    const drawCopiedDrag = (): void => {
      if (!toDraw || inCopyModeRef.current || !heldFreshRef.current) return
      const { column, row, length } = toDraw
      toDraw = null
      term.select(column, term.buffer.active.viewportY + row, length)
      drawnRef.current = true
    }
    const clipboard = createWriteOnlyClipboard({
      write: (text) => navigator.clipboard.writeText(text),
      hold: (text) => {
        if (direct) {
          navigator.clipboard.writeText(text).catch(() => {})
          return
        }
        heldRef.current = text
        setFresh(text !== '')
        const drag = dragRef.current
        dragRef.current = null
        toDraw = text !== '' && drag && Date.now() - drag.at < DRAG_COPY_MS ? drag.range : null
        drawCopiedDrag()
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

    // What an explicit copy takes: a fresh tmux mouse selection (highlighted by xterm too, but tmux's text is what was
    // selected), else xterm's own selection (Shift/Option+drag), else the last tmux mouse selection.
    const copyText = (): string =>
      heldFreshRef.current ? heldRef.current : term.hasSelection() ? term.getSelection() : heldRef.current
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
      if (!heldFreshRef.current && term.hasSelection()) {
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
    /**
     * Input for the program. In copy mode (after a scroll back or a mouse selection) tmux would swallow typed text or
     * read it as copy-mode commands: the first key leaves copy mode, and it and what follows are held until tmux is
     * out of it. Scrolling keys still scroll while the view is scrolled back. An Escape that left copy mode isn't
     * also sent on (it would interrupt Claude). In direct mode there is no copy mode: everything goes straight on.
     */
    const send = (data: string): void => {
      if (direct) {
        api.ptyWrite(data)
        return
      }
      const mouse = data.startsWith('\x1b[<')
      // Focus in/out reports (focus-events) are no keystroke.
      const focus = FOCUS_REPORT.test(data)
      // Typing ends the moment when Ctrl+C copies the tmux selection.
      if (!mouse && !focus) setFresh(false)
      if (pendingRef.current) {
        pendingRef.current.push(data)
        return
      }
      const leave = handlersRef.current.onLeaveCopyMode
      const maybeInMode = wheelRef.current || inCopyModeRef.current
      const scrolling = (wheelRef.current || viewScrolledRef.current) && NAVIGATION_KEY.test(data)
      if (maybeInMode && !mouse && !focus && !scrolling && leave) {
        wheelRef.current = false
        const pending = [data]
        pendingRef.current = pending
        void leave()
          .catch(() => false)
          .then((left) => {
            if (pendingRef.current !== pending) return // another session is shown now
            pendingRef.current = null
            if (left && pending[0] === '\x1b') pending.shift()
            for (const queued of pending) api.ptyWrite(queued)
          })
        return
      }
      api.ptyWrite(data)
    }

    const pasteClipboard = (orImage: boolean): void => {
      void navigator.clipboard
        .readText()
        .catch(() => '')
        .then((text) => {
          if (text) term.paste(text)
          // Nothing to paste as text: maybe an image, which Claude Code reads from the clipboard itself on ^V.
          else if (orImage) send(PASTE_IMAGE_SEQUENCE)
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
    // Files dragged in from the desktop are typed as their quoted paths, as other terminals do: Claude Code reads a
    // path to an image as that image.
    const draggingFiles = (e: DragEvent): boolean => !!api.pathForFile && !!e.dataTransfer?.types.includes('Files')
    const onDragOver = (e: DragEvent): void => {
      if (!draggingFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent): void => {
      if (!draggingFiles(e) || modalOpenRef.current) return
      e.preventDefault()
      const paths = [...(e.dataTransfer?.files ?? [])].map((f) => api.pathForFile?.(f) ?? '').filter(Boolean)
      if (paths.length === 0) return
      term.paste(`${joinShellWords(paths)} `)
      term.focus()
    }
    host.addEventListener('dragover', onDragOver)
    host.addEventListener('drop', onDrop)
    // Captured: in mouse mode xterm stops the wheel event once it has reported it to tmux.
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0) wheelRef.current = true
    }
    if (!direct) host.addEventListener('wheel', onWheel, { capture: true, passive: true })
    // A new click or drag replaces the selection; tmux reports a drag's text once the button is released. A drag that
    // starts on the live screen (not scrolled back in copy mode, where tmux keeps its own highlight) is remembered for
    // the copy that follows it.
    const cellOf = (e: MouseEvent): ReturnType<typeof cellAt> =>
      cellAt(
        (term.element?.querySelector('.xterm-screen') ?? host).getBoundingClientRect(),
        term.cols,
        term.rows,
        e.clientX,
        e.clientY,
      )
    let dragStart: ReturnType<typeof cellAt> = null
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0) return
      setFresh(false)
      dragRef.current = null
      dragStart = inCopyModeRef.current ? null : cellOf(e)
    }
    const onMouseUp = (e: MouseEvent): void => {
      const start = dragStart
      dragStart = null
      if (e.button !== 0 || !start) return
      const end = cellOf(e)
      if (end && (end.col !== start.col || end.row !== start.row))
        dragRef.current = { range: dragRange(start, end, term.cols), at: Date.now() }
    }
    if (!direct) {
      host.addEventListener('mousedown', onMouseDown)
      window.addEventListener('mouseup', onMouseUp)
    }

    term.attachCustomKeyEventHandler((e) => {
      if (modalOpenRef.current) return false
      // App shortcuts (palette, panel, …) are handled by App's window listener: never send them to tmux.
      if (matchShortcut(e)) return false
      const sequence = editingKeySequence(e, isMac)
      if (sequence) {
        e.preventDefault()
        if (e.type === 'keydown') send(sequence)
        return false
      }
      const action = terminalKeyAction(e, isMac)
      if (!action || (action === 'newline' && !claudeTabRef.current)) return true
      if (action === 'copyOrInterrupt' && !term.hasSelection() && !heldFreshRef.current) return true // ^C
      // Handled here, on keydown; the keypress (and Chromium's native paste) must not act on it too.
      e.preventDefault()
      if (e.type !== 'keydown') return false
      if (action === 'newline') send(NEWLINE_SEQUENCE)
      else if (action === 'copy' || action === 'copyOrInterrupt') {
        const text = copyText()
        if (text) copy(text)
      } else pasteClipboard(action === 'pasteOrImage')
      return false
    })

    const offData = api.onPtyData((data) => term.write(data))
    const input = term.onData(send)
    // Direct mode: xterm's own view, scrolled back when it is above the bottom, after a scroll or new output.
    const followView = (): void => {
      const { viewportY, baseY } = term.buffer.active
      setScrolledBack(viewportY < baseY)
    }
    const viewEvents = direct ? [term.onScroll(followView), term.onWriteParsed(followView)] : []
    // Classic mode: tmux's title says where its view is (programs' titles are no business of ours in direct mode).
    const title = term.onTitleChange((text) => {
      if (direct) return
      const mode = parseTmuxTitle(text)
      if (!mode) return
      inCopyModeRef.current = mode.inCopyMode
      viewScrolledRef.current = mode.scrolledBack > 0
      if (!mode.inCopyMode) {
        wheelRef.current = false // e.g. the wheel scrolled back to the bottom, which leaves it: keys go straight on
        drawCopiedDrag()
      } else if (drawnRef.current) {
        // tmux shows its own view now (scrolled back): the highlight would cover other text.
        drawnRef.current = false
        term.clearSelection()
      }
      setScrolledBack(viewScrolledRef.current)
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
      window.removeEventListener('mouseup', onMouseUp)
      host.removeEventListener('wheel', onWheel, { capture: true })
      host.removeEventListener('dragover', onDragOver)
      host.removeEventListener('drop', onDrop)
      settled.cancel()
      offData()
      input.dispose()
      pendingRef.current = null // a leave still on its way must not type into the next terminal
      title.dispose()
      for (const event of viewEvents) event.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [api, direct, setFresh, showNotice, openLink])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.reset() // the new tmux client redraws the whole screen on attach
    heldRef.current = ''
    setFresh(false)
    dragRef.current = null
    linkFilesCache.current = null
    wheelRef.current = false
    pendingRef.current = null
    inCopyModeRef.current = viewScrolledRef.current = false
    setScrolledBack(false)
    fitRef.current?.fit()
    api.ptyResize(term.cols, term.rows)
    term.focus()
  }, [sessionKey, direct, api, setFresh])

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
        <div
          className="terminal-hint"
          // Kept inside the window for a link near its right or bottom edge.
          style={{
            left: Math.max(0, Math.min(hovered.x + 12, window.innerWidth - HINT_WIDTH)),
            top: hovered.y + 40 > window.innerHeight ? hovered.y - 30 : hovered.y + 18,
          }}
          aria-hidden="true"
        >
          {linkHint}
        </div>
      )}
      {(notice || heldFresh) && (
        <div className="terminal-notice" role="status">
          {notice ?? `Selected · ${COPY_KEY} to copy`}
        </div>
      )}
      {scrolledBack && (
        <button
          className="terminal-jump"
          onClick={() => {
            if (direct) termRef.current?.scrollToBottom()
            else {
              wheelRef.current = false
              void handlersRef.current.onLeaveCopyMode?.().catch(() => false)
            }
            termRef.current?.focus()
          }}
        >
          ↓ Jump to the bottom
        </button>
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
