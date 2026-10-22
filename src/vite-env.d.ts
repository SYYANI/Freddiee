/// <reference types="vite/client" />
import type { FreddieAPI } from '../shared/types'

declare global {
  interface Window {
    freddie: FreddieAPI
  }
  const __APP_VERSION__: string
  const __APP_BUILD__: string
}

export {}
