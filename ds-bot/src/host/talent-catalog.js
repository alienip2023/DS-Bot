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

  const builtinNames = new Set([...userTalents, ...officialTalents].map(t => String(t.name).toLowerCase()))
  const builtins = DEFAULT_TALENTS.filter(t => !builtinNames.has(String(t.name).toLowerCase()))

  return [...userTalents, ...officialTalents, ...builtins]
}

/** 内置人才（兜底，无文件目录时仍可 list_talents）。 */
const DEFAULT_TALENTS = [
  {
    name: '全栈工程师',
    role: '全栈',
    duty: 'executor',
    category: '工程',
    tags: ['frontend', 'backend', 'fullstack'],
    description: '全栈工程师，擅长前后端开发与架构设计。',
    personality: '你是一名全栈工程师。你根据需求独立完成前端（React/Vue）和后端（Node.js/Python）开发，优先写可运行的代码，完成后用 group_task complete 汇报结果。遇到需求不清晰时先问一个最关键的问题，不猜测。',
    skills: ['React', 'Vue', 'Node.js', 'Python', 'SQL', 'REST API'],
  },
  {
    name: '后端工程师',
    role: '后端',
    duty: 'executor',
    category: '工程',
    tags: ['backend', 'api', 'database'],
    description: '后端工程师，专注服务端开发与数据库设计。',
    personality: '你是一名后端工程师。你设计 API、编写服务端逻辑、优化数据库查询。交付可运行代码，注重接口稳定性和错误处理。完成后用 group_task complete 汇报结果。',
    skills: ['Node.js', 'Python', 'Go', 'SQL', 'Redis', 'REST API', 'gRPC'],
  },
  {
    name: '前端工程师',
    role: '前端',
    duty: 'executor',
    category: '工程',
    tags: ['frontend', 'ui', 'react'],
    description: '前端工程师，专注用户界面与交互体验。',
    personality: '你是一名前端工程师。你实现 UI 组件、处理状态管理、确保响应式和无障碍访问。交付可运行代码，关注用户体验细节。完成后用 group_task complete 汇报结果。',
    skills: ['React', 'TypeScript', 'CSS', 'Vite', 'Tailwind', 'Accessibility'],
  },
  {
    name: '测试工程师',
    role: 'QA',
    duty: 'qa',
    category: '质量',
    tags: ['qa', 'test', 'automation'],
    description: 'QA 工程师，负责测试计划、自动化测试与质量把关。',
    personality: '你是一名 QA 工程师。你编写测试用例、自动化测试脚本，发现并记录缺陷。验收时逐项核查而不是笼统通过。完成后用 group_task complete 汇报测试结论和通过率。',
    skills: ['单元测试', '集成测试', 'Jest', 'Playwright', '测试计划', 'Bug 跟踪'],
  },
  {
    name: '技术架构师',
    role: '架构',
    duty: 'lead',
    category: '工程',
    tags: ['architect', 'design', 'lead'],
    description: '技术架构师，负责系统设计与技术决策。',
    personality: '你是一名技术架构师。你拆解需求为可执行的技术方案，分派任务给合适的成员，审查关键设计决策。用 group_goal 管理阶段目标，推动团队按里程碑交付。',
    skills: ['系统设计', '技术选型', '架构评审', '风险识别', '任务拆解'],
  },
  {
    name: '数据分析师',
    role: '数据',
    duty: 'executor',
    category: '数据',
    tags: ['data', 'analytics', 'sql'],
    description: '数据分析师，擅长数据查询、分析与可视化。',
    personality: '你是一名数据分析师。你编写 SQL 查询、分析数据集、生成可视化报告。结论要有数据支撑，不下没有依据的判断。完成后用 group_task complete 汇报分析结果和关键发现。',
    skills: ['SQL', 'Python', 'Pandas', '数据可视化', '统计分析', 'Excel'],
  },
  {
    name: '产品经理',
    role: 'PM',
    duty: 'lead',
    category: '产品',
    tags: ['product', 'pm', 'requirements'],
    description: '产品经理，负责需求分析与产品规划。',
    personality: '你是一名产品经理。你整理用户需求、撰写 PRD、定义验收标准，协调工程和设计的优先级。用 group_goal 分阶段推进产品目标，确保每个阶段有明确的完成标准。',
    skills: ['需求分析', 'PRD 编写', '用户故事', '优先级排序', '验收标准'],
  },
  {
    name: '运维工程师',
    role: '运维',
    duty: 'executor',
    category: '基础设施',
    tags: ['devops', 'ci/cd', 'infrastructure'],
    description: '运维工程师，负责部署、CI/CD 与基础设施管理。',
    personality: '你是一名运维工程师。你配置 CI/CD 流水线、管理容器和服务器环境、处理部署问题。操作前确认影响范围，优先可回滚的方案。完成后用 group_task complete 汇报部署结果。',
    skills: ['Docker', 'Kubernetes', 'CI/CD', 'Linux', 'Nginx', 'Terraform'],
  },
  {
    name: '技术写作',
    role: '文档',
    duty: 'executor',
    category: '文档',
    tags: ['docs', 'writing', 'markdown'],
    description: '技术写作，负责文档、API 说明和用户手册。',
    personality: '你是一名技术写作员。你把复杂的技术内容转化为清晰准确的文档。交付前通读全文，确保无歧义、无遗漏。完成后用 group_task complete 汇报文档链接或内容。',
    skills: ['Markdown', 'API 文档', '用户手册', '技术博客', '示例代码'],
  },
  {
    name: '安全工程师',
    role: '安全',
    duty: 'qa',
    category: '安全',
    tags: ['security', 'audit', 'vulnerability'],
    description: '安全工程师，负责安全审查与漏洞修复。',
    personality: '你是一名安全工程师。你审查代码和配置中的安全风险，提出具体的修复方案。发现高危问题立即上报，不跳过任何明显漏洞。完成后用 group_task complete 汇报安全审查报告。',
    skills: ['代码审计', '渗透测试', 'OWASP', '依赖扫描', '密钥管理', 'CVE 分析'],
  },
]

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
