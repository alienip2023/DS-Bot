// controller-wrap.js — put a wrapper on a method of a core service and take it off again.
//
// Reading a function property from a service VIEW in a real cordis context returns a NEW proxy
// every time (cordis createTraceable → createShadowMethod), so `controller.cancel === intercepted`
// is never true and a "restore only if it is still ours" check never restores. What a write does
// is plain: `view.name = fn` ends as an OWN property of the raw service object (reached through
// the Symbol.for('cordis.original') key of the view), and removing that property uncovers the
// prototype method again. So:
//   · install writes the wrapper through the view, as before;
//   · dispose looks at the RAW object, where identity holds: if the wrapper is still the current
//     value, the state from before it is put back (the previous own value, or no own value);
//   · if someone wrapped on top of ours, their wrapper holds ours as its "original" and cannot be
//     unlinked — ours is switched to a pass-through (`disposed`) so it does nothing any more.
// Installing again after a dispose therefore never leaves two live layers.
// Two of our own wrappers stacked and disposed outer-after-inner: the inner one was switched to
// pass-through when it could not be removed, so when the outer one goes the restore skips over
// every already-disposed wrapper of ours and lands on what was there before them.

const ORIGINAL = Symbol.for('cordis.original')
const WRAPPER = Symbol('ds-bot.controller-wrap')   // on our wrappers: { isDisposed(), before }

/** The raw service behind a cordis view; a plain object is its own raw. */
export function rawService(view) {
  return view?.[ORIGINAL] ?? view
}

/**
 * Wrap `controller[name]` for the life of the plugin.
 * @param ctx - the plugin context (effect owner)
 * @param controller - the service as the plugin sees it
 * @param name - the method name
 * @param make - original => wrapper; the wrapper calls `original.call(this, …)` for what it passes on
 * @param label - effect label
 * @returns true when the wrapper was installed
 */
export function wrapControllerMethod(ctx, controller, name, make, label) {
  const original = controller?.[name]
  if (typeof original !== 'function') return false
  let disposed = false
  const inner = make(original)
  const intercepted = function (...args) { return (disposed ? original : inner).apply(this, args) }
  ctx.effect(() => {
    const raw = rawService(controller)
    let before = Object.getOwnPropertyDescriptor(raw, name)
    intercepted[WRAPPER] = { isDisposed: () => disposed, get before() { return before } }
    controller[name] = intercepted
    return () => {
      disposed = true
      if (raw[name] !== intercepted) return
      // skip wrappers of ours that were already switched off underneath this one
      while (before !== undefined && typeof before.value === 'function' && before.value[WRAPPER]?.isDisposed()) before = before.value[WRAPPER].before
      if (before !== undefined) Object.defineProperty(raw, name, before)
      else delete raw[name]
    }
  }, label)
  return true
}
