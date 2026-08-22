import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import type { AutomationRecipe, SequenceStep } from '../shared/recipes'
import type { StepResult } from '../shared/exec'
import type { UserProfile } from '../shared/messages'
import { actionLabel, stepLabel } from '../shared/labels'
import { autoTagPhases, hasExplicitPhases } from '../shared/phases'
import {
  evaluateCondition,
  expandLoops,
  normalizeActionName,
  repairStepConditions,
  resolveSelectorReferences,
  resolveTemplatePlaceholders,
} from '../shared/run'
import {
  ensureTabReady,
  executeOne,
  resolveTarget,
  testStepOnActiveTab,
  waitForPageReady,
  withTimeout,
} from './executor'
import { logRunFinalize, logRunStart, logRunStep } from '../shared/runLog'
import { createExtensionClient } from '../shared/supabase'
import {
  buildTokenReplaceMap,
  collectReferencedColumns,
  collectReferencedTokens,
  normalizeMaybeExcelSerialDate,
  type AutomationToken,
  type DataRow,
  type SensitiveValues,
} from '../shared/tokens'
import * as XLSX from 'xlsx'

type EntryStatus = 'pending' | 'running' | 'success' | 'skipped' | 'error'

interface RunEntry {
  sequence: number
  action: string
  label: string
  status: EntryStatus
  message?: string
  value?: string
  durationMs?: number
  /** 0-based data-row index when the step was part of a batch row run. */
  row?: number
  /** The resolved step that produced this entry — used by the ▶ Test button. */
  step?: SequenceStep
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
  const [tokens, setTokens] = useState<AutomationToken[]>([])
  const [tokensLoaded, setTokensLoaded] = useState(false)
  const [dataFile, setDataFile] = useState<{
    name: string
    wb: XLSX.WorkBook
    sheets: string[]
    selected: string
    columns: string[]
    rows: DataRow[]
  } | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const abortRef = useRef(false)
  const prefilledRef = useRef<Set<string>>(new Set())

  const replaceKeys = useMemo(
    () => Object.keys(recipe.replace_map ?? {}),
    [recipe.replace_map],
  )

  // Run is triggered by incrementing runToken (phase is UI-only, so mid-run
  // phase changes never tear down the running effect). Auto-start waits for
  // the token fetch so token-backed recipes can resolve without input.
  const [runToken, setRunToken] = useState(0)
  const [phase, _setPhase] = useState<RunPhase>('preparing')
  const setPhase = _setPhase

  const steps = useMemo(
    () =>
      expandLoops(recipe.steps ?? [])
        .filter((s) => !s.disabled)
        .map((s) => ({ ...s, action: normalizeActionName(s.action) })),
    [recipe.steps],
  )

  /** Batch mode: a loaded data file splits the run into a setup phase (run
   *  once) plus row steps (run per data row), like the web app. */
  const batchActive = !!(dataFile && dataFile.rows.length > 0 && steps.length > 0)

  const projectedTotalSteps = useMemo(() => {
    if (!batchActive) return steps.length
    const tagged = hasExplicitPhases(steps) ? steps : autoTagPhases(steps)
    const setupCount = tagged.filter((s) => s.phase === 'setup').length
    return setupCount + (tagged.length - setupCount) * dataFile!.rows.length
  }, [steps, dataFile, batchActive])

  const referencedNames = useMemo(() => {
    const names = collectReferencedTokens(steps)
    const tokenNames = new Set(tokens.map((t) => t.name))
    for (const key of replaceKeys) {
      if (tokenNames.has(key)) names.add(key)
    }
    return names
  }, [steps, tokens, replaceKeys])

  const referencedColumns = useMemo(() => collectReferencedColumns(steps), [steps])

  const promptKeys = useMemo(() => {
    if (referencedNames.size === 0) return replaceKeys
    const auto = buildTokenReplaceMap({
      tokens: tokens.filter((t) => referencedNames.has(t.name)),
      row: dataFile?.rows[0],
    })
    const missing: string[] = []
    for (const name of referencedNames) {
      if (!(name in auto) && !(`{{${name}}}` in auto)) missing.push(name)
    }
    for (const key of replaceKeys) {
      if (!missing.includes(key) && !(key in auto) && !(`{{${key}}}` in auto)) missing.push(key)
    }
    return missing
  }, [referencedNames, tokens, dataFile, replaceKeys])

  const sensitiveNames = useMemo(
    () =>
      new Set(
        tokens
          .filter((t) => t.source === 'sensitive' || t.source === 'login_config' || t.is_sensitive)
          .map((t) => t.name),
      ),
    [tokens],
  )

  /** Which referenced tokens/columns the loaded sheet can (and cannot) fill. */
  const resolutionInfo = useMemo(() => {
    if (!dataFile) return null
    const row = dataFile.rows[0]
    const found: string[] = []
    const missing: string[] = []
    const tokenByName = new Map(tokens.map((t) => [t.name, t]))
    for (const name of referencedNames) {
      const token = tokenByName.get(name)
      if (!token) continue
      if (token.source !== 'data_column' && token.source !== 'login_config') continue
      const header = token.data_column ?? undefined
      const hit = [header, name].find((h) => h !== undefined && h !== '' && h in row)
      if (hit) found.push(token.name)
      else missing.push(token.name)
    }
    for (const col of referencedColumns) {
      if (col in row) found.push(`col:${col}`)
      else missing.push(`col:${col}`)
    }
    return { found, missing }
  }, [dataFile, tokens, referencedNames, referencedColumns])

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

  // Load the user's automation tokens (RLS-scoped) for token resolution.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const client = createExtensionClient()
        const { data, error } = await client.from('automation_tokens').select('*')
        if (!cancelled && !error) setTokens((data as AutomationToken[]) ?? [])
      } catch {
        // tokens are optional — the run falls back to manual entry
      } finally {
        if (!cancelled) setTokensLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Auto-start once tokens are loaded and nothing still needs input.
  useEffect(() => {
    if (!tokensLoaded || runToken !== 0) return
    const needsDataFile = referencedColumns.size > 0 && dataFile === null
    if (promptKeys.length === 0 && !needsDataFile) setRunToken(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokensLoaded, runToken, promptKeys.length, referencedColumns.size, dataFile])

  /** Fill the visible prompt fields from the data row (tokens first, then
   *  bare header names). Values stay in `prefilledRef` so sheet switches
   *  refresh them and file removal drops them. */
  const applyRowToVariables = useCallback(
    (row: DataRow | undefined) => {
      if (!row) {
        setVariables((prev) => {
          const next = { ...prev }
          for (const k of prefilledRef.current) delete next[k]
          prefilledRef.current.clear()
          return next
        })
        return
      }
      setVariables((prev) => {
        const next = { ...prev }
        const tokenByName = new Map(tokens.map((t) => [t.name, t]))
        for (const key of promptKeys) {
          const token = tokenByName.get(key)
          const header =
            token && token.source === 'data_column' && token.data_column
              ? token.data_column
              : undefined
          const hit = [header, key].find(
            (h) => h !== undefined && h !== '' && h in row,
          )
          if (!hit) continue
          const value = normalizeMaybeExcelSerialDate(hit, String(row[hit] ?? ''))
          if (prefilledRef.current.has(key)) {
            next[key] = value
          } else if (!(key in next) || next[key] === '') {
            next[key] = value
            prefilledRef.current.add(key)
          }
        }
        return next
      })
    },
    [promptKeys, tokens],
  )

  const handleDataFile = useCallback(
    async (fileList: FileList | null) => {
      const file = fileList?.[0]
      if (!file) return
      setFatalError(null)
      try {
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
        const sheets = wb.SheetNames
        if (sheets.length === 0) throw new Error('The file has no worksheets.')
        const first = sheets[0]
        const ws = wb.Sheets[first]
        if (!ws) throw new Error('The file has no worksheets.')
        const rows = XLSX.utils.sheet_to_json<DataRow>(ws, { defval: null })
        if (rows.length === 0) throw new Error(`Worksheet "${first}" has no data rows.`)
        setDataFile({
          name: file.name,
          wb,
          sheets,
          selected: first,
          columns: Object.keys(rows[0]),
          rows,
        })
        applyRowToVariables(rows[0])
      } catch (err) {
        setFatalError(err instanceof Error ? err.message : String(err))
      }
    },
    [applyRowToVariables],
  )

  const selectSheet = useCallback(
    (sheet: string) => {
      if (!dataFile) return
      const ws = dataFile.wb.Sheets[sheet]
      if (!ws) return
      const rows = XLSX.utils.sheet_to_json<DataRow>(ws, { defval: null })
      if (rows.length === 0) {
        setFatalError(`Worksheet "${sheet}" has no data rows.`)
        return
      }
      setDataFile({ ...dataFile, selected: sheet, columns: Object.keys(rows[0]), rows })
      applyRowToVariables(rows[0])
    },
    [dataFile, applyRowToVariables],
  )

  const removeDataFile = useCallback(() => {
    applyRowToVariables(undefined)
    setDataFile(null)
  }, [applyRowToVariables])

  const startRun = useCallback(() => {
    if (remember && replaceKeys.length) {
      void chrome.storage.local.set({ [profileKey]: variables }).catch(() => {})
    }
    setRunToken((t) => t + 1)
  }, [remember, replaceKeys.length, profileKey, variables])

  const appendEntry = useCallback((entry: RunEntry) => {
    setEntries((prev) => [...prev, entry])
  }, [])

  const updateEntry = useCallback(
    (sequence: number, patch: Partial<RunEntry>, row?: number) => {
      setEntries((prev) =>
        prev.map((e) => (e.sequence === sequence && e.row === row ? { ...e, ...patch } : e)),
      )
    },
    [],
  )

  const abort = useCallback(() => {
    abortRef.current = true
  }, [])

  /** Test mode: re-run ONE entry's step on the currently active tab. */
  const [stepTest, setStepTest] = useState<{
    key: string
    running: boolean
    result?: StepResult
    url?: string
  } | null>(null)

  const runEntryTest = useCallback(
    async (index: number) => {
      const entry = entries[index]
      if (!entry?.step) return
      setStepTest({ key: String(index), running: true })
      const { result, url } = await testStepOnActiveTab(entry.step, recipe.replace_map ?? {})
      setStepTest({ key: String(index), running: false, result, url })
    },
    [entries, recipe.replace_map],
  )

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

      const sensitive: SensitiveValues = {}
      for (const name of promptKeys) sensitive[name] = variables[name] ?? ''
      const buildValues = (row: DataRow | undefined): Record<string, string> => {
        const tokenMap = buildTokenReplaceMap({
          tokens,
          row,
          sensitive,
          fallback: recipe.replace_map ?? {},
        })
        const out: Record<string, string> = {}
        for (const [key, raw] of Object.entries({ ...tokenMap, ...variables })) {
          const str = raw ?? ''
          out[key] = str
          out[`{{${key}}}`] = str
        }
        return out
      }
      const baseValues = buildValues(dataFile?.rows[0])

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
        if (!(await ensureTabReady(tabId))) {
          throw new Error(
            'The page did not become ready. Make sure the tab is a regular http(s) page.',
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
      const activeTabId = tabId

      // Batch split: "setup" step(s) run once, "row" step(s) run per data row.
      // Undefined phases default to "row" (web parity); auto-tag when the
      // recipe author tagged nothing.
      const tagged = batchActive ? (hasExplicitPhases(steps) ? steps : autoTagPhases(steps)) : []
      const setupSteps = batchActive ? tagged.filter((s) => s.phase === 'setup') : []
      const rowSteps = batchActive ? tagged.filter((s) => s.phase !== 'setup') : []
      const totalSteps = batchActive
        ? setupSteps.length + rowSteps.length * dataFile!.rows.length
        : steps.length

      // Best-effort run-history logging.
      const runId = await logRunStart(
        {
          userId: user.id,
          recipeId: recipe.id,
          recipeName: recipe.name,
          targetUrl: recipe.target_url,
          replaceMap: baseValues,
        },
        totalSteps,
      )

      const counters = { executed: 0, skipped: 0, failed: 0 }
      let aborted = false

      const runSubSequence = async (
        seq: SequenceStep[],
        initialValues: Record<string, string>,
        priorResults: Record<number, StepResult>,
        rowIndex?: number,
      ): Promise<{
        counters: { executed: number; skipped: number; failed: number }
        resultsBySequence: Record<number, StepResult>
        captured: Record<string, string>
        aborted: boolean
      }> => {
        // Conditions inside a row-subset run may reference setup-phase steps
        // that live outside the list — preserve those references as-is.
        const substeps = Object.keys(priorResults).length > 0 ? seq : repairStepConditions(seq)
        const localResults: Record<number, StepResult> = { ...priorResults }
        const localCounters = { executed: 0, skipped: 0, failed: 0 }
        const localValues: Record<string, string> = { ...initialValues }
        let localAborted = false

        for (const step of substeps) {
          if (abortRef.current) {
            localAborted = true
            break
          }
          const startedAt = Date.now()
          appendEntry({
            sequence: step.sequence,
            action: step.action,
            label: stepLabel(step),
            status: 'running',
            row: rowIndex,
            step,
          })

          if (step.condition) {
            const { run, reason } = evaluateCondition(step.condition, localResults)
            if (!run) {
              localCounters.skipped += 1
              const entryPatch: Partial<RunEntry> = {
                status: 'skipped',
                message: reason,
                durationMs: Date.now() - startedAt,
              }
              updateEntry(step.sequence, entryPatch, rowIndex)
              await logRunStep({
                runId,
                userId: user.id,
                step,
                status: 'skipped',
                skipReason: reason,
                durationMs: Date.now() - startedAt,
              })
              if (step.condition.on_false === 'abort') {
                localAborted = true
                break
              }
              continue
            }
          }

          const resolvedStep: SequenceStep = {
            ...step,
            xpath: resolveSelectorReferences(
              resolveTemplatePlaceholders(step.xpath ?? '', localValues),
              localValues,
            ),
            default_value:
              step.default_value === undefined
                ? undefined
                : resolveTemplatePlaceholders(step.default_value, localValues),
          }

          let result: StepResult
          try {
            result = await withTimeout(
              executeOne(activeTabId, resolvedStep),
              90000,
              actionLabel(step.action),
            )
          } catch (e) {
            result = { status: 'error', message: e instanceof Error ? e.message : String(e) }
          }

          localResults[step.sequence] = result

          if (result.status === 'success') {
            localCounters.executed += 1
            if (result.value !== undefined && GETTER_ACTIONS.has(step.action)) {
              const key = step.element_name ?? String(step.sequence)
              localValues[key] = result.value
              localValues[`{{${key}}}`] = result.value
            }
            if (NAVIGATION_ACTIONS.has(step.action)) {
              await waitForPageReady(activeTabId, 15000)
            }
            const patch: Partial<RunEntry> = {
              status: 'success',
              message: result.message,
              value: result.value,
              durationMs: Date.now() - startedAt,
            }
            updateEntry(step.sequence, patch, rowIndex)
          } else if (result.status === 'skipped') {
            localCounters.skipped += 1
            updateEntry(
              step.sequence,
              {
                status: 'skipped',
                message: result.message,
                durationMs: Date.now() - startedAt,
              },
              rowIndex,
            )
          } else {
            localCounters.failed += 1
            updateEntry(
              step.sequence,
              {
                status: 'error',
                message: result.message,
                durationMs: Date.now() - startedAt,
              },
              rowIndex,
            )
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
        }

        return {
          counters: localCounters,
          resultsBySequence: localResults,
          captured: localValues,
          aborted: localAborted,
        }
      }

      if (batchActive) {
        // Setup phase runs once; its results seed conditions for every row.
        const setupRun = await runSubSequence(
          setupSteps,
          buildValues(undefined),
          {},
          undefined,
        )
        counters.executed += setupRun.counters.executed
        counters.skipped += setupRun.counters.skipped
        counters.failed += setupRun.counters.failed
        if (setupRun.aborted) {
          aborted = true
        } else {
          // Setup-phase get_* captures seed every row's value map.
          for (let i = 0; i < dataFile!.rows.length; i++) {
            if (abortRef.current) {
              aborted = true
              break
            }
            const rowRun = await runSubSequence(
              rowSteps,
              { ...setupRun.captured, ...buildValues(dataFile!.rows[i]) },
              setupRun.resultsBySequence,
              i,
            )
            counters.executed += rowRun.counters.executed
            counters.skipped += rowRun.counters.skipped
            counters.failed += rowRun.counters.failed
            if (rowRun.aborted) {
              aborted = true
              break
            }
          }
        }
      } else {
        const seqRun = await runSubSequence(steps, baseValues, {}, undefined)
        counters.executed = seqRun.counters.executed
        counters.skipped = seqRun.counters.skipped
        counters.failed = seqRun.counters.failed
        aborted = seqRun.aborted
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
  }, [runToken, steps, recipe, variables, promptKeys, tokens, dataFile, user.id, appendEntry, updateEntry])

  const doneCount = entries.filter((e) => e.status !== 'pending' && e.status !== 'running').length
  const running = phase === 'running'

  if (runToken === 0) {
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
            {dataFile
              ? `Data file: ${dataFile.name} — sheet "${dataFile.selected}" (${dataFile.rows.length} rows) — ${
                  batchActive
                    ? 'batch run: setup steps run once, then row steps per row.'
                    : 'token values resolve from row 1.'
                }`
              : promptKeys.length > 0
                ? `This recipe needs ${promptKeys.length} value${promptKeys.length > 1 ? 's' : ''} before it can run.`
                : 'Ready to run — data-column and static tokens resolve automatically.'}
          </p>
          <div className="toolbar">
            <button
              type="button"
              className="button small"
              onClick={() => fileInputRef.current?.click()}
            >
              {dataFile ? 'Replace data file…' : 'Load data file (optional)'}
            </button>
            {dataFile && (
              <>
                <select
                  className="select"
                  value={dataFile.selected}
                  onChange={(e) => selectSheet(e.target.value)}
                  aria-label="Data file worksheet"
                >
                  {dataFile.sheets.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <button type="button" className="button small" onClick={removeDataFile}>
                  Remove
                </button>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xlsm,.xls,.xlsb,.csv"
              style={{ display: 'none' }}
              onChange={(e) => {
                void handleDataFile(e.target.files)
                e.target.value = ''
              }}
            />
          </div>
          {referencedColumns.size > 0 && !dataFile && (
            <p className="muted small">
              Recipe references data columns ({[...referencedColumns].slice(0, 3).join(', ')}
              {referencedColumns.size > 3 ? ', …' : ''}) — load a data file or the placeholders
              stay literal.
            </p>
          )}
          {dataFile && resolutionInfo && (
            <p className="muted small">
              {resolutionInfo.missing.length > 0 ? (
                <>
                  Not resolvable from "{dataFile.selected}":{' '}
                  {resolutionInfo.missing.slice(0, 5).join(', ')}
                  {resolutionInfo.missing.length > 5 ? ', …' : ''}. Available columns:{' '}
                  {dataFile.columns.slice(0, 5).join(', ')}
                  {dataFile.columns.length > 5 ? ', …' : ''}.
                </>
              ) : (
                'All referenced values resolve from the data file.'
              )}
            </p>
          )}
          {fatalError && <p className="error">{fatalError}</p>}
        </div>

        {promptKeys.length > 0 && (
          <div className="card">
            <div className="card-title">Values needed</div>
            <div className="stack">
              {promptKeys.map((key) => (
                <label key={key} className="field">
                  <span className="step-title">
                    {key}
                    {sensitiveNames.has(key) && (
                      <span className="badge badge-sensitive">sensitive</span>
                    )}
                  </span>
                  <input
                    type={sensitiveNames.has(key) ? 'password' : 'text'}
                    value={variables[key] ?? ''}
                    onChange={(e) => {
                      prefilledRef.current.delete(key)
                      setVariables((prev) => ({ ...prev, [key]: e.target.value }))
                    }}
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
              <button
                type="button"
                className="button primary"
                onClick={startRun}
                disabled={!tokensLoaded}
              >
                Start run
              </button>
              <button type="button" className="button" onClick={onBack}>
                Cancel
              </button>
            </div>
          </div>
        )}
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
          {running && `Running ${doneCount}/${projectedTotalSteps}…`}
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
        {entries.map((entry, idx) => {
          const prevRow = idx > 0 ? entries[idx - 1].row : undefined
          const showDivider = entry.row !== undefined && dataFile && entry.row !== prevRow
          const testState = stepTest && stepTest.key === String(idx) ? stepTest : null
          return (
            <Fragment key={`${entry.sequence}-${entry.action}-${entry.row ?? 's'}-${idx}`}>
              {showDivider && (
                <div className="row-divider">
                  Row {entry.row! + 1} / {dataFile.rows.length}
                </div>
              )}
              <RunRow
                entry={entry}
                onTest={entry.step ? () => void runEntryTest(idx) : undefined}
                testing={testState?.running === true || running}
                testResult={testState?.result}
                testUrl={testState?.url}
              />
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

function RunRow({
  entry,
  onTest,
  testing,
  testResult,
  testUrl,
}: {
  entry: RunEntry
  onTest?: () => void
  testing?: boolean
  testResult?: StepResult
  testUrl?: string
}) {
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
        {testResult && (
          <div className={`test-result ${testResult.status === 'success' ? 'ok' : 'err'}`}>
            <span>{testResult.status === 'success' ? '✓' : '✗'}</span> Test:{' '}
            {testResult.message || testResult.status}
            {testResult.status === 'error' && /not found/i.test(testResult.message ?? '') && (
              <span> — if this element lives in an iframe, set the step's iFrame Selector.</span>
            )}
            {testUrl && <div className="muted-url">{testUrl}</div>}
          </div>
        )}
      </div>
      {onTest && (
        <button
          type="button"
          className="button small step-test-btn"
          onClick={onTest}
          disabled={testing}
          title="Run this step on the active tab"
        >
          {testing ? '…' : '▶ Test'}
        </button>
      )}
    </div>
  )
}