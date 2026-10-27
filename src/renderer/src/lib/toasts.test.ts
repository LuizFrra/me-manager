import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACTION_MS, cleanError, errorSummary, INFO_MS, RESUME_MS, useToasts } from './toasts'

describe('cleanError', () => {
  it('strips the Electron IPC prefix', () => {
    const err = new Error('Error invoking remote method \'api:createTask\': Error: A task named "x" already exists')
    expect(cleanError(err)).toBe('A task named "x" already exists')
  })
  it('handles non-errors', () => {
    expect(cleanError('plain')).toBe('plain')
  })
})

describe('errorSummary', () => {
  it('keeps a short error whole', () => {
    expect(errorSummary('Nothing to commit')).toEqual({ summary: 'Nothing to commit', more: false })
  })
  it('cuts a long one at a word, marking that there is more', () => {
    const { summary, more } = errorSummary(`pre-commit hook failed ${'word '.repeat(60)}`, 40)
    expect(summary).toBe('pre-commit hook failed word word word…')
    expect(more).toBe(true)
  })
  it('cuts a text without spaces at the limit', () => {
    expect(errorSummary('x'.repeat(50), 10)).toEqual({ summary: `${'x'.repeat(9)}…`, more: true })
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

  it('marks a warning toast, and only that one', () => {
    const { result } = renderHook(() => useToasts())
    act(() => result.current.showInfo('Copied branch name'))
    expect(result.current.toasts[0].warning).toBeUndefined()
    act(() => result.current.showInfo('Budget reached', { warning: true }))
    expect(result.current.toasts.map((t) => [t.message, t.warning])).toEqual([['Budget reached', true]])
  })

  it('keeps an info toast with an action for ACTION_MS, and a plain one never replaces it', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const { result } = renderHook(() => useToasts())
    act(() => result.current.showInfo('Copied branch name'))
    act(() => result.current.showInfo('Removed "notes"', { action: { label: 'Undo', run } }))
    act(() => result.current.showInfo('Copied worktree path'))
    expect(result.current.toasts.map((t) => [t.message, t.action?.label])).toEqual([
      ['Removed "notes"', 'Undo'],
      ['Copied worktree path', undefined],
    ])
    act(() => vi.advanceTimersByTime(INFO_MS))
    expect(result.current.toasts.map((t) => t.message)).toEqual(['Removed "notes"'])
    act(() => vi.advanceTimersByTime(ACTION_MS - INFO_MS - 1))
    expect(result.current.toasts).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.toasts).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })

  it('stacks two toasts with actions, each with its own', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useToasts())
    act(() => result.current.showInfo('Removed a', { action: { label: 'Undo', run: () => {} } }))
    act(() => result.current.showInfo('Removed b', { action: { label: 'Undo', run: () => {} } }))
    expect(result.current.toasts.map((t) => t.message)).toEqual(['Removed a', 'Removed b'])
  })

  it('keeps a hovered toast until the pointer leaves, then a little longer', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useToasts())
    act(() => result.current.showError(new Error('push failed: a long reason to read')))
    const id = result.current.toasts[0].id
    act(() => result.current.hold(id))
    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current.toasts).toHaveLength(1)
    act(() => result.current.release(id))
    act(() => vi.advanceTimersByTime(RESUME_MS - 1))
    expect(result.current.toasts).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.toasts).toEqual([])
  })

  it('shows the same error once, however often it happens', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useToasts())
    act(() => result.current.showError(new Error('offline')))
    act(() => vi.advanceTimersByTime(5000))
    act(() => result.current.showError(new Error('offline')))
    act(() => result.current.showError(new Error('other')))
    expect(result.current.toasts.map((t) => t.message)).toEqual(['offline', 'other'])
    act(() => vi.advanceTimersByTime(5000))
    expect(result.current.toasts.map((t) => t.message)).toEqual(['offline', 'other']) // its time started again
    act(() => vi.advanceTimersByTime(3000))
    expect(result.current.toasts).toEqual([])
    act(() => result.current.showError(new Error('offline')))
    expect(result.current.toasts).toHaveLength(1) // gone, so shown again
  })
})
