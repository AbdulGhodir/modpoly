import test from 'node:test';
import assert from 'node:assert/strict';
import {GameState} from '../src/logic/GameStateCore.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {applyInitialSnapshot, initInitialSnapshotSync} from '../src/network/InitialSnapshotSync.js';
import {initAuthoritativeDiceSync} from '../src/network/AuthoritativeDiceSync.js';

class FakeClient {
  listeners = new Map();
  on(name, listener) {
    this.listeners.set(name, listener);
    return () => this.listeners.delete(name);
  }
  emit(name, payload) { return this.listeners.get(name)?.(payload); }
}

function makeRoom() {
  return {
    roomCode: 'AB2CD3', status: 'started', minPlayers: 2, maxPlayers: 4,
    players: [
      {playerId: 'host-id', playerName: 'Host'},
      {playerId: 'guest-id', playerName: 'Guest'}
    ]
  };
}

function makeSnapshot(roomCode = 'AB2CD3') {
  return {
    version: 1, roomCode, gameStatus: 'IN_GAME', round: 1, currentTurn: 0, turnId: 1, activePlayerId: 'host-id',
    consecutiveDoubles: 0, lastRoll: null, phase: 'WAITING_ROLL', bankHouses: 32, bankHotels: 12,
    players: [
      {id: 1, playerId: 'host-id', seat: 0, name: 'Host', money: 1200, pos: 3, status: 'ACTIVE', properties: [], jailTurns: 0, inJail: false, hasGetOutOfJailCard: 0, consecutiveDoubles: 0},
      {id: 2, playerId: 'guest-id', seat: 1, name: 'Guest', money: 1500, pos: 0, status: 'ACTIVE', properties: [], jailTurns: 0, inJail: false, hasGetOutOfJailCard: 0, consecutiveDoubles: 0}
    ],
    properties: [[1, {id: 'prop_1', owner: null}]], transactions: []
  };
}

test('accepts the active started room snapshot in place and notifies subscribers', () => {
  const state = new GameState();
  const store = new ClientGameStore(state);
  const playersRef = state.players;
  const propertiesRef = state.properties;
  const client = new FakeClient();
  const updates = [];
  store.subscribe(update => updates.push(update.change.type));
  initInitialSnapshotSync({client, store, getActiveRoom: makeRoom, logger: {info() {}, warn() {}}});

  assert.equal(client.emit('game:initial-snapshot', {roomCode: 'AB2CD3', snapshot: makeSnapshot()}), true);
  assert.equal(store.getPlayers(), playersRef);
  assert.equal(state.properties, propertiesRef);
  assert.equal(store.getPlayer('host-id').money, 1200);
  assert.equal(store.getProperty(1).id, 'prop_1');
  assert.deepEqual(updates, ['snapshot']);
});

test('rejects a wrong room, non-started room, or roster-mismatched snapshot without mutation', () => {
  const state = new GameState();
  const store = new ClientGameStore(state);
  const client = new FakeClient();
  const room = makeRoom();
  const warnings = [];
  initInitialSnapshotSync({client, store, getActiveRoom: () => room, logger: {warn: message => warnings.push(message)}});
  const before = store.getSnapshot();

  assert.equal(client.emit('game:initial-snapshot', {roomCode: 'ZZ9YY8', snapshot: makeSnapshot('ZZ9YY8')}), false);
  const invalidRoster = makeSnapshot();
  invalidRoster.players[0].playerId = 'unexpected';
  assert.equal(client.emit('game:initial-snapshot', {roomCode: 'AB2CD3', snapshot: invalidRoster}), false);
  room.status = 'waiting';
  assert.equal(client.emit('game:initial-snapshot', {roomCode: 'AB2CD3', snapshot: makeSnapshot()}), false);
  assert.equal(store.getPlayerAtIndex(0).money, before.players[0].money);
  assert.equal(warnings.length, 3);
});

test('restores a pending property offer from a reconnect snapshot without replaying movement', () => {
  const state = new GameState();
  const store = new ClientGameStore(state);
  const client = new FakeClient();
  const room = makeRoom();
  const snapshot = makeSnapshot();
  snapshot.phase = 'WAITING_PROPERTY_DECISION';
  snapshot.players[0].pos = 3;
  snapshot.properties = [[3, {id: 'prop_3', pos: 3, owner: null, price: 150}]];
  snapshot.pendingPropertyOffer = {roomCode: 'AB2CD3', resolutionId: 'offer-resume', playerId: 'host-id', seat: 0,
    turnId: 1, propertyPos: 3, propertyId: 'prop_3', propertyName: 'Petak Tiga', price: 150};
  initInitialSnapshotSync({client, store, getActiveRoom: () => room, logger: {info() {}, warn() {}}});
  store.lastMovementId = 'stale-movement';
  store.presentation.movement = {movementId: 'stale-movement', status: 'ANIMATING'};

  assert.equal(client.emit('game:initial-snapshot', {roomCode: 'AB2CD3', snapshot}), true);
  assert.deepEqual(store.pendingResolution, snapshot.pendingPropertyOffer);
  assert.equal(store.getPhase(), 'WAITING_PROPERTY_DECISION');
  assert.equal(store.lastMovementId, null);
  assert.equal(store.presentation.movement, null);
});

test('validates and restores a pending Chance presentation without replaying game actions', () => {
  const store = new ClientGameStore(new GameState());
  const client = new FakeClient();
  const room = makeRoom();
  const snapshot = makeSnapshot();
  snapshot.phase = 'CHANCE_PRESENTATION';
  snapshot.players[0].pos = 2;
  snapshot.pendingChancePresentation = {presentationId: 'chance-resume:ch_1', pendingPlayerIds: ['host-id'], event: {
    roomCode: 'AB2CD3', resolutionId: 'chance-resume', presentationId: 'chance-resume:ch_1',
    playerId: 'host-id', recipientPlayerId: 'host-id', seat: 0, turnId: 1, previousTurnId: 1,
    movementId: 'move-1', position: 2, phase: 'CHANCE_PRESENTATION',
    card: {id: 'ch_1', type: 'MONEY_GAIN', title: 'KARTU KESEMPATAN',
      desc: 'Juara 1 Lomba Desain Batik Nusantara! Dapatkan hadiah dari Bank.'}}};
  initInitialSnapshotSync({client, store, getActiveRoom: () => room, logger: {info() {}, warn() {}}});

  assert.equal(client.emit('game:initial-snapshot', {roomCode: 'AB2CD3', snapshot}), true);
  assert.equal(store.pendingChancePresentation.presentationId, 'chance-resume:ch_1');
  assert.equal(store.presentation.movement, null);

  const forged = makeSnapshot();
  forged.pendingChancePresentation = structuredClone(snapshot.pendingChancePresentation);
  forged.pendingChancePresentation.pendingPlayerIds = ['player-from-another-room'];
  assert.equal(client.emit('game:initial-snapshot', {roomCode: 'AB2CD3', snapshot: forged}), false);
});

test('restores an active authoritative auction from a reconnect snapshot', () => {
  const store = new ClientGameStore(new GameState());
  const client = new FakeClient();
  const room = makeRoom();
  const snapshot = makeSnapshot();
  snapshot.phase = 'WAITING_AUCTION_ACTION';
  snapshot.players[0].pos = 3;
  snapshot.pendingPropertyOffer = null;
  snapshot.properties = [[3, {id: 'prop_3', pos: 3, name: 'Petak Tiga', type: 'prop', owner: null, price: 150}]];
  snapshot.activeAuction = {auctionId: 'offer-resume:auction', roomCode: 'AB2CD3', resolutionId: 'offer-resume',
    turnId: 1, propertyPos: 3, propertyId: 'prop_3', propertyName: 'Petak Tiga', propertyPrice: 150,
    participantIds: ['host-id', 'guest-id'], activeBidderIds: ['host-id', 'guest-id'], currentBidderIndex: 0,
    currentBidderId: 'host-id', highestBid: 0, highestBidderId: null, highestBidder: null, revision: 1,
    participants: [{playerId: 'host-id', name: 'Host', seat: 0, money: 1200, status: 'ACTIVE'},
      {playerId: 'guest-id', name: 'Guest', seat: 1, money: 1500, status: 'ACTIVE'}],
    activeBidders: [{playerId: 'host-id', name: 'Host', seat: 0, money: 1200, status: 'ACTIVE'},
      {playerId: 'guest-id', name: 'Guest', seat: 1, money: 1500, status: 'ACTIVE'}]};
  initInitialSnapshotSync({client, store, getActiveRoom: () => room, logger: {info() {}, warn() {}}});

  assert.equal(client.emit('game:initial-snapshot', {roomCode: room.roomCode, snapshot}), true);
  assert.equal(store.activeAuction.auctionId, 'offer-resume:auction');
  assert.equal(store.getPhase(), 'WAITING_AUCTION_ACTION');
});

test('applies only a matching server dice result and rejects duplicates or other room/turn results', () => {
  const state = new GameState();
  const store = new ClientGameStore(state);
  const client = new FakeClient();
  const room = makeRoom();
  store.setSnapshot(makeSnapshot());
  const playersRef = state.players;
  const updates = [];
  store.subscribe(({change}) => updates.push(change.type));
  initAuthoritativeDiceSync({
    client, store, getActiveRoom: () => room, logger: {warn() {}}
  });
  const result = {
    roomCode: 'AB2CD3', playerId: 'host-id', seat: 0,
    die1: 2, die2: 5, total: 7, isDouble: false, consecutiveDoubles: 0,
    tripleDouble: false, turnId: 1, phase: 'MOVING'
  };

  assert.equal(client.emit('game:dice-rolled', {...result, roomCode: 'ZZ9YY8'}), false);
  assert.equal(client.emit('game:dice-rolled', {...result, turnId: 9}), false);
  assert.equal(client.emit('game:dice-rolled', {...result, playerId: 'guest-id'}), false);
  assert.equal(client.emit('game:dice-rolled', result), true);
  assert.equal(client.emit('game:dice-rolled', result), false);
  assert.equal(state.players, playersRef);
  assert.equal(state.lastRoll.total, 7);
  assert.deepEqual(state.lastRoll.dice, [2, 5]);
  assert.equal(state.phase, 'MOVING');
  assert.equal(state.activePlayerId, 'host-id');
  assert.deepEqual(updates, ['dice-rolled']);
});

test('authoritative dice sync counts doubles once and identifies the third double jail phase', () => {
  const state = new GameState();
  const store = new ClientGameStore(state);
  store.setSnapshot(makeSnapshot());
  const client = new FakeClient();
  initAuthoritativeDiceSync({client, store, getActiveRoom: makeRoom, logger: {warn() {}}});
  const emitDouble = (turnId, value, count, tripleDouble = false) => client.emit('game:dice-rolled', {
    roomCode: 'AB2CD3', playerId: 'host-id', seat: 0, die1: value, die2: value,
    total: value * 2, isDouble: true, consecutiveDoubles: count, tripleDouble,
    turnId, phase: tripleDouble ? 'JAILING' : 'MOVING'
  });

  assert.equal(emitDouble(1, 2, 1), true);
  assert.equal(store.getPlayer('host-id').consecutiveDoubles, 1);
  assert.equal(emitDouble(1, 2, 1), false);
  store.state.phase = 'WAITING_ROLL';
  store.state.turnId = 2;
  store.state.lastRoll = null;
  assert.equal(emitDouble(2, 3, 2), true);
  assert.equal(store.getPlayer('host-id').consecutiveDoubles, 2);
  store.state.phase = 'WAITING_ROLL';
  store.state.turnId = 3;
  store.state.lastRoll = null;
  assert.equal(emitDouble(3, 4, 3, true), true);
  assert.equal(store.getPhase(), 'JAILING');
  assert.equal(store.getState().consecutiveDoubles, 3);
});

test('reconnect snapshot is applied even when a store subscriber throws', async () => {
  const {ClientGameStore} = await import('../src/state/ClientGameStore.js');
  const {createGameState} = await import('../src/logic/GameState.js');
  const state = createGameState();
  const snap = {...state.toSnapshot(), roomCode: 'ABC234'};
  snap.players = snap.players.slice(0, 2);
  snap.turnId = 4;
  const room = {roomCode: 'ABC234', status: 'started',
    players: snap.players.map(p => ({playerId: p.playerId, playerName: p.name}))};
  const store = new ClientGameStore();
  const seen = [];
  const originalError = console.error;
  console.error = () => {};
  store.subscribe(() => { throw new Error('listener rusak'); });
  store.subscribe(({change}) => seen.push(change.type));
  try {
    assert.equal(applyInitialSnapshot({payload: {roomCode: 'ABC234', snapshot: snap}, store,
      getActiveRoom: () => room, logger: {}}), true);
  } finally { console.error = originalError; }
  assert.equal(store.roomCode, 'ABC234');
  assert.equal(store.getState().turnId, 4);
  assert.deepEqual(seen, ['snapshot'], 'later subscribers still run after an earlier one throws');
});
