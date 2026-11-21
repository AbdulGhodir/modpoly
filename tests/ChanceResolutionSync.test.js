import test from 'node:test';
import assert from 'node:assert/strict';
import {GameState} from '../src/logic/GameStateCore.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {initChanceResolutionSync} from '../src/network/ChanceResolutionSync.js';
import {initChancePresentationSync} from '../src/network/ChancePresentationSync.js';
import {CHANCE_CARDS} from '../src/data/cards.js';

class FakeClient {
  listeners = new Map();
  on(name, listener) { this.listeners.set(name, listener); return () => this.listeners.delete(name); }
  emit(name, payload) { return this.listeners.get(name)?.(payload); }
}

function setupClient() {
  const state = new GameState();
  const store = new ClientGameStore(state);
  const snapshot = state.toSnapshot();
  snapshot.roomCode = 'AB2CD3';
  snapshot.players = snapshot.players.slice(0, 2).map((player, seat) => ({...player, playerId: `p${seat + 1}`, seat}));
  snapshot.activePlayerId = 'p1'; snapshot.currentTurn = 0; snapshot.turnId = 1; snapshot.round = 1;
  snapshot.phase = 'WAITING_TILE_RESOLUTION'; snapshot.players[0].pos = 2;
  store.setSnapshot(snapshot);
  store.lastMovementId = 'move-1';
  const client = new FakeClient();
  const room = {roomCode: 'AB2CD3', status: 'started', minPlayers: 2, maxPlayers: 4,
    players: [{playerId: 'p1', playerName: 'Pemain 1'}, {playerId: 'p2', playerName: 'Pemain 2'}]};
  const logger = {warn() {}};
  initChancePresentationSync({client, store, getActiveRoom: () => room, logger});
  initChanceResolutionSync({client, store, getActiveRoom: () => room, tiles: [{pos: 2, type: 'chance'}], logger});
  return {store, client, room};
}

const card = id => ({...CHANCE_CARDS.find(item => item.id === id)});
const presentation = cardId => ({roomCode: 'AB2CD3', resolutionId: `res-${cardId}`, presentationId: `pres-${cardId}`,
  movementId: 'move-1', playerId: 'p1', recipientPlayerId: 'p1', seat: 0, turnId: 1, previousTurnId: 1,
  position: 2, phase: 'CHANCE_PRESENTATION', card: card(cardId), cards: [card(cardId)]});

test('both clients receive the same pending card without applying its reward, then apply the official result once', () => {
  const clients = [setupClient(), setupClient()];
  const events = clients.map(() => presentation('ch_1'));
  assert.deepEqual(clients.map(({client}, i) => client.emit('game:chance-presented', events[i])), [true, true]);
  assert.deepEqual(clients.map(({store}) => [store.getPhase(), store.getBalance('p1'), store.state.transactions.length]),
    [['CHANCE_PRESENTATION', 1500, 0], ['CHANCE_PRESENTATION', 1500, 0]]);
  const result = {...presentation('ch_1'), position: 2, landedPosition: 2, supported: true,
    amount: 100, balance: 1600, balances: [{playerId: 'p1', money: 1600}, {playerId: 'p2', money: 1500}],
    transactions: [{id: 'tx_res-ch_1', players: ['Pemain 1', 'Bank'], amount: 100, type: 'CARD_REWARD'}],
    turnId: 1, currentTurn: 0, activePlayerId: 'p1', round: 1, phase: 'PLAYER_ACTION',
    consecutiveDoubles: 0, extraRollAllowed: false, message: 'Hadiah dari bank.'};
  assert.deepEqual(clients.map(({client}) => client.emit('game:chance-resolved', result)), [true, true]);
  assert.deepEqual(clients.map(({store}) => [store.getBalance('p1'), store.getPhase(), store.state.transactions.length]),
    [[1600, 'PLAYER_ACTION', 1], [1600, 'PLAYER_ACTION', 1]]);
  assert.equal(clients[0].client.emit('game:chance-resolved', result), false);
});

test('movement and START salary remain unapplied until continue, then accept only the official route', () => {
  const {store, client} = setupClient();
  const cardEvent = presentation('ch_4');
  assert.equal(client.emit('game:chance-presented', cardEvent), true);
  const movement = {movementId: 'res-ch_4:card:1', startPos: 2, endPos: 5, steps: 3,
    direction: 'forward', passedStart: false, startBonus: 0, balance: 1500};
  const result = {...cardEvent, sourceMovementId: 'move-1', initialPosition: 2, position: 5,
    resultingPosition: 5, landedPosition: 5, cards: [card('ch_4')], movements: [movement],
    destinationResolution: 'PROPERTY_OFFER', destinationOffer: {propertyPos: 5}, destinationEvent: null,
    supported: true, balance: 1500, balances: [{playerId: 'p1', money: 1500}, {playerId: 'p2', money: 1500}],
    transactions: [], phase: 'WAITING_PROPERTY_DECISION', message: 'Kartu selesai.'};
  result.movementId = 'move-1';
  assert.equal(client.emit('game:chance-resolved', result), true);
  assert.equal(store.getPlayer('p1').pos, 5);
  assert.equal(store.getPhase(), 'WAITING_TILE_RESOLUTION');
  assert.equal(store.presentation.movements.has(movement.movementId), true);
  assert.equal(client.emit('game:chance-resolved', result), false);
});

test('debt-producing card keeps the turn in debt resolution and does not charge before official resolution', () => {
  const {store, client} = setupClient();
  const cardEvent = presentation('ch_2');
  assert.equal(client.emit('game:chance-presented', cardEvent), true);
  assert.equal(store.getBalance('p1'), 1500);
  const debt = {debtId: 'debt_res-ch_2', playerId: 'p1', debtType: 'CHANCE', amount: 50,
    creditorId: 'BANK', creditorName: 'Bank', originResolutionId: 'res-ch_2', turnId: 1, status: 'OPEN'};
  const result = {...cardEvent, position: 2, landedPosition: 2, supported: true, amount: 50, balance: 1500,
    balances: [{playerId: 'p1', money: 1500}, {playerId: 'p2', money: 1500}], transactions: [], debt,
    phase: 'DEBT_RESOLUTION', message: 'Utang menunggu.'};
  assert.equal(client.emit('game:chance-resolved', result), true);
  assert.equal(store.getPhase(), 'DEBT_RESOLUTION');
  assert.equal(store.getBalance('p1'), 1500);
  assert.equal(store.pendingDebt.debtId, debt.debtId);
});