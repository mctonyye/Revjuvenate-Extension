import type { ContentMessage, StepResult } from '../shared/exec'
import type { SequenceStep } from '../shared/recipes'
import { executeStep } from './executor'
import { registerIframeChild, routeIframeStep } from './iframe'

registerIframeChild(executeStep)

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const msg = message as ContentMessage

  if (msg?.type === 'exec:ping') {
    sendResponse({ ok: true, pong: true })
    return false
  }

  if (msg?.type === 'exec:page-state') {
    sendResponse({
      readyState: document.readyState,
      resourceCount: performance.getEntriesByType('resource').length,
    })
    return false
  }

  if (msg?.type === 'exec:step') {
    void (async () => {
      const step: SequenceStep = msg.step
      const result: StepResult = step.iframe
        ? await routeIframeStep(step, msg.values)
        : await executeStep(step)
      sendResponse(result)
    })()
    return true
  }

  return false
})
