import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AutomationRecipe, SequenceStep } from '../shared/recipes'
import type { StepResult } from '../shared/exec'
import type { UserProfile } from '../shared/messages'
import { actionLabel } from '../shared/labels'
import {
  evaluateCondition,
  expandLoops,
  repairStepConditions,
  resolveSelectorReferences,
  resolveTemplatePlaceholders,
} from '../shared/run'
import { logRunFinalize, logRunStart, logRunStep } from '../shared/runLog'

type EntryStatus = 'pending' | 'running' | 'success' | 'skipped' | 'error'

interface RunEntry {
  sequence: number
  action: string
  label: string
  status: EntryStatus
  message?: string
  value?: string
  durationMs?: number
}

interface RunSummary {
  status: 'success' | 'failed' | 'aborted'
  executed: number
  skipped: number
  failed: number
}

const GETTER_ACTIONS = new Set([
  'get_text',
  'get_attribute',
  'get_url',
  'get_n_keep_values',
  'get_n_keep_values1',
  'get_n_keep_ids',
  'evaluate_js',
])

/** Click-family actions can start a navigation; Playwright waits for
 *  domcontentloaded after clicks, so mirror that here. */
const NAVIGATION_ACTIONS = new Set(['click', 'click_navigate', 'js_click'])

const PROFILE_KEY_PREFIX = 'revj:vars'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${Math.round(ms / 1000)}s (${label})`)),
      ms,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

async function pingTab(tabId: number): Promise<boolean> {
  try {
    const res = (await chrome.tabs.sendMessage(
      tabId,
      { type: 'exec:ping' },
      { frameId: 0 },
    )) as { pong?: boolean }
    return res?.pong === true
  } catch {
    return false
  }
}

async function waitForPageReady(tabId: number, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pingTab(tabId)) return true
    await sleep(400)
  }
  return false
}

function resolveTarget(targetUrl: string | null | undefined): string | null {
  if (!targetUrl) return null
  const trimmed = targetUrl.trim()
  if (!trimmed) return null
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`
  return trimmed
}

function matchesUrl(current: string, target: string): boolean {
  const strip = (u: string) => u.split('?')[0].split('#')[0]
  return strip(current) === strip(target) || current.includes(target) || target.includes(current)
}

function stringifyScriptResult(raw: unknown): string {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
}

async function executeOne(tabId: number, step: SequenceStep): Promise<StepResult> {
  const action = step.action
  const value = step.default_value ?? ''

  switch (action) {
    case 'goto': {
      if (!value) return { status: 'error', message: 'goto requires a URL value.' }
      await chrome.tabs.update(tabId, { url: value })
      const ready = await waitForPageReady(tabId)
      return ready
        ? { status: 'success' }
        : { status: 'error', message: 'Page did not become ready after navigation.' }
    }
    case 'back': {
      await chrome.tabs.goBack(tabId)
      const ready = await waitForPageReady(tabId)
      return ready
        ? { status: 'success' }
        : { status: 'error', message: 'Page did not become ready after going back.' }
    }
    case 'forward': {
      await chrome.tabs.goForward(tabId)
      const ready = await waitForPageReady(tabId)
      return ready
        ? { status: 'success' }
        : { status: 'error', message: 'Page did not become ready after going forward.' }
    }
    case 'wait_for_url': {
      const deadline = Date.now() + 30000
      for (;;) {
        const tab = await chrome.tabs.get(tabId)
        if (matchesUrl(tab.url ?? '', value)) return { status: 'success' }
        if (Date.now() >= deadline) {
          return { status: 'error', message: `Timed out waiting for URL: ${value}` }
        }
        await sleep(500)
      }
    }
    case 'wait': {
      const seconds = parseFloat(value) || step.wait_time || 0
      await sleep(seconds * 1000)
      return { status: 'success' }
    }
    case 'screenshot': {
      const tab = await chrome.tabs.get(tabId)
      const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId })
      if (active?.id !== tabId) {
        return { status: 'error', message: 'Run tab is not active — switch to it to capture a screenshot.' }
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
      return { status: 'success', message: 'Screenshot captured', screenshot: dataUrl }
    }
    case 'evaluate_js': {
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        func: (source: string, xpath: string | null) => {
          const run = (ctx: unknown) => {
            try {
              return new Function('return (' + source + ')').call(ctx)
            } catch {
              return new Function(source).call(ctx)
            }
          }
          try {
            if (xpath) {
              const el = document.evaluate(
                xpath,
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null,
              ).singleNodeValue
              if (!el) return { __revjError: `Element not found: ${xpath}` }
              return run(el)
            }
            return run(null)
          } catch (e) {
            return { __revjError: e instanceof Error ? e.message : String(e) }
          }
        },
        args: [value, step.xpath || null],
      })
      const raw = results?.[0]?.result as unknown
      if (raw && typeof raw === 'object' && '__revjError' in (raw as Record<string, unknown>)) {
        return {
          status: 'error',
          message: String((raw as Record<string, unknown>).__revjError),
        }
      }
      return { status: 'success', value: stringifyScriptResult(raw) }
    }
    default: {
      const res = (await chrome.tabs.sendMessage(
        tabId,
        { type: 'exec:step', step, values: {} },
        { frameId: 0 },
      )) as StepResult
      if (!res || typeof res !== 'object' || !res.status) {
        return { status: 'error', message: 'The page did not respond to the step.' }
      }
      return res
    }
  }
}

interface RunViewProps {
  recipe: AutomationRecipe
  user: UserProfile
  onBack: () => void
}

type RunPhase = 'prompt' | 'preparing' | 'running' | 'done'

export default function RunView({ recipe, user, onBack }: RunViewProps) {
  const [entries, setEntries] = useState<RunEntry[]>([])
  const [summary, setSummary] = useState<RunSummary | null>(null)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [variables, setVariables] = useState<Record<string, string>>({})
  const [remember, setRemember] = useState(true)
  const abortRef = useRef(false)

  const replaceKeys = useMemo(
    () => Object.keys(recipe.replace_map ?? {}),
    [recipe.replace_map],
  )

  // Run is triggered by incrementing runToken (phase is UI-only, so mid-run
  // phase changes never tear down the running effect).
  const [runToken, setRunToken] = useState(() => (replaceKeys.length ? 0 : 1))
  const [phase, _setPhase] = useState<RunPhase>(() =>
    replaceKeys.length ? 'prompt' : 'preparing',
  )
  const setPhase = _setPhase

  const steps = useMemo(
    () => expandLoops(repairStepConditions(recipe.steps ?? []).filter((s) => !s.disabled)),
    [recipe.steps],
  )

  const profileKey = `${PROFILE_KEY_PREFIX}:${user.id}:${recipe.id}`

  // Load the saved variable profile for this recipe.
  useEffect(() => {
    if (!replaceKeys.length) {
      setVariables({ ...(recipe.replace_map ?? {}) })
      return
    }
    void (async () => {
      try {
        const stored = await chrome.storage.local.get(profileKey)
        const saved = (stored[profileKey] ?? {}) as Record<string, string>
        setVariables({ ...(recipe.replace_map ?? {}), ...saved })
      } catch {
        setVariables({ ...(recipe.replace_map ?? {}) })
      }
    })()
  }, [profileKey, recipe.replace_map, replaceKeys.length])

  const startRun = useCallback(() => {
    if (remember && replaceKeys.length) {
      void chrome.storage.local.set({ [profileKey]: variables }).catch(() => {})
    }
    setRunToken((t) => t + 1)
  }, [remember, replaceKeys.length, profileKey, variables])

  const appendEntry = useCallback((entry: RunEntry) => {
    setEntries((prev) => [...prev, entry])
  }, [])

  const updateEntry = useCallback((sequence: number, patch: Partial<RunEntry>) => {
    setEntries((prev) => prev.map((e) => (e.sequence === sequence ? { ...e, ...patch } : e)))
  }, [])

  const abort = useCallback(() => {
    abortRef.current = true
  }, [])

  useEffect(() => {
    if (runToken === 0) return
    let cancelled = false
    let tabId: number | null = null

    void (async () => {
      if (steps.length === 0) {
        setSummary({ status: 'success', executed: 0, skipped: 0, failed: 0 })
        setPhase('done')
        return
      }

      const values: Record<string, string> = {}
      for (const [key, raw] of Object.entries({ ...(recipe.replace_map ?? {}), ...variables })) {
        const str = raw ?? ''
        values[key] = str
        values[`{{${key}}}`] = str
      }

      try {
        const target = resolveTarget(recipe.target_url)
        if (target) {
          const tab = await chrome.tabs.create({ url: target, active: true })
          tabId = tab.id ?? null
        } else {
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
          tabId = active?.id ?? null
        }
        if (tabId == null) throw new Error('No tab available for the run.')
        if (!(await waitForPageReady(tabId))) {
          throw new Error(
            'The page did not become ready. Make sure it is a regular http(s) page.',
          )
        }
      } catch (e) {
        if (!cancelled) {
          setFatalError(e instanceof Error ? e.message : String(e))
          setPhase('done')
        }
        return
      }

      if (cancelled) return
      setPhase('running')

      // Best-effort run-history logging.
      const runId = await logRunStart(
        {
          userId: user.id,
          recipeId: recipe.id,
          recipeName: recipe.name,
          targetUrl: recipe.target_url,
          replaceMap: values,
        },
        steps.length,
      )

      const resultsBySequence: Record<number, StepResult> = {}
      const counters = { executed: 0, skipped: 0, failed: 0 }
      let aborted = false

      for (const step of steps) {
        if (abortRef.current) {
          aborted = true
          break
        }
        const startedAt = Date.now()
        appendEntry({
          sequence: step.sequence,
          action: step.action,
          label: actionLabel(step.action),
          status: 'running',
        })

        if (step.condition) {
          const { run, reason } = evaluateCondition(step.condition, resultsBySequence)
          if (!run) {
            counters.skipped += 1
            const entryPatch: Partial<RunEntry> = {
              status: 'skipped',
              message: reason,
              durationMs: Date.now() - startedAt,
            }
            updateEntry(step.sequence, entryPatch)
            await logRunStep({
              runId,
              userId: user.id,
              step,
              status: 'skipped',
              skipReason: reason,
              durationMs: Date.now() - startedAt,
            })
            if (step.condition.on_false === 'abort') {
              aborted = true
              break
            }
            continue
          }
        }

        const resolvedStep: SequenceStep = {
          ...step,
          xpath: resolveSelectorReferences(
            resolveTemplatePlaceholders(step.xpath ?? '', values),
            values,
          ),
          default_value:
            step.default_value === undefined
              ? undefined
              : resolveTemplatePlaceholders(step.default_value, values),
        }

        let result: StepResult
        try {
          result = await withTimeout(executeOne(tabId, resolvedStep), 90000, actionLabel(step.action))
        } catch (e) {
          result = { status: 'error', message: e instanceof Error ? e.message : String(e) }
        }

        resultsBySequence[step.sequence] = result

        if (result.status === 'success') {
          counters.executed += 1
          if (result.value !== undefined && GETTER_ACTIONS.has(step.action)) {
            const key = step.element_name ?? String(step.sequence)
            values[key] = result.value
            values[`{{${key}}}`] = result.value
          }
          if (NAVIGATION_ACTIONS.has(step.action)) {
            await waitForPageReady(tabId, 15000)
          }
          const patch: Partial<RunEntry> = {
            status: 'success',
            message: result.message,
            value: result.value,
            durationMs: Date.now() - startedAt,
          }
          updateEntry(step.sequence, patch)
        } else if (result.status === 'skipped') {
          counters.skipped += 1
          updateEntry(step.sequence, {
            status: 'skipped',
            message: result.message,
            durationMs: Date.now() - startedAt,
          })
        } else {
          counters.failed += 1
          updateEntry(step.sequence, {
            status: 'error',
            message: result.message,
            durationMs: Date.now() - startedAt,
          })
        }

        await logRunStep({
          runId,
          userId: user.id,
          step,
          status: result.status,
          message: result.message,
          returnedValue: result.value,
          durationMs: Date.now() - startedAt,
        })

        if (step.wait_time && step.wait_time > 0 && result.status === 'success') {
          await sleep(step.wait_time * 1000)
        }
      }

      if (!cancelled) {
        const finalStatus: RunSummary['status'] =
          aborted ? 'aborted' : counters.failed > 0 ? 'failed' : 'success'
        setSummary({ status: finalStatus, ...counters })
        setPhase('done')
        await logRunFinalize(runId, finalStatus, counters, fatalError ?? undefined)
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runToken, steps, recipe, variables, user.id, appendEntry, updateEntry])

  const doneCount = entries.filter((e) => e.status !== 'pending' && e.status !== 'running').length
  const running = phase === 'running'

  if (phase === 'prompt' && replaceKeys.length > 0) {
    return (
      <div className="stack">
        <div className="toolbar">
          <button type="button" className="button small" onClick={onBack}>
            ← Back to recipes
          </button>
        </div>
        <div className="card">
          <div className="detail-title">{recipe.name}</div>
          <p className="muted small">
            This recipe needs values for {replaceKeys.length} variable
            {replaceKeys.length > 1 ? 's' : ''} before it can run.
          </p>
          <div className="stack">
            {replaceKeys.map((key) => (
              <label key={key} className="field">
                {key}
                <input
                  value={variables[key] ?? ''}
                  onChange={(e) =>
                    setVariables((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                  spellCheck={false}
                />
              </label>
            ))}
          </div>
          <label className="remember-row">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span className="small">Remember these values on this device</span>
          </label>
          <div className="toolbar">
            <button type="button" className="button primary" onClick={startRun}>
              Start run
            </button>
            <button type="button" className="button" onClick={onBack}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <button type="button" className="button small" onClick={onBack} disabled={running}>
          ← Back
        </button>
        {running && (
          <button type="button" className="button small danger" onClick={abort}>
            Abort
          </button>
        )}
      </div>

      <div className="card">
        <div className="detail-title">{recipe.name}</div>
        <div className="run-status">
          {phase === 'preparing' && 'Preparing tab…'}
          {running && `Running ${doneCount}/${steps.length}…`}
          {phase === 'done' && summary && `Completed: ${summary.status}`}
        </div>
        {fatalError && <p className="error">{fatalError}</p>}
        {summary && (
          <div className="badges">
            <span
              className={`badge ${summary.status === 'success' ? 'badge-mine' : summary.status === 'failed' ? 'badge-error' : 'badge-shared'}`}
            >
              {summary.status}
            </span>
            <span className="badge">{summary.executed} executed</span>
            <span className="badge">{summary.skipped} skipped</span>
            <span className="badge">{summary.failed} failed</span>
          </div>
        )}
      </div>

      <div className="step-list">
        {entries.map((entry) => (
          <RunRow key={`${entry.sequence}-${entry.action}`} entry={entry} />
        ))}
      </div>
    </div>
  )
}

function RunRow({ entry }: { entry: RunEntry }) {
  return (
    <div className={`run-row ${entry.status}`}>
      <span className={`status-dot ${entry.status}`} aria-hidden="true" />
      <div className="step-main">
        <div className="step-title">
          <span className="step-index">{entry.sequence}</span>
          {entry.label}
          {entry.durationMs !== undefined && (
            <span className="run-duration">{(entry.durationMs / 1000).toFixed(1)}s</span>
          )}
        </div>
        {entry.value !== undefined && entry.status === 'success' && (
          <div className="step-value">
            Value: <code>{entry.value}</code>
          </div>
        )}
        {entry.message && <div className="run-message">{entry.message}</div>}
      </div>
    </div>
  )
}