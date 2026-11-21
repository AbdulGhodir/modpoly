import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameState} from '../src/logic/GameState.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {getDiceHintPresentation, OfficialLandingTracker} from '../src/board/boardPresentation.js';

function multiplayerStore() {
  const state = createGameState();
  const store = new ClientGameStore(state);
  store.roomCode = 'BOARD01';
  return {state, store};
}

test('dice hints follow the authoritative active player and refresh with turn state', () => {
  const {state, store} = multiplayerStore();
  state.currentTurn = 2;
  state.activePlayerId = 'player-3';
  state.players[2].pos = 17;
  assert.deepEqual(getDiceHintPresentation({state, store}), {playerId: 'player-3', position: 17});

  state.currentTurn = 3;
  state.activePlayerId = 'player-4';
  state.players[3].pos = 29;
  store.notify({type: 'turn-ended'});
  assert.deepEqual(getDiceHintPresentation({state, store}), {playerId: 'player-4', position: 29});
});

test('hints show for required extra rolls and hide for jail, rolling, movement, and stale phases', () => {
  const {state, store} = multiplayerStore();
  state.phase = 'PLAYER_ACTION';
  store.extraRollAvailable = true;
  state.lastRoll = {dice: [4, 4], total: 8, isDouble: true};
  assert.equal(getDiceHintPresentation({state, store}).playerId, 'player-1');

  state.players[0].status = 'IN_JAIL';
  state.players[0].inJail = true;
  assert.equal(getDiceHintPresentation({state, store}), null);
  state.players[0].status = 'ACTIVE';
  state.players[0].inJail = false;
  state.phase = 'JAILING';
  assert.equal(getDiceHintPresentation({state, store}), null);
  state.phase = 'MOVING';
  assert.equal(getDiceHintPresentation({state, store}), null);
  state.phase = 'PLAYER_ACTION';
  store.extraRollAvailable = false;
  assert.equal(getDiceHintPresentation({state, store}), null);
});

test('official dice values remain the only recorded roll result', () => {
  const {state, store} = multiplayerStore();
  store.applyDiceResult({die1: 2, die2: 5, total: 7, phase: 'MOVING', turnId: 1, playerId: 'player-1'});
  assert.deepEqual(state.lastRoll.dice, [2, 5]);
  assert.equal(state.lastRoll.total, 7);
  assert.equal(getDiceHintPresentation({state, store}), null);
});

test('landing tracker waits for all accepted official movements and ignores duplicate events', () => {
  const tracker = new OfficialLandingTracker();
  const first = {movementId: 'move-a', endPos: 5};
  const second = {movementId: 'move-b', endPos: 14};
  assert.equal(tracker.begin(first), true);
  assert.equal(tracker.begin(first), false);
  assert.equal(tracker.begin(second), true);
  assert.equal(tracker.complete('move-a'), null);
  assert.equal(tracker.complete('move-b'), 14);
  assert.equal(tracker.complete('move-b'), null);
  assert.equal(tracker.begin(second), false);
});

test('official landing destination can be corrected to jail', () => {
  const tracker = new OfficialLandingTracker();
  tracker.begin({movementId: 'move-to-jail', endPos: 30});
  assert.equal(tracker.setDestination(10), 10);
  assert.equal(tracker.complete('move-to-jail'), null);
  assert.equal(tracker.latestDestination, 10);
});

test('snapshot refresh changes dice hint to the restored active player and position', () => {
  const {state, store} = multiplayerStore();
  const snapshot = state.toSnapshot();
  snapshot.roomCode = 'BOARD01';
  snapshot.currentTurn = 1;
  snapshot.activePlayerId = 'player-2';
  snapshot.players[1].pos = 26;
  snapshot.phase = 'WAITING_ROLL';
  assert.equal(store.setSnapshot(snapshot), true);
  assert.deepEqual(getDiceHintPresentation({state: store.getState(), store}), {playerId: 'player-2', position: 26});
});
