import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Appearance } from '../../../shared/types'
import { mockColorScheme } from '../test/matchMedia'
import { AppearanceContext, useDocumentAppearance, useResolvedAppearance } from './appearance'

function Root({ appearance }: { appearance: Appearance }): React.JSX.Element {
  const resolved = useDocumentAppearance(appearance)
  return (
    <AppearanceContext value={resolved}>
      <Child />
    </AppearanceContext>
  )
}
function Child(): React.JSX.Element {
  return <span data-testid="child">{useResolvedAppearance()}</span>
}

const rootAttribute = (): string | undefined => document.documentElement.dataset.appearance

afterEach(() => {
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.appearance
})

describe('useDocumentAppearance', () => {
  it('puts the resolved appearance on the root element and in context', () => {
    mockColorScheme(true)
    const { rerender } = render(<Root appearance="light" />)
    expect(rootAttribute()).toBe('light')
    expect(screen.getByTestId('child')).toHaveTextContent('light')
    rerender(<Root appearance="dark" />)
    expect(rootAttribute()).toBe('dark')
    expect(screen.getByTestId('child')).toHaveTextContent('dark')
  })

  it('follows the OS preference live in system mode, and ignores it otherwise', () => {
    const scheme = mockColorScheme(false)
    const { rerender, unmount } = render(<Root appearance="system" />)
    expect(rootAttribute()).toBe('light')
    act(() => scheme.setDark(true))
    expect(rootAttribute()).toBe('dark')
    expect(screen.getByTestId('child')).toHaveTextContent('dark')
    rerender(<Root appearance="light" />)
    act(() => scheme.setDark(false))
    act(() => scheme.setDark(true))
    expect(rootAttribute()).toBe('light')
    rerender(<Root appearance="system" />)
    expect(rootAttribute()).toBe('dark')
    unmount()
    expect(scheme.listeners()).toBe(0)
  })

  it('is dark without matchMedia (and so without a preference)', () => {
    vi.stubGlobal('matchMedia', undefined)
    render(<Root appearance="system" />)
    expect(rootAttribute()).toBe('dark')
  })
})

describe('useResolvedAppearance', () => {
  it('is dark outside a provider', () => {
    render(<Child />)
    expect(screen.getByTestId('child')).toHaveTextContent('dark')
  })
})
