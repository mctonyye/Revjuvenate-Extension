// AI-assisted recipes (backend automation) — mirror of the FastAPI
// Recipe/RecipeVersion/RecipeStep models. Read-only for the extension:
// these tables are FORCE RLS with no client policies, so they are fetched
// through the `recipes-read` edge function (service role).

import type { SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_URL } from './supabase'

export interface AiLocatorSpec {
  strategy: string
  value: string
  role?: string
  name?: string
  exact?: boolean
}

export interface AiRecipeStep {
  step_id: string
  version_id: string
  order_index: number
  intent: string
  action: string
  primary_locator: AiLocatorSpec | null
  fallback_locators: AiLocatorSpec[]
  value: string
  value_from_param: string | null
  value_format: string | null
  wait_conditions: Array<{ type: string; value?: string; timeout_ms?: number }>
  timeout_ms: number
  frame_selector: string | null
  pre_assertion: string | null
  post_assertion: string | null
  screenshot_on_error: boolean
  enabled: boolean
}

export interface AiRecipeVersion {
  version_id: string
  recipe_id: string
  version_num: number
  params_schema: Record<string, unknown>
  notes: string
  is_production: boolean
  heal_policy: 'never' | 'suggest' | 'auto_low' | 'auto_high'
  created_at: string
  created_by: string
  steps: AiRecipeStep[]
}

export interface AiRecipe {
  recipe_id: string
  name: string
  description: string
  target_url_pattern: string
  status: 'draft' | 'approved' | 'archived'
  tags: string[]
  created_at: string
  updated_at: string
  versions: AiRecipeVersion[]
}

export function locatorText(locator: AiLocatorSpec | null): string {
  if (!locator) return ''
  const base = `${locator.strategy}: ${locator.value}`
  return locator.role ? `${base} (role=${locator.role})` : base
}

/**
 * Fetches AI recipes through the recipes-read edge function using the
 * user's current session access token.
 */
export async function fetchAiRecipes(
  client: SupabaseClient,
  signal?: AbortSignal,
): Promise<AiRecipe[]> {
  const {
    data: { session },
  } = await client.auth.getSession()
  if (!session) {
    throw new Error('Not signed in')
  }

  const response = await fetch(`${SUPABASE_URL}/functions/v1/recipes-read`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
    signal,
  })

  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { error?: string }
      if (body.error) detail = body.error
    } catch {
      // keep the HTTP status as the detail
    }
    throw new Error(`recipes-read failed: ${detail}`)
  }

  const data = (await response.json()) as { recipes?: AiRecipe[] }
  return data.recipes ?? []
}