import { describe, expect, it } from 'vitest'
import { appState, folder, repo, task, theme } from '../test/fixtures'
import { filterSidebar } from './sidebarFilter'

const state = appState(
  theme('Client X', [repo('api', [task('fix login'), task('add tests')]), folder('notes')]),
  theme('Personal', [repo('blog', [task('new layout')]), folder('Recipes')]),
)
const shown = (query: string): { themes: string[]; items: string[]; tasks: string[] } | null => {
  const f = filterSidebar(state, query)
  return f && { themes: [...f.themes], items: [...f.items], tasks: [...f.tasks] }
}

describe('filterSidebar', () => {
  it('is no filter for a blank query', () => {
    expect(filterSidebar(state, '')).toBeNull()
    expect(filterSidebar(state, '   ')).toBeNull()
  })

  it('keeps a matching task with its repo and theme', () => {
    expect(shown('login')).toEqual({ themes: ['Client X'], items: ['api'], tasks: ['fix login'] })
  })

  it('matches case-insensitively, as a substring, ignoring surrounding spaces', () => {
    expect(shown('  RECIP ')).toEqual({ themes: ['Personal'], items: ['Recipes'], tasks: [] })
    expect(shown('LAY')).toEqual({ themes: ['Personal'], items: ['blog'], tasks: ['new layout'] })
  })

  it('keeps everything inside a matching repo or theme', () => {
    expect(shown('api')).toEqual({ themes: ['Client X'], items: ['api'], tasks: ['fix login', 'add tests'] })
    expect(shown('personal')).toEqual({ themes: ['Personal'], items: ['blog', 'Recipes'], tasks: ['new layout'] })
  })

  it('collects matches across themes', () => {
    expect(shown('es')).toEqual({
      themes: ['Client X', 'Personal'],
      items: ['api', 'notes', 'Recipes'],
      tasks: ['add tests'],
    })
  })

  it('shows a matching theme even when it is empty', () => {
    expect(filterSidebar(appState(theme('Empty', [])), 'emp')?.themes).toEqual(new Set(['Empty']))
  })

  it('returns empty sets when nothing matches', () => {
    expect(shown('zzz')).toEqual({ themes: [], items: [], tasks: [] })
  })
})
