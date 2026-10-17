import type { MeManagerApi } from '../../../shared/types'
import { createMockApi } from './mockApi'

function resolveApi(): MeManagerApi {
  if (window.api) return window.api
  // Dev only: lets the UI run in a plain browser. In a packaged app a missing preload is a bug.
  if (import.meta.env.DEV) return createMockApi()
  throw new Error('window.api is missing: the preload script did not load')
}

export const api: MeManagerApi = resolveApi()
