// Step-execution plumbing shared by the recipe run loop and the per-step test
// mode. All `chrome.tabs` / content-script messaging for executing a step on a
// page lives here so RunView and the ▶ Test buttons behave identically.

import type { SequenceStep } from '../shared/recipes'
import type { StepResult } from '../shared/exec'
import {
  resolveSelectorReferences,
  resolveTemplatePlaceholders,
} from '../shared/run'

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

export async function pingTab(tabId: number): Promise<boolean> {
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

export async function waitForPageReady(tabId: number, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pingTab(tabId)) return true
    await sleep(400)
  }
  return false
}

/** Reloading the extension strips content scripts from OPEN tabs; Chrome only
 *  re-injects them on a fresh page load. Self-heal: ping → reload once (http(s)
 *  pages only) → ping again. */
export async function ensureTabReady(tabId: number, timeoutMs = 30000): Promise<boolean> {
  if (await waitForPageReady(tabId, timeoutMs)) return true
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.url && /^https?:\/\//i.test(tab.url)) {
      await chrome.tabs.reload(tabId)
    }
  } catch {
    // tab may have closed meanwhile - fall through
  }
  return waitForPageReady(tabId, timeoutMs)
}

/** Sends that mean a navigation destroyed the frame's content script.
 *  Retry semantics: wait for the new page's content script (budgeted by the
 *  step's wait_time) then retry. */
const SEND_ERROR_RE =
  /receiving end does not exist|could not establish connection|port closed|message channel closed/i

export async function sendStepToContent(tabId: number, step: SequenceStep): Promise<StepResult> {
  const waitBudgetMs = Math.max(5, step.wait_time || 10) * 1000
  const attempts = 3
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = (await chrome.tabs.sendMessage(
        tabId,
        { type: 'exec:step', step, values: {} },
        { frameId: 0 },
      )) as StepResult
      if (res && typeof res === 'object' && res.status) return res
      return { status: 'error', message: 'The page did not respond to the step.' }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (!SEND_ERROR_RE.test(message) || attempt === attempts - 1) {
        if (attempt === attempts - 1 && SEND_ERROR_RE.test(message)) {
          return {
            status: 'error',
            message:
              'The page navigated repeatedly while this step ran (3 retries). Add a "wait until page ready" / "wait" step before this one, or retry after the page loads.',
          }
        }
        return { status: 'error', message }
      }
      const ready = await waitForPageReady(tabId, waitBudgetMs)
      if (!ready) {
        return {
          status: 'error',
          message: 'The page did not become reachable (content script did not load in time).',
        }
      }
    }
  }
  return { status: 'error', message: 'The page did not respond to the step.' }
}

export function resolveTarget(targetUrl: string | null | undefined): string | null {
  if (!targetUrl) return null
  const trimmed = targetUrl.trim()
  if (!trimmed) return null
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`
  return trimmed
}

export function matchesUrl(current: string, target: string): boolean {
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

export async function executeOne(tabId: number, step: SequenceStep): Promise<StepResult> {
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
      if (!value) return { status: 'error', message: 'wait_for_url requires a URL pattern.' }
      const timeoutMs = Math.max(1, step.wait_time ?? 10) * 1000
      const deadline = Date.now() + timeoutMs
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
      const seconds = Math.min(Math.max(parseFloat(value) || 3, 0), 30)
      await sleep(seconds * 1000)
      return { status: 'success' }
    }
    case 'wait_until_page_ready': {
      // Mirrors the backend: wait for network idle, fall back to 'load', and
      // never fail the step on timeout. The timeout derives from the step's
      // wait_time (locator timeout), like the backend's wait_time * 1000.
      const timeoutSec = Math.max(1, step.wait_time || parseFloat(value) || 10)
      const deadline = Date.now() + timeoutSec * 1000
      let lastResourceCount: number | null = null
      let quietPolls = 0
      for (;;) {
        let state: { readyState: string; resourceCount: number | null } | null = null
        try {
          const res = (await chrome.tabs.sendMessage(
            tabId,
            { type: 'exec:page-state' },
            { frameId: 0 },
          )) as { readyState?: string; resourceCount?: number } | undefined
          if (res && typeof res.readyState === 'string') {
            state = { readyState: res.readyState, resourceCount: res.resourceCount ?? null }
          }
        } catch {
          state = null
        }
        const tab = await chrome.tabs.get(tabId)
        const loaded = tab.status === 'complete' && (!state || state.readyState === 'complete')
        if (loaded) {
          if (state && state.resourceCount !== null) {
            if (lastResourceCount !== null && state.resourceCount === lastResourceCount) {
              quietPolls += 1
              if (quietPolls >= 3) return { status: 'success' }
            } else {
              quietPolls = 0
              lastResourceCount = state.resourceCount
            }
          } else {
            return { status: 'success' }
          }
        }
        if (Date.now() >= deadline) return { status: 'success' }
        await sleep(400)
      }
    }
    case 'screenshot': {
      const tab = await chrome.tabs.get(tabId)
      const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId })
      if (active?.id !== tabId) {
        return {
          status: 'error',
          message: 'Run tab is not active — switch to it to capture a screenshot.',
        }
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
      return sendStepToContent(tabId, step)
    }
  }
}

export interface TestRunResult {
  result: StepResult
  /** Tab URL at the moment the test finished (for diagnostics). */
  url: string
}

/** Test mode: run ONE step on the currently active tab (self-healing the tab
 *  if the extension was reloaded). Placeholders resolve from the recipe's
 *  static replace_map only; anything else stays literal so you can see exactly
 *  what is being queried. */
export async function testStepOnActiveTab(
  step: SequenceStep,
  replaceMap: Record<string, string>,
): Promise<TestRunResult> {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!active?.id) {
    return {
      result: { status: 'error', message: 'No active tab to test on — open the target page first.' },
      url: '',
    }
  }
  const tabId = active.id
  if (!(await ensureTabReady(tabId, 20000))) {
    try {
      const tab = await chrome.tabs.get(tabId)
      return {
        result: {
          status: 'error',
          message: 'The page did not become ready. Make sure the tab is a regular http(s) page.',
        },
        url: tab.url ?? '',
      }
    } catch {
      return {
        result: {
          status: 'error',
          message: 'The page did not become ready. Make sure the tab is a regular http(s) page.',
        },
        url: '',
      }
    }
  }
  const resolvedStep: SequenceStep = {
    ...step,
    xpath: resolveSelectorReferences(
      resolveTemplatePlaceholders(step.xpath ?? '', replaceMap),
      replaceMap,
    ),
    default_value:
      step.default_value === undefined
        ? undefined
        : resolveTemplatePlaceholders(step.default_value, replaceMap),
  }
  const result = await executeOne(tabId, resolvedStep)
  let url = ''
  try {
    const tab = await chrome.tabs.get(tabId)
    url = tab.url ?? ''
  } catch {
    // tab closed mid-test — url stays empty
  }
  return { result, url }
}
