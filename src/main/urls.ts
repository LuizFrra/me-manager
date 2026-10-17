/** True for http(s) URLs, the only scheme the app hands to the system browser. */
export function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** True if `url` is the app's own page (same dev-server origin, or the same local file), ignoring query and hash. */
export function isAppUrl(url: string, appUrl: string): boolean {
  try {
    const target = new URL(url)
    const app = new URL(appUrl)
    if (app.protocol === 'file:') return target.protocol === 'file:' && target.pathname === app.pathname
    return target.origin === app.origin
  } catch {
    return false
  }
}
