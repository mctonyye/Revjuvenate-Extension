import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

if (!url || !anonKey) {
  throw new Error(
    'Missing Supabase configuration. Copy .env.example to .env and fill in VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.',
  )
}

export const SUPABASE_URL = url
export const SUPABASE_PUBLISHABLE_KEY = anonKey

interface StorageLike {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

/**
 * Persists the Supabase auth session in chrome.storage.session:
 * survives service-worker restarts, cleared automatically when the
 * browser closes (more secure than localStorage).
 */
export const chromeSessionStorage: StorageLike = {
  async getItem(key: string) {
    const result = await chrome.storage.session.get(key)
    return (result[key] as string | undefined) ?? null
  },
  async setItem(key: string, value: string) {
    await chrome.storage.session.set({ [key]: value })
  },
  async removeItem(key: string) {
    await chrome.storage.session.remove(key)
  },
}

export function createExtensionClient() {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      storage: chromeSessionStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  })
}
