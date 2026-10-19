import { describe, expect, it } from 'vitest'
import {
  expandTaskName,
  MAX_TASK_TEMPLATES,
  MAX_TEMPLATE_NAME,
  normalizeTaskTemplates,
  templateBase,
  templateErrors,
  templateListErrors,
  toTaskTemplate,
  type TemplateFields,
} from './templates'
import { MAX_TASK_PROMPT } from './types'

// Local time, as the pattern's {date} is.
const NOW = new Date(2026, 9, 18, 23, 30)

describe('expandTaskName', () => {
  it('keeps text without placeholders as it is, trimmed', () => {
    expect(expandTaskName(' fix login ', [], NOW)).toBe('fix login')
  })

  it('puts in the local date as YYYYMMDD', () => {
    expect(expandTaskName('fix-{date}', [], NOW)).toBe('fix-20261018')
    expect(expandTaskName('{date}', [], new Date(2027, 0, 5))).toBe('20270105')
  })

  it('numbers after the highest number in use, counting every given name, ignoring case', () => {
    expect(expandTaskName('review-{n}', [], NOW)).toBe('review-1')
    expect(expandTaskName('review-{n}', ['review-1', 'Review-3', 'review-x', 'other-9'], NOW)).toBe('review-4')
    // A gap is not reused: a removed task's branch may still be there.
    expect(expandTaskName('review-{n}', ['review-2'], NOW)).toBe('review-3')
  })

  it('skips a number whose name is taken under another spelling (the same slug)', () => {
    expect(expandTaskName('review-{n}', ['review-1', 'Review 2'], NOW)).toBe('review-3')
  })

  it('treats the rest of the pattern literally, regular expression characters included', () => {
    expect(expandTaskName('fix (v{n}) *', ['fix (v2) *', 'fix vv9 *'], NOW)).toBe('fix (v3) *')
  })

  it('numbers per day when the pattern has both', () => {
    expect(expandTaskName('fix-{date}-{n}', ['fix-20261017-5', 'fix-20261018-1'], NOW)).toBe('fix-20261018-2')
  })

  it('leaves unknown braces alone and ignores numbers too large to count', () => {
    expect(expandTaskName('a{x}b', [], NOW)).toBe('a{x}b')
    expect(expandTaskName('r{n}', ['r99999999999999999999'], NOW)).toBe('r1')
  })
})

const fields = (over: Partial<TemplateFields> = {}): TemplateFields => ({
  name: 'Review',
  taskName: '',
  base: '',
  prompt: '',
  ...over,
})

describe('templateErrors', () => {
  it('accepts a name alone, and every field filled in', () => {
    expect(templateErrors(fields())).toEqual({})
    expect(
      templateErrors(fields({ taskName: 'review-{n}', base: 'origin/develop', prompt: 'Review the diff' })),
    ).toEqual({})
  })

  it('needs a name of at most MAX_TEMPLATE_NAME characters', () => {
    expect(templateErrors(fields({ name: '  ' }))).toEqual({ name: 'Enter a name.' })
    expect(templateErrors(fields({ name: 'x'.repeat(MAX_TEMPLATE_NAME + 1) })).name).toBe(
      `Use at most ${MAX_TEMPLATE_NAME} characters.`,
    )
  })

  it('checks the task name pattern', () => {
    expect(templateErrors(fields({ taskName: 'fix-{day}' })).taskName).toBe(
      'Unknown placeholder {day}: use {date} or {n}.',
    )
    expect(templateErrors(fields({ taskName: '!!' })).taskName).toBe('The name needs letters or numbers.')
    expect(templateErrors(fields({ taskName: 'a\tb' })).taskName).toBe(
      'No tabs, line breaks or other control characters.',
    )
    expect(templateErrors(fields({ taskName: 'x'.repeat(101) })).taskName).toBe('Use at most 100 characters.')
    expect(templateErrors(fields({ taskName: '{n}' }))).toEqual({})
  })

  it('checks the base branch looks like one', () => {
    for (const base of ['-x', 'two words', 'a\0b'])
      expect(templateErrors(fields({ base })).base).toBe('Enter a branch name, e.g. origin/main.')
  })

  it('caps the prompt like the New task dialog', () => {
    expect(templateErrors(fields({ prompt: 'x'.repeat(MAX_TASK_PROMPT + 1) })).prompt).toBe(
      `Use at most ${MAX_TASK_PROMPT} characters.`,
    )
    expect(templateErrors(fields({ prompt: 'a\0b' })).prompt).toBe('No NUL characters.')
  })
})

describe('templateListErrors', () => {
  it('flags a name used by an earlier template, ignoring case and spaces', () => {
    expect(templateListErrors([fields(), fields({ name: 'Fix' }), fields({ name: ' review ' })])).toEqual([
      {},
      {},
      { name: 'Another template has this name.' },
    ])
  })
})

describe('toTaskTemplate', () => {
  it('trims and leaves out empty fields', () => {
    expect(toTaskTemplate(fields({ name: ' Review ', taskName: ' r-{n} ', prompt: '  ' }))).toEqual({
      name: 'Review',
      taskName: 'r-{n}',
    })
  })
})

describe('normalizeTaskTemplates', () => {
  it('keeps valid templates, trimmed, without empty fields or unknown keys', () => {
    expect(
      normalizeTaskTemplates([
        { name: ' Review ', taskName: 'review-{n}', base: 'origin/develop', prompt: ' Look ', extra: 1 },
        { name: 'Fix', taskName: '', base: '' },
      ]),
    ).toEqual([{ name: 'Review', taskName: 'review-{n}', base: 'origin/develop', prompt: 'Look' }, { name: 'Fix' }])
  })

  it('drops invalid entries', () => {
    expect(
      normalizeTaskTemplates([
        null,
        'Review',
        [],
        {},
        { name: '' },
        { name: 3 },
        { name: 'x'.repeat(MAX_TEMPLATE_NAME + 1) },
        { name: 'a', taskName: 5 },
        { name: 'b', taskName: '{when}' },
        { name: 'c', base: '--force' },
        { name: 'd', prompt: 'x'.repeat(MAX_TASK_PROMPT + 1) },
        { name: 'e\0' },
        { name: 'ok', base: null },
      ]),
    ).toEqual([{ name: 'ok' }])
  })

  it('keeps the first of templates with the same name, ignoring case', () => {
    expect(normalizeTaskTemplates([{ name: 'Review' }, { name: 'review', prompt: 'x' }, { name: 'Fix' }])).toEqual([
      { name: 'Review' },
      { name: 'Fix' },
    ])
  })

  it('keeps at most MAX_TASK_TEMPLATES', () => {
    const many = Array.from({ length: MAX_TASK_TEMPLATES + 5 }, (_, i) => ({ name: `t${i}` }))
    const kept = normalizeTaskTemplates(many)
    expect(kept).toHaveLength(MAX_TASK_TEMPLATES)
    expect(kept.at(-1)).toEqual({ name: `t${MAX_TASK_TEMPLATES - 1}` })
  })

  it('gives none for anything that is not an array, and never the caller’s objects', () => {
    for (const raw of [undefined, null, {}, 'x']) expect(normalizeTaskTemplates(raw)).toEqual([])
    const template = { name: 'Review' }
    expect(normalizeTaskTemplates([template])[0]).not.toBe(template)
  })
})

describe('templateBase', () => {
  const list = { default: 'origin/main', branches: ['origin/main', 'origin/develop', 'main'] }

  it('is the default when the template has no base', () => {
    expect(templateBase(undefined, list)).toEqual({ baseRef: 'origin/main' })
  })

  it("is the template's base when the repo has it, or origin's branch of that name", () => {
    expect(templateBase('main', list)).toEqual({ baseRef: 'main' })
    expect(templateBase('develop', list)).toEqual({ baseRef: 'origin/develop' })
  })

  it('falls back to the default, saying which base is missing', () => {
    expect(templateBase('release', list)).toEqual({ baseRef: 'origin/main', missing: 'release' })
  })
})
