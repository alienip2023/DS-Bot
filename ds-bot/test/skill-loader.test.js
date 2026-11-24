import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import {
  SKILL_INJECT_SOURCE, botsRoot, catalogText, loadBotSkills, matchSkill, mentions, parseSkillFile,
  saveSkill, skillMessageFor,
} from '../src/host/skill-loader.js'

const said = (text, kind = 'user') => ({ role: 'user', source: { kind }, content: [{ type: 'text', text }] })
const skill = (name, triggers = [], description = '') => ({ name, triggers, description, content: `steps for ${name}`, filePath: '' })

test('preload keeps Bot state out of ~/.dsh', () => {
  assert.ok(process.env.DSH_BOTS_DIR, 'harness-resolve.mjs sets DSH_BOTS_DIR')
  assert.equal(botsRoot(), process.env.DSH_BOTS_DIR)
})

test('mentions: ASCII terms need word edges; CJK terms match as substrings', () => {
  assert.equal(mentions('run the test suite', 'test'), true)
  assert.equal(mentions('show the latest build', 'test'), false)
  assert.equal(mentions('please deploy-prod now', 'deploy-prod'), true)
  assert.equal(mentions('use deploy-prod-eu', 'deploy-prod'), false)
  assert.equal(mentions('帮我部署到生产环境', '部署'), true)
  assert.equal(mentions('anything', '  '), false)
})

test('matchSkill: by name or trigger, case-insensitive, first wins', () => {
  const skills = [skill('deploy-prod', ['release', '上线']), skill('weekly-report', ['周报'])]
  assert.equal(matchSkill(skills, 'Time to RELEASE')?.name, 'deploy-prod')
  assert.equal(matchSkill(skills, '今天上线吗')?.name, 'deploy-prod')
  assert.equal(matchSkill(skills, '写一下周报')?.name, 'weekly-report')
  assert.equal(matchSkill(skills, 'releases are fun'), null)
  assert.equal(matchSkill([], 'release'), null)
})

test('parseSkillFile: frontmatter (CRLF too), name falls back to the file name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-parse-'))
  try {
    writeFileSync(join(dir, 'a.md'), '---\r\nname: deploy\r\ntrigger: ship|上线\r\ndescription: Ship it\r\n---\r\n## Steps\r\n1. go')
    writeFileSync(join(dir, 'plain-one.md'), '# no frontmatter')
    assert.deepEqual({ ...parseSkillFile(join(dir, 'a.md')), filePath: '' }, { name: 'deploy', description: 'Ship it', triggers: ['ship', '上线'], content: '## Steps\r\n1. go', filePath: '' })
    assert.equal(parseSkillFile(join(dir, 'plain-one.md')).name, 'plain-one')
    assert.equal(parseSkillFile(join(dir, 'missing.md')), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('saveSkill rejects non-kebab names and loadBotSkills is sorted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-save-'))
  try {
    assert.throws(() => saveSkill('b', '../escape', 'x', dir), /kebab-case/)
    assert.throws(() => saveSkill('b', 'Upper', 'x', dir), /kebab-case/)
    saveSkill('b', 'zeta', 'z', dir)
    saveSkill('b', 'alpha', 'a', dir)
    assert.deepEqual(loadBotSkills('b', dir).map(s => s.name), ['alpha', 'zeta'])
    assert.deepEqual(loadBotSkills('nobody', dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('catalogText lists skills; empty when none', () => {
  assert.equal(catalogText([]), '')
  const text = catalogText([skill('deploy-prod', ['release'], 'Ship to prod')])
  assert.match(text, /- deploy-prod \(triggers: release\) — Ship to prod/)
})

test('skillMessageFor: injects for the latest said message only, once', () => {
  const skills = [skill('deploy-prod', ['release'])]
  const first = skillMessageFor(skills, [said('please release')])
  assert.equal(first.source.kind, SKILL_INJECT_SOURCE)
  assert.equal(first.source.skill, 'deploy-prod')
  assert.equal(first.source.form, 'snapshot')
  assert.match(first.content[0].text, /## Active Skill: deploy-prod/)
  // Next step of the same turn: the injected message is in the history now → nothing added.
  assert.equal(skillMessageFor(skills, [said('please release')], [first]), undefined)
  assert.equal(skillMessageFor(skills, [first, said('please release')]), undefined)
  // A new message naming it again gets it again.
  assert.ok(skillMessageFor(skills, [said('release once more')], [first]))
})

test('skillMessageFor: ignores injected user messages (memory recall etc.) and empty text', () => {
  const skills = [skill('deploy-prod', ['release'])]
  assert.equal(skillMessageFor(skills, [said('release', 'ds-bot:memory-recall')]), undefined)
  assert.equal(skillMessageFor(skills, [said('release'), said('nothing here', 'user')]), undefined)
  assert.ok(skillMessageFor(skills, [said('release', 'bot')]), 'another Bot naming it counts')
  assert.equal(skillMessageFor(skills, [said('   ')]), undefined)
})

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  revision: 1,
  whaleStored: true,
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    ada: { id: 'ada', sessionId: 'ada', name: 'Ada', role: 'Dev', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

async function start(t) {
  // Each test its own Bot-state root, so one test's skills never show in another's.
  const before = process.env.DSH_BOTS_DIR
  process.env.DSH_BOTS_DIR = mkdtempSync(join(tmpdir(), 'ds-bot-skill-bots-'))
  const ownRoot = process.env.DSH_BOTS_DIR
  t.after(() => { process.env.DSH_BOTS_DIR = before; rmSync(ownRoot, { recursive: true, force: true }) })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-skill-tools-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({})
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const tool = name => rt.teamTools.find(def => def.name === name)
  const call = (name, args, as) => tool(name).execute(args, { agent: { id: as }, callId: 'c', signal: new AbortController().signal })
  return { rt, call }
}

test('create_skill without bot: writes the caller\'s own skill (not ~/.dsh/bots/undefined)', async (t) => {
  const { call } = await start(t)
  const out = await call('create_skill', { name: 'deploy-prod', content: '---\ntrigger: release\ndescription: Ship\n---\n1. go' }, 'chief')
  assert.match(out, /saved for Chief/)
  assert.ok(existsSync(join(botsRoot(), 'chief', 'skills', 'deploy-prod.md')))
  assert.equal(existsSync(join(botsRoot(), 'undefined')), false)
  const listed = await call('list_skills', {}, 'chief')
  assert.match(listed, /Chief's skills:/)
  assert.match(listed, /deploy-prod \[triggers: release\] — Ship/)
})

test('create_skill for another Bot: only a Main Bot may', async (t) => {
  const { call } = await start(t)
  assert.match(await call('create_skill', { name: 'x', content: 'c', bot: 'Chief' }, 'ada'), /Only a Main Bot/)
  assert.equal(existsSync(join(botsRoot(), 'chief', 'skills', 'x.md')), false)
  assert.match(await call('create_skill', { name: 'review', content: 'c', bot: 'Ada' }, 'chief'), /saved for Ada/)
  assert.equal(readFileSync(join(botsRoot(), 'ada', 'skills', 'review.md'), 'utf8'), 'c')
})

test('create_skill validates name and content; list_skills on an unknown Bot says so', async (t) => {
  const { call } = await start(t)
  assert.match(await call('create_skill', { name: 'Bad Name', content: 'c' }, 'ada'), /kebab-case/)
  assert.match(await call('create_skill', { name: 'ok', content: '  ' }, 'ada'), /empty/)
  assert.match(await call('list_skills', { bot: 'Nobody' }, 'ada'), /No Bot named "Nobody"/)
  assert.match(await call('list_skills', {}, 'ada'), /Ada has no skills yet/)
})

test('bot_journal reads the caller\'s journal and flags an unfinished turn', async (t) => {
  const { call } = await start(t)
  assert.match(await call('bot_journal', {}, 'ada'), /Ada has no journal entries yet/)
  const dir = join(botsRoot(), 'ada')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'journal.jsonl'), [
    { seq: 1, type: 'turn/start', exchangeId: 'ex-done-1' },
    { seq: 2, type: 'turn/end', exchangeId: 'ex-done-1' },
    { seq: 3, type: 'turn/start', exchangeId: 'ex-crash-2' },
    { seq: 4, type: 'step/tool', exchangeId: 'ex-crash-2', name: 'shell' },
  ].map(e => JSON.stringify(e)).join('\n') + '\n')
  const out = await call('bot_journal', {}, 'ada')
  assert.match(out, /Ada journal \(last 4 of 4 entries\)/)
  assert.match(out, /Incomplete turns.*ex-crash-2/)
  assert.doesNotMatch(out, /Incomplete turns.*ex-done-1/)
})
