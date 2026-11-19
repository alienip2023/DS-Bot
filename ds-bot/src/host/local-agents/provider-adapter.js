/**
 * Engine surface consumed by LocalAgentAdapter. Optional capabilities are
 * called only when present. Session handles and payloads are provider-specific.
 * @typedef {Object} ProviderAdapter
 * @property {(session: Object) => boolean} [canSteer] Check whether the current turn can accept input.
 * @property {(session: Object) => void | Promise<unknown>} [cancel] Interrupt the current turn.
 * @property {() => Promise<void>} [close] Close the engine.
 * @property {(session: Object) => Promise<void>} [closeSession] Close one engine session.
 * @property {(session: Object) => boolean} [compact] Request context compaction.
 * @property {(sessionId: string) => void} [forget] Drop the engine's mapping for a DSH session.
 * @property {(session: Object, text: string) => Promise<void>} [instruct] Update a live session's instructions.
 * @property {(options: Object) => Promise<Object[]>} listModels List CLI models.
 * @property {(sessionId: string, options: Object) => Promise<Object>} open Open or resume a session.
 * @property {(session: Object, blocks: Object[], options: Object) => Promise<unknown>} prompt Start a turn.
 * @property {(session: Object, input: string | Object[]) => Promise<unknown>} [steer] Send input to a running turn.
 * @property {(session?: Object) => boolean} [supportsImages] Check image support for the engine or a session.
 */

export const PROVIDER_ADAPTER_REQUIRED_METHODS = Object.freeze(['listModels', 'open', 'prompt'])

// Keep the supported surface independent of which methods every engine must implement.
const supportedMethods = [
  'canSteer',
  'cancel',
  'close',
  'closeSession',
  'compact',
  'forget',
  'instruct',
  'listModels',
  'open',
  'prompt',
  'steer',
  'supportsImages',
]

export const PROVIDER_ADAPTER_OPTIONAL_METHODS = Object.freeze(
  supportedMethods.filter(name => !PROVIDER_ADAPTER_REQUIRED_METHODS.includes(name)),
)

export const PROVIDER_ADAPTER_METHODS = Object.freeze([
  ...PROVIDER_ADAPTER_REQUIRED_METHODS,
  ...PROVIDER_ADAPTER_OPTIONAL_METHODS,
].sort())

export function assertProviderAdapter(x) {
  for (const name of PROVIDER_ADAPTER_REQUIRED_METHODS) {
    if (typeof x?.[name] !== 'function') throw new TypeError(`provider-adapter-missing-method: ${name}`)
  }
  const adapter = Object(x)
  for (const name of PROVIDER_ADAPTER_OPTIONAL_METHODS) {
    if (name in adapter && typeof adapter[name] !== 'function') throw new TypeError(`provider-adapter-missing-method: ${name}`)
  }
  return x
}
