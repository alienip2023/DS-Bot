// 人才库集成（dsh-ai-team 格式兼容）。
//
// 人才库格式（talent.yml v1.1.0）：
//   name        Bot 显示名
//   role        职责一行（对应 createBot role）
//   duty        lead / qa / executor（对应团队角色分工）
//   personality 人格描述（写入 instructions 核心段）
//   description 简短说明（写入 instructions 开头）
//   skills      技能列表（写入 instructions 技能段）
//   category    分类标签（用于过滤）
//   tags        标签数组（用于过滤）
//   recommended_model 推荐模型（可选）
//
// 目录优先级：
//   ~/.dsh/ai-team/catalog/user/talents/   用户自定义（最高）
//   ~/.dsh/ai-team/catalog/official/*/     官方人才（次之）
//   内置 DEFAULT_TALENTS（兜底）
//
// 不依赖 yaml npm 包——用内置简单解析，talent.yml 格式固定。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 极简 YAML 解析，只处理 talent.yml 的 flat key-value + inline array + inline object。 */
export function parseTalentYaml(text) {
  const result = {}
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx < 1) continue
    const key = line.slice(0, colonIdx).trim()
    const rawVal = line.slice(colonIdx + 1).trim()
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      // Inline array: [a, b, c] or [a, "b"]
      result[key] = rawVal.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    } else if (rawVal.startsWith('{') && rawVal.endsWith('}')) {
      // Inline object: {k: v, k2: v2}
      const obj = {}
      for (const pair of rawVal.slice(1, -1).split(',')) {
        const [k, ...rest] = pair.split(':')
        if (k) obj[k.trim()] = rest.join(':').trim().replace(/^['"]|['"]$/g, '')
      }
      result[key] = obj
    } else {
      result[key] = rawVal.replace(/^['"]|['"]$/g, '')
    }
  }
  return result
}

/**
 * 把 talent 字段映射成 createBot 参数。
 *
 * instructions 构成：
 *   [description 一行]\n\n[personality]\n\n[skills 段]
 *
 * personality 是决定 Bot 行为质量的核心——把它直接写入 instructions
 * 而不是 role，让模型在每个 turn 都能看到。role 只保留 talent.role（职责类别）。
 */
export function talentToCreateBot(talent) {
  const lines = []
  if (talent.description && talent.description !== talent.personality) {
    lines.push(String(talent.description).trim())
    lines.push('')
  }
  if (talent.personality) {
    lines.push(String(talent.personality).trim())
  }
  const skills = Array.isArray(talent.skills) ? talent.skills.filter(Boolean) : []
  if (skills.length > 0) {
    lines.push('')
    lines.push('技能：' + skills.join('、'))
  }
  return {
    name: String(talent.name || '').trim(),
    role: String(talent.role || talent.duty || '').trim().slice(0, 24),
    instructions: lines.join('\n').trim(),
    ...(talent.recommended_model ? { model: talent.recommended_model } : {}),
  }
}

/** 从目录递归读取所有 talent.yml 文件。 */
function readTalentsFromDir(dir) {
  const talents = []
  if (!existsSync(dir)) return talents
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return talents }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const ymlPath = join(dir, entry.name, 'talent.yml')
    if (!existsSync(ymlPath)) continue
    try {
      const raw = readFileSync(ymlPath, 'utf8')
      const parsed = parseTalentYaml(raw)
      if (typeof parsed.name === 'string' && parsed.name.trim() !== '') {
        talents.push({ ...parsed, _id: entry.name, _source: dir })
      }
    } catch { /* skip unreadable */ }
  }
  return talents
}

/**
 * 读取人才库。返回 talent 对象数组，已按 user > official 优先级去重（同名 user 优先）。
 * @param {string} dshHome DSH_HOME 目录
 */
export function loadTalentCatalog(dshHome) {
  const catalogRoot = join(dshHome, 'ai-team', 'catalog')
  const userDir = join(catalogRoot, 'user', 'talents')
  const officialRoot = join(catalogRoot, 'official')

  const userTalents = readTalentsFromDir(userDir)
  const userNames = new Set(userTalents.map(t => String(t.name).toLowerCase()))

  // Official: scan all version subdirectories
  let officialDirs = []
  try {
    officialDirs = readdirSync(officialRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => join(officialRoot, e.name, 'talents'))
  } catch { /* no official catalog */ }

  const officialTalents = officialDirs.flatMap(readTalentsFromDir)
    .filter(t => !userNames.has(String(t.name).toLowerCase()))

  return [...userTalents, ...officialTalents]
}

/** 按 name/role/category/tags 模糊过滤。 */
export function filterTalents(talents, query) {
  if (!query || query.trim() === '') return talents
  const q = query.trim().toLowerCase()
  return talents.filter(t => {
    const hay = [t.name, t.role, t.description, t.category, ...(Array.isArray(t.tags) ? t.tags : [])]
      .filter(Boolean).join(' ').toLowerCase()
    return hay.includes(q)
  })
}
