import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameState} from '../src/logic/GameState.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {clientGameStore} from '../src/state/ClientGameStore.js';
import {gameState} from '../src/logic/GameState.js';

test('stores backed by separate GameStates remain isolated', () => {
  const aState = createGameState();
  const bState = createGameState();
  const a = new ClientGameStore(aState);
  const b = new ClientGameStore(bState);
  aState.players[0].money = 900;
  assert.equal(a.getBalance('player-1'), 900);
  assert.equal(b.getBalance('player-1'), 1500);
});

test('snapshot replacement updates the existing state and notifies subscribers', () => {
  const state = createGameState();
  const store = new ClientGameStore(state);
  const updates = [];
  const unsubscribe = store.subscribe(update => updates.push(update));
  const snapshot = state.toSnapshot();
  snapshot.players[0].money = 725;
  snapshot.currentTurn = 1;
  store.setSnapshot(snapshot);
  assert.equal(store.getState(), state);
  assert.equal(store.getBalance('player-1'), 725);
  assert.equal(store.getActivePlayer().playerId, 'player-2');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].change.type, 'snapshot');
  unsubscribe();
  store.notify({type: 'after-unsubscribe'});
  assert.equal(updates.length, 1);
});

test('snapshot restore keeps legacy player and property collection references stable', () => {
  const state = createGameState();
  const playersRef = state.players;
  const propertiesRef = state.properties;
  const transactionsRef = state.transactions;
  const snapshot = state.toSnapshot();
  snapshot.players[0].money = 700;
  state.restoreSnapshot(snapshot);
  assert.equal(state.players, playersRef);
  assert.equal(state.properties, propertiesRef);
  assert.equal(state.transactions, transactionsRef);
  assert.equal(playersRef[0].money, 700);
});

test('legacy singleton mutations are visible through the singleton-backed store', () => {
  const state = createGameState();
  const store = new ClientGameStore(state);
  state.players[1].money = 1234;
  assert.equal(store.getBalance('player-2'), 1234);
  assert.equal(store.getPlayerAtIndex(1), state.players[1]);
});

test('application store reads mutations made through the legacy singleton', () => {
  const priorBalance = gameState.players[0].money;
  gameState.players[0].money = 1111;
  assert.equal(clientGameStore.getBalance('player-1'), 1111);
  gameState.players[0].money = priorBalance;
});

test('applies official jail release snapshots once and keeps action duplicates from replaying', () => {
  const state = createGameState();
  const store = new ClientGameStore(state);
  store.roomCode = 'JAIL01';
  state.players[0].status = 'IN_JAIL'; state.players[0].inJail = true; state.players[0].pos = 10;
  state.players[0].money = 100; state.phase = 'WAITING_ROLL';
  const snapshot = state.toSnapshot();
  snapshot.roomCode = 'JAIL01'; snapshot.players[0].status = 'ACTIVE'; snapshot.players[0].inJail = false;
  snapshot.players[0].jailTurns = 0; snapshot.players[0].money = 50;
  snapshot.transactions.push({id: 'tx_jail_action_bail-client-1', time: 'now', players: ['Player 1'], amount: 50, type: 'BAIL', description: 'Bail'});
  const event = {roomCode: 'JAIL01', actionId: 'bail-client-1', action: 'PAY_BAIL', playerId: 'player-1',
    playerName: 'Player 1', turnId: state.turnId, balance: 50, status: 'ACTIVE', inJail: false,
    jailTurns: 0, hasGetOutOfJailCard: 0, snapshot};
  assert.equal(store.applyJailResolution(event), true);
  assert.equal(store.getPlayer('player-1').money, 50);
  assert.equal(store.getPlayer('player-1').status, 'ACTIVE');
  assert.equal(store.applyJailResolution(event), false);
});

test('trade events synchronize pending and completed offers and ignore duplicate completion', () => {
  const firstState = createGameState(), secondState = createGameState();
  firstState.properties.set(3, {id: 'prop_3', pos: 3, owner: null, houses: 0, hasHotel: false, isMortgaged: false});
  secondState.properties.set(3, {id: 'prop_3', pos: 3, owner: null, houses: 0, hasHotel: false, isMortgaged: false});
  const first = new ClientGameStore(firstState);
  const second = new ClientGameStore(secondState);
  const firstSnapshot = first.getSnapshot();
  firstSnapshot.roomCode = 'TRADE01';
  first.setSnapshot(firstSnapshot);
  const secondSnapshot = second.getSnapshot();
  secondSnapshot.roomCode = 'TRADE01';
  second.setSnapshot(secondSnapshot);
  first.getProperty(3).owner = 'player-1';
  first.getPlayer('player-1').properties.push(first.getProperty(3).id);
  second.getProperty(3).owner = 'player-1';
  second.getPlayer('player-1').properties.push(second.getProperty(3).id);
  const trade = {tradeId: 'trade-a', roomCode: 'TRADE01', fromPlayerId: 'player-1', toPlayerId: 'player-2',
    status: 'PENDING', offer: {giveMoney: 100, receiveMoney: 0, giveJailCards: 0, receiveJailCards: 0,
      givePropPositions: [3], receivePropPositions: []}};
  const pendingSnapshot = first.getSnapshot();
  pendingSnapshot.roomCode = 'TRADE01';
  const pending = {roomCode: 'TRADE01', type: 'PENDING', trade, snapshot: pendingSnapshot};
  assert.equal(first.applyTradeEvent(pending), true);
  assert.equal(second.applyTradeEvent(pending), true);

  const completedSnapshot = first.getSnapshot();
  const propertyId = first.getProperty(3).id;
  completedSnapshot.roomCode = 'TRADE01';
  completedSnapshot.players[0].money = 1400;
  completedSnapshot.players[1].money = 1600;
  completedSnapshot.players[0].properties = [];
  completedSnapshot.players[1].properties = [propertyId];
  completedSnapshot.properties.find(([position]) => position === 3)[1].owner = 'player-2';
  completedSnapshot.transactions.push({id: 'tx_trade-a_give', players: ['Pemain 1', 'Pemain 2'], amount: 100, type: 'TRADE'});
  const completedTrade = {...trade, status: 'COMPLETED'};
  const completed = {roomCode: 'TRADE01', type: 'COMPLETED', trade: completedTrade, snapshot: completedSnapshot};
  assert.equal(first.applyTradeEvent(completed), true);
  assert.equal(second.applyTradeEvent(completed), true);
  assert.equal(first.getBalance('player-1'), 1400);
  assert.equal(second.getBalance('player-2'), 1600);
  assert.equal(first.getProperty(3).owner, 'player-2');
  assert.equal(second.getProperty(3).owner, 'player-2');
  assert.equal(first.applyTradeEvent(completed), false);
});

test('trade store rejects terminal events without a pending offer and cross-room events', () => {
  const store = new ClientGameStore(createGameState());
  const snapshot = store.getSnapshot();
  snapshot.roomCode = 'TRADE02';
  store.setSnapshot(snapshot);
  const trade = {tradeId: 'trade-b', roomCode: 'TRADE02', fromPlayerId: 'player-1', toPlayerId: 'player-2',
    status: 'REJECTED', offer: {givePropPositions: [], receivePropPositions: []}};
  assert.equal(store.applyTradeEvent({roomCode: 'TRADE02', type: 'REJECTED', trade, snapshot}), false);
  assert.equal(store.applyTradeEvent({roomCode: 'OTHER1', type: 'PENDING', trade: {...trade, status: 'PENDING'}, snapshot}), false);
});

test('event binding publishes legacy browser events without owning the event target', () => {
  const store = new ClientGameStore(createGameState());
  const target = new EventTarget();
  let received;
  store.subscribe(update => { received = update.change; });
  const unbind = store.bindEvents(target);
  const event = new Event('property:updated');
  Object.defineProperty(event, 'detail', {value: {pos: 7}});
  target.dispatchEvent(event);
  assert.deepEqual(received, {type: 'property:updated', detail: {pos: 7}});
  unbind();
});

test('applies one authoritative Chance reward identically and rejects replay', () => {
  const state = createGameState();
  const store = new ClientGameStore(state);
  state.phase = 'WAITING_TILE_RESOLUTION';
  state.turnId = 1;
  state.activePlayerId = 'player-1';
  state.players[0].pos = 2;
  state.players[0].money = 1500;
  store.lastMovementId = 'move-chance';
  let notifications = 0;
  store.subscribe(({change}) => { if (change.type === 'chance-resolved') notifications++; });
  const presentation = {roomCode: 'ABC234', resolutionId: 'chance-1', presentationId: 'chance-1-card1',
    movementId: 'move-chance', playerId: 'player-1', recipientPlayerId: 'player-1', seat: 0,
    previousTurnId: 1, turnId: 1, position: 2, phase: 'CHANCE_PRESENTATION', card: {id: 'ch_1'}};
  assert.equal(store.applyChancePresentation(presentation), true);
  assert.equal(store.getBalance('player-1'), 1500, 'displaying the card does not apply its effect');
  const result = {
    roomCode: 'ABC234', resolutionId: 'chance-1', presentationId: presentation.presentationId,
    movementId: 'move-chance', playerId: 'player-1', seat: 0,
    previousTurnId: 1, position: 2, landedPosition: 2, card: {id: 'ch_1', type: 'MONEY_GAIN'}, supported: true,
    amount: 100, balance: 1600, balances: [
      {playerId: 'player-1', money: 1600}, {playerId: 'player-2', money: 1500},
      {playerId: 'player-3', money: 1500}, {playerId: 'player-4', money: 1500}
    ],
    transactions: [{id: 'tx_chance-1', players: ['Pemain 1', 'Bank'], amount: 100, type: 'CARD_REWARD'}],
    turnId: 1, currentTurn: 0, activePlayerId: 'player-1', round: 1, phase: 'PLAYER_ACTION',
    consecutiveDoubles: 0, extraRollAllowed: false, message: 'Dapat hadiah'
  };
  assert.equal(store.applyChanceResolution(result), true);
  assert.equal(store.getBalance('player-1'), 1600);
  assert.equal(store.getBalance('player-2'), 1500);
  assert.equal(store.getState().activePlayerId, 'player-1');
  assert.equal(store.getState().transactions.length, 1);
  assert.equal(store.applyChanceResolution(result), false);
  assert.equal(notifications, 1);
});
