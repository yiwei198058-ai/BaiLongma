import assert from 'node:assert/strict'
import { createVoiceStateController, VOICE_STATES } from './ui/brain-ui/voice-state.js'

assert.deepEqual(VOICE_STATES, [
  'idle', 'listening', 'thinking', 'speaking', 'interrupted',
  'confirming', 'executing', 'completed', 'failed',
])

let clock = 1000
let turnCounter = 0
const events = []
const state = createVoiceStateController({
  now: () => clock++,
  createTurnId: () => `turn-${++turnCounter}`,
})
state.subscribe(event => events.push(event))

state.transition('listening', { reason: 'microphone-started' })
state.transition('thinking', { reason: 'voice-message-sent', newTurn: true })
state.transition('executing', { reason: 'tool-executing', meta: { tool: 'calendar' } })
state.transition('completed', { reason: 'response' })

assert.equal(events.length, 4)
assert.equal(events[0].previousState, 'idle')
assert.equal(events[0].turnId, 'turn-1')
assert.equal(events[1].turnId, 'turn-2')
assert.equal(events[2].turnId, 'turn-2')
assert.deepEqual(events[2].meta, { tool: 'calendar' })
assert.deepEqual(events.map(event => event.sequence), [1, 2, 3, 4])

state.transition('completed', { reason: 'duplicate-response' })
assert.equal(events.length, 4, 'duplicate states should not emit duplicate events')

state.transition('idle', { reason: 'microphone-stopped' })
state.transition('listening', { reason: 'microphone-restarted' })
assert.equal(events.at(-1).turnId, 'turn-3', 'idle should close the previous turn')

assert.throws(() => state.transition('unknown'), /Unknown voice state/)

console.log('All voice state tests passed.')
