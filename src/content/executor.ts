import type { SequenceStep } from '../shared/recipes'
import type { StepResult } from '../shared/exec'
import { executeAction } from './actions'

export function executeStep(step: SequenceStep): Promise<StepResult> {
  return executeAction(step)
}
