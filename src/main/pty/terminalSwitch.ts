import type { TerminalMode } from '../../shared/types'
import type { PtyApi } from '../contracts'

/**
 * The terminal of the mode the settings ask for (read at each attach): one shows the session, the other is
 * detached. Only the shown one's data and exit are passed on.
 */
export class TerminalSwitch implements PtyApi {
  private active: PtyApi | null = null
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(code: number) => void>()

  constructor(
    private readonly impls: Record<TerminalMode, PtyApi>,
    private readonly mode: () => TerminalMode,
  ) {
    for (const impl of Object.values(impls)) {
      impl.onData((data) => {
        if (this.active === impl) this.dataListeners.forEach((cb) => cb(data))
      })
      impl.onExit((code) => {
        if (this.active !== impl) return
        this.active = null
        this.exitListeners.forEach((cb) => cb(code))
      })
    }
  }

  attach(session: string, cwd: string): void {
    const impl = this.impls[this.mode()]
    for (const other of Object.values(this.impls)) if (other !== impl) other.detach()
    this.active = impl
    impl.attach(session, cwd)
  }

  detach(): void {
    const impl = this.active
    this.active = null
    impl?.detach()
  }

  write(data: string): void {
    this.active?.write(data)
  }

  /** Both remember it, so the one attached next starts at the right size. */
  resize(cols: number, rows: number): void {
    for (const impl of Object.values(this.impls)) impl.resize(cols, rows)
  }

  onData(cb: (data: string) => void): () => void {
    this.dataListeners.add(cb)
    return () => this.dataListeners.delete(cb)
  }

  onExit(cb: (code: number) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }
}
