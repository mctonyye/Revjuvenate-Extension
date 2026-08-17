// Best-effort run history logging — mirrors the web app's runSequence logging
// (Revjuvenate-Web/src/hooks/useBrowserAutomation.ts): inserts into
// automation_runs / automation_run_steps with the user's JWT. RLS scopes reads
// to the user's own rows. Failures never block execution.
import type { SequenceStep } from './recipes'
import { createExtensionClient } from './supabase'

let client: ReturnType<typeof createExtensionClient> | null = null

export function getDb() {
  if (!client) client = createExtensionClient()
  return client
}

export interface RunLogContext {
  userId: string
  recipeId?: string | null
  recipeName?: string | null
  targetUrl?: string | null
  replaceMap?: Record<string, string> | null
}

export async function logRunStart(
  ctx: RunLogContext,
  totalSteps: number,
): Promise<string | null> {
  try {
    const { data, error } = await getDb()
      .from('automation_runs')
      .insert({
        user_id: ctx.userId,
        recipe_id: ctx.recipeId ?? null,
        recipe_name: ctx.recipeName ?? null,
        agent_session_id: null,
        target_url: ctx.targetUrl ?? null,
        status: 'running',
        total_steps: totalSteps,
        replace_map: ctx.replaceMap ?? {},
      })
      .select('id')
      .single()
    if (error) return null
    return (data?.id ?? null) as string | null
  } catch {
    return null
  }
}

export async function logRunStep(params: {
  runId: string | null
  userId: string
  step: SequenceStep
  status: string
  message?: string
  returnedValue?: string
  skipReason?: string
  durationMs: number
}): Promise<void> {
  if (!params.runId) return
  try {
    await getDb().from('automation_run_steps').insert({
      run_id: params.runId,
      user_id: params.userId,
      sequence: params.step.sequence,
      action: params.step.action,
      element_name: params.step.element_name ?? null,
      status: params.status,
      message: params.message ?? null,
      returned_value: params.returnedValue ?? null,
      condition: params.step.condition ?? null,
      skip_reason: params.skipReason ?? null,
      duration_ms: params.durationMs,
    })
  } catch {
    // ignore
  }
}

export async function logRunFinalize(
  runId: string | null,
  status: 'success' | 'failed' | 'aborted',
  counters: { executed: number; skipped: number; failed: number },
  errorMessage?: string,
): Promise<void> {
  if (!runId) return
  try {
    await getDb()
      .from('automation_runs')
      .update({
        status,
        executed_steps: counters.executed,
        skipped_steps: counters.skipped,
        failed_steps: counters.failed,
        error_message: errorMessage ?? null,
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId)
  } catch {
    // ignore
  }
}