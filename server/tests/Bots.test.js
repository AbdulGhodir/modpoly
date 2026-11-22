import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomManager} from '../src/RoomManager.js';

function manager(seed = 1) {
  let id = 0;
  let state = seed;
  const rand = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
  return new RoomManager({codeGenerator: () => 'BTX234', idGenerator: () => `p-${++id}`,
    diceRoller: () => [1 + Math.floor(rand() * 6), 1 + Math.floor(rand() * 6)], botActionDelayMs: 0});
}

test('host can add and remove bots; bots are ready and flagged in the public room', () => {
  const rooms = manager();
  rooms.createRoom({socketId: 's1', playerName: 'Host'});
  const added = rooms.addBot('s1');
  assert.equal(added.ok, true);
  const bot = added.room.players.find(player => player.isBot);
  assert.equal(bot.isReady, true);
  assert.equal(bot.isConnected, true);
  assert.match(bot.playerName, /Bot 1/);
  assert.equal(rooms.removeBot('s1', {playerId: bot.playerId}).room.players.length, 1);
});

test('only host can manage bots, room capacity is respected, and bots cannot be added after start', () => {
  const rooms = manager();
  rooms.createRoom({socketId: 's1', playerName: 'Host'});
  rooms.joinRoom({socketId: 's2', roomCode: 'BTX234', playerName: 'Guest'});
  assert.equal(rooms.addBot('s2').error.code, 'HOST_ONLY');
  assert.equal(rooms.addBot('s1').ok, true);
  assert.equal(rooms.addBot('s1').ok, true);
  assert.equal(rooms.addBot('s1').error.code, 'ROOM_FULL');
  rooms.setReady('s1', true); rooms.setReady('s2', true);
  assert.equal(rooms.startRoom('s1').ok, true);
  assert.equal(rooms.removeBot('s1', {playerId: 'p-3'}).error.code, 'ROOM_STARTED');
});

test('one human plus one bot can start, and trades with bots are refused', () => {
  const rooms = manager();
  rooms.createRoom({socketId: 's1', playerName: 'Host'});
  rooms.addBot('s1');
  rooms.setReady('s1', true);
  const started = rooms.startRoom('s1');
  assert.equal(started.ok, true);
  const game = rooms.getGameState('BTX234');
  assert.equal(game.state.players.filter(player => player.isBot).length, 1);
  const bot = game.state.players.find(player => player.isBot);
  const human = game.state.players.find(player => !player.isBot);
  const refused = rooms.createTradeOffer('s1', {turnId: game.state.turnId, actionId: 'a1', toPlayerId: bot.playerId,
    offer: {giveMoney: 10, receiveMoney: 0, giveJailCards: 0, receiveJailCards: 0, givePropPositions: [], receivePropPositions: []}});
  assert.equal(refused.error.code, 'BOT_TRADE_UNAVAILABLE');
  assert.ok(human);
});

test('a room with only bots left is removed when the last human leaves while waiting', () => {
  const rooms = manager();
  rooms.createRoom({socketId: 's1', playerName: 'Host'});
  rooms.addBot('s1');
  rooms.leaveRoom('s1');
  assert.equal(rooms.rooms.size, 0);
});

for (const seed of [1, 7, 42]) {
  test(`four bots play a full game without ever getting stuck (seed ${seed})`, async () => {
    const rooms = manager(seed);
    rooms.createRoom({socketId: 's1', playerName: 'Host'});
    rooms.addBot('s1'); rooms.addBot('s1'); rooms.addBot('s1');
    rooms.setReady('s1', true);
    assert.equal(rooms.startRoom('s1').ok, true);
    const room = rooms.rooms.get('BTX234');
    const game = room.gameState;
    for (const player of game.state.players) player.isBot = true;
    for (const player of room.players) player.isBot = true;
    const events = new Set();
    rooms.setAutoActionListener((code, action) => events.add(action.type));

    let steps = 0;
    while (game.state.gameStatus === 'IN_GAME' && steps < 6000) {
      const ok = await rooms._runDisconnectedAutomation('BTX234');
      assert.equal(ok, true, `bot stuck at step ${steps}: phase=${game.state.phase} turn=${game.state.turnId} debt=${JSON.stringify(game.pendingDebt)?.slice(0, 120)}`);
      steps++;
      for (const player of game.state.players) assert.ok(player.money >= 0, `negative money for ${player.name}`);
    }
    const owned = [...game.state.properties.values()].filter(property => property.owner).length;
    assert.ok(owned >= 8, `bots should buy properties, owned=${owned}`);
    assert.ok(events.has('property') && events.has('roll') && events.has('turn-ended'));
    assert.ok(steps > 100);
  });
}
