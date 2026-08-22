import type { SequenceStep } from '../shared/recipes'
import type { StepResult } from '../shared/exec'
import { findElement } from './find'

const MSG_TAG = '__revj_exec__'
const TIMEOUT_MS = 30000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Iframes are often created lazily (after a click/navigation) — locate them
 *  with the same retry loop as elements, budgeted by the step's wait_time. */
async function waitForIframe(
  selector: string,
  timeoutMs: number,
): Promise<HTMLIFrameElement | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const el = findElement(selector)
    if (el instanceof HTMLIFrameElement && el.contentWindow) return el
    if (Date.now() >= deadline) return null
    await sleep(250)
  }
}

/**
 * Iframe steps are routed from the parent frame's content script to the child
 * frame's content script via window.postMessage (cross-origin safe). Both
 * frames run the extension content script (manifest: all_frames), and content
 * scripts share DOM event dispatch with the page, so each side sees the other's
 * postMessage.
 */

export function routeIframeStep(
  step: SequenceStep,
  values: Record<string, string>,
): Promise<StepResult> {
  return new Promise((resolve) => {
    void (async () => {
      if (!step.iframe) {
        resolve({ status: 'error', message: 'No iframe selector provided.' })
        return
      }
      const iframeTimeoutMs = (step.wait_time ? Math.max(1, step.wait_time) : 10) * 1000
      const iframeEl = await waitForIframe(step.iframe, iframeTimeoutMs)
      if (!(iframeEl instanceof HTMLIFrameElement) || !iframeEl.contentWindow) {
        resolve({ status: 'error', message: `Iframe not found: ${step.iframe}` })
        return
      }
      const childWindow = iframeEl.contentWindow

      const onMessage = (event: MessageEvent) => {
        if (event.source !== childWindow) return
        const data = event.data as { tag?: string; type?: string; result?: StepResult } | null
        if (data?.tag !== MSG_TAG || data.type !== 'result') return
        window.removeEventListener('message', onMessage)
        clearTimeout(timer)
        resolve(data.result ?? { status: 'error', message: 'Iframe returned no result.' })
      }

      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage)
        resolve({
          status: 'error',
          message: 'Iframe step timed out waiting for the frame to respond.',
        })
      }, TIMEOUT_MS)

      window.addEventListener('message', onMessage)
      childWindow.postMessage(
        { tag: MSG_TAG, type: 'step', step: { ...step, iframe: undefined }, values },
        '*',
      )
    })()
  })
}

/** Runs in every frame; only child frames (source === window.parent) act. */
export function registerIframeChild(
  execute: (step: SequenceStep) => Promise<StepResult>,
): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return
    const data = event.data as { tag?: string; type?: string; step?: SequenceStep } | null
    if (data?.tag !== MSG_TAG || data.type !== 'step' || !data.step) return
    void execute(data.step).then((result) => {
      window.parent.postMessage({ tag: MSG_TAG, type: 'result', result }, '*')
    })
  })
}
