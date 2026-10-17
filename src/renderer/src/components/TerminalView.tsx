import type { MeManagerApi } from '../../../shared/types'

export interface TerminalViewProps {
  api: Pick<MeManagerApi, 'ptyWrite' | 'ptyResize' | 'onPtyData'>
  /** Changes whenever the attached session changes; the terminal resets. */
  sessionKey: string
}

export function TerminalView(_props: TerminalViewProps): React.JSX.Element {
  return <div className="terminal-host" />
}
