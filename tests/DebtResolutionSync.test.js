import test from 'node:test';
import assert from 'node:assert/strict';
import {GameState} from '../src/logic/GameStateCore.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {ServerGameState} from '../server/src/game/ServerGameState.js';
import {initDebtResolutionSync} from '../src/network/DebtResolutionSync.js';

class FakeClient {
  listeners = new Map();
  on(name, listener) { this.listeners.set(name, listener); return () => this.listeners.delete(name); }
  emit(name, payload) { return this.listeners.get(name)?.(payload); }
}

function makeServer() {
  const server = new ServerGameState({roomCode: 'DEBT01', roster: [
    {playerId: 'p1', playerName: 'Pemain 1'}, {playerId: 'p2', playerName: 'Pemain 2'}
  ]});
  const player = server.state.players[0];
  player.pos = 4; player.money = 30;
  server.state.phase = 'WAITING_TILE_RESOLUTION';
  server.state.lastRoll = {dice: [1, 2], total: 3, isDouble: false, movementId: 'move-1'};
  server.state.properties.get(39).owner = player.playerId;
  player.properties.push('prop_39');
  return server;
}

test('low tax creates persistent authoritative debt; mortgage and payment sync to both stores', () => {
  const server = makeServer();
  const game = new GameState();
  const store = new ClientGameStore(game);
  store.setSnapshot(server.toPublicSnapshot());
  const room = {roomCode: 'DEBT01', status: 'started'};
  const client = new FakeClient();
  initDebtResolutionSync({client, store, getActiveRoom: () => room, logger: {warn() {}}});

  const created = server.resolveLandedTile({playerId: 'p1', turnId: 1, movementId: 'move-1', resolutionId: 'tax-origin'});
  assert.equal(created.resolution.kind, 'DEBT_CREATED');
  const creationEvent = server.debtStateEvent('CREATED', created.resolution.event);
  assert.equal(client.emit('game:debt-created', creationEvent), true);
  assert.equal(store.getPhase(), 'DEBT_RESOLUTION');
  assert.equal(store.pendingDebt.debtType, 'TAX');
  assert.equal(store.getBalance('p1'), 30);

  const debtId = server.pendingDebt.debtId;
  const mortgage = server.resolveDebtAction({playerId: 'p1', turnId: 1, debtId, actionId: 'mortgage-39', action: 'MORTGAGE', propertyPos: 39});
  const mortgageEvent = server.debtStateEvent('UPDATED', mortgage.result);
  assert.equal(client.emit('game:debt-state', mortgageEvent), true);
  assert.equal(store.getProperty(39).isMortgaged, true);
  assert.equal(store.getBalance('p1'), 230);
  assert.equal(store.pendingDebt.debtId, debtId);

  const payment = server.resolveDebtAction({playerId: 'p1', turnId: 1, debtId, actionId: 'pay-tax', action: 'PAY'});
  const paymentEvent = server.debtStateEvent('RESOLVED', payment.result);
  assert.equal(client.emit('game:debt-state', paymentEvent), true);
  assert.equal(store.pendingDebt, null);
  assert.equal(store.getPhase(), 'PLAYER_ACTION');
  assert.equal(store.getBalance('p1'), 30);
  assert.equal(store.getState().transactions.at(-1).type, 'TAX');
});

test('rent insufficiency installs rent creditor debt without transferring money or advancing turn', () => {
  const server = makeServer();
  const property = server.state.properties.get(3);
  property.owner = 'p2'; property.hasHotel = true;
  server.state.players[0].pos = 3;
  const preResolution = server.toPublicSnapshot();
  const store = new ClientGameStore(new GameState());
  store.setSnapshot(preResolution);
  store.lastMovementId = 'move-1';
  const result = server.resolveLandedTile({playerId: 'p1', turnId: 1, movementId: 'move-1', resolutionId: 'rent-origin'});
  const event = result.resolution.event;
  assert.equal(event.rent.outcome, 'INSUFFICIENT_FUNDS');
  assert.equal(event.debt.creditorId, 'p2');
  assert.equal(store.applyRentResolution(event), true);
  assert.equal(store.pendingDebt.debtType, 'RENT');
  assert.equal(store.pendingDebt.creditorId, 'p2');
  assert.equal(store.getPhase(), 'DEBT_RESOLUTION');
  assert.equal(store.getBalance('p2'), 1500);
  assert.equal(store.getCurrentTurn(), 0);
});
