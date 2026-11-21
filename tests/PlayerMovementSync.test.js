import test from 'node:test';
import assert from 'node:assert/strict';
import {GameState} from '../src/logic/GameStateCore.js';
import {calculateMovement} from '../src/logic/movement.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {initPlayerMovementSync} from '../src/network/PlayerMovementSync.js';
import {playMovementAfterDice} from '../src/logic/movementPresentation.js';

class FakeClient {
  listeners = new Map();
  on(name, listener) { this.listeners.set(name, listener); return () => this.listeners.delete(name); }
  emit(name, payload) { return this.listeners.get(name)?.(payload); }
}

const room = {
  roomCode: 'AB2CD3', status: 'started', minPlayers: 2, maxPlayers: 4,
  players: [
    {playerId: 'host-id', playerName: 'Host'},
    {playerId: 'guest-id', playerName: 'Guest'}
  ]
};

function makeStore() {
  const state = new GameState();
  state.players.splice(0, state.players.length,
    {...state.players[0], playerId: 'host-id', name: 'Host', seat: 0, pos: 38, money: 1500},
    {...state.players[1], playerId: 'guest-id', name: 'Guest', seat: 1, pos: 0, money: 1500});
  state.activePlayerId = 'host-id';
  state.currentTurn = 0;
  state.turnId = 1;
  state.phase = 'WAITING_ROLL';
  const store = new ClientGameStore(state);
  store.applyDiceResult({die1: 1, die2: 1, total: 2, phase: 'MOVING', turnId: 1, playerId: 'host-id'});
  return store;
}

const startMovement = {
  roomCode: 'AB2CD3', movementId: 'AB2CD3:turn-1', playerId: 'host-id', seat: 0,
  turnId: 1, startPos: 38, endPos: 0, steps: 2, diceTotal: 2,
  passedStart: true, startBonus: 200, balance: 1700, phase: 'WAITING_TILE_RESOLUTION',
  transactions: [{id: 'tx_start_1_AB2CD3:turn-1', type: 'SALARY', amount: 200, players: ['Host']}]
};

test('shared movement calculator wraps positions and detects exact START arrival', () => {
  assert.deepEqual(calculateMovement(38, 2, 40), {
    startPos: 38, endPos: 0, steps: 2, passedStart: true
  });
  assert.deepEqual(calculateMovement(0, 1, 40), {
    startPos: 0, endPos: 1, steps: 1, passedStart: false
  });
  assert.throws(() => calculateMovement(40, 1, 40), RangeError);
});

test('movement sync validates server movement, updates official position and balance once, and tracks animation completion', () => {
  const store = makeStore();
  const client = new FakeClient();
  const playersRef = store.getPlayers();
  const propertiesRef = store.getState().properties;
  const updates = [];
  store.subscribe(({change}) => updates.push(change.type));
  initPlayerMovementSync({client, store, getActiveRoom: () => room, tileCount: 40, logger: {warn() {}}});

  assert.equal(client.emit('game:player-moved', {...startMovement, endPos: 1}), false);
  assert.equal(store.getPlayer('host-id').pos, 38);
  assert.equal(store.getPlayer('host-id').money, 1500);
  assert.equal(client.emit('game:player-moved', {...startMovement, roomCode: 'WRONG1'}), false);
  assert.equal(client.emit('game:player-moved', startMovement), true);
  assert.equal(client.emit('game:player-moved', startMovement), false);
  assert.equal(store.getPlayers(), playersRef);
  assert.equal(store.getState().properties, propertiesRef);
  assert.equal(store.getPlayer('host-id').pos, 0);
  assert.equal(store.getPlayer('host-id').money, 1700);
  assert.equal(store.getState().transactions.some(tx => tx.id === startMovement.transactions[0].id), true);
  assert.equal(store.getState().phase, 'WAITING_TILE_RESOLUTION');
  assert.deepEqual(store.presentation.movement, {movementId: startMovement.movementId, status: 'ANIMATING'});
  assert.equal(store.completeMovement(startMovement.movementId), true);
  assert.deepEqual(store.presentation.movement, {movementId: startMovement.movementId, status: 'COMPLETE'});
  assert.deepEqual(updates, ['player-moved', 'movement-animation-complete']);
});

test('independent clients accept the same movement and end at the same official position', async () => {
  const first = makeStore();
  const second = makeStore();
  first.beginDiceAnimation(1);
  second.beginDiceAnimation(1);
  const firstClient = new FakeClient();
  const secondClient = new FakeClient();
  initPlayerMovementSync({client: firstClient, store: first, getActiveRoom: () => room, tileCount: 40, logger: {warn() {}}});
  initPlayerMovementSync({client: secondClient, store: second, getActiveRoom: () => room, tileCount: 40, logger: {warn() {}}});
  assert.equal(firstClient.emit('game:player-moved', startMovement), true);
  assert.equal(secondClient.emit('game:player-moved', startMovement), true);
  assert.equal(first.getPlayer('host-id').pos, second.getPlayer('host-id').pos);
  assert.equal(first.getPlayer('host-id').money, second.getPlayer('host-id').money);

  const firstOrder = [];
  const secondOrder = [];
  const makeSequence = (store, order) => playMovementAfterDice({
    turnId: 1,
    waitForDiceAnimation: id => store.waitForDiceAnimation(id),
    delay: async ms => order.push(`delay-${ms}`),
    animate: async () => order.push('move-token')
  });
  const firstSequence = makeSequence(first, firstOrder);
  const secondSequence = makeSequence(second, secondOrder);
  assert.deepEqual(firstOrder, []);
  assert.deepEqual(secondOrder, []);
  first.completeDiceAnimation(1);
  await firstSequence;
  assert.deepEqual(firstOrder, ['delay-1000', 'move-token']);
  assert.deepEqual(secondOrder, []);
  second.completeDiceAnimation(1);
  await secondSequence;
  assert.deepEqual(secondOrder, ['delay-1000', 'move-token']);
});

test('movement waits for dice animation completion, then waits 1000ms before starting', async () => {
  const store = new ClientGameStore(new GameState());
  const order = [];
  store.beginDiceAnimation(4);
  const sequence = playMovementAfterDice({
    turnId: 4,
    waitForDiceAnimation: turnId => {
      order.push('wait-dice');
      return store.waitForDiceAnimation(turnId);
    },
    onDiceAnimationComplete: () => { order.push('show-landing-marker'); },
    delay: async duration => { order.push(`delay-${duration}`); },
    animate: async () => { order.push('move-token'); }
  });

  await Promise.resolve();
  assert.deepEqual(order, ['wait-dice']);
  assert.equal(store.completeDiceAnimation(3), false);
  assert.deepEqual(order, ['wait-dice']);
  assert.equal(store.completeDiceAnimation(4), true);
  await sequence;
  assert.deepEqual(order, ['wait-dice', 'show-landing-marker', 'delay-1000', 'move-token']);
  assert.equal(store.completeDiceAnimation(4), false);
});
