import type { MeManagerApi } from '../../../shared/types'
import { createMockApi } from './mockApi'

/** Real API from the preload, or the in-memory mock when running in a plain browser. */
export const api: MeManagerApi = window.api ?? createMockApi()
