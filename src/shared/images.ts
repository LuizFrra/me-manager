/** Images the file viewer previews (and Markdown embeds), by lowercase extension. */
export const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
}

/** The largest image readImage returns, in bytes. */
export const MAX_IMAGE_BYTES = 5_000_000

/** The lowercase extension of a POSIX path's last segment, with its dot ('' when there is none). */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export const isImagePath = (path: string): boolean => extensionOf(path) in IMAGE_MIME

export const isSvgPath = (path: string): boolean => extensionOf(path) === '.svg'
