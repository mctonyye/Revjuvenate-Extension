// Runs in every frame of every page. Phase 1: only marks the context as
// ready. The step executor (action catalogue, iframe routing, token
// resolution) lands in a later phase.
console.debug('[Revjuvenate] content script loaded', location.href)
