import type { AutomationRecipe } from './recipes'

export interface UserProfile {
  id: string
  email?: string
  createdAt?: string
  lastSignInAt?: string
  orgId?: string
  roles?: string[]
}

export type ExtensionMessage =
  | { type: 'auth:get-state' }
  | { type: 'auth:sign-in'; email: string; password: string }
  | { type: 'auth:sign-out' }
  | { type: 'recipes:list' }

export type ExtensionResponse =
  | { ok: true; kind: 'auth:state'; user: UserProfile | null }
  | { ok: true; kind: 'auth:sign-in'; user: UserProfile }
  | { ok: true; kind: 'auth:sign-out' }
  | { ok: true; kind: 'recipes:list'; recipes: AutomationRecipe[] }
  | { ok: false; error: string }

export interface AuthChangedMessage {
  type: 'auth:changed'
  user: UserProfile | null
}

export function isExtensionResponse(value: unknown): value is ExtensionResponse {
  return typeof value === 'object' && value !== null && 'ok' in value
}

export async function sendMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  const response = await chrome.runtime.sendMessage(message)
  return isExtensionResponse(response)
    ? response
    : { ok: false, error: 'Unexpected extension response.' }
}
