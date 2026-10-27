import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Toasts } from './Toasts'

describe('Toasts', () => {
  it('holds a toast while it is hovered or focused, and lets it go after', () => {
    const onHold = vi.fn()
    const onRelease = vi.fn()
    render(
      <Toasts
        toasts={[{ id: 7, kind: 'error', message: 'boom' }]}
        onDismiss={vi.fn()}
        onHold={onHold}
        onRelease={onRelease}
      />,
    )
    const toast = screen.getByRole('alert')
    fireEvent.mouseEnter(toast)
    expect(onHold).toHaveBeenCalledWith(7)
    fireEvent.mouseLeave(toast)
    expect(onRelease).toHaveBeenCalledWith(7)
    fireEvent.focus(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onHold).toHaveBeenCalledTimes(2)
  })
})
