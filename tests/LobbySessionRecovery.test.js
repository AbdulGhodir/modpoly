import test from 'node:test';
import assert from 'node:assert/strict';
import {GameState} from '../src/logic/GameStateCore.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {applyInitialSnapshot} from '../src/network/InitialSnapshotSync.js';
import {LobbyManager} from '../src/network/LobbyManager.js';

const TOKEN_KEY = 'monopoly.sessionToken';
const ROOM_KEY = 'monopoly.sessionRoomCode';

class FakeClient {
  constructor(response = null) {
    this.status = 'disconnected';
    this.url = 'http://localhost:3000';
    this.listeners = new Map();
    this.statusListeners = new Set();
    this.response = response;
  }
  getStatus() { return this.status; }
  isConnected() { return this.status === 'connected'; }
  onStatusChange(listener) { this.statusListeners.add(listener); listener(this.status); return () => this.statusListeners.delete(listener); }
  on(eventName, listener) { this.listeners.set(eventName, listener); return () => this.listeners.delete(eventName); }
  connect() {}
  async request(eventName, payload) { this.lastRequest = {eventName, payload}; return this.response; }
  setStatus(status) { this.status = status; this.statusListeners.forEach(listener => listener(status)); }
}

function withStorage(t, initial = {}) {
  const values = new Map(Object.entries(initial));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  }});
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; });
  return values;
}

function makeStartedSession() {
  const game = new GameState();
  const snapshot = game.toSnapshot();
  snapshot.players = snapshot.players.slice(0, 2).map((player, seat) => ({...player,
    playerId: `p${seat + 1}`, name: `Pemain ${seat + 1}`, seat, money: seat === 0 ? 875 : 1500}));
  snapshot.currentTurn = 0;
  snapshot.activePlayerId = 'p1';
  snapshot.phase = 'WAITING_ROLL';
  snapshot.roomCode = 'AB2CD3';
  const room = {roomCode: 'AB2CD3', status: 'started', minPlayers: 2, maxPlayers: 4,
    players: snapshot.players.map(player => ({playerId: player.playerId, playerName: player.name}))};
  return {snapshot, room};
}

test('reconnect requests server restoration with stored token and applies latest snapshot in-place', async t => {
  const values = withStorage(t, {[TOKEN_KEY]: 'old-session-token-value', [ROOM_KEY]: 'AB2CD3'});
  const {snapshot, room} = makeStartedSession();
  const client = new FakeClient({ok: true, room, playerId: 'p1', sessionToken: 'rotated-session-token-value', snapshot});
  const lobby = new LobbyManager(client);
  const state = new GameState();
  const store = new ClientGameStore(state);
  const stateReference = store.getState();
  let applied = false;
  lobby.setSessionRestoredHandler(payload => {
    applied = applyInitialSnapshot({payload, store, getActiveRoom: () => lobby.getRoomState(), logger: {info() {}, warn() {}}});
    return applied;
  });
  client.setStatus('connected');
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(client.lastRequest, {eventName: 'room:resume', payload: {
    sessionToken: 'old-session-token-value', roomCode: 'AB2CD3'
  }});
  assert.equal(lobby.playerId, 'p1');
  assert.equal(lobby.getRoomState().roomCode, 'AB2CD3');
  assert.equal(applied, true);
  assert.equal(store.getState(), stateReference);
  assert.equal(store.getBalance('p1'), 875);
  assert.equal(values.get(TOKEN_KEY), 'rotated-session-token-value');
});

test('invalid session clears persisted credentials and removes the stale room identity', async t => {
  const values = withStorage(t, {[TOKEN_KEY]: 'expired-session-token', [ROOM_KEY]: 'AB2CD3'});
  const client = new FakeClient({ok: false, error: {code: 'SESSION_EXPIRED', message: 'Sesi kedaluwarsa.'}});
  const lobby = new LobbyManager(client);
  client.setStatus('connected');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(lobby.sessionToken, '');
  assert.equal(lobby.playerId, null);
  assert.equal(lobby.getRoomState(), null);
  assert.equal(values.has(TOKEN_KEY), false);
  assert.match(lobby.errorMessage, /kedaluwarsa/i);
});

test('explicit room leave removes the saved token so it cannot restore membership', async t => {
  const values = withStorage(t);
  const client = new FakeClient({ok: true, room: null, deleted: false});
  const lobby = new LobbyManager(client);
  lobby.room = {roomCode: 'AB2CD3', status: 'waiting'};
  lobby.playerId = 'p1';
  lobby.sessionToken = 'active-session-token';
  values.set(TOKEN_KEY, 'active-session-token');
  values.set(ROOM_KEY, 'AB2CD3');
  await lobby._leaveRoom();
  assert.equal(client.lastRequest.eventName, 'room:leave');
  assert.equal(lobby.sessionToken, '');
  assert.equal(values.has(TOKEN_KEY), false);
  assert.equal(values.has(ROOM_KEY), false);
});
