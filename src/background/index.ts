import type { User } from '@supabase/supabase-js'
import { createExtensionClient } from '../shared/supabase'
import type { AutomationRecipe } from '../shared/recipes'
import type {
  AuthChangedMessage,
  ExtensionMessage,
  ExtensionResponse,
  UserProfile,
} from '../shared/messages'

const supabase = createExtensionClient()

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

function toUserProfile(user: User): UserProfile {
  const metadata = user.app_metadata ?? {}
  return {
    id: user.id,
    email: user.email ?? undefined,
    createdAt: user.created_at ?? undefined,
    lastSignInAt: user.last_sign_in_at ?? undefined,
    orgId: typeof metadata.org_id === 'string' ? metadata.org_id : undefined,
    roles: Array.isArray(metadata.roles) ? (metadata.roles as string[]) : undefined,
  }
}

async function getCurrentUser(): Promise<UserProfile | null> {
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return null
  return toUserProfile(data.user)
}

function broadcastAuthState(): void {
  void getCurrentUser().then((user) => {
    const message: AuthChangedMessage = { type: 'auth:changed', user }
    void chrome.runtime.sendMessage(message).catch(() => {
      // No receiver (e.g. side panel closed) - ignore.
    })
  })
}

supabase.auth.onAuthStateChange((event) => {
  if (
    event === 'SIGNED_IN' ||
    event === 'SIGNED_OUT' ||
    event === 'TOKEN_REFRESHED' ||
    event === 'USER_UPDATED'
  ) {
    broadcastAuthState()
  }
})

async function handleMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  switch (message.type) {
    case 'auth:get-state': {
      return { ok: true, kind: 'auth:state', user: await getCurrentUser() }
    }
    case 'auth:sign-in': {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: message.email,
        password: message.password,
      })
      if (error) return { ok: false, error: error.message }
      return { ok: true, kind: 'auth:sign-in', user: toUserProfile(data.user) }
    }
    case 'auth:sign-out': {
      await supabase.auth.signOut()
      return { ok: true, kind: 'auth:sign-out' }
    }
    case 'recipes:list': {
      const user = await getCurrentUser()
      if (!user) return { ok: false, error: 'Not authenticated.' }
      // RLS on browser_automation_recipes enforces the same visibility as the
      // web app: own recipes, or shared recipes for developers / users with any
      // role assignment. Writes are owner-only (WITH CHECK user_id = auth.uid()).
      const { data, error } = await supabase
        .from('browser_automation_recipes')
        .select('*')
        .order('updated_at', { ascending: false })
      if (error) return { ok: false, error: error.message }
      return { ok: true, kind: 'recipes:list', recipes: (data ?? []) as AutomationRecipe[] }
    }
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  void handleMessage(message as ExtensionMessage).then(sendResponse)
  return true
})
