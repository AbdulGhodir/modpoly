import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState, GameState, PlayerStatus } from '../src/logic/GameState.js';

test('new GameState instances have independent mutable data', () => {
  const first = createGameState();
  const second = createGameState();

  first.players[0].money = 25;
  first.players[0].properties.push('prop_1');
  first.properties.set(1, { owner: first.players[0].id, houses: 2 });
  first.transactions.push({ amount: 10 });

  assert.equal(second.players[0].money, 1500);
  assert.deepEqual(second.players[0].properties, []);
  assert.equal(second.properties.size, 0);
  assert.deepEqual(second.transactions, []);
});

test('snapshot round-trip retains game data without sharing references', () => {
  const original = createGameState();
  original.players[2].status = PlayerStatus.IN_JAIL;
  original.players[2].pos = 10;
  original.currentTurn = 2;
  original.round = 8;
  original.lastRoll = { die1: 3, die2: 4, total: 7 };
  original.properties.set(12, { pos: 12, owner: original.players[2].id, houses: 1 });
  original.transactions.push({ id: 'tx-1', amount: 50 });

  const snapshot = original.toSnapshot();
  const restored = GameState.fromSnapshot(snapshot);
  snapshot.players[2].money = -1;
  restored.properties.get(12).houses = 4;

  assert.equal(restored.players[2].playerId, 'player-3');
  assert.equal(restored.players[2].seat, 2);
  assert.equal(restored.getSeatByPlayerId('player-3'), 2);
  assert.equal(restored.getPlayerBySeat(2).id, 3);
  assert.equal(restored.players[2].money, 1500);
  assert.equal(original.properties.get(12).houses, 1);
  assert.equal(restored.properties.get(12).houses, 4);
  assert.equal(restored.currentTurn, 2);
  assert.equal(restored.round, 8);
  assert.deepEqual(restored.lastRoll, { die1: 3, die2: 4, total: 7 });
  assert.equal(restored.transactions[0].id, 'tx-1');
});

test('legacy numeric ids and stable player ids resolve to the same player', () => {
  const state = createGameState();
  assert.equal(state.getPlayerById(2), state.getPlayerById('player-2'));
  assert.equal(state.getPlayerIndexById('player-4'), 3);
  assert.deepEqual(state.players.map(player => player.seat), [0, 1, 2, 3]);
});
