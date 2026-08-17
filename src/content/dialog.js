// Page-world dialog shim (declared as content_scripts entry with world: "MAIN").
// Hooks window.alert/confirm/prompt so automation can auto-respond to JS
// dialogs without chrome.debugger (which shows an intrusive banner).
//
// Protocol via window.postMessage, tag "__revj_dialog__":
//   content script → page: { tag, type: "arm", accept: boolean, text: string|null }
//   page → content script: { tag, type: "armed" } | { tag, type: "handled"|"handled-auto", ... }
//
// Semantics mirror Playwright: an armed accept/dismiss step responds to the
// NEXT dialog call; un-armed dialogs are auto-dismissed (Playwright default).
;(() => {
  const TAG = '__revj_dialog__'
  let armed = null

  const post = (payload) => {
    try {
      window.postMessage({ tag: TAG, ...payload }, '*')
    } catch {
      // Ignore — the content script may be gone (navigation).
    }
  }

  window.addEventListener('message', (event) => {
    const d = event && event.data
    if (!d || d.tag !== TAG) return
    if (d.type === 'arm') {
      armed = { accept: !!d.accept, text: typeof d.text === 'string' ? d.text : null }
      post({ type: 'armed', accept: armed.accept, text: armed.text })
    }
  })

  function handle(type, message) {
    if (armed) {
      const { accept, text } = armed
      armed = null
      post({ type: 'handled', dialogType: type, message: String(message), accept, text })
      if (type === 'alert') return undefined
      if (type === 'confirm') return accept
      return accept ? text : null
    }
    post({ type: 'handled-auto', dialogType: type, message: String(message), accept: false })
    if (type === 'alert') return undefined
    if (type === 'confirm') return false
    return null
  }

  if (!window.__revjDialogInstalled) {
    window.__revjDialogInstalled = true
    window.alert = (message) => handle('alert', message)
    window.confirm = (message) => handle('confirm', message)
    window.prompt = (message, defaultValue) =>
      handle('prompt', message || defaultValue || '')
  }

  post({ type: 'ready' })
})()