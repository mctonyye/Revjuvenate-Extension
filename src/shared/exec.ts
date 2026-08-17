import type { SequenceStep } from './recipes'

export interface StepResult {
  status: 'success' | 'skipped' | 'error'
  message?: string
  /** Extracted value for get_* / evaluate_js steps. */
  value?: string
  /** data: URL for screenshot steps. */
  screenshot?: string
}

export type ContentMessage =
  | { type: 'exec:ping' }
  | { type: 'exec:step'; step: SequenceStep; values: Record<string, string> }

export type ContentResponse = { ok: true; pong: true } | StepResult
