/// <reference types="vite/client" />

import type { NeoDeskPetApi } from './neoDeskPetApi'

declare global {
  interface Window {
    neoDeskPet?: NeoDeskPetApi
  }
}

export {}
