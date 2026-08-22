import type { SequenceStep } from '../shared/recipes'
import type { StepResult } from '../shared/exec'
import { findElement, findElements, isEnabled, isVisible } from './find'
import { armDialog } from './dialogHost'

/** Actions that must target a visible element (mirrors the backend's
 *  wait_state="visible" set; js_click and upload_file stay "attached"). */
const VISIBLE_ACTIONS = new Set([
  'click',
  'click_navigate',
  'double_click',
  'hover',
  'hover_with_offset',
  'input',
  'type',
  'type_slowly',
  'clear',
  'select',
  'custom_select',
  'select_from_list',
  'double_click_from_list',
  'multi_check_uncheck_from_checkboxes',
  'list_activate_deactivate',
  'input_activate_deactivate',
  'custom_check_uncheck_daylight',
  'check_uncheck',
  'press_key',
  'drag_and_drop',
  'replace_click',
  'scroll_to_element',
  'get_text',
  'get_attribute',
  'get_n_keep_values',
  'get_n_keep_values1',
  'get_n_keep_ids',
])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForElement(
  xpath: string,
  timeoutMs: number,
  requireVisible = false,
  requireEnabled = false,
): Promise<Element | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const el = findElement(xpath)
    if (
      el &&
      (!requireVisible || isVisible(el)) &&
      (!requireEnabled || isEnabled(el))
    ) {
      return el
    }
    if (Date.now() >= deadline) return null
    await sleep(250)
  }
}

async function waitForElements(
  xpath: string,
  timeoutMs: number,
  requireVisible = false,
): Promise<Element[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const els = findElements(xpath)
    const ready = !requireVisible ? els.length > 0 : els.some((el) => isVisible(el))
    if (ready) return els
    if (Date.now() >= deadline) return []
    await sleep(250)
  }
}

function ok(message?: string, value?: string): StepResult {
  return { status: 'success', message, value }
}

function err(message: string): StepResult {
  return { status: 'error', message }
}

function elementError(xpath: string): StepResult {
  return err(`Element not found: ${xpath}`)
}

/** Sets a value on React/SPA-controlled inputs without breaking their internal state. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
}

function setElementValue(el: Element, value: string): void {
  if (el instanceof HTMLElement && el.isContentEditable) {
    el.textContent = value
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
    return
  }
  const input = el as HTMLInputElement
  setNativeValue(input, value)
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function clickElement(el: Element): void {
  if (el instanceof HTMLElement) el.scrollIntoView({ block: 'center', inline: 'nearest' })
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
  // el.click() runs the full event pipeline AND the browser's default actions
  // (anchor navigation, submit buttons, checkbox toggles) — a dispatched
  // MouseEvent alone triggers handlers but skips defaults.
  ;(el as HTMLElement).click()
}

/** Nearest real anchor from the click target — the clicked element is often a
 *  span/text node inside <a>, whose default navigation only fires for a real
 *  anchor click. */
function anchorTarget(el: Element): HTMLAnchorElement | null {
  const a = el instanceof HTMLAnchorElement ? el : (el.closest('a[href]') as HTMLAnchorElement | null)
  return a && a.href ? a : null
}

/** Elements clicked via an upgradeable anchor: after a click, JavaScript-initiated
 *  navigation (router.push / history.pushState / location.href) should settle. */
const CLICK_ENABLED_ACTIONS = new Set([
  'click',
  'click_navigate',
  'js_click',
  'double_click',
  'replace_click',
])

const KEY_MAP: Record<string, { key: string; code: string }> = {
  Enter: { key: 'Enter', code: 'Enter' },
  Tab: { key: 'Tab', code: 'Tab' },
  Escape: { key: 'Escape', code: 'Escape' },
  Esc: { key: 'Escape', code: 'Escape' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp' },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft' },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight' },
  Backspace: { key: 'Backspace', code: 'Backspace' },
  Delete: { key: 'Delete', code: 'Delete' },
  Home: { key: 'Home', code: 'Home' },
  End: { key: 'End', code: 'End' },
  PageUp: { key: 'PageUp', code: 'PageUp' },
  PageDown: { key: 'PageDown', code: 'PageDown' },
  Space: { key: ' ', code: 'Space' },
}

export async function executeAction(step: SequenceStep): Promise<StepResult> {
  const action = step.action
  const xpath = step.xpath ?? ''
  const value = step.default_value ?? ''
  // Legacy wait_time is the locator-lookup timeout in seconds (default 10s);
  // interactive actions additionally require the element to be visible.
  const elementWaitMs = (step.wait_time ? Math.max(1, step.wait_time) : 10) * 1000
  const requireVisible = VISIBLE_ACTIONS.has(action)
  const requireEnabled = CLICK_ENABLED_ACTIONS.has(action)

  switch (action) {
    case 'click': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible, requireEnabled)
      if (!el) return elementError(xpath)
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        el.click()
        return ok()
      }
      clickElement(el)
      const anchor = anchorTarget(el)
      if (anchor) {
        // Synthetic clicks can skip the anchor's default navigation; fall back
        // to explicit navigation when the URL did not change.
        const before = location.href
        await sleep(300)
        if (location.href === before) location.href = anchor.href
      }
      return ok()
    }
    case 'js_click': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible, requireEnabled)
      if (!el) return elementError(xpath)
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        el.checked = !el.checked
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
      ;(el as HTMLElement).click()
      const anchor = anchorTarget(el)
      if (anchor && anchor.href) {
        const before = location.href
        await sleep(300)
        if (location.href === before) location.href = anchor.href
      }
      return ok()
    }
    case 'click_navigate': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible, requireEnabled)
      if (!el) return elementError(xpath)
      clickElement(el)
      const anchor = anchorTarget(el)
      if (anchor) {
        // Synthetic clicks can skip the anchor's default navigation; navigate explicitly.
        const before = location.href
        setTimeout(() => {
          if (location.href === before) location.href = anchor.href!
        }, 0)
      }
      return ok()
    }
    case 'replace_click': {
      const resolvedXpath = xpath.replaceAll('REPLACE_VALUE', value)
      const el = await waitForElement(
        resolvedXpath,
        elementWaitMs,
        requireVisible,
        requireEnabled,
      )
      if (!el) return elementError(resolvedXpath)
      clickElement(el)
      const editable =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      if (editable && value) setElementValue(el, value)
      return ok()
    }
    case 'double_click': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible, requireEnabled)
      if (!el) return elementError(xpath)
      if (el instanceof HTMLElement) el.scrollIntoView({ block: 'center', inline: 'nearest' })
      clickElement(el)
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      return ok()
    }
    case 'hover':
    case 'hover_with_offset': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible)
      if (!el) return elementError(xpath)
      let clientX: number | undefined
      let clientY: number | undefined
      if (action === 'hover_with_offset' && value && value.includes(',')) {
        const [xOff, yOff] = value.split(',').map((p) => parseFloat(p.trim()))
        if (Number.isFinite(xOff) && Number.isFinite(yOff)) {
          const rect = el.getBoundingClientRect()
          clientX = rect.left + Math.min(Math.max(xOff, 0), rect.width)
          clientY = rect.top + Math.min(Math.max(yOff, 0), rect.height)
        }
      }
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }))
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
      el.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          cancelable: true,
          ...(clientX !== undefined && { clientX, clientY }),
        }),
      )
      return ok()
    }
    case 'input':
    case 'type': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible)
      if (!el) return elementError(xpath)
      setElementValue(el, value)
      return ok()
    }
    case 'type_slowly': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible)
      if (!el) return elementError(xpath)
      setNativeValue(el as HTMLInputElement, '')
      for (const ch of value) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }))
        const input = el as HTMLInputElement
        setNativeValue(input, input.value + ch)
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }))
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }))
        await sleep(25)
      }
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return ok()
    }
    case 'clear': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible)
      if (!el) return elementError(xpath)
      setElementValue(el, '')
      return ok()
    }
    case 'select': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible)
      if (!el) return elementError(xpath)
      if (el instanceof HTMLSelectElement) {
        const opt = [...el.options].find(
          (o) => o.value === value || o.text.trim() === value || o.textContent?.trim() === value,
        )
        el.value = opt ? opt.value : value
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return ok()
      }
      return err(`Element is not a <select>: ${xpath}`)
    }
    case 'custom_select': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible)
      if (!el) return elementError(xpath)
      if (el instanceof HTMLSelectElement) {
        const opt = [...el.options].find((o) =>
          o.textContent?.trim().toLowerCase().includes(value.toLowerCase()),
        )
        if (!opt) return err(`Option not found: ${value}`)
        el.value = opt.value
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return ok()
      }
      const candidates = findElements(`${xpath}//*[normalize-space(text())="${value}"]`).concat(
        findElements(`${xpath}//*[@data-value="${value}"]`),
      )
      const target = candidates[0]
      if (target) {
        clickElement(target)
        return ok()
      }
      return err(`Option not found for custom select: ${value}`)
    }
    case 'select_from_list': {
      const els = await waitForElements(xpath, elementWaitMs, true)
      if (els.length === 0) return elementError(xpath)
      const needle = value.toLowerCase()
      for (const item of els) {
        const text = (item.textContent ?? '').trim()
        if (text.toLowerCase().includes(needle)) {
          if (item instanceof HTMLElement) item.scrollIntoView({ block: 'center' })
          clickElement(item)
          return ok(undefined, text)
        }
      }
      return err(`'${value}' not found in list`)
    }
    case 'double_click_from_list': {
      const els = await waitForElements(xpath, elementWaitMs, true)
      if (els.length === 0) return elementError(xpath)
      const needles = value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)
      const matched: string[] = []
      for (const item of els) {
        const text = (item.textContent ?? '').trim()
        if (needles.some((n) => text.toLowerCase().includes(n))) {
          if (item instanceof HTMLElement) item.scrollIntoView({ block: 'center' })
          clickElement(item)
          item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
          item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
          matched.push(text)
        }
      }
      return matched.length > 0 ? ok(undefined, matched.join(', ')) : err(`No list item matched '${value}'`)
    }
    case 'multi_check_uncheck_from_checkboxes': {
      const els = await waitForElements(xpath, elementWaitMs, true)
      if (els.length === 0) return elementError(xpath)
      const needles = value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)
      const matched: string[] = []
      for (const el of els) {
        const text = (el.textContent ?? '').trim()
        const shouldBeChecked = needles.some((n) => text.toLowerCase().includes(n))
        const isChecked =
          (el instanceof HTMLInputElement && el.checked) ||
          el.hasAttribute('checked') ||
          el.getAttribute('aria-checked') === 'true'
        if (shouldBeChecked !== isChecked) {
          clickElement(el)
          matched.push(`${shouldBeChecked ? 'checked' : 'unchecked'}: ${text}`)
        }
      }
      return ok(undefined, matched.join('\n'))
    }
    case 'list_activate_deactivate':
    case 'input_activate_deactivate':
    case 'custom_check_uncheck_daylight': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible)
      if (!el) return elementError(xpath)
      const target = Boolean(value && !/^(false|0|none)$/i.test(value.trim()))
      const isChecked =
        el.hasAttribute('checked') || el.getAttribute('aria-checked') === 'true'
      const isActive = (el.getAttribute('class') ?? '').includes('selected')
      const active =
        action === 'list_activate_deactivate' ? isActive : isChecked
      if (target !== active) clickElement(el)
      return ok()
    }
    case 'check_uncheck': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible)
      if (!el) return elementError(xpath)
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        const desired = /^(true|1|yes|checked|on)$/i.test(value)
        if (el.checked !== desired) el.click()
        return ok()
      }
      clickElement(el)
      return ok()
    }
    case 'press_key': {
      const el = xpath ? await waitForElement(xpath, elementWaitMs, requireVisible) : null
      if (xpath && !el) return elementError(xpath)
      if (el instanceof HTMLElement) el.focus()
      const target = (el ?? document.activeElement ?? document.body) as Element
      const combo = (value || 'Enter').trim()
      const parts = combo.split('+').map((p) => p.trim())
      const keyName = parts[parts.length - 1]
      const mapped = KEY_MAP[keyName] ?? { key: keyName, code: '' }
      const init: KeyboardEventInit = {
        key: mapped.key,
        code: mapped.code,
        bubbles: true,
        cancelable: true,
        ctrlKey: parts.some((p) => /^ctrl$/i.test(p)),
        shiftKey: parts.some((p) => /^shift$/i.test(p)),
        altKey: parts.some((p) => /^alt$/i.test(p)),
        metaKey: parts.some((p) => /^(meta|cmd|win)$/i.test(p)),
      }
      target.dispatchEvent(new KeyboardEvent('keydown', init))
      target.dispatchEvent(new KeyboardEvent('keypress', init))
      target.dispatchEvent(new KeyboardEvent('keyup', init))
      return ok()
    }
    case 'drag_and_drop': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible)
      if (!el) return elementError(xpath)
      let target: Element | null = null
      if (value) {
        try {
          target = findElement(value)
        } catch {
          target = null
        }
      }
      const dataTransfer = new DataTransfer()
      el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
      el.dispatchEvent(new DragEvent('drag', { bubbles: true, cancelable: true, dataTransfer }))
      const dropTarget = target ?? document.body
      dropTarget.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }))
      dropTarget.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
      dropTarget.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
      el.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }))
      return ok()
    }
    case 'upload_file': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible)
      if (!el) return elementError(xpath)
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
        return err('upload_file requires an <input type="file"> element')
      }
      const input: HTMLInputElement = el
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          input.removeEventListener('change', onChange)
          resolve({
            status: 'error',
            message:
              'Timed out waiting for a file selection (30s). Browser extensions cannot set file inputs programmatically — pick the file in the dialog that opened.',
          })
        }, 30000)
        function onChange() {
          clearTimeout(timeout)
          input.removeEventListener('change', onChange)
          const count = input.files?.length ?? 0
          resolve({
            status: 'success',
            message:
              count > 0 ? `${count} file(s) selected.` : 'No file selected — continuing.',
          })
        }
        input.addEventListener('change', onChange)
        try {
          input.click()
        } catch {
          clearTimeout(timeout)
          input.removeEventListener('change', onChange)
          resolve({
            status: 'error',
            message: 'File picker could not be opened from the extension — select the file manually, then retry.',
          })
        }
      })
    }
    case 'loop': {
      return ok(value ? `Loop marker — repeats ${value}×.` : 'Loop marker (control step).')
    }
    case 'accept_dialog':
    case 'dismiss_dialog': {
      const accept = action === 'accept_dialog'
      return armDialog(accept, accept ? value || null : null)
    }
    case 'get_text': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible)
      if (!el) return elementError(xpath)
      const text = (el instanceof HTMLElement ? el.innerText : el.textContent ?? '').trim()
      return ok(undefined, text)
    }
    case 'get_attribute': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible)
      if (!el) return elementError(xpath)
      const attr = value || 'href'
      const val =
        el.getAttribute(attr) ??
        ((el as unknown as Record<string, unknown>)[attr] as string | undefined) ??
        ''
      return ok(undefined, val)
    }
    case 'get_url': {
      return ok(undefined, location.href)
    }
    case 'get_n_keep_values': {
      const els = await waitForElements(xpath, elementWaitMs, true)
      const texts = els
        .map((el) => (el.textContent ?? '').trim())
        .filter((t) => t.length > 0)
      return ok(undefined, texts.join('\n'))
    }
    case 'get_n_keep_values1': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible)
      if (!el) return elementError(xpath)
      return ok(undefined, (el.textContent ?? '').trim())
    }
    case 'get_n_keep_ids': {
      const els = await waitForElements(xpath, elementWaitMs, true)
      const ids = els
        .map((el) => el.getAttribute('id') || el.getAttribute('data-id') || '')
        .filter((id) => id.length > 0)
      return ok(undefined, ids.join('\n'))
    }
    case 'check_exists': {
      return ok(undefined, findElement(xpath) ? 'true' : 'false')
    }
    case 'check_visible': {
      const el = findElement(xpath)
      return ok(undefined, el ? String(isVisible(el)) : 'false')
    }
    case 'wait_until_element_ready': {
      const timeoutSec = Math.max(1, parseFloat(value) || step.wait_time || 10)
      const timeoutMs = timeoutSec * 1000
      const deadline = Date.now() + timeoutMs
      const el = await waitForElement(xpath, timeoutMs, true)
      if (!el) return elementError(xpath)
      while (Date.now() < deadline) {
        if (isEnabled(el)) return ok(undefined, 'true')
        await sleep(100)
      }
      return err(`Element did not become enabled within ${timeoutSec}s: ${xpath}`)
    }
    case 'scroll': {
      if (xpath) {
        const el = await waitForElement(xpath, elementWaitMs, requireVisible)
        if (!el) return elementError(xpath)
        if (el instanceof HTMLElement) el.scrollIntoView({ block: 'center', inline: 'nearest' })
        return ok()
      }
      const direction = (value || 'down').toLowerCase()
      if (direction === 'up') window.scrollBy(0, -500)
      else if (direction === 'down') window.scrollBy(0, 500)
      else window.scrollBy({ top: Number(value) || 0, behavior: 'auto' })
      return ok()
    }
    case 'scroll_to_top': {
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return ok()
    }
    case 'scroll_to_bottom': {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
      return ok()
    }
    case 'scroll_up_page': {
      window.scrollBy(0, -window.innerHeight)
      return ok()
    }
    case 'scroll_down_page': {
      window.scrollBy(0, window.innerHeight)
      return ok()
    }
    case 'scroll_to_element': {
      const el = await waitForElement(xpath, elementWaitMs, requireVisible)
      if (!el) return elementError(xpath)
      if (el instanceof HTMLElement) el.scrollIntoView({ block: 'center', inline: 'nearest' })
      return ok()
    }
    default:
      return err(`Unsupported action in browser extension: ${action}`)
  }
}
