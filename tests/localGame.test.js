import test from 'node:test';
import assert from 'node:assert/strict';
import {startLocalGame, DEFAULT_PLAYER_COLORS} from '../src/logic/localGame.js';
import {clientGameStore} from '../src/state/ClientGameStore.js';
import {loadBoardCatalog} from '../server/src/game/loadBoardCatalog.js';

const {TILES} = loadBoardCatalog();

test('startLocalGame sets up specified number of players with initial money and randomized order', () => {
  const customNames = ['Alice', 'Bob', 'Charlie'];
  const players = startLocalGame({ playerCount: 3, playerNames: customNames, tiles: TILES });

  assert.equal(players.length, 3);
  assert.equal(clientGameStore.getPlayers().length, 3);

  // Every player starts with $1500 and pos 0
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    assert.equal(p.seat, i);
    assert.equal(p.id, i + 1);
    assert.equal(p.pos, 0);
    assert.equal(p.money, 1500);
    assert.equal(p.color, DEFAULT_PLAYER_COLORS[i].color);
    assert.ok(customNames.includes(p.name));
  }

  // Active player matches seat 0
  assert.equal(clientGameStore.getActivePlayer().playerId, players[0].playerId);
  assert.equal(clientGameStore.getCurrentTurn(), 0);
  assert.equal(clientGameStore.getRound(), 1);
});

test('startLocalGame limits player count between 2 and 4', () => {
  const pMin = startLocalGame({ playerCount: 1, tiles: TILES });
  assert.equal(pMin.length, 2);

  const pMax = startLocalGame({ playerCount: 10, tiles: TILES });
  assert.equal(pMax.length, 4);
});
