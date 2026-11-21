import test from 'node:test';
import assert from 'node:assert/strict';
import {GameState} from '../src/logic/GameStateCore.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {initRentResolutionSync} from '../src/network/RentResolutionSync.js';
import {initChanceResolutionSync} from '../src/network/ChanceResolutionSync.js';
import {CHANCE_CARDS} from '../src/data/cards.js';
import {initMultiplayerRentResolution} from '../src/ui/MultiplayerRentResolution.js';

class FakeClient {
  listeners = new Map();
  on(name, listener) { this.listeners.set(name, listener); return () => this.listeners.delete(name); }
  emit(name, payload) { return this.listeners.get(name)?.(payload); }
}

function setup() {
  const state = new GameState();
  const snapshot = state.toSnapshot();
  snapshot.players = snapshot.players.slice(0, 2).map((player, seat) => ({...player, playerId: `p${seat + 1}`, seat}));
  snapshot.players[0].pos = 3;
  snapshot.players[0].money = 1500;
  snapshot.players[1].money = 1500;
  snapshot.activePlayerId = 'p1';
  snapshot.currentTurn = 0;
  snapshot.turnId = 1;
  snapshot.phase = 'WAITING_TILE_RESOLUTION';
  snapshot.lastRoll = {dice: [1, 2], total: 3, isDouble: false};
  snapshot.properties = [[3, {id: 'prop_3', pos: 3, name: 'Laos', type: 'prop', owner: 'p2', isMortgaged: false}]];
  const store = new ClientGameStore(state);
  store.setSnapshot(snapshot);
  store.lastMovementId = 'move-1';
  const client = new FakeClient();
  const room = {roomCode: 'AB2CD3', status: 'started'};
  initRentResolutionSync({client, store, getActiveRoom: () => room, logger: {warn() {}}});
  return {state, store, client, room};
}

const paidEvent = () => ({roomCode: 'AB2CD3', resolutionId: 'rent-1', movementId: 'move-1',
  playerId: 'p1', seat: 0, previousTurnId: 1, turnId: 1, currentTurn: 0, round: 1, activePlayerId: 'p1',
  phase: 'PLAYER_ACTION', balance: 1400, status: 'ACTIVE', inJail: false, jailTurns: 0,
  consecutiveDoubles: 0, extraRollAllowed: false, message: 'Sewa dibayar.',
  rent: {resolutionId: 'rent-1', propertyPos: 3, propertyId: 'prop_3', propertyName: 'Laos', propertyType: 'prop',
    tenantId: 'p1', tenantName: 'Pemain 1', ownerId: 'p2', ownerName: 'Pemain 2', amount: 100, outcome: 'PAID',
    tenantBalance: 1400, ownerBalance: 1600,
    transaction: {id: 'tx_rent-1', players: ['Pemain 1', 'Pemain 2'], amount: 100, type: 'RENT'}},
  balances: [{playerId: 'p1', money: 1400}, {playerId: 'p2', money: 1600}]});

test('two clients apply the same authoritative rent once without a confirmation modal', () => {
  const clients = [setup(), setup()];
  const displayed = [[], []];
  clients.forEach(({store}, index) => initMultiplayerRentResolution({store, eventTarget: new EventTarget(),
    modalManager: {isOpen: () => false, showAuthoritativeRentResult: event => { displayed[index].push(event); return true; }}}));
  const events = [paidEvent(), paidEvent()];
  assert.deepEqual(clients.map(({client}, index) => client.emit('game:rent-resolved', events[index])), [true, true]);
  for (const {store, client} of clients) {
    assert.equal(store.getBalance('p1'), 1400);
    assert.equal(store.getBalance('p2'), 1600);
    assert.equal(store.getState().activePlayerId, 'p1');
    assert.equal(store.getState().transactions.filter(tx => tx.type === 'RENT').length, 1);
    assert.equal(client.emit('game:rent-resolved', paidEvent()), false);
  }
  assert.deepEqual(displayed, [[], []]);
});

test('insufficient rent leaves balances and turn unchanged and exposes held resolution', () => {
  const {store, client} = setup();
  store.getPlayer('p1').money = 50;
  const event = paidEvent();
  event.turnId = 1; event.currentTurn = 0; event.activePlayerId = 'p1'; event.balance = 50;
  event.phase = 'DEBT_RESOLUTION'; event.message = 'Saldo tidak cukup.';
  event.rent.outcome = 'INSUFFICIENT_FUNDS'; event.rent.amount = 100;
  event.rent.tenantBalance = 50; event.rent.ownerBalance = 1500; event.rent.transaction = null;
  event.debt = {debtId: 'debt-rent-1', playerId: 'p1', debtType: 'RENT', amount: 100,
    creditorId: 'p2', creditorName: 'Pemain 2', status: 'OPEN'};
  event.balances = [{playerId: 'p1', money: 50}, {playerId: 'p2', money: 1500}];
  assert.equal(client.emit('game:rent-resolved', event), true);
  assert.equal(store.getBalance('p1'), 50);
  assert.equal(store.getBalance('p2'), 1500);
  assert.equal(store.getState().turnId, 1);
  assert.equal(store.getPhase(), 'DEBT_RESOLUTION');
  assert.equal(store.pendingDebt.debtId, 'debt-rent-1');
  assert.equal(store.unsupportedTile, null);
});

test('client rejects forged owner, room, property, and rent data', () => {
  const {client, room} = setup();
  const badOwner = paidEvent(); badOwner.rent.ownerId = 'p1';
  assert.equal(client.emit('game:rent-resolved', badOwner), false);
  const badRoom = paidEvent(); badRoom.roomCode = 'ZZZZZZ';
  assert.equal(client.emit('game:rent-resolved', badRoom), false);
  room.status = 'waiting';
  assert.equal(client.emit('game:rent-resolved', paidEvent()), false);
});

test('successful automatic rent never queues a modal behind movement or Chance presentation', () => {
  const {store} = setup();
  const eventTarget = new EventTarget();
  const displayed = [];
  const manager = {isOpen: () => false, showAuthoritativeRentResult: event => { displayed.push(event); return true; }};
  initMultiplayerRentResolution({store, modalManager: manager, eventTarget});
  store.presentation.movement = {movementId: 'move-1', status: 'ANIMATING'};
  store.presentation.chancePending = true;
  store.notify({type: 'rent-resolved', detail: paidEvent()});
  assert.equal(displayed.length, 0);
  store.presentation.movement.status = 'COMPLETE';
  store.notify({type: 'movement-animation-complete', detail: {movementId: 'move-1'}});
  assert.equal(displayed.length, 0);
  store.presentation.chancePending = false;
  store.notify({type: 'chance-presentation-complete'});
  assert.equal(displayed.length, 0);
  eventTarget.dispatchEvent(new Event('tilemodal:closed'));
  assert.equal(store.presentation.rentPending, false);
});

test('Chance movement applies its pre-rent snapshot before the same rent resolution completes', () => {
  const state = new GameState();
  const snapshot = state.toSnapshot();
  snapshot.players = snapshot.players.slice(0, 2).map((player, seat) => ({...player, playerId: `p${seat + 1}`, seat}));
  snapshot.players[0].pos = 2;
  snapshot.activePlayerId = 'p1'; snapshot.currentTurn = 0; snapshot.turnId = 1; snapshot.phase = 'WAITING_TILE_RESOLUTION';
  snapshot.properties = [[24, {id: 'prop_24', pos: 24, name: 'Kota 24', type: 'prop', owner: 'p2', isMortgaged: false}]];
  const store = new ClientGameStore(state); store.setSnapshot(snapshot); store.lastMovementId = 'move-base';
  const client = new FakeClient(); const room = {roomCode: 'AB2CD3', status: 'started'};
  initChanceResolutionSync({client, store, getActiveRoom: () => room, tiles: [{pos: 2, type: 'chance'}], logger: {warn() {}}});
  initRentResolutionSync({client, store, getActiveRoom: () => room, logger: {warn() {}}});
  const card = {...CHANCE_CARDS.find(item => item.id === 'ch_5')};
  const presentationId = 'chance-rent-presentation';
  assert.equal(store.applyChancePresentation({roomCode: 'AB2CD3', resolutionId: 'chance-rent',
    presentationId, movementId: 'move-base', playerId: 'p1', recipientPlayerId: 'p1', seat: 0,
    previousTurnId: 1, turnId: 1, position: 2, phase: 'CHANCE_PRESENTATION', card}), true);
  const chance = {roomCode: 'AB2CD3', resolutionId: 'chance-rent', movementId: 'move-base', playerId: 'p1', seat: 0,
    presentationId, sourceMovementId: 'move-base',
    previousTurnId: 1, initialPosition: 2, position: 24, resultingPosition: 24, landedPosition: 24,
    card, cards: [card], movements: [{movementId: 'chance-rent:card:1', startPos: 2, endPos: 24, steps: 22,
      direction: 'forward', passedStart: false, startBonus: 0, balance: 1500}], destinationResolution: 'RENT_RESOLVED',
    destinationEvent: null, supported: true, balance: 1500, balances: [{playerId: 'p1', money: 1500}, {playerId: 'p2', money: 1500}],
    transactions: [], phase: 'PLAYER_ACTION', message: card.desc};
  assert.equal(client.emit('game:chance-resolved', chance), true);
  assert.equal(store.getPlayer('p1').pos, 24);
  assert.equal(store.getBalance('p1'), 1500);
  const rent = paidEvent();
  rent.resolutionId = 'chance-rent'; rent.movementId = 'chance-rent:card:1';
  rent.rent.resolutionId = 'chance-rent'; rent.rent.propertyPos = 24; rent.rent.propertyId = 'prop_24';
  rent.rent.propertyName = 'Kota 24'; rent.rent.amount = 100; rent.rent.tenantBalance = 1400; rent.rent.ownerBalance = 1600;
  rent.rent.transaction.id = 'tx_chance-rent'; rent.balances = [{playerId: 'p1', money: 1400}, {playerId: 'p2', money: 1600}];
  rent.balance = 1400;
  assert.equal(client.emit('game:rent-resolved', rent), true);
  assert.equal(store.getBalance('p1'), 1400);
  assert.equal(store.getBalance('p2'), 1600);
  assert.equal(store.getState().activePlayerId, 'p1');
});
