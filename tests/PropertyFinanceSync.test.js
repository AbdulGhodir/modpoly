import test from 'node:test';
import assert from 'node:assert/strict';
import {GameState} from '../src/logic/GameStateCore.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {initPropertyFinanceSync} from '../src/network/PropertyFinanceSync.js';

class FakeClient {
  listeners = new Map();
  on(name, listener) { this.listeners.set(name, listener); return () => this.listeners.delete(name); }
  emit(name, payload) { return this.listeners.get(name)?.(payload); }
}

function setup() {
  const state = new GameState();
  const snapshot = state.toSnapshot();
  snapshot.players = snapshot.players.slice(0, 2).map((player, seat) => ({...player, playerId: `p${seat + 1}`, seat}));
  snapshot.players[0].money = 1500; snapshot.players[1].money = 1500;
  snapshot.phase = 'WAITING_ROLL'; snapshot.currentTurn = 0; snapshot.turnId = 4; snapshot.activePlayerId = 'p1';
  snapshot.properties = [[3, {id: 'prop_3', pos: 3, name: 'Laos', type: 'prop', owner: 'p1',
    isMortgaged: false, mortgageValue: 60, price: 120, houses: 0, hasHotel: false, group: 'Brown'}]];
  const store = new ClientGameStore(state); store.setSnapshot(snapshot);
  const client = new FakeClient(), room = {roomCode: 'AB2CD3', status: 'started'};
  initPropertyFinanceSync({client, store, getActiveRoom: () => room, logger: {warn() {}}});
  return {store, client, room};
}

function eventFor(action) {
  const mortgage = action === 'MORTGAGE';
  const amount = mortgage ? 60 : 66;
  const balance = mortgage ? 1560 : 1434;
  const before = !mortgage, after = mortgage;
  const type = action;
  const resolutionId = `finance-${action.toLowerCase()}`;
  return {roomCode: 'AB2CD3', resolutionId, action, playerId: 'p1', playerName: 'Pemain 1', seat: 0,
    turnId: 4, currentTurn: 0, activePlayerId: 'p1', phase: 'WAITING_ROLL', propertyPos: 3,
    propertyId: 'prop_3', propertyName: 'Laos', owner: 'p1', statusBefore: before, statusAfter: after,
    amount, balance, property: {id: 'prop_3', pos: 3, name: 'Laos', owner: 'p1', isMortgaged: after, houses: 0, hasHotel: false},
    transaction: {id: `tx_${resolutionId}`, players: ['Pemain 1', 'Bank'], amount, type},
    balances: [{playerId: 'p1', money: balance}, {playerId: 'p2', money: 1500}], message: 'Finance'};
}

test('both mortgage and redemption update balance, property status, transaction, and board-facing state once', () => {
  const {store, client} = setup();
  const mortgage = eventFor('MORTGAGE');
  assert.equal(client.emit('game:property-finance-resolved', mortgage), true);
  assert.equal(store.getProperty(3).isMortgaged, true);
  assert.equal(store.getBalance('p1'), 1560);
  assert.equal(store.getState().transactions[0].type, 'MORTGAGE');
  assert.equal(client.emit('game:property-finance-resolved', mortgage), false);

  const redemption = eventFor('UNMORTGAGE');
  redemption.balance = 1494;
  redemption.balances[0].money = 1494;
  assert.equal(client.emit('game:property-finance-resolved', redemption), true);
  assert.equal(store.getProperty(3).isMortgaged, false);
  assert.equal(store.getBalance('p1'), 1494);
  assert.deepEqual(store.getState().transactions.map(item => item.type), ['MORTGAGE', 'UNMORTGAGE']);
});

test('rejects forged finance amount, owner, room, phase, and property state without mutation', () => {
  const {store, client, room} = setup();
  const forgedAmount = eventFor('MORTGAGE'); forgedAmount.amount = 1; forgedAmount.balance = 1501;
  forgedAmount.balances[0].money = 1501;
  assert.equal(client.emit('game:property-finance-resolved', forgedAmount), false);
  const forgedOwner = eventFor('MORTGAGE'); forgedOwner.owner = 'p2'; forgedOwner.property.owner = 'p2';
  assert.equal(client.emit('game:property-finance-resolved', forgedOwner), false);
  const wrongPhase = eventFor('MORTGAGE'); wrongPhase.phase = 'WAITING_TILE_RESOLUTION';
  assert.equal(client.emit('game:property-finance-resolved', wrongPhase), false);
  room.roomCode = 'ZZZZZZ';
  assert.equal(client.emit('game:property-finance-resolved', eventFor('MORTGAGE')), false);
  assert.equal(store.getProperty(3).isMortgaged, false);
  assert.equal(store.getBalance('p1'), 1500);
});
