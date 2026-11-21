import test from 'node:test';
import assert from 'node:assert/strict';
import {GameState} from '../src/logic/GameStateCore.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {initFreeParkingResolutionSync} from '../src/network/FreeParkingResolutionSync.js';
import {initPlayerMovementSync} from '../src/network/PlayerMovementSync.js';
import {initMultiplayerFreeParking} from '../src/ui/MultiplayerFreeParking.js';

class FakeClient {
  listeners = new Map(); requests = [];
  on(name, listener) { this.listeners.set(name, listener); return () => this.listeners.delete(name); }
  emit(name, payload) { return this.listeners.get(name)?.(payload); }
  isConnected() { return true; }
  request(name, payload) { this.requests.push({name, payload}); return Promise.resolve({ok: true}); }
}

function setup() {
  const state = new GameState();
  const snapshot = state.toSnapshot();
  snapshot.players = snapshot.players.slice(0, 2).map((player, seat) => ({...player, playerId: `p${seat + 1}`, seat}));
  snapshot.players[0].pos = 20; snapshot.players[0].money = 1500;
  snapshot.activePlayerId = 'p1'; snapshot.currentTurn = 0; snapshot.turnId = 2; snapshot.phase = 'WAITING_ROLL';
  snapshot.pendingFreeParkingDecision = {playerId: 'p1', turnId: 2};
  const store = new ClientGameStore(state); store.setSnapshot({...snapshot, roomCode: 'PARK01'});
  const client = new FakeClient(), room = {roomCode: 'PARK01', status: 'started'};
  initFreeParkingResolutionSync({client, store, getActiveRoom: () => room, logger: {warn() {}}});
  initPlayerMovementSync({client, store, getActiveRoom: () => room, tileCount: 40, logger: {warn() {}}});
  return {state, store, client, room};
}

test('two clients apply Free Parking choice and START-crossing travel movement with transactions once', () => {
  const clients = [setup(), setup()];
  const makeDecision = () => ({roomCode: 'PARK01', actionId: 'parking-sync-1', action: 'TRAVEL', outcome: 'TRAVEL_STARTED',
    playerId: 'p1', playerName: 'Player 1', turnId: 2, startPos: 20, targetPos: 1, steps: 21, cost: 50, phase: 'MOVING'});
  assert.deepEqual(clients.map(({client}) => client.emit('game:free-parking-action-resolved', makeDecision())), [true, true]);
  const transactions = [
    {id: 'tx_free_parking_parking-sync-1', players: ['Player 1'], amount: 50, type: 'PARKING_TRAVEL'},
    {id: 'tx_free_parking_parking-sync-1_start', players: ['Player 1'], amount: 200, type: 'SALARY'}
  ];
  const movement = {roomCode: 'PARK01', movementId: 'parking-move-1', movementType: 'FREE_PARKING_TRAVEL',
    travelActionId: 'parking-sync-1', travelCost: 50, transactions, playerId: 'p1', seat: 0, turnId: 2,
    startPos: 20, endPos: 1, steps: 21, diceTotal: 21, passedStart: true, startBonus: 200, balance: 1650,
    phase: 'WAITING_TILE_RESOLUTION'};
  assert.deepEqual(clients.map(({client}) => client.emit('game:player-moved', {...movement, transactions: transactions.map(tx => ({...tx, players: [...tx.players]}))})), [true, true]);
  for (const {store, client} of clients) {
    assert.equal(store.getPlayer('p1').pos, 1);
    assert.equal(store.getBalance('p1'), 1650);
    assert.equal(store.getState().transactions.filter(tx => ['PARKING_TRAVEL', 'SALARY'].includes(tx.type)).length, 2);
    assert.equal(store.getState().lastRoll.total, null);
    assert.equal(client.emit('game:player-moved', movement), false);
  }
});

test('choosing to stay clears the pending decision and leaves the same turn ready to roll', () => {
  const {state, store, client} = setup();
  const snapshot = state.toSnapshot(); snapshot.roomCode = 'PARK01'; snapshot.pendingFreeParkingDecision = null;
  const event = {roomCode: 'PARK01', actionId: 'parking-stay-1', action: 'STAY', outcome: 'STAY',
    playerId: 'p1', playerName: 'Player 1', turnId: 2, balance: 1500, phase: 'WAITING_ROLL', snapshot};
  assert.equal(client.emit('game:free-parking-action-resolved', event), true);
  assert.equal(store.pendingFreeParkingDecision, null);
  assert.equal(store.getPhase(), 'WAITING_ROLL');
  assert.equal(client.emit('game:free-parking-action-resolved', event), false);
});

test('store discovers a Free Parking decision when an authoritative turn advance selects a player at tile 20', () => {
  const state = new GameState(), snapshot = state.toSnapshot();
  snapshot.players = snapshot.players.slice(0, 2).map((player, seat) => ({...player, playerId: `p${seat + 1}`, seat}));
  snapshot.activePlayerId = 'p1'; snapshot.currentTurn = 0; snapshot.turnId = 1; snapshot.phase = 'WAITING_ROLL';
  const store = new ClientGameStore(state); store.setSnapshot({...snapshot, roomCode: 'PARK02'});
  state.players[1].pos = 20; state.currentTurn = 1; state.activePlayerId = 'p2'; state.turnId = 2; state.phase = 'WAITING_ROLL';
  store.notify({type: 'turn-advanced'});
  assert.deepEqual(store.pendingFreeParkingDecision, {playerId: 'p2', turnId: 2});
});

test('only local active player receives enabled Free Parking decisions and sends only choice data', async () => {
  const {store, client, room} = setup();
  let promptOptions;
  const modal = {isOpen: () => false, close() {}, promptTravel(_player, options) { promptOptions = options; }};
  initMultiplayerFreeParking({client, store, modal, getActiveRoom: () => room, getLocalPlayerId: () => 'p1'});
  assert.equal(promptOptions.canAct, true);
  await promptOptions.onAction('TRAVEL', 1);
  assert.equal(client.requests[0].name, 'game:free-parking-action');
  assert.deepEqual({...client.requests[0].payload, actionId: 'omitted'}, {
    turnId: 2, actionId: 'omitted', action: 'TRAVEL', targetPos: 1
  });
  assert.equal('cost' in client.requests[0].payload, false);

  const readOnlyStore = setup().store;
  let readOnlyOptions;
  let closedReadOnlyModal = false;
  initMultiplayerFreeParking({client: new FakeClient(), store: readOnlyStore,
    modal: {isOpen: () => true, close() { closedReadOnlyModal = true; }, promptTravel(_player, options) { readOnlyOptions = options; }},
    getActiveRoom: () => room, getLocalPlayerId: () => 'p2'});
  assert.equal(readOnlyOptions, undefined);
  assert.equal(closedReadOnlyModal, true);
});
