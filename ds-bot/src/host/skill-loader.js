// skill-loader.js — load a Bot's Markdown skill files and inject them as context.
//
// Skills are Markdown files stored at ~/.dsh/bots/<botId>/skills/<name>.md
// When a Bot's turn text mentions a skill name (exact match) or the Bot explicitly
// invokes invoke_skill, the skill's content is prepended to the turn context so the
// Bot follows its encoded procedure.
//
// Skill format (frontmatter optional):
//   ---
//   name: deploy-prod
//   trigger: deploy|release
//   description: Deploy to production
//   ---
//   ## Steps
//   1. Run tests
//   2. Push to main
//   ...
//   ## Success criteria
//   All tests pass, CI green, deploy complete.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { textOf } from './text.js'

const BOTS_DIR = join(homedir(), '.dsh', 'bots')

/**
 * @typedef {object} Skill
 * @property {string} name
 * @property {string} description
 * @property {string[]} triggers   words/phrases that activate this skill automatically
 * @property {string} content      full Markdown content (without frontmatter)
 * @property {string} filePath
 */

/**
 * Parse a skill Markdown file.
 * @param {string} filePath
 * @returns {Skill|null}
 */
export function parseSkillFile(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8')
    let name = filePath.replace(/^.*[\\/]/, '').replace(/\.md$/, '')
    let description = ''
    let triggers = []
    let content = raw

    // Parse optional YAML frontmatter
    if (raw.startsWith('---\n')) {
      const end = raw.indexOf('\n---\n', 4)
      if (end !== -1) {
        const front = raw.slice(4, end)
        content = raw.slice(end + 5).trim()
        for (const line of front.split('\n')) {
          const m = line.match(/^(\w+):\s*(.+)$/)
          if (!m) continue
          if (m[1] === 'name') name = m[2].trim()
          else if (m[1] === 'description') description = m[2].trim()
          else if (m[1] === 'trigger') triggers = m[2].split('|').map(t => t.trim()).filter(Boolean)
        }
      }
    }

    return { name, description, triggers, content, filePath }
  } catch { return null }
}

/**
 * Load all skills for a Bot.
 * @param {string} botId
 * @param {string} [botsDir]
 * @returns {Skill[]}
 */
export function loadBotSkills(botId, botsDir = BOTS_DIR) {
  const dir = join(botsDir, botId, 'skills')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => parseSkillFile(join(dir, f)))
      .filter(Boolean)
  } catch { return [] }
}

/**
 * Find the best matching skill for a turn's text.
 * Returns the skill if any trigger word appears in the text, or if the
 * text contains the exact skill name. Returns null if no match.
 *
 * @param {Skill[]} skills
 * @param {string} text
 * @returns {Skill|null}
 */
export function matchSkill(skills, text) {
  if (!text || skills.length === 0) return null
  const lower = text.toLowerCase()
  for (const skill of skills) {
    // Exact name match
    if (lower.includes(skill.name.toLowerCase())) return skill
    // Trigger word match
    for (const trigger of skill.triggers) {
      if (trigger && lower.includes(trigger.toLowerCase())) return skill
    }
  }
  return null
}

/**
 * Save a skill to disk.
 * @param {string} botId
 * @param {string} name   kebab-case skill name
 * @param {string} content  full Markdown content
 * @param {string} [botsDir]
 */
export function saveSkill(botId, name, content, botsDir = BOTS_DIR) {
  const dir = join(botsDir, botId, 'skills')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), content, 'utf8')
}

/**
 * Build a context injection string for a matched skill.
 * Prepended to the Bot's system context so it follows the procedure.
 *
 * @param {Skill} skill
 * @returns {string}
 */
export function skillContextFor(skill) {
  return [
    `## Active Skill: ${skill.name}`,
    skill.description ? `> ${skill.description}` : '',
    '',
    skill.content,
    '',
    '---',
    '',
  ].filter(l => l !== null).join('\n')
}

const SKILL_INJECT_SOURCE = 'ds-bot:skill-inject'

/**
 * install — register the Bot-skill prompt section and a pre-step hook that
 * injects any skill whose name or trigger word appears in the turn's text.
 * Mirrors the memory module's pre-step pattern (memory.js:1226) so a matched
 * skill lands as a front message before the turn's own messages.
 */
export function install(rt) {
  const botsDir = rt.config?.skillBotsDir || BOTS_DIR

  // Catalog section: lists the Bot's installed skills by name + description so the
  // model knows what it can invoke. Order sits between bot-memory (645) and
  // feature-packs (646).
  rt.ctx.effect(() => rt.ctx.systemPrompt.section({
    name: 'bot-skills',
    order: 645,
    interpolate: false,
    text: context => {
      const sessionId = context?.agent?.id
      if (!sessionId || !rt.isBotSession?.(sessionId)) return ''
      const botId = rt.selfOf?.(sessionId)
      if (!botId) return ''
      const skills = loadBotSkills(botId, botsDir)
      if (skills.length === 0) return ''
      const lines = ['## Skills available', 'Invoke any by name or trigger word.']
      for (const s of skills) {
        const trig = s.triggers.length > 0 ? ` (triggers: ${s.triggers.join(', ')})` : ''
        lines.push(`- ${s.name}${trig} — ${s.description}`)
      }
      return lines.join('\n')
    },
  }), 'ds-bot: skills catalog section')

  // Pre-step hook: find a matching skill and inject its content as a front
  // message so the Bot follows the procedure for this turn.
  rt.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal?.aborted || !Array.isArray(decision.messages)) return decision
    const sessionId = agent?.id
    if (!sessionId || !rt.isBotSession?.(sessionId)) return decision
    const botId = rt.selfOf?.(sessionId)
    if (!botId) return decision

    const skills = loadBotSkills(botId, botsDir)
    if (skills.length === 0) return decision

    const said = decision.messages.findLast(message => message?.role === 'user')
    const query = said === undefined ? '' : textOf(said.content).slice(0, 4000)
    if (query.trim() === '') return decision

    const skill = matchSkill(skills, query)
    if (!skill) return decision

    const text = skillContextFor(skill)
    const inject = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: SKILL_INJECT_SOURCE, skill: skill.name },
    })
    return { ...decision, messages: [inject, ...decision.messages] }
  })
}
