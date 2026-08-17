// Mirror of the web app's recipe model (Revjuvenate-Web/src/hooks/useBrowserAutomation.ts
// and useAutomationRecipes.ts). Steps are stored as JSONB on browser_automation_recipes.

export type StepConditionOperator =
  | 'succeeded'
  | 'failed'
  | 'element_not_found'
  | 'element_found'
  | 'returned_truthy'
  | 'returned_falsy'
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'

export interface StepCondition {
  /** 1-based sequence number of the step whose result we evaluate. */
  ref_sequence: number
  operator: StepConditionOperator
  /** Required for equals/not_equals/contains/not_contains. */
  expected?: string
  /** What to do when the condition evaluates to false. Default: "skip". */
  on_false?: 'skip' | 'abort'
}

export interface SequenceStep {
  element_name?: string
  sequence: number
  xpath: string
  action: string
  default_value?: string
  iframe?: string
  wait_time?: number
  loop?: number
  disabled?: boolean
  phase?: 'setup' | 'row'
  condition?: StepCondition
  value_format?: string | null
}

export interface AutomationRecipe {
  id: string
  name: string
  description?: string | null
  system?: string | null
  category?: string | null
  target_url?: string | null
  steps: SequenceStep[] | null
  replace_map?: Record<string, string> | null
  is_shared: boolean
  created_at: string
  updated_at: string
  user_id: string
  property_id?: string | null
}
