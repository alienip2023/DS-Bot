// Load functions out of the core's OWN source, unchanged, so a test feeds ds-bot's output to the code a
// reader really runs and not to a copy written here. A TypeScript file is stripped of its types with
// node:module's stripTypeScriptTypes and the named declarations are cut out of the result by brace
// matching; they run in a fresh function scope with whatever outer names they need passed in.
//
// The source is read from the DeepSeek Harness checkout (DSH_HARNESS, which test/harness-resolve.mjs
// sets). Without that checkout `coreSource` returns undefined and a test says so and skips; with
// DSH_REQUIRE_CORE_SOURCE=1 it fails instead.
import { readFileSync, existsSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'

export const REQUIRE_CORE_SOURCE = process.env.DSH_REQUIRE_CORE_SOURCE === '1'

/** The text of a file under packages/ of the Harness checkout, or undefined. */
function read(relative) {
  const root = process.env.DSH_HARNESS
  if (typeof root !== 'string' || root === '') return undefined
  const file = join(root, 'packages', relative)
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

// Cut `kind name` (function or class) out of `text` by brace matching. For a function the body starts at
// the first `{` after the parameter list's closing parenthesis, so a return type that holds braces needs the
// type-stripped text (which has none).
function declaration(text, kind, name) {
  const head = new RegExp(`(?:^|\\n)(?:export\\s+)?${kind}\\s+${name}\\b`).exec(text)
  if (head === null) throw new Error(`core source has no ${kind} ${name}`)
  const start = head.index + (text[head.index] === '\n' ? 1 : 0)
  let from = start
  if (kind === 'function') {
    let parens = 0
    for (let at = text.indexOf('(', start); at < text.length; at += 1) {
      if (text[at] === '(') parens += 1
      else if (text[at] === ')') { parens -= 1; if (parens === 0) { from = at; break } }
    }
  }
  const open = text.indexOf('{', from)
  let depth = 0
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === '{') depth += 1
    else if (text[at] === '}') { depth -= 1; if (depth === 0) return text.slice(start, at + 1).replace(/^export\s+/, '') }
  }
  throw new Error(`core source: unbalanced ${kind} ${name}`)
}

// Strip a whole file when the strip-only mode accepts it (parameter properties and enums it does not);
// otherwise each declaration is cut out of the raw text and stripped alone.
function stripped(text, kind, name) {
  try { return declaration(stripTypeScriptTypes(text), kind, name) } catch (error) {
    if (error?.code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') throw error
    return stripTypeScriptTypes(declaration(text, kind, name)).replace(/^export\s+/, '')
  }
}

/**
 * @param spec - [{ file, functions?: string[], classes?: string[] }]
 * @param outer - names the declarations use from outside the cut-out parts (passed in as values)
 * @returns the declarations as an object, or undefined when a file is missing
 */
export function coreSource(spec, outer = {}) {
  let body = ''
  const names = []
  for (const { file, functions = [], classes = [] } of spec) {
    const text = read(file)
    if (text === undefined) return undefined
    for (const name of functions) { body += `${stripped(text, 'function', name)}\n`; names.push(name) }
    for (const name of classes) { body += `${stripped(text, 'class', name)}\n`; names.push(name) }
  }
  return new Function(...Object.keys(outer), `${body}\nreturn { ${names.join(', ')} }`)(...Object.values(outer))
}
