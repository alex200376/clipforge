import type { ClipForgeApi } from '../shared/api'

declare global {
  interface Window {
    clipforge: ClipForgeApi
  }
}

export {}
