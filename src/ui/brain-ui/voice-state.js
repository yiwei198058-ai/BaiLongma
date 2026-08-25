export const VOICE_STATES = Object.freeze([
  'idle',
  'listening',
  'thinking',
  'speaking',
  'interrupted',
  'confirming',
  'executing',
  'completed',
  'failed',
]);

const VOICE_STATE_SET = new Set(VOICE_STATES);

function defaultTurnId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeMeta(meta) {
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta } : {};
}

export function createVoiceStateController({
  initialState = 'idle',
  now = () => Date.now(),
  createTurnId = defaultTurnId,
} = {}) {
  if (!VOICE_STATE_SET.has(initialState)) {
    throw new TypeError(`Unknown voice state: ${initialState}`);
  }

  let sequence = 0;
  let activeTurnId = null;
  let snapshot = {
    version: 1,
    state: initialState,
    previousState: null,
    turnId: null,
    sequence,
    ts: new Date(now()).toISOString(),
    reason: 'initial',
    meta: {},
  };
  const listeners = new Set();

  function getSnapshot() {
    return { ...snapshot, meta: { ...snapshot.meta } };
  }

  function transition(nextState, {
    reason = '',
    meta = {},
    turnId,
    newTurn = false,
    force = false,
  } = {}) {
    if (!VOICE_STATE_SET.has(nextState)) {
      throw new TypeError(`Unknown voice state: ${nextState}`);
    }
    if (!force && snapshot.state === nextState && !newTurn && turnId === undefined) return getSnapshot();

    if (turnId !== undefined && turnId !== null && String(turnId).trim()) {
      activeTurnId = String(turnId).trim();
    } else if (newTurn || (!activeTurnId && nextState !== 'idle')) {
      activeTurnId = createTurnId();
    }

    const previousState = snapshot.state;
    snapshot = {
      version: 1,
      state: nextState,
      previousState,
      turnId: activeTurnId,
      sequence: ++sequence,
      ts: new Date(now()).toISOString(),
      reason: String(reason || ''),
      meta: normalizeMeta(meta),
    };

    const event = getSnapshot();
    for (const listener of listeners) listener(event);
    if (nextState === 'idle') activeTurnId = null;
    return event;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { getSnapshot, transition, subscribe };
}
