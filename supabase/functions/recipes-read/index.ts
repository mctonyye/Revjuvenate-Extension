// recipes-read edge function
// ===========================
// Reads AI-assisted recipes (recipes + recipe_versions + recipe_steps)
// for the authenticated Revjuvenate user.
//
// Why an edge function: the AI recipe tables are FORCE RLS with no
// client-role policies (they are written/read exclusively by the FastAPI
// backend via the service role). The extension side panel therefore
// cannot query them with the user's anon-key client. This function
// authenticates the caller (anon key + Authorization header -> getUser)
// and re-reads the data with the service role — mirroring the backend's
// GET /automation/recipes behaviour (all recipes visible to any
// authenticated user for now).
//
// Deploy:
//   supabase functions deploy recipes-read --project-ref tpoazafyhrtteqerceuv
// (run from this repo root, where supabase/functions/recipes-read lives)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.91.1'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

interface RecipeRow {
  recipe_id: string
  [key: string]: unknown
}

interface VersionRow {
  version_id: string
  recipe_id: string
  [key: string]: unknown
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'GET') {
    return json({ error: 'method_not_allowed' }, 405)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return json({ error: 'missing_authorization_header' }, 401)
  }

  const anonClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } },
  )

  const { data: { user }, error: userError } = await anonClient.auth.getUser()
  if (userError || !user) {
    return json({ error: 'unauthorized' }, 401)
  }

  const serviceClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const limitParam = Number(new URL(req.url).searchParams.get('limit') ?? 200)
  const limit = Math.min(Number.isFinite(limitParam) ? limitParam : 200, 500)

  const { data: recipes, error: recipesError } = await serviceClient
    .from('recipes')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (recipesError) {
    return json({ error: 'recipes_read_failed' }, 500)
  }

  const { data: versions, error: versionsError } = await serviceClient
    .from('recipe_versions')
    .select('*')
    .order('version_num', { ascending: true })
    .limit(1000)
  if (versionsError) {
    return json({ error: 'versions_read_failed' }, 500)
  }

  const { data: steps, error: stepsError } = await serviceClient
    .from('recipe_steps')
    .select('*')
    .order('order_index', { ascending: true })
    .limit(5000)
  if (stepsError) {
    return json({ error: 'steps_read_failed' }, 500)
  }

  const recipeById = new Map<string, RecipeRow & { versions: VersionRow[] }>()
  for (const recipe of recipes ?? []) {
    recipeById.set(recipe.recipe_id as string, { ...recipe, versions: [] })
  }

  const versionById = new Map<string, VersionRow & { steps: unknown[] }>()
  for (const version of versions ?? []) {
    const entry = { ...version, steps: [] }
    versionById.set(version.version_id as string, entry)
    recipeById.get(version.recipe_id as string)?.versions.push(entry)
  }

  for (const step of steps ?? []) {
    versionById.get(step.version_id as string)?.steps.push(step)
  }

  return json({ recipes: [...recipeById.values()], total: recipeById.size }, 200)
})