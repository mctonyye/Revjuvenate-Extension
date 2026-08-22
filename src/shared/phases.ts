// Mirror of the web app's phase detection for batch (data-driven) runs
// (Revjuvenate-Web/src/lib/automation/phaseDetection.ts): "setup" steps run
// ONCE at task start (login / SSO / 2FA / navigation), "row" steps run for
// each data row.

import type { SequenceStep } from './recipes'

/** Heuristic: true if a step looks like a one-time setup step
 *  (login, SSO, 2FA, "stay signed in" prompt). */
export function looksLikeSetupStep(step: SequenceStep): boolean {
  const hay = [
    step.element_name || '',
    step.xpath || '',
    step.default_value || '',
  ]
    .join(' ')
    .toLowerCase()

  const patterns = [
    'password',
    'passwd',
    'pwd',
    'username',
    'user_name',
    'email',
    'login',
    'signin',
    'sign_in',
    'sign-in',
    'sso',
    'otp',
    'totp',
    'one-time',
    'one_time',
    '2fa',
    'two-factor',
    'two_factor',
    'verify',
    'verification',
    'idsibutton', // Microsoft "Stay signed in"
    'idbtn_back',
    'stay signed',
    '{{username}}',
    '{{email}}',
    '{{password}}',
    '{{totp_code}}',
    'replace_value',
  ]
  return patterns.some((p) => hay.includes(p))
}

/** Returns a copy of steps with phase set: detected setup steps → "setup", rest → "row". */
export function autoTagPhases(steps: SequenceStep[]): SequenceStep[] {
  return steps.map((s) => ({
    ...s,
    phase: s.phase ?? (looksLikeSetupStep(s) ? 'setup' : 'row'),
  }))
}

/** True if at least one step has an explicit `phase` set. */
export function hasExplicitPhases(steps: SequenceStep[]): boolean {
  return steps.some((s) => s.phase === 'setup' || s.phase === 'row')
}
