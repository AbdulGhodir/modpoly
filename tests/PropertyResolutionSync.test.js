import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameState} from '../src/logic/GameState.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {initPropertyResolutionSync} from '../src/network/PropertyResolutionSync.js';
import {getMultiplayerTurnControls} from '../src/ui/multiplayerTurnControls.js';

function fixture({pos = 3, consecutiveDoubles = 0, isDouble = false} = {}) {
  const state = createGameState();
  state.players.splice(2);
  state.players[0].pos = pos;
  state.players[1].pos = 0;
  state.currentTurn = 0;
  state.turnId = 1;
  state.activePlayerId = state.players[0].playerId;
  state.round = 1;
  state.phase = 'WAITING_TILE_RESOLUTION';
  state.consecutiveDoubles = consecutiveDoubles;
  state.players[0].consecutiveDoubles = consecutiveDoubles;
  state.lastRoll = isDouble ? {dice: [2, 2], total: 4, isDouble: true, consecutiveDoubles} : null;
  state.properties.set(3, {
    id: 'prop_3', pos: 3, name: 'Laos', type: 'prop', price: 60,
    owner: null, rent: {base: 4}, houses: 0, hasHotel: false
  });
  const store = new ClientGameStore(state);
  store.lastMovementId = 'movement-1';
  const listeners = new Map();
  const client = {on(name, callback) {
    listeners.set(name, callback);
    return () => listeners.delete(name);
  }};
  const room = {roomCode: 'AB2CD3', status: 'started'};
  const warnings = [];
  const dispose = initPropertyResolutionSync({
    client, store, getActiveRoom: () => room, logger: {warn: value => warnings.push(value)}
  });
  return {store, listeners, warnings, dispose, state, room};
}

function offerPayload() {
  return {
    roomCode: 'AB2CD3', playerId: 'player-1', seat: 0, turnId: 1,
    resolutionId: 'resolution-1', propertyPos: 3, propertyId: 'prop_3',
    propertyName: 'Laos', price: 60, balance: 1500, phase: 'WAITING_PROPERTY_DECISION'
  };
}

test('accepts a matching server property offer and rejects forged or stale offers', () => {
  const {store, listeners, warnings, dispose} = fixture();
  const offer = offerPayload();
  assert.equal(listeners.get('game:property-offer')({...offer, price: 1}), false);
  assert.equal(store.pendingResolution, null);
  assert.equal(listeners.get('game:property-offer')({...offer, roomCode: 'ZZ9ZZ9'}), false);
  assert.equal(listeners.get('game:property-offer')(offer), true);
  assert.equal(store.pendingResolution.resolutionId, 'resolution-1');
  assert.equal(store.getPhase(), 'WAITING_PROPERTY_DECISION');
  assert.equal(warnings.length, 2);
  assert.equal(listeners.get('game:property-offer')(offer), false);
  dispose();
});

test('applies an official purchase once and waits in PLAYER_ACTION for explicit end turn', () => {
  const {store, listeners, dispose} = fixture();
  listeners.get('game:property-offer')(offerPayload());
  const result = {
    roomCode: 'AB2CD3', resolutionId: 'resolution-1', decision: 'BUY', playerId: 'player-1',
    property: {id: 'prop_3', pos: 3, name: 'Laos', owner: 'player-1'},
    transaction: {id: 'tx_resolution-1', players: ['Pemain 1'], amount: 60, type: 'BUY_PROP', description: 'buy'},
    balance: 1440, previousTurnId: 1, turnId: 1, currentTurn: 0, round: 1,
    extraRollAllowed: false, consecutiveDoubles: 0,
    activePlayerId: 'player-1', phase: 'PLAYER_ACTION'
  };
  assert.equal(listeners.get('game:property-resolution-complete')(result), true);
  assert.equal(store.getBalance('player-1'), 1440);
  assert.equal(store.getProperty(3).owner, 'player-1');
  assert.deepEqual(store.getPlayer('player-1').properties, ['prop_3']);
  assert.equal(store.state.transactions.length, 1);
  assert.equal(store.state.turnId, 1);
  assert.equal(store.getActivePlayer().playerId, 'player-1');
  assert.equal(listeners.get('game:property-resolution-complete')(result), false);
  assert.equal(store.state.transactions.length, 1);
  dispose();
});

test('decline preserves money and ownership while server completion waits in PLAYER_ACTION', () => {
  const {store, listeners, dispose} = fixture();
  listeners.get('game:property-offer')(offerPayload());
  const declined = {
    roomCode: 'AB2CD3', resolutionId: 'resolution-1', decision: 'DECLINE', playerId: 'player-1',
    property: null, transaction: null, balance: 1500, previousTurnId: 1, turnId: 1,
    currentTurn: 0, round: 1, activePlayerId: 'player-1', phase: 'PLAYER_ACTION',
    extraRollAllowed: false, consecutiveDoubles: 0
  };
  assert.equal(listeners.get('game:property-resolution-complete')(declined), true);
  assert.equal(store.getBalance('player-1'), 1500);
  assert.equal(store.getProperty(3).owner, null);
  assert.equal(store.state.turnId, 1);
  dispose();
});

test('unsupported tiles stay waiting and the obsolete automatic turn-advance event is not subscribed', () => {
  const {store, listeners, dispose} = fixture();
  const unsupported = {
    roomCode: 'AB2CD3', playerId: 'player-1', seat: 0, turnId: 1,
    resolutionId: 'unsupported-1', movementId: 'movement-1',
    position: 3, tileName: 'Laos', tileType: 'prop', phase: 'WAITING_TILE_RESOLUTION',
    message: 'Resolusi belum tersedia.'
  };
  assert.equal(listeners.get('game:tile-resolution-unsupported')(unsupported), true);
  assert.equal(store.getPhase(), 'WAITING_TILE_RESOLUTION');
  assert.equal(store.getState().turnId, 1);
  assert.equal(listeners.has('game:turn-advanced'), false);
  assert.equal(store.getState().turnId, 1);
  dispose();
});

function completedTile({kind, pos, resolutionId, balance = 1500, taxAmount = null, transaction = null,
  resultingPosition = pos, status = 'ACTIVE', inJail = false, jailTurns = 0, message = 'Resolved.'}) {
  return {
    roomCode: 'AB2CD3', resolutionId, movementId: 'movement-1', kind,
    playerId: 'player-1', seat: 0, previousTurnId: 1,
    landedPosition: pos, resultingPosition, balance, status, inJail, jailTurns,
    taxAmount, transaction, message,
    turnId: 1, currentTurn: 0, round: 1, activePlayerId: 'player-1', phase: 'PLAYER_ACTION',
    extraRollAllowed: false, consecutiveDoubles: 0
  };
}

test('tax resolution applies the server balance and transaction once on every client', () => {
  const {store, listeners, dispose} = fixture({pos: 4});
  const result = completedTile({
    kind: 'TAX_PAID', pos: 4, resolutionId: 'tax-resolution', balance: 1300, taxAmount: 200,
    transaction: {id: 'tx_tax-resolution', players: ['Pemain 1', 'Bank'], amount: 200, type: 'TAX'}
  });
  assert.equal(listeners.get('game:tile-resolution-complete')(result), true);
  assert.equal(store.getBalance('player-1'), 1300);
  assert.equal(store.state.transactions.length, 1);
  assert.equal(listeners.get('game:tile-resolution-complete')(result), false);
  assert.equal(store.getBalance('player-1'), 1300);
  assert.equal(store.state.transactions.length, 1);
  dispose();
});

test('START tile resolution enters PLAYER_ACTION without advancing the active player', () => {
  const {store, listeners, dispose, room} = fixture({pos: 0});
  store.roomCode = room.roomCode;
  room.players = [{playerId: 'player-1', isConnected: true}];
  store.presentation.movement = {movementId: 'movement-1', status: 'ANIMATING'};
  store.presentation.movements.set('movement-1', store.presentation.movement);
  const result = completedTile({kind: 'START', pos: 0, resolutionId: 'start-resolution'});
  assert.equal(listeners.get('game:tile-resolution-complete')(result), true);
  assert.equal(store.getPhase(), 'PLAYER_ACTION');
  assert.equal(store.getState().activePlayerId, 'player-1');
  assert.equal(store.getState().turnId, 1);
  const controls = () => getMultiplayerTurnControls({state: store.getState(), store, room,
    localPlayerId: 'player-1', connected: true});
  assert.equal(controls().showEndTurn, false);
  assert.equal(store.completeMovement('movement-1'), true);
  assert.equal(controls().showEndTurn, true);
  dispose();
});

test('jail visit remains active while go-to-jail synchronizes position and jail status', () => {
  const visiting = fixture({pos: 10});
  const visit = completedTile({kind: 'JAIL_VISIT', pos: 10, resolutionId: 'visit-jail'});
  assert.equal(visiting.listeners.get('game:tile-resolution-complete')(visit), true);
  assert.equal(visiting.store.getPlayer('player-1').status, 'ACTIVE');
  assert.equal(visiting.store.getPlayer('player-1').inJail, false);
  visiting.dispose();

  const entering = fixture({pos: 30});
  const jailed = completedTile({
    kind: 'JAILED', pos: 30, resultingPosition: 10, resolutionId: 'enter-jail',
    status: 'IN_JAIL', inJail: true
  });
  assert.equal(entering.listeners.get('game:tile-resolution-complete')(jailed), true);
  assert.equal(entering.store.getPlayer('player-1').pos, 10);
  assert.equal(entering.store.getPlayer('player-1').status, 'IN_JAIL');
  assert.equal(entering.store.getPlayer('player-1').inJail, true);
  assert.equal(entering.listeners.get('game:tile-resolution-complete')(jailed), false);
  const observer = fixture({pos: 30});
  assert.equal(observer.listeners.get('game:tile-resolution-complete')(jailed), true);
  assert.equal(observer.store.getPlayer('player-1').pos, entering.store.getPlayer('player-1').pos);
  assert.equal(observer.store.getPlayer('player-1').status, entering.store.getPlayer('player-1').status);
  entering.dispose();
  observer.dispose();
});

test('free parking only notifies and advances with the same balance', () => {
  const {store, listeners, dispose} = fixture({pos: 20});
  const result = completedTile({kind: 'FREE_PARKING', pos: 20, resolutionId: 'parking'});
  assert.equal(listeners.get('game:tile-resolution-complete')(result), true);
  assert.equal(store.getBalance('player-1'), 1500);
  assert.equal(store.state.transactions.length, 0);
  assert.equal(store.state.turnId, 1);
  dispose();
});

test('free parking cancels a double reroll in line with the single-player rule', () => {
  const {store, listeners, dispose} = fixture({pos: 20, consecutiveDoubles: 1, isDouble: true});
  const result = completedTile({kind: 'FREE_PARKING', pos: 20, resolutionId: 'parking-double'});
  assert.equal(listeners.get('game:tile-resolution-complete')(result), true);
  assert.equal(store.getState().activePlayerId, 'player-1');
  assert.equal(store.state.consecutiveDoubles, 0);
  dispose();
});

test('a double property resolution finishes before the same player receives a new roll turnId', () => {
  const {store, listeners, dispose} = fixture({consecutiveDoubles: 1, isDouble: true});
  listeners.get('game:property-offer')(offerPayload());
  const declined = {
    roomCode: 'AB2CD3', resolutionId: 'resolution-1', decision: 'DECLINE', playerId: 'player-1',
    property: null, transaction: null, balance: 1500, previousTurnId: 1, turnId: 2,
    currentTurn: 0, round: 1, activePlayerId: 'player-1', phase: 'PLAYER_ACTION',
    extraRollAllowed: true, consecutiveDoubles: 1
  };
  assert.equal(listeners.get('game:property-resolution-complete')(declined), true);
  assert.equal(store.getState().activePlayerId, 'player-1');
  assert.equal(store.getState().currentTurn, 0);
  assert.equal(store.getState().turnId, 2);
  assert.equal(store.state.consecutiveDoubles, 1);
  dispose();
});

test('third-double jail event changes official status without applying a normal movement', () => {
  const {store, listeners, dispose} = fixture({pos: 7, consecutiveDoubles: 3, isDouble: true});
  store.state.phase = 'JAILING';
  store.state.lastRoll.tripleDouble = true;
  const penalty = {
    roomCode: 'AB2CD3', resolutionId: 'triple-jail', kind: 'THREE_DOUBLES_JAIL',
    playerId: 'player-1', seat: 0, previousTurnId: 1, previousPosition: 7,
    resultingPosition: 10, status: 'IN_JAIL', inJail: true, jailTurns: 0, consecutiveDoubles: 0,
    turnId: 2, currentTurn: 1, round: 1, activePlayerId: 'player-2', phase: 'WAITING_ROLL',
    message: 'Pemain masuk penjara.'
  };
  assert.equal(listeners.get('game:jail-penalty')(penalty), true);
  assert.equal(store.getPlayer('player-1').pos, 10);
  assert.equal(store.getPlayer('player-1').status, 'IN_JAIL');
  assert.equal(store.state.activePlayerId, 'player-2');
  assert.equal(store.state.consecutiveDoubles, 0);
  assert.equal(listeners.get('game:jail-penalty')(penalty), false);
  dispose();
});
