import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanError, INFO_MS, useToasts } from './toasts'

describe('cleanError', () => {
  it('strips the Electron IPC prefix', () => {
    const err = new Error('Error invoking remote method \'api:createTask\': Error: A task named "x" already exists')
    expect(cleanError(err)).toBe('A task named "x" already exists')
  })
  it('handles non-errors', () => {
    expect(cleanError('plain')).toBe('plain')
  })
})

describe('useToasts', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows info toasts briefly, one at a time, next to errors', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useToasts())
    act(() => result.current.showError(new Error('boom')))
    act(() => result.current.showInfo('Copied branch name'))
    act(() => result.current.showInfo('Copied worktree path'))
    expect(result.current.toasts.map((t) => [t.kind, t.message])).toEqual([
      ['error', 'boom'],
      ['info', 'Copied worktree path'],
    ])
    act(() => vi.advanceTimersByTime(INFO_MS))
    expect(result.current.toasts.map((t) => t.kind)).toEqual(['error'])
  })
})
