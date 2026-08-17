import type { SequenceStep, StepCondition } from './recipes'
import type { StepResult } from './exec'

/**
 * Ports of the web app's run helpers
 * (Revjuvenate-Web/src/lib/automation/{stepRenumber,conditionEvaluator,tokenResolver}.ts)
 * so local runs behave identically.
 */

/** Stateless normalization: every condition's ref_sequence must point to an
 *  existing step that precedes its own step. Idempotent. */
export function repairStepConditions(steps: SequenceStep[]): SequenceStep[] {
  return steps.map((step, i) => {
    const cond: StepCondition | undefined = step.condition
    if (!cond) return step
    const refIndex = steps.findIndex((s, k) => k !== i && s.sequence === cond.ref_sequence)
    if (refIndex >= 0 && refIndex < i) return step
    if (i === 0) return { ...step, condition: undefined }
    return { ...step, condition: { ...cond, ref_sequence: steps[i - 1].sequence } }
  })
}

/** Evaluates whether a step should run based on a referenced prior step's result.
 *  Fails open when the referenced result does not exist yet. */
export function evaluateCondition(
  cond: StepCondition,
  priorResults: Record<number, StepResult>,
): { run: boolean; reason: string } {
  const ref = priorResults[cond.ref_sequence]

  if (!ref) {
    return {
      run: true,
      reason: `Referenced step #${cond.ref_sequence} has no result yet — running by default.`,
    }
  }

  const status = (ref.status || '').toLowerCase()
  const message = ref.message || ''
  const value = (ref.value ?? '').toString()
  const succeeded = status === 'success' || status === 'ok' || status === 'completed'

  const elementMissRegex =
    /not\s*found|no such element|resolved to 0|timeout.*(?:waiting|locator|selector)|element.*not.*(?:visible|attached|present)/i
  const looksLikeMiss =
    !succeeded && (elementMissRegex.test(message) || elementMissRegex.test(status))

  const expected = (cond.expected ?? '').toString()
  const haystack = value || message

  let pass = false
  switch (cond.operator) {
    case 'succeeded':
      pass = succeeded
      break
    case 'failed':
      pass = !succeeded
      break
    case 'element_not_found':
      pass = looksLikeMiss
      break
    case 'element_found':
      pass = !looksLikeMiss
      break
    case 'returned_truthy':
      pass = isTruthy(value)
      break
    case 'returned_falsy':
      pass = !isTruthy(value)
      break
    case 'equals':
      pass = haystack.trim() === expected.trim()
      break
    case 'not_equals':
      pass = haystack.trim() !== expected.trim()
      break
    case 'contains':
      pass = haystack.toLowerCase().includes(expected.toLowerCase())
      break
    case 'not_contains':
      pass = !haystack.toLowerCase().includes(expected.toLowerCase())
      break
    default:
      pass = true
  }

  if (pass) {
    return { run: true, reason: `Condition met (#${cond.ref_sequence} ${cond.operator}).` }
  }
  return { run: false, reason: `Skipped: step #${cond.ref_sequence} ${describeFailure(cond, ref, value)}.` }
}

function isTruthy(v: string): boolean {
  if (!v) return false
  const s = v.trim().toLowerCase()
  if (!s) return false
  if (['false', '0', 'no', 'null', 'undefined', 'nan'].includes(s)) return false
  return true
}

function describeFailure(cond: StepCondition, ref: StepResult, value: string): string {
  switch (cond.operator) {
    case 'succeeded':
      return `did not succeed (status="${ref.status}")`
    case 'failed':
      return 'succeeded (expected failure)'
    case 'element_not_found':
      return 'element was found'
    case 'element_found':
      return 'element was not found'
    case 'returned_truthy':
      return `returned a falsy value ("${value}")`
    case 'returned_falsy':
      return `returned a truthy value ("${value}")`
    case 'equals':
      return `value "${value}" ≠ "${cond.expected ?? ''}"`
    case 'not_equals':
      return `value "${value}" === "${cond.expected ?? ''}"`
    case 'contains':
      return `value "${value}" does not contain "${cond.expected ?? ''}"`
    case 'not_contains':
      return `value "${value}" contains "${cond.expected ?? ''}"`
    default:
      return 'condition not met'
  }
}

/** Substitute ONLY `{{...}}` placeholders in `text`. Keys may be bare
 *  ("SELL_DATE") or braced ("{{SELL_DATE}}"). Unmatched placeholders are
 *  left untouched; literal text is never rewritten. */
export function resolveTemplatePlaceholders(
  text: string,
  replaceMap: Record<string, string>,
): string {
  if (!text) return text
  return text.replace(/\{\{([^}]+)\}\}/g, (_m, raw: string) => {
    const bare = raw.trim()
    if (bare in replaceMap) {
      const v = replaceMap[bare]
      return v == null ? '' : String(v)
    }
    const full = `{{${bare}}}`
    if (full in replaceMap) {
      const v = replaceMap[full]
      return v == null ? '' : String(v)
    }
    return _m
  })
}

/** Substitute `retrieved_values:KEY` / `retrieved_numbers:KEY` references
 *  embedded inside a selector/xpath — port of the backend's
 *  _SELECTOR_REF_RE resolution (agents/session_manager.py). */
const SELECTOR_REF_RE = /retrieved_(?:values|numbers):([^'"\s\]\),<]+)/g

export function resolveSelectorReferences(
  selector: string,
  values: Record<string, string>,
): string {
  if (!selector) return selector
  return selector.replace(SELECTOR_REF_RE, (m, key: string) => {
    const v = values[key]
    return v == null || v === '' ? m : v
  })
}

function parseLoopCount(step: SequenceStep): number {
  const raw = (step.default_value ?? '').trim()
  const n = raw ? parseInt(raw, 10) : (step.loop ?? 1)
  return Number.isFinite(n) && n > 0 ? n : 1
}

/**
 * Expands `loop` control steps into repeated bodies (single level). The
 * backend treats `loop` as a counter setter for batch clients; locally we
 * expand the steps following the loop step up to the next loop step (or end
 * of sequence) `N` times, keeping the loop step itself as an executed step.
 */
export function expandLoops(steps: SequenceStep[]): SequenceStep[] {
  const out: SequenceStep[] = []
  let i = 0
  while (i < steps.length) {
    const step = steps[i]
    if (step.action === 'loop') {
      const count = parseLoopCount(step)
      out.push({ ...step, loop: count })
      i += 1
      const body: SequenceStep[] = []
      while (i < steps.length && steps[i].action !== 'loop') {
        body.push(steps[i])
        i += 1
      }
      for (let k = 0; k < count; k++) out.push(...body)
      continue
    }
    out.push(step)
    i += 1
  }
  return out
}
