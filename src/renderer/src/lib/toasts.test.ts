import { describe, expect, it } from 'vitest'
import { cleanError } from './toasts'

describe('cleanError', () => {
  it('strips the Electron IPC prefix', () => {
    const err = new Error('Error invoking remote method \'api:createTask\': Error: A task named "x" already exists')
    expect(cleanError(err)).toBe('A task named "x" already exists')
  })
  it('handles non-errors', () => {
    expect(cleanError('plain')).toBe('plain')
  })
})
