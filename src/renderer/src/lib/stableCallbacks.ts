import { createElement, memo, useInsertionEffect, useRef, useState, type ComponentType } from 'react'

type AnyFunction = (...args: unknown[]) => unknown

/**
 * `Component`, re-rendered only when a prop that isn't a function changed. Its function props are stand-ins that
 * call the latest ones, so a parent that makes new callbacks at every render (inline arrows) doesn't re-render it:
 * for a large component (the sidebar) under a parent that re-renders at every poll that changed anything.
 * Only for components that call their function props from events and effects, never while rendering.
 */
export function withStableCallbacks<P extends object>(Component: ComponentType<P>): ComponentType<P> {
  const Inner = memo(Component) as unknown as ComponentType<P>
  function Stable(props: P): React.JSX.Element {
    const latest = useRef(props)
    // Before any effect of the component (its layout effects included) can call a stand-in.
    useInsertionEffect(() => {
      latest.current = props
    })
    const [standIns] = useState(() => new Map<string, AnyFunction>())
    const passed: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(props)) {
      if (typeof value !== 'function') {
        passed[key] = value
        continue
      }
      let standIn = standIns.get(key)
      if (!standIn) {
        standIn = (...args) => (latest.current as Record<string, AnyFunction>)[key](...args)
        standIns.set(key, standIn)
      }
      passed[key] = standIn
    }
    return createElement(Inner, passed as P)
  }
  Stable.displayName = `Stable(${Component.displayName ?? Component.name})`
  return Stable
}
