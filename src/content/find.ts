export function findElement(xpath: string, root: Document = document): Element | null {
  if (!xpath) return null
  try {
    const result = root.evaluate(xpath, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
    return result.singleNodeValue instanceof Element ? (result.singleNodeValue as Element) : null
  } catch {
    return null
  }
}

export function findElements(xpath: string): Element[] {
  if (!xpath) return []
  try {
    const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
    const out: Element[] = []
    for (let i = 0; i < result.snapshotLength; i++) {
      const node = result.snapshotItem(i)
      if (node instanceof Element) out.push(node)
    }
    return out
  } catch {
    return []
  }
}

export function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  return el.getClientRects().length > 0
}
