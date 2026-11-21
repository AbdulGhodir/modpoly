import test from 'node:test';
import assert from 'node:assert/strict';
import {GameState} from '../src/logic/GameStateCore.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {initJailResolutionSync} from '../src/network/JailResolutionSync.js';
import {initAuthoritativeDiceSync} from '../src/network/AuthoritativeDiceSync.js';

class FakeClient {
  listeners = new Map();
  on(name, listener) { this.listeners.set(name, listener); return () => this.listeners.delete(name); }
  emit(name, payload) { return this.listeners.get(name)?.(payload); }
}

function setup() {
  const state = new GameState();
  const snapshot = state.toSnapshot();
  snapshot.players = snapshot.players.slice(0, 2).map((player, seat) => ({...player, playerId: `p${seat + 1}`, seat}));
  snapshot.players[0].pos = 10; snapshot.players[0].status = 'IN_JAIL'; snapshot.players[0].inJail = true;
  snapshot.players[0].money = 100; snapshot.activePlayerId = 'p1'; snapshot.currentTurn = 0;
  snapshot.turnId = 1; snapshot.phase = 'WAITING_ROLL';
  const store = new ClientGameStore(state); store.setSnapshot({...snapshot, roomCode: 'JA1L01'});
  const client = new FakeClient(); const room = {roomCode: 'JA1L01', status: 'started'};
  initAuthoritativeDiceSync({client, store, getActiveRoom: () => room, logger: {warn() {}}});
  initJailResolutionSync({client, store, getActiveRoom: () => room, logger: {warn() {}}});
  return {state, store, client, room};
}

test('jail action result sync accepts authoritative release once and rejects replay or cross-room event', () => {
  const clients = [setup(), setup()];
  const makeEvent = () => {
    const snapshot = clients[0].state.toSnapshot(); snapshot.roomCode = 'JA1L01';
    snapshot.players[0].status = 'ACTIVE'; snapshot.players[0].inJail = false; snapshot.players[0].jailTurns = 0;
    snapshot.players[0].money = 50;
    snapshot.transactions.push({id: 'tx_jail_action_jail-sync-1', time: 'now', players: ['Player 1'], amount: 50, type: 'BAIL'});
    return {roomCode: 'JA1L01', actionId: 'jail-sync-1', action: 'PAY_BAIL', playerId: 'p1', playerName: 'Player 1',
      turnId: 1, cost: 50, balance: 50, hasGetOutOfJailCard: 0, jailTurns: 0, status: 'ACTIVE', inJail: false,
      phase: 'WAITING_ROLL', snapshot};
  };
  const events = clients.map(makeEvent);
  assert.deepEqual(clients.map(({client}, index) => client.emit('game:jail-action-resolved', events[index])), [true, true]);
  assert.equal(clients[0].store.getBalance('p1'), clients[1].store.getBalance('p1'));
  assert.equal(clients[0].state.players[0].status, 'ACTIVE');
  assert.equal(clients[0].client.emit('game:jail-action-resolved', events[0]), false);
  clients[1].room.roomCode = 'OTHER1';
  assert.equal(clients[1].client.emit('game:jail-action-resolved', makeEvent()), false);
});

test('jailed roll uses the server dice and failed result advances the same snapshot on both clients', () => {
  const clients = [setup(), setup()];
  const dice = {roomCode: 'JA1L01', playerId: 'p1', seat: 0, die1: 2, die2: 3, total: 5, isDouble: false,
    consecutiveDoubles: 0, tripleDouble: false, jailAttempt: true, jailReleased: false, turnId: 1, phase: 'JAIL_ATTEMPT'};
  assert.deepEqual(clients.map(({client}) => client.emit('game:dice-rolled', {...dice})), [true, true]);
  const makeResolution = ({state}) => {
    const snapshot = state.toSnapshot(); snapshot.roomCode = 'JA1L01';
    snapshot.players[0].jailTurns = 1; snapshot.currentTurn = 1; snapshot.activePlayerId = 'p2';
    snapshot.turnId = 2; snapshot.phase = 'WAITING_ROLL'; snapshot.lastRoll = null; snapshot.consecutiveDoubles = 0;
    return {roomCode: 'JA1L01', actionId: 'jail-roll-failed-1', outcome: 'FAILED', playerId: 'p1',
      playerName: 'Player 1', previousTurnId: 1, turnId: 2, total: 5, isDouble: false, jailTurns: 1,
      status: 'IN_JAIL', inJail: true, balance: 1500, phase: 'WAITING_ROLL', snapshot};
  };
  const results = clients.map(makeResolution);
  assert.deepEqual(clients.map(({client}, index) => client.emit('game:jail-action-resolved', results[index])), [true, true]);
  for (const {store} of clients) {
    assert.equal(store.getState().turnId, 2);
    assert.equal(store.getState().activePlayerId, 'p2');
    assert.equal(store.getPlayer('p1').status, 'IN_JAIL');
    assert.equal(store.getPlayer('p1').jailTurns, 1);
  }
});
