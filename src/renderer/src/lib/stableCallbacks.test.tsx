import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { withStableCallbacks } from './stableCallbacks'

let renders = 0
function Child(props: { label: string; onPick: (n: number) => void }): React.JSX.Element {
  renders++
  return <button onClick={() => props.onPick(1)}>{props.label}</button>
}
const StableChild = withStableCallbacks(Child)

describe('withStableCallbacks', () => {
  it('skips re-rendering for new callbacks alone, and calls the latest ones', async () => {
    const user = userEvent.setup()
    const picked: string[] = []
    function Parent(): React.JSX.Element {
      const [count, setCount] = useState(0)
      const [label, setLabel] = useState('a')
      return (
        <>
          <button onClick={() => setCount((c) => c + 1)}>bump</button>
          <button onClick={() => setLabel('b')}>relabel</button>
          {/* A new arrow at every render, closing over this render's count. */}
          <StableChild label={label} onPick={(n) => picked.push(`${count}+${n}`)} />
        </>
      )
    }
    render(<Parent />)
    expect(renders).toBe(1)
    await user.click(screen.getByRole('button', { name: 'bump' }))
    await user.click(screen.getByRole('button', { name: 'bump' }))
    expect(renders).toBe(1)
    await user.click(screen.getByRole('button', { name: 'a' }))
    expect(picked).toEqual(['2+1'])
    await user.click(screen.getByRole('button', { name: 'relabel' }))
    expect(renders).toBe(2)
    await user.click(screen.getByRole('button', { name: 'b' }))
    expect(picked).toEqual(['2+1', '2+1'])
  })
})
