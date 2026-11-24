// skill-loader.js — a Bot's own Markdown skills, listed in its prompt and pulled into a
// turn when the user names one.
//
// Skills live with the Bot's portable state: <botsRoot>/<botId>/skills/<name>.md, where
// botsRoot() is ~/.dsh/bots unless DSH_BOTS_DIR says otherwise (same rule as AC's
// lib/persist/bots-root.js, so both plugins agree on where a Bot's state lives).
//
// Two hooks:
//  - a system-prompt section lists the Bot's skills (name, triggers, description);
//  - agent/pre-step: when the latest thing said to the Bot (by the user, a schedule or
//    another Bot) names a skill or one of its triggers, the skill's full text goes in as a
//    snapshot message. pre-step runs on every model step and what it adds stays in the
//    history, so a skill goes in once per message that named it, never once per step.
//
// Skill format (frontmatter optional):
//   ---
//   name: deploy-prod
//   trigger: deploy|release
//   description: Deploy to production
//   ---
//   ## Steps
//   1. Run tests ...

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { textOf } from './text.js'

export const SKILL_INJECT_SOURCE = 'ds-bot:skill-inject'
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const SAID = new Set(['user', 'schedule', 'bot'])
const QUERY_MAX = 4000
const SKILL_TEXT_MAX = 16_000

export function botsRoot() {
  const override = process.env.DSH_BOTS_DIR
  return typeof override === 'string' && override !== '' ? override : join(homedir(), '.dsh', 'bots')
}

export const skillsDirOf = (botId, botsDir = botsRoot()) => join(botsDir, botId, 'skills')

/**
 * @typedef {object} Skill
 * @property {string} name
 * @property {string} description
 * @property {string[]} triggers   words/phrases that pull the skill into a turn
 * @property {string} content      Markdown body (frontmatter removed)
 * @property {string} filePath
 */

/** @returns {Skill|null} */
export function parseSkillFile(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8')
    let name = filePath.replace(/^.*[\\/]/, '').replace(/\.md$/, '')
    let description = ''
    let triggers = []
    let content = raw
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
    if (front) {
      content = raw.slice(front[0].length).trim()
      for (const line of front[1].split(/\r?\n/)) {
        const m = /^(\w+):\s*(.+)$/.exec(line.trim())
        if (!m) continue
        if (m[1] === 'name') name = m[2].trim()
        else if (m[1] === 'description') description = m[2].trim()
        else if (m[1] === 'trigger' || m[1] === 'triggers') triggers = m[2].split('|').map(t => t.trim()).filter(Boolean)
      }
    }
    return { name, description, triggers, content, filePath }
  } catch { return null }
}

/** @returns {Skill[]} sorted by name, so the prompt section is byte-stable */
export function loadBotSkills(botId, botsDir = botsRoot()) {
  const dir = skillsDirOf(botId, botsDir)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .map(f => parseSkillFile(join(dir, f)))
      .filter(Boolean)
  } catch { return [] }
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Does `term` appear in `lower` as a whole word? ASCII terms need word edges (so a skill
 * named "test" does not fire on "latest"); terms with other scripts (Chinese has no
 * spaces between words) match as plain substrings.
 */
export function mentions(lower, term) {
  const t = term.trim().toLowerCase()
  if (t === '') return false
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]+$/.test(t)) return lower.includes(t)
  return new RegExp(`(^|[^a-z0-9_-])${escapeRe(t)}($|[^a-z0-9_-])`, 'u').test(lower)
}

/** First skill whose name or a trigger is mentioned in `text`; null if none. */
export function matchSkill(skills, text) {
  if (!text || skills.length === 0) return null
  const lower = text.toLowerCase()
  for (const skill of skills) {
    if (mentions(lower, skill.name)) return skill
    if (skill.triggers.some(trigger => mentions(lower, trigger))) return skill
  }
  return null
}

export function saveSkill(botId, name, content, botsDir = botsRoot()) {
  if (!SKILL_NAME.test(name)) throw new Error('Skill name must be kebab-case: lowercase letters, digits and hyphens.')
  const dir = skillsDirOf(botId, botsDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), content, 'utf8')
}

export function skillContextFor(skill) {
  const body = skill.content.length > SKILL_TEXT_MAX ? `${skill.content.slice(0, SKILL_TEXT_MAX)}\n…(truncated)` : skill.content
  return [
    `## Active Skill: ${skill.name}`,
    ...(skill.description ? [`> ${skill.description}`] : []),
    '',
    'The latest message named this skill. Follow its procedure for this request.',
    '',
    body,
  ].join('\n')
}

/** The prompt section: what skills this Bot has, so it can be asked for them by name. */
export function catalogText(skills) {
  if (skills.length === 0) return ''
  const lines = ['## Your skills', 'Saved procedures. When a message names one (or a trigger), its full text is added to the conversation.']
  for (const s of skills) {
    const trig = s.triggers.length > 0 ? ` (triggers: ${s.triggers.join(', ')})` : ''
    lines.push(`- ${s.name}${trig}${s.description ? ` — ${s.description}` : ''}`)
  }
  return lines.join('\n')
}

const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 16)
const isSkillInject = message => message?.source?.kind === SKILL_INJECT_SOURCE

/**
 * What pre-step adds for one step, or undefined. `history` is what the Session already
 * holds; a skill already put in for the same said message is not put in again.
 */
export function skillMessageFor(skills, messages, history = []) {
  const said = messages.findLast(message => message?.role === 'user' && SAID.has(message.source?.kind))
  const query = said === undefined ? '' : textOf(said.content).slice(0, QUERY_MAX)
  if (query.trim() === '') return undefined
  const skill = matchSkill(skills, query)
  if (!skill) return undefined
  const forSaid = digest(query)
  const already = message => isSkillInject(message) && message.source.skill === skill.name && message.source.forSaid === forSaid
  if (messages.some(already) || history.some(already)) return undefined
  const text = skillContextFor(skill)
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: SKILL_INJECT_SOURCE, form: 'snapshot', skill: skill.name, forSaid, sections: [{ name: SKILL_INJECT_SOURCE, text }] },
  })
}

export function install(rt) {
  const dirOf = () => rt.config?.skillBotsDir || botsRoot()
  const botIdOf = sessionId => (sessionId && rt.isBotSession?.(sessionId) ? rt.selfOf?.(sessionId) : undefined)

  rt.ctx.effect(() => rt.ctx.systemPrompt.section({
    name: 'bot-skills',
    order: 647,
    interpolate: false,
    text: context => {
      const botId = botIdOf(context?.agent?.id)
      return botId ? catalogText(loadBotSkills(botId, dirOf())) : ''
    },
  }), 'ds-bot: skills catalog section')

  rt.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal?.aborted || !Array.isArray(decision.messages)) return decision
    const botId = botIdOf(agent?.id)
    if (!botId) return decision
    const skills = loadBotSkills(botId, dirOf())
    if (skills.length === 0) return decision
    let history = []
    try { history = agent.session?.deriveMessages?.() ?? [] } catch { /* nothing to look in */ }
    const inject = skillMessageFor(skills, decision.messages, history)
    return inject === undefined ? decision : { ...decision, messages: [inject, ...decision.messages] }
  })
}
