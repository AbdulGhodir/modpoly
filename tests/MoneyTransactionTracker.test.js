import test from 'node:test';
import assert from 'node:assert/strict';
import {GameState} from '../src/logic/GameStateCore.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {MoneyTransactionTracker} from '../src/network/MoneyTransactionTracker.js';
import {getAnimatedBalanceChanges, MovementMoneyPresentation} from '../src/network/MovementMoneyPresentation.js';

function setup(onBalanceChange, isMultiplayer = () => true) {
  const state = new GameState();
  const snapshot = state.toSnapshot();
  snapshot.players = snapshot.players.slice(0, 3).map((player, seat) => ({...player, playerId: `p${seat + 1}`, seat}));
  snapshot.players.forEach(player => { player.money = 1500; });
  snapshot.activePlayerId = 'p1'; snapshot.currentTurn = 0; snapshot.turnId = 1;
  snapshot.roomCode = 'MONEY1';
  const store = new ClientGameStore(state);
  store.setSnapshot(snapshot);
  const tracker = new MoneyTransactionTracker({store, isMultiplayer, onBalanceChange});
  return {store, tracker};
}

function commit(store, transactionId, deltas, type = 'TEST') {
  for (const [playerId, delta] of Object.entries(deltas)) store.getPlayer(playerId).money += delta;
  store.getState().transactions.push({id: transactionId, type, amount: Math.max(...Object.values(deltas).map(Math.abs)), players: []});
  store.notify({type: 'authoritative-test-transaction'});
}

test('new authoritative transactions animate every changed profile with its signed balance delta', () => {
  const events = [];
  const {store} = setup(event => events.push(event));
  commit(store, 'rent-1', {p1: -100, p2: 100}, 'RENT');
  commit(store, 'tax-1', {p1: -50}, 'TAX');
  commit(store, 'chance-1', {p3: 200}, 'CARD_REWARD');
  assert.deepEqual(events.map(event => event.changes), [
    [{playerId: 'p1', delta: -100}, {playerId: 'p2', delta: 100}],
    [{playerId: 'p1', delta: -50}],
    [{playerId: 'p3', delta: 200}]
  ]);
  assert.deepEqual(events.map(event => event.transactionIds), [['rent-1'], ['tax-1'], ['chance-1']]);
  assert.equal(events[0].transactions[0].type, 'RENT');
});

test('transactions without a player balance change, and balance changes without a transaction, do not animate', () => {
  const balanceOnlyEvents = [];
  const {store: balanceOnlyStore} = setup(event => balanceOnlyEvents.push(event));
  balanceOnlyStore.getPlayer('p1').money -= 25;
  balanceOnlyStore.notify({type: 'unlogged-change'});
  assert.deepEqual(balanceOnlyEvents, []);

  const metadataOnlyEvents = [];
  const {store: metadataOnlyStore} = setup(event => metadataOnlyEvents.push(event));
  metadataOnlyStore.getState().transactions.push({id: 'no-balance-change', type: 'TEST', amount: 10, players: []});
  metadataOnlyStore.notify({type: 'metadata-only'});
  assert.deepEqual(metadataOnlyEvents, []);
});

test('duplicate notifications and recovered snapshots never replay old money animations', () => {
  const events = [];
  const {store} = setup(event => events.push(event));
  commit(store, 'purchase-1', {p1: -60}, 'BUY_PROP');
  store.notify({type: 'duplicate-notification'});
  const recovered = store.getSnapshot();
  recovered.players[0].money -= 300;
  recovered.transactions.push({id: 'old-recovered-transaction', type: 'TAX', amount: 300, players: []});
  store.setSnapshot(recovered);
  store.notify({type: 'late-duplicate'});
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].changes, [{playerId: 'p1', delta: -60}]);
});

test('closely spaced transactions each produce an independent update for the presentation layer', () => {
  const events = [];
  const {store} = setup(event => events.push(event));
  commit(store, 'salary-1', {p1: 200}, 'SALARY');
  commit(store, 'jail-1', {p1: -50}, 'BAIL');
  assert.deepEqual(events.map(event => event.changes[0].delta), [200, -50]);
});

test('balance changes that arrive before transaction metadata are matched when the transaction is recorded', () => {
  const events = [];
  const {store} = setup(event => events.push(event));
  store.getPlayer('p1').money += 200;
  store.notify({type: 'official-movement-snapshot'});
  assert.equal(events.length, 0);
  store.getState().transactions.push({id: 'start-salary-1', type: 'SALARY', amount: 200, players: []});
  store.notify({type: 'official-movement-transaction'});
  assert.deepEqual(events[0].changes, [{playerId: 'p1', delta: 200}]);
});

test('tracker stays quiet outside multiplayer while updating its balance baseline', () => {
  const events = [];
  let multiplayer = false;
  const {store, tracker} = setup(event => events.push(event), () => multiplayer);
  commit(store, 'offline-1', {p1: 200}, 'SALARY');
  multiplayer = true;
  commit(store, 'online-1', {p2: -25}, 'TAX');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].changes, [{playerId: 'p2', delta: -25}]);
  tracker.destroy();
});

test('rent and tax money presentation waits for the official movement animation to finish', () => {
  const state = new GameState();
  const snapshot = state.toSnapshot();
  snapshot.roomCode = 'MONEY1';
  const store = new ClientGameStore(state);
  store.setSnapshot(snapshot);
  const shown = [];
  const animation = new MovementMoneyPresentation({store, present: payload => shown.push(payload)});
  store.presentation.movements.set('move-rent', {movementId: 'move-rent', status: 'ANIMATING'});
  state.players[0].money -= 75;
  state.players[1].money += 75;
  const rent = {id: 'rent-after-move', type: 'RENT', amount: 75, players: ['Pemain 1', 'Pemain 2']};
  state.transactions.push(rent);
  animation.handleBalanceChange({transactions: [rent], changes: [{playerId: 'player-1', delta: -75},
    {playerId: 'player-2', delta: 75}], change: {type: 'rent-resolved', detail: {movementId: 'move-rent'}}});
  assert.equal(shown.length, 0);

  store.presentation.movements.get('move-rent').status = 'COMPLETE';
  animation.handleStoreChange({type: 'movement-animation-complete', detail: {movementId: 'move-rent'}});
  assert.equal(shown.length, 1);
  assert.equal(shown[0].transactions[0].type, 'RENT');

  store.presentation.movements.set('move-tax', {movementId: 'move-tax', status: 'ANIMATING'});
  const tax = {id: 'tax-after-move', type: 'TAX', amount: 100, players: ['Pemain 1', 'Bank']};
  animation.handleBalanceChange({transactions: [tax], changes: [{playerId: 'player-1', delta: -100}],
    change: {type: 'tile-resolved', detail: {movementId: 'move-tax'}}});
  assert.equal(shown.length, 1);
  animation.handleStoreChange({type: 'movement-animation-complete', detail: {movementId: 'move-tax'}});
  assert.equal(shown.length, 2);
  assert.equal(shown[1].transactions[0].type, 'TAX');
  animation.clear();
});

test('START salary is rendered at the board step instead of a duplicate balance popup', () => {
  const players = [{playerId: 'p1', name: 'Pemain 1'}];
  const changes = [{playerId: 'p1', delta: 200}];
  const salary = [{type: 'SALARY', amount: 200, players: ['Pemain 1']}];
  assert.deepEqual(getAnimatedBalanceChanges(changes, salary, players), []);

  const netTravel = [{playerId: 'p1', delta: 150}];
  const travelAndSalary = [...salary, {type: 'PARKING_TRAVEL', amount: 50, players: ['Pemain 1']}];
  assert.deepEqual(getAnimatedBalanceChanges(netTravel, travelAndSalary, players), [{playerId: 'p1', delta: -50}]);
});
