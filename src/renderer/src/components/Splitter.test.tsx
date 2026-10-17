import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Splitter } from './Splitter'

function setup(fraction = 0.4): { onChange: ReturnType<typeof vi.fn>; onCommit: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn()
  const onCommit = vi.fn()
  render(
    <div data-testid="workspace">
      <Splitter fraction={fraction} onChange={onChange} onCommit={onCommit} />
    </div>,
  )
  vi.spyOn(screen.getByTestId('workspace'), 'getBoundingClientRect').mockReturnValue({
    left: 0,
    right: 1000,
    width: 1000,
    top: 0,
    bottom: 500,
    height: 500,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
  return { onChange, onCommit }
}

describe('Splitter', () => {
  it('drags to resize, clamped to 280px … 70%, and commits on release', () => {
    const { onChange, onCommit } = setup()
    const splitter = screen.getByRole('separator', { name: 'Resize files panel' })
    fireEvent.pointerDown(splitter, { button: 0, pointerId: 1, clientX: 600 })
    fireEvent.pointerMove(splitter, { pointerId: 1, clientX: 500 })
    expect(onChange).toHaveBeenLastCalledWith(0.5)
    fireEvent.pointerMove(splitter, { pointerId: 1, clientX: 100 })
    expect(onChange).toHaveBeenLastCalledWith(0.7)
    fireEvent.pointerMove(splitter, { pointerId: 1, clientX: 990 })
    expect(onChange).toHaveBeenLastCalledWith(0.28)
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.pointerUp(splitter, { pointerId: 1 })
    expect(onCommit).toHaveBeenCalledWith(0.28)
    expect(document.body).not.toHaveClass('resizing')
  })

  it('ignores moves without a drag and resets on double-click', () => {
    const { onChange, onCommit } = setup(0.6)
    const splitter = screen.getByRole('separator')
    fireEvent.pointerMove(splitter, { clientX: 500 })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.doubleClick(splitter)
    expect(onCommit).toHaveBeenCalledWith(0.4)
  })
})
