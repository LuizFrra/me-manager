import { describe, expect, it } from 'vitest'
import { isRunCommand, MAX_RUN_COMMAND, normalizeRunCommand, runCommandError } from './runCommand'

describe('run commands', () => {
  it('accepts a shell command line, trimmed', () => {
    expect(normalizeRunCommand('  npm run dev  ')).toBe('npm run dev')
    expect(normalizeRunCommand('FOO=1 pnpm dev -- --port 5173 && echo "done" | tee log')).toBe(
      'FOO=1 pnpm dev -- --port 5173 && echo "done" | tee log',
    )
    expect(normalizeRunCommand('a\tb')).toBe('a\tb') // a tab is just a space to the shell
    expect(runCommandError('python manage.py runserver')).toBeNull()
  })

  it("treats '' and whitespace as no command", () => {
    expect(normalizeRunCommand('')).toBe('')
    expect(normalizeRunCommand('   ')).toBe('')
    expect(runCommandError('  ')).toBeNull()
    expect(isRunCommand('')).toBe(false)
  })

  it('refuses a NUL, line breaks and other control characters, an over-long command and non-strings', () => {
    expect(runCommandError('npm\0run')).toBe('The run command must be one line of text')
    expect(runCommandError('npm run dev\nrm -rf x')).toBe('The run command must be one line of text')
    expect(runCommandError('npm run dev\r')).toBeNull() // trimmed away
    expect(runCommandError('a\rb')).toBe('The run command must be one line of text')
    expect(runCommandError('a\x1b[31mb')).toBe('The run command must be one line of text')
    expect(runCommandError('x'.repeat(MAX_RUN_COMMAND))).toBeNull()
    expect(runCommandError('x'.repeat(MAX_RUN_COMMAND + 1))).toBe(
      `The run command is limited to ${MAX_RUN_COMMAND.toLocaleString('en-US')} characters`,
    )
    expect(runCommandError(5 as unknown as string)).toBe('The run command must be text')
    expect(() => normalizeRunCommand('a\nb')).toThrow('The run command must be one line of text')
    expect(() => normalizeRunCommand(null)).toThrow('The run command must be text')
  })

  it('tells a stored command that is valid from one that is not (a hand-edited state)', () => {
    expect(isRunCommand('npm run dev')).toBe(true)
    expect(isRunCommand(' npm run dev')).toBe(false) // stored trimmed
    expect(isRunCommand('a\nb')).toBe(false)
    expect(isRunCommand(['npm'])).toBe(false)
    expect(isRunCommand(undefined)).toBe(false)
  })
})
