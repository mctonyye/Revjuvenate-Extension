import type { StepResult } from '../shared/exec'

const DIALOG_TAG = '__revj_dialog__'
const DIALOG_TIMEOUT_MS = 5000

interface DialogMessage {
  tag?: string
  type?: string
  accept?: boolean
  text?: string | null
}

/** Arms the page-world dialog shim so the next alert/confirm/prompt call is
 *  auto-answered (accepted or dismissed). Mirrors Playwright's dialog handler. */
export function armDialog(accept: boolean, text: string | null): Promise<StepResult> {
  return new Promise((resolve) => {
    function onMessage(event: MessageEvent) {
      const d = event.data as DialogMessage | null
      if (!d || d.tag !== DIALOG_TAG || d.type !== 'armed') return
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve({
        status: 'success',
        message: accept
          ? `Dialog will be accepted${text ? ` with text "${text}"` : ''} when it appears.`
          : 'Dialog will be dismissed when it appears.',
      })
    }

    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      resolve({
        status: 'error',
        message: 'Dialog shim did not respond — it may be blocked on this page.',
      })
    }, DIALOG_TIMEOUT_MS)

    window.addEventListener('message', onMessage)
    window.postMessage({ tag: DIALOG_TAG, type: 'arm', accept, text }, '*')
  })
}