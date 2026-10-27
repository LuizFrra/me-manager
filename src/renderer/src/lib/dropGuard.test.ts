import { afterEach, describe, expect, it } from 'vitest'
import { refuseStrayFileDrops } from './dropGuard'

const drag = (type: 'dragover' | 'drop', types: string[]): DragEvent => {
  const e = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(e, 'dataTransfer', { value: { types, dropEffect: 'copy' } })
  return e
}

describe('refuseStrayFileDrops', () => {
  let stop = (): void => {}
  afterEach(() => stop())

  it('refuses files dropped where nothing takes them, so the window never opens them', () => {
    stop = refuseStrayFileDrops(window)
    const over = drag('dragover', ['Files'])
    document.body.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    expect(over.dataTransfer?.dropEffect).toBe('none')
    const drop = drag('drop', ['Files'])
    document.body.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
  })

  it('keeps the drop effect of a place that takes files, and leaves other drags alone', () => {
    stop = refuseStrayFileDrops(window)
    const zone = document.createElement('div')
    document.body.append(zone)
    zone.addEventListener('dragover', (e) => e.preventDefault())
    const over = drag('dragover', ['Files'])
    zone.dispatchEvent(over)
    expect(over.dataTransfer?.dropEffect).toBe('copy')
    const text = drag('dragover', ['text/plain'])
    document.body.dispatchEvent(text)
    expect(text.defaultPrevented).toBe(false)
    zone.remove()
  })
})
