import { useEffect, useState } from 'react'
import { MAX_IMAGE_BYTES } from '../../../../shared/images'
import { formatSize } from '../../lib/files'

export interface ImageViewProps {
  path: string
  /** The file's size when known (the Files tab reads it first); too large a file is then not even requested. */
  size?: number
  /** readImage for this path: a data: URL, or null when it can't be read. */
  load: (path: string) => Promise<string | null>
  /** Compact: no zoom, a smaller stage (above a diff in Changes). */
  compact?: boolean
  /** A caption above the image, e.g. "New version". */
  label?: string
}

type Zoom = 'fit' | 'actual'

type Loaded = { key: string; url: string | null } | null

/** Bytes encoded in a base64 data: URL. */
function dataUrlBytes(url: string): number {
  const base64 = url.slice(url.indexOf(',') + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

/**
 * An image file, shown through `<img src="data:…">` only: an SVG is never put in the page as markup, so its
 * scripts and external references can't run or load. Centered on a checkerboard so transparency shows; Fit (the
 * default) scales it down to the panel, 100% shows it at its natural size.
 */
export function ImageView({ path, size, load, compact, label }: ImageViewProps): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>(null)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [dims, setDims] = useState<{ key: string; w: number; h: number } | null>(null)
  const [broken, setBroken] = useState<string | null>(null)
  const tooLarge = size !== undefined && size > MAX_IMAGE_BYTES
  // A new size means new contents: read the image again.
  const key = `${path}\0${size ?? ''}`

  useEffect(() => {
    if (tooLarge) return
    let alive = true
    load(path).then(
      (url) => alive && setLoaded({ key, url }),
      () => alive && setLoaded({ key, url: null }),
    )
    return () => {
      alive = false
    }
  }, [load, path, key, tooLarge])

  if (tooLarge) {
    return <p className="viewer-message">Image too large to preview ({formatSize(size)})</p>
  }
  if (!loaded || loaded.key !== key) return <p className="panel-hint">Loading image…</p>
  if (loaded.url === null) {
    return (
      <p className="viewer-message">
        {size === undefined
          ? `Can't preview this image: it is missing, unreadable or over ${formatSize(MAX_IMAGE_BYTES)}.`
          : "Can't preview this image: it could not be read."}
      </p>
    )
  }
  const bytes = size ?? dataUrlBytes(loaded.url)
  const shownDims = dims?.key === key ? dims : null
  const name = path.slice(path.lastIndexOf('/') + 1)
  return (
    <div className={compact ? 'image-view compact' : 'image-view'}>
      <div className="image-bar">
        {label && <span className="image-label">{label}</span>}
        <span className="image-info">
          {shownDims && shownDims.w > 0 ? `${shownDims.w} × ${shownDims.h} px · ` : ''}
          {formatSize(bytes)}
        </span>
        {!compact && (
          <div className="segmented" role="group" aria-label="Zoom">
            <button aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')} title="Fit the image to the panel">
              Fit
            </button>
            <button aria-pressed={zoom === 'actual'} onClick={() => setZoom('actual')} title="Actual size">
              100%
            </button>
          </div>
        )}
      </div>
      {broken === key ? (
        <p className="viewer-message">
          The image could not be displayed: it may be damaged or in an unsupported format.
        </p>
      ) : (
        <div className={`image-stage zoom-${compact ? 'fit' : zoom}`}>
          <img
            src={loaded.url}
            alt={name}
            draggable={false}
            onLoad={(e) => setDims({ key, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setBroken(key)}
          />
        </div>
      )}
    </div>
  )
}
