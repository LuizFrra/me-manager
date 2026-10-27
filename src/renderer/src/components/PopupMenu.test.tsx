import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PopupMenu } from './PopupMenu'

describe('PopupMenu', () => {
  const items = [
    { label: 'Copy', run: vi.fn() },
    { label: 'Paste', run: vi.fn() },
  ]
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(80)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
  })
  afterEach(() => vi.restoreAllMocks())

  const menuAt = (y: number): HTMLElement => {
    render(<PopupMenu label="m" x={10} y={y} trigger={document.body} items={items} onClose={vi.fn()} />)
    return screen.getByRole('menu')
  }

  it('opens below the point when it fits', () => {
    expect(menuAt(100).style.top).toBe('100px')
  })

  it('opens above the point when it would run off the bottom of the window', () => {
    expect(menuAt(560).style.top).toBe('480px')
  })
})
