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

export type AuthResponse =
  | { ok: true; kind: 'state'; user: UserProfile | null }
  | { ok: true; kind: 'sign-in'; user: UserProfile }
  | { ok: true; kind: 'sign-out' }
  | { ok: false; error: string }

export interface AuthChangedMessage {
  type: 'auth:changed'
  user: UserProfile | null
}

export function isAuthResponse(value: unknown): value is AuthResponse {
  return typeof value === 'object' && value !== null && 'ok' in value
}

export async function sendMessage(message: ExtensionMessage): Promise<AuthResponse> {
  const response = await chrome.runtime.sendMessage(message)
  return isAuthResponse(response) ? response : { ok: false, error: 'Unexpected extension response.' }
}
