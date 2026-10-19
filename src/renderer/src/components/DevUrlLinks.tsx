import { devUrlLabel } from '../../../shared/devUrls'
import type { DevUrl } from '../../../shared/types'

/**
 * Dev-server URLs as links. A click goes through `onOpen` (main's openExternal, which takes http(s) only), never
 * the window's own navigation; the `href` is there for the tooltip, middle clicks and screen readers.
 */
export function DevUrlLinks(props: {
  urls: readonly DevUrl[]
  onOpen: (url: string) => void
  className?: string
}): React.JSX.Element {
  return (
    <>
      {props.urls.map(({ url, tab }) => (
        <a
          key={url}
          className={props.className}
          href={url}
          target="_blank"
          rel="noreferrer"
          title={`Open ${url} in the browser (printed in the “${tab}” tab)`}
          onClick={(e) => {
            e.preventDefault()
            props.onOpen(url)
          }}
        >
          {devUrlLabel(url)}
        </a>
      ))}
    </>
  )
}
