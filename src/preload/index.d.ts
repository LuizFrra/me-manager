import type { MeManagerApi } from '../shared/types'

declare global {
  interface Window {
    api: MeManagerApi
  }
}

export {}
