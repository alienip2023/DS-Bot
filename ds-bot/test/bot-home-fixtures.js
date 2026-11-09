import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { teamActions } from '../src/client/team-actions.js'
import { indexRoster, EMPTY_ROSTER } from '../src/client/sources.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

export function realTeamActions(rosterState) {
  return teamActions({
    call: () => Promise.resolve({}),
    after: p => p,
    partFor: () => null,
    roster: { getSnapshot: () => rosterState },
    ui: { set: () => {}, getSnapshot: () => ({}) },
    live: { getSnapshot: () => ({}) },
    cards: { getSnapshot: () => ({}) },
    heldCards: { getSnapshot: () => ({}) },
    turnClock: { getSnapshot: () => ({}) },
    panelFolded: () => false,
  })
}

// The roster the client sees, built from a REAL runtime's chatOf (store.js) exactly the way
// channel.js view() does for `bots` (`sessionId: rt.chatOf(bot.id)`), then indexed by the
// client's own indexRoster. Until a mirror session exists chatOf falls back to the Bot's id.
export function hostRoster(rt) {
  const bots = Object.values(rt.state.bots).map(({ segments, kickoff, ...bot }) => ({
    ...bot, sessionId: rt.chatOf(bot.id), parts: (segments ?? []).map(segment => segment.sessionId),
  }))
  return { ...EMPTY_ROSTER, ...indexRoster({ bots, rooms: [], agents: [] }), botHomeEnabled: rt.botHomeEnabled === true }
}

export function joinedRuntime({ mirrorSessionId } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-s23b-'))
  const rt = createRuntime(fakeContext(), { home, features: { botHome: true } })
  rt.state.bots['bot-j1'] = {
    id: 'bot-j1', name: 'Joined', origin: 'joined', type: 'remote-worker',
    worker: { nodeId: 'n1', remoteBotId: 'rb1', home: 'remote', online: true },
    ...(mirrorSessionId === undefined ? {} : { sessionId: mirrorSessionId }),
  }
  return rt
}

