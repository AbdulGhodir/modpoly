import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomManager, ROOM_MAX_PLAYERS, ROOM_MIN_PLAYERS} from '../src/RoomManager.js';

function managerWithCodes(...codes) {
  let id = 0;
  return new RoomManager({codeGenerator: () => codes.shift() || 'ZZZZZZ', idGenerator: () => `player-${++id}`});
}

function createHost(manager, socketId = 'socket-host', playerName = 'Host') {
  return manager.createRoom({socketId, playerName});
}

function join(manager, roomCode, socketId, playerName = socketId) {
  return manager.joinRoom({socketId, roomCode, playerName});
}

function createReadyRoom(manager, code, count, prefix) {
  const hostSocket = `${prefix}-socket-1`;
  const created = createHost(manager, hostSocket, `${prefix} 1`);
  for (let seat = 1; seat < count; seat++) {
    join(manager, code, `${prefix}-socket-${seat + 1}`, `${prefix} ${seat + 1}`);
  }
  for (let seat = 0; seat < count; seat++) manager.setReady(`${prefix}-socket-${seat + 1}`, true);
  return created;
}

test('creates rooms with unique, readable six-character codes', () => {
  const manager = managerWithCodes('AB2CD3', 'EF4GH5');
  const first = createHost(manager, 'one');
  const second = createHost(manager, 'two');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.match(first.room.roomCode, /^[A-HJ-KM-NP-Z2-9]{6}$/);
  assert.notEqual(first.room.roomCode, second.room.roomCode);
  assert.equal(first.room.players[0].playerId, 'player-1');
  assert.equal(first.room.players[0].socketId, undefined);
  assert.equal(manager.getGameState(first.room.roomCode), null);
});

test('room creation is bounded by the configured in-memory room capacity', () => {
  const manager = new RoomManager({codeGenerator: () => 'AB2CD3', maxRooms: 1});
  assert.equal(manager.createRoom({socketId: 'first', playerName: 'First'}).ok, true);
  assert.equal(manager.createRoom({socketId: 'second', playerName: 'Second'}).error.code, 'ROOM_CAPACITY');
});

test('endTurn requires the active socket and PLAYER_ACTION, advances once, and replays idempotently', () => {
  const manager = managerWithCodes('ET2ABC');
  const created = createReadyRoom(manager, 'ET2ABC', 2, 'end');
  manager.startRoom('end-socket-1');
  const game = manager.getGameState(created.room.roomCode);
  game.state.phase = 'PLAYER_ACTION';
  const turnId = game.state.turnId;
  assert.equal(manager.endTurn('end-socket-2', {turnId, actionId: 'wrong-owner'}).error.code, 'NOT_ACTIVE_PLAYER');
  assert.equal(manager.endTurn('end-socket-1', {turnId: turnId + 1, actionId: 'stale-action-1'}).error.code, 'STALE_TURN');
  game.extraRollAvailable = true;
  assert.equal(manager.endTurn('end-socket-1', {turnId, actionId: 'double-must-reroll'}).error.code, 'EXTRA_ROLL_REQUIRED');
  assert.equal(game.state.turnId, turnId, 'a rejected double opt-out does not advance the turn');
  game.extraRollAvailable = false;
  const ended = manager.endTurn('end-socket-1', {turnId, actionId: 'end-once'});
  assert.equal(ended.ok, true);
  assert.equal(ended.result.activePlayerId, 'player-2');
  assert.equal(game.state.turnId, turnId + 1);
  assert.equal(manager.endTurn('end-socket-1', {turnId, actionId: 'end-once'}).result.duplicate, true);
  assert.equal(game.state.turnId, turnId + 1, 'duplicate action cannot advance twice');
});

test('endTurn rejects pending property, debt, auction, Chance presentation, and wrong phase', () => {
  const manager = managerWithCodes('ET2ABC');
  const created = createReadyRoom(manager, 'ET2ABC', 2, 'pending');
  manager.startRoom('pending-socket-1');
  const game = manager.getGameState(created.room.roomCode);
  const turnId = game.state.turnId;
  const attempt = () => manager.endTurn('pending-socket-1', {turnId, actionId: `pending-${counter++}`});
  let counter = 0;
  assert.equal(attempt().error.code, 'END_TURN_NOT_ALLOWED');
  game.state.phase = 'PLAYER_ACTION';
  game.pendingResolution = {playerId: 'player-1'};
  assert.equal(attempt().error.code, 'PENDING_ACTION'); game.pendingResolution = null;
  game.pendingDebt = {playerId: 'player-1'};
  assert.equal(attempt().error.code, 'PENDING_ACTION'); game.pendingDebt = null;
  game.activeAuction = {auctionId: 'auction'};
  assert.equal(attempt().error.code, 'PENDING_ACTION'); game.activeAuction = null;
  game.pendingChancePresentation = {presentationId: 'chance', pendingPlayerIds: ['player-1']};
  assert.equal(attempt().error.code, 'PENDING_ACTION');
});

test('normalizes room codes and rejects unknown or malformed codes', () => {
  const manager = managerWithCodes('AB2CD3');
  createHost(manager);
  assert.equal(join(manager, 'ab2cd3', 'guest').ok, true);
  assert.equal(managerWithCodes().joinRoom({socketId: 'x', roomCode: 'NOPE00', playerName: 'X'}).error.code, 'INVALID_ROOM_CODE');
  assert.equal(manager.joinRoom({socketId: 'x2', roomCode: 'ZZZZZZ', playerName: 'X'}).error.code, 'ROOM_NOT_FOUND');
});

test('rejects a socket attempting to join a second room or duplicate itself', () => {
  const manager = managerWithCodes('AB2CD3', 'EF4GH5');
  createHost(manager, 'host');
  createHost(manager, 'other-host');
  assert.equal(join(manager, 'AB2CD3', 'host').error.code, 'ALREADY_IN_ROOM');
  assert.equal(join(manager, 'AB2CD3', 'host-guest').ok, true);
  assert.equal(join(manager, 'AB2CD3', 'host-guest').error.code, 'ALREADY_IN_ROOM');
});

test('rejects players beyond the four-seat game capacity', () => {
  const manager = managerWithCodes('AB2CD3');
  createHost(manager, 's1');
  assert.equal(join(manager, 'AB2CD3', 's2').ok, true);
  assert.equal(join(manager, 'AB2CD3', 's3').ok, true);
  assert.equal(join(manager, 'AB2CD3', 's4').ok, true);
  assert.equal(join(manager, 'AB2CD3', 's5').error.code, 'ROOM_FULL');
  assert.equal(manager.getPublicRoom('AB2CD3').players.length, ROOM_MAX_PLAYERS);
});

test('returns updated public roster without socket identifiers on join and leave', () => {
  const manager = managerWithCodes('AB2CD3');
  const host = createHost(manager, 's1');
  const guest = join(manager, 'AB2CD3', 's2', 'Guest');
  assert.equal(guest.room.players.length, 2);
  assert.equal(guest.room.players[1].playerName, 'Guest');
  assert.equal('socketId' in guest.room.players[1], false);

  const left = manager.leaveRoom('s2');
  assert.equal(left.room.players.length, 1);
  assert.equal(left.room.players[0].playerId, host.playerId);
});

test('room members can change only their own ready status through socket identity', () => {
  const manager = managerWithCodes('AB2CD3');
  const host = createHost(manager, 's1');
  const guest = join(manager, 'AB2CD3', 's2');
  manager.setReady('s2', true);
  assert.equal(manager.getPublicRoom('AB2CD3').players.find(p => p.playerId === guest.playerId).isReady, true);
  assert.equal(manager.getPublicRoom('AB2CD3').players.find(p => p.playerId === host.playerId).isReady, false);
  assert.equal(manager.setReady('outsider', true).error.code, 'NOT_IN_ROOM');
  assert.equal(manager.setReady('s2', 'yes').error.code, 'INVALID_READY_STATE');
});

test('session tokens are private, room-bound, invalidated on leave, and rejected when forged', () => {
  const manager = managerWithCodes('AB2CD3', 'EF4GH5');
  const first = createHost(manager, 'one', 'One');
  const second = createHost(manager, 'two', 'Two');
  assert.match(first.sessionToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(first.room).includes(first.sessionToken), false);
  assert.equal(manager.resumeSession({socketId: 'resume', sessionToken: 'invalid-token'}).error.code, 'INVALID_SESSION');
  manager.handleDisconnect('one');
  assert.equal(manager.resumeSession({socketId: 'wrong-room', sessionToken: first.sessionToken,
    roomCode: second.room.roomCode}).error.code, 'SESSION_ROOM_MISMATCH');
  manager.leaveRoom('two');
  assert.equal(manager.resumeSession({socketId: 'old-token', sessionToken: second.sessionToken}).error.code, 'INVALID_SESSION');
});

test('lobby disconnect retains host and ready status during grace period, then resume reclaims the same seat', () => {
  const manager = managerWithCodes('AB2CD3');
  const host = createHost(manager, 'socket-host', 'Host');
  join(manager, host.room.roomCode, 'socket-guest', 'Guest');
  manager.setReady('socket-host', true);
  manager.handleDisconnect('socket-host');
  const room = manager.getPublicRoom(host.room.roomCode);
  assert.equal(room.players.length, 2);
  assert.equal(room.hostPlayerId, host.playerId);
  assert.equal(room.players[0].isConnected, false);
  assert.equal(room.players[0].isReady, true);
  const resumed = manager.resumeSession({socketId: 'socket-host-new', sessionToken: host.sessionToken, roomCode: 'AB2CD3'});
  assert.equal(resumed.ok, true);
  assert.equal(resumed.playerId, host.playerId);
  assert.equal(resumed.room.hostPlayerId, host.playerId);
  assert.equal(resumed.room.players[0].isConnected, true);
  assert.equal(resumed.room.players[0].isReady, true);
  assert.notEqual(resumed.sessionToken, host.sessionToken);
  assert.equal(manager.getMembership('socket-host'), null);
  assert.deepEqual(manager.getMembership('socket-host-new'), {roomCode: 'AB2CD3', playerId: host.playerId});
  assert.equal(manager.setReady('socket-host', false).error.code, 'NOT_IN_ROOM');
});

test('expired lobby session is removed and host handoff occurs only after the configured grace period', async () => {
  let id = 0;
  const manager = new RoomManager({codeGenerator: () => 'AB2CD3', idGenerator: () => `expire-${++id}`, sessionGracePeriodMs: 20});
  const host = manager.createRoom({socketId: 'host', playerName: 'Host'});
  const guest = manager.joinRoom({socketId: 'guest', roomCode: 'AB2CD3', playerName: 'Guest'});
  manager.handleDisconnect('host');
  assert.equal(manager.getPublicRoom('AB2CD3').hostPlayerId, host.playerId);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(manager.getPublicRoom('AB2CD3').hostPlayerId, guest.playerId);
  assert.deepEqual(manager.getPublicRoom('AB2CD3').players.map(player => player.playerId), [guest.playerId]);
  assert.equal(manager.resumeSession({socketId: 'late', sessionToken: host.sessionToken}).error.code, 'INVALID_SESSION');
});

test('active-game sessions remain recoverable beyond lobby grace and players cannot leave mid-game', async () => {
  const manager = new RoomManager({codeGenerator: () => 'AB2CD3', idGenerator: (() => { let id = 0; return () => `active-${++id}`; })(),
    sessionGracePeriodMs: 15});
  const host = manager.createRoom({socketId: 'host', playerName: 'Host'});
  const guest = manager.joinRoom({socketId: 'guest', roomCode: 'AB2CD3', playerName: 'Guest'});
  manager.setReady('host', true);
  manager.setReady('guest', true);
  assert.equal(manager.startRoom('host').ok, true);

  assert.equal(manager.leaveRoom('guest').error.code, 'GAME_IN_PROGRESS');
  assert.deepEqual(manager.getMembership('guest'), {roomCode: 'AB2CD3', playerId: guest.playerId});
  assert.equal(manager.getGameState('AB2CD3').state.players.length, 2);

  manager.handleDisconnect('host');
  await new Promise(resolve => setTimeout(resolve, 35));
  const room = manager.rooms.get('AB2CD3');
  const hostPlayer = room.players.find(player => player.playerId === host.playerId);
  assert.equal(hostPlayer.isConnected, false);
  assert.equal(hostPlayer.sessionExpired, undefined);
  assert.equal(manager.sessionsByPlayer.get(`AB2CD3:${host.playerId}`).expiresAt, null);
  const resumed = manager.resumeSession({socketId: 'host-rejoined', sessionToken: host.sessionToken});
  assert.equal(resumed.ok, true);
  assert.equal(resumed.playerId, host.playerId);
  assert.equal(manager.getPublicRoom('AB2CD3').players.length, 2);
});

test('requires host, at least two players, and every player ready before start', () => {
  const alone = managerWithCodes('AB2CD3');
  const loneHost = createHost(alone, 's1');
  assert.equal(alone.startRoom('s1').error.code, 'NOT_ENOUGH_PLAYERS');
  assert.equal(alone.rooms.get(loneHost.room.roomCode).status, 'waiting');

  const manager = managerWithCodes('EF4GH5');
  const host = createHost(manager, 'host');
  const guest = join(manager, host.room.roomCode, 'guest');
  assert.equal(manager.startRoom('guest').error.code, 'HOST_ONLY');
  assert.equal(manager.startRoom('host').error.code, 'PLAYERS_NOT_READY');
  manager.setReady('host', true);
  manager.setReady('guest', true);
  const started = manager.startRoom('host');
  assert.equal(started.ok, true);
  assert.equal(started.room.status, 'started');
  assert.equal(manager.joinRoom({socketId: 'late', roomCode: 'EF4GH5', playerName: 'Late'}).error.code, 'ROOM_STARTED');
  assert.equal(manager.setReady('guest', false).error.code, 'ROOM_STARTED');
  assert.equal(guest.room.players.length, ROOM_MIN_PLAYERS);
});

test('host leaving transfers host and an empty room is deleted', () => {
  const manager = managerWithCodes('AB2CD3');
  const host = createHost(manager, 's1');
  const guest = join(manager, 'AB2CD3', 's2');
  const afterHostLeaves = manager.leaveRoom('s1');
  assert.equal(afterHostLeaves.room.hostPlayerId, guest.playerId);
  assert.equal(manager.rooms.has('AB2CD3'), true);
  const empty = manager.leaveRoom('s2');
  assert.equal(empty.deleted, true);
  assert.equal(empty.room, null);
  assert.equal(manager.rooms.has('AB2CD3'), false);
});

test('duplicate create and ready calls never duplicate roster members', () => {
  const manager = managerWithCodes('AB2CD3');
  createHost(manager, 's1');
  assert.equal(manager.createRoom({socketId: 's1', playerName: 'Again'}).error.code, 'ALREADY_IN_ROOM');
  join(manager, 'AB2CD3', 's2');
  manager.setReady('s2', true);
  manager.setReady('s2', true);
  const roster = manager.getPublicRoom('AB2CD3').players;
  assert.equal(roster.length, 2);
  assert.equal(new Set(roster.map(player => player.playerId)).size, 2);
});

test('starting rooms with two, three, or four players maps the full lobby roster to unique seats', () => {
  const manager = managerWithCodes('AB2CD3', 'EF4GH5', 'JK6MN7');
  for (const count of [2, 3, 4]) {
    const prefix = `room-${count}`;
    const created = createReadyRoom(manager, ['AB2CD3', 'EF4GH5', 'JK6MN7'][count - 2], count, prefix);
    const result = manager.startRoom(`${prefix}-socket-1`);
    assert.equal(result.ok, true);
    const state = manager.getGameState(created.room.roomCode).state;
    const room = manager.rooms.get(created.room.roomCode);
    assert.equal(state.players.length, count);
    assert.deepEqual(state.players.map(player => player.playerId), room.players.map(player => player.playerId));
    assert.deepEqual(state.players.map(player => player.name), room.players.map(player => player.playerName));
    assert.deepEqual(state.players.map(player => player.seat), [0, 1, 2, 3].slice(0, count));
    assert.equal(new Set(state.players.map(player => player.seat)).size, count);
  }
});

test('separate rooms own isolated game state and repeated start does not recreate it', () => {
  let factoryCalls = 0;
  const manager = managerWithCodes('AB2CD3', 'EF4GH5');
  const defaultFactory = manager.gameStateFactory;
  manager.gameStateFactory = options => { factoryCalls++; return defaultFactory(options); };

  const roomA = createReadyRoom(manager, 'AB2CD3', 2, 'a');
  const roomB = createReadyRoom(manager, 'EF4GH5', 2, 'b');
  manager.startRoom('a-socket-1');
  manager.startRoom('b-socket-1');
  const stateA = manager.getGameState(roomA.room.roomCode);
  const stateB = manager.getGameState(roomB.room.roomCode);
  assert.notEqual(stateA, stateB);
  assert.notEqual(stateA.state.players, stateB.state.players);
  assert.notEqual(stateA.state.properties, stateB.state.properties);

  stateA.state.players[0].money = 12;
  stateA.state.properties.get(8).owner = stateA.state.players[0].playerId;
  assert.equal(stateB.state.players[0].money, 1500);
  assert.equal(stateB.state.properties.get(8).owner, null);

  const repeated = manager.startRoom('a-socket-1');
  assert.equal(repeated.error.code, 'ROOM_STARTED');
  assert.equal(manager.getGameState(roomA.room.roomCode), stateA);
  assert.equal(factoryCalls, 2);
});

test('GameState creation failure leaves room waiting with no partial state', () => {
  const manager = managerWithCodes('AB2CD3');
  manager.gameStateFactory = () => { throw new Error('fixture failure'); };
  const created = createReadyRoom(manager, 'AB2CD3', 2, 'failure');
  const result = manager.startRoom('failure-socket-1');

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'GAME_STATE_CREATION_FAILED');
  assert.equal(manager.rooms.get(created.room.roomCode).status, 'waiting');
  assert.equal(manager.rooms.get(created.room.roomCode).gameState, null);
  assert.equal(manager.getGameState(created.room.roomCode), null);
});

test('deleting an empty started room clears its ServerGameState reference', () => {
  const manager = managerWithCodes('AB2CD3');
  const created = createReadyRoom(manager, 'AB2CD3', 2, 'delete');
  manager.startRoom('delete-socket-1');
  const roomRecord = manager.rooms.get(created.room.roomCode);
  const state = roomRecord.gameState;
  assert.ok(state);
  state.state.gameStatus = 'FINISHED';

  manager.leaveRoom('delete-socket-1');
  const deleted = manager.leaveRoom('delete-socket-2');
  assert.equal(deleted.deleted, true);
  assert.equal(roomRecord.gameState, null);
  assert.equal(manager.getGameState(created.room.roomCode), null);
});

test('authoritative dice accepts only the active socket and rejects concurrent, repeated, stale, and client-supplied dice', async () => {
  let rolls = 0;
  let id = 0;
  const manager = new RoomManager({
    codeGenerator: () => 'AB2CD3',
    idGenerator: () => `player-${++id}`,
    diceRoller: () => { rolls++; return [4, 2]; }
  });
  const room = createHost(manager, 's1', 'Host');
  const guest = join(manager, room.room.roomCode, 's2', 'Guest');
  manager.setReady('s1', true);
  manager.setReady('s2', true);
  manager.startRoom('s1');

  assert.equal(manager.requestRoll('s2', {turnId: 1}).error.code, 'NOT_ACTIVE_PLAYER');
  assert.equal(manager.requestRoll('s1', {turnId: 1, dice: [1, 1]}).error.code, 'INVALID_PAYLOAD');
  assert.equal(rolls, 0);

  const results = await Promise.all([
    Promise.resolve(manager.requestRoll('s1', {turnId: 1})),
    Promise.resolve(manager.requestRoll('s1', {turnId: 1}))
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(rolls, 1);
  const rolled = results.find(result => result.ok).result;
  assert.deepEqual([rolled.die1, rolled.die2, rolled.total], [4, 2, 6]);
  assert.equal(rolled.playerId, room.playerId);
  assert.equal(rolled.seat, 0);
  assert.equal(rolled.phase, 'MOVING');
  assert.equal(rolled.movement.startPos, 0);
  assert.equal(rolled.movement.endPos, 6);
  assert.equal(rolled.movement.steps, 6);
  assert.equal(rolled.movement.startBonus, 0);
  assert.equal(manager.getGameState(room.room.roomCode).state.players[0].pos, 6);
  assert.equal(manager.requestRoll('s1', {turnId: 1, endPos: 22, steps: 22}).error.code, 'INVALID_PAYLOAD');
  assert.equal(manager.requestRoll('s1', {turnId: 1}).error.code, 'ROLL_NOT_ALLOWED');

  const serverState = manager.getGameState(room.room.roomCode);
  serverState.state.phase = 'PLAYER_ACTION'; // Simulasikan resolusi petak dari tahap berikutnya.
  assert.equal(serverState.advanceTurn({playerId: room.playerId, turnId: 1}), true);
  assert.equal(serverState.state.activePlayerId, guest.playerId);
  assert.equal(serverState.state.turnId, 2);
  assert.equal(manager.requestRoll('s2', {turnId: 1}).error.code, 'STALE_TURN');
  assert.equal(manager.requestRoll('s2', {turnId: 2}).ok, true);
  assert.equal(rolls, 2);
});

test('invalid server dice generator never stores an invalid result and leaves roll phase retryable', () => {
  let id = 0;
  const manager = new RoomManager({
    codeGenerator: () => 'EF4GH5', idGenerator: () => `bad-${++id}`, diceRoller: () => [0, 7]
  });
  const host = createHost(manager, 'bad-s1');
  join(manager, host.room.roomCode, 'bad-s2');
  manager.setReady('bad-s1', true);
  manager.setReady('bad-s2', true);
  manager.startRoom('bad-s1');
  const result = manager.requestRoll('bad-s1', {turnId: 1});
  assert.equal(result.error.code, 'DICE_ROLL_FAILED');
  assert.equal(manager.getGameState(host.room.roomCode).state.phase, 'WAITING_ROLL');
  assert.equal(manager.getGameState(host.room.roomCode).state.lastRoll, null);
});

test('property decision accepts only an active member and a minimal authoritative decision payload', () => {
  let id = 0;
  const manager = new RoomManager({
    codeGenerator: () => 'AB2CD3',
    idGenerator: () => `buyer-${++id}`,
    diceRoller: () => [1, 2],
    movementIdGenerator: () => 'movement-1',
    resolutionIdGenerator: () => 'resolution-1'
  });
  const host = createHost(manager, 's1', 'Host');
  const guest = join(manager, host.room.roomCode, 's2', 'Guest');
  manager.setReady('s1', true);
  manager.setReady('s2', true);
  manager.startRoom('s1');
  const rolled = manager.requestRoll('s1', {turnId: 1});
  assert.equal(rolled.result.tileResolution.kind, 'PROPERTY_OFFER');

  assert.equal(manager.resolvePropertyDecision('s2', {
    turnId: 1, resolutionId: 'resolution-1', decision: 'BUY'
  }).error.code, 'NOT_ACTIVE_PLAYER');
  assert.equal(manager.resolvePropertyDecision('s1', {
    turnId: 1, resolutionId: 'resolution-1', decision: 'BUY', price: 1, balance: 999999
  }).error.code, 'INVALID_PAYLOAD');
  const resolved = manager.resolvePropertyDecision('s1', {
    turnId: 1, resolutionId: 'resolution-1', decision: 'BUY'
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.result.balance, 1440);
  assert.equal(manager.getGameState(host.room.roomCode).state.properties.get(3).owner, host.playerId);
  assert.equal(manager.getGameState(host.room.roomCode).state.activePlayerId, host.playerId);
  assert.equal(manager.resolvePropertyDecision('s1', {
    turnId: 1, resolutionId: 'resolution-1', decision: 'BUY'
  }).error.code, 'STALE_RESOLUTION');
});

test('doubles preserve the active player through tile resolution, while a non-double ends the turn', () => {
  let id = 0;
  const rolls = [[1, 1], [2, 2], [1, 2]];
  const manager = new RoomManager({
    codeGenerator: () => 'EF4GH5',
    idGenerator: () => `double-${++id}`,
    diceRoller: () => rolls.shift(),
    movementIdGenerator: (() => { let movement = 0; return () => `movement-${++movement}`; })(),
    resolutionIdGenerator: (() => { let resolution = 0; return () => `resolution-${++resolution}`; })()
  });
  const host = createHost(manager, 'double-s1', 'Host');
  const guest = join(manager, host.room.roomCode, 'double-s2', 'Guest');
  manager.setReady('double-s1', true);
  manager.setReady('double-s2', true);
  manager.startRoom('double-s1');
  const game = manager.getGameState(host.room.roomCode);
  game.state.players[0].pos = 8;

  const first = manager.requestRoll('double-s1', {turnId: 1});
  assert.equal(first.result.isDouble, true);
  assert.equal(first.result.consecutiveDoubles, 1);
  assert.equal(first.result.tileResolution.event.kind, 'JAIL_VISIT');
  assert.equal(first.result.tileResolution.event.extraRollAllowed, true);
  assert.equal(game.state.activePlayerId, host.playerId);
  assert.equal(game.state.currentTurn, 0);
  assert.equal(game.state.turnId, 2);
  assert.equal(game.state.consecutiveDoubles, 1);
  assert.equal(manager.requestRoll('double-s1', {turnId: 1}).error.code, 'STALE_TURN');

  const second = manager.requestRoll('double-s1', {turnId: 2});
  assert.equal(second.result.consecutiveDoubles, 2);
  assert.equal(second.result.tileResolution.kind, 'PROPERTY_OFFER');
  assert.equal(game.state.phase, 'WAITING_PROPERTY_DECISION');
  assert.equal(manager.requestRoll('double-s1', {turnId: 2}).error.code, 'ROLL_NOT_ALLOWED');
  const declined = manager.resolvePropertyDecision('double-s1', {
    turnId: 2, resolutionId: second.result.tileResolution.offer.resolutionId, decision: 'DECLINE'
  });
  assert.equal(declined.result.type, 'STARTED');
  const auctionId = declined.result.auction.auctionId;
  manager.resolveAuctionAction('double-s1', {turnId: 2, auctionId, actionId: 'double-pass-host', action: 'PASS'});
  const auctionEnd = manager.resolveAuctionAction('double-s2', {turnId: 2, auctionId, actionId: 'double-pass-guest', action: 'PASS'});
  assert.equal(auctionEnd.result.extraRollAllowed, true);
  assert.equal(auctionEnd.result.activePlayerId, host.playerId);
  assert.equal(auctionEnd.result.consecutiveDoubles, 2);
  assert.equal(game.state.turnId, 3);

  game.state.players[0].pos = 1;
  const third = manager.requestRoll('double-s1', {turnId: 3});
  assert.equal(third.result.isDouble, false);
  assert.equal(third.result.consecutiveDoubles, 0);
  assert.equal(third.result.tileResolution.event.kind, 'TAX_PAID');
  assert.equal(third.result.tileResolution.event.extraRollAllowed, false);
  assert.equal(game.state.consecutiveDoubles, 0);
  assert.equal(game.state.phase, 'PLAYER_ACTION');
  assert.equal(game.state.activePlayerId, host.playerId);
  assert.equal(game.state.turnId, 3);
  assert.equal(game.state.players[0].consecutiveDoubles, 0);
  const ended = manager.endTurn('double-s1', {turnId: 3, actionId: 'end-after-normal-roll'});
  assert.equal(ended.ok, true);
  assert.equal(game.state.activePlayerId, guest.playerId);
  assert.equal(game.state.turnId, 4);
});

test('third consecutive double jails the player without moving by the dice total', () => {
  let id = 0;
  const manager = new RoomManager({
    codeGenerator: () => 'JK6MN7', idGenerator: () => `triple-${++id}`,
    diceRoller: () => [3, 3], movementIdGenerator: () => 'must-not-move',
    resolutionIdGenerator: () => 'triple-jail-resolution'
  });
  const host = createHost(manager, 'triple-s1', 'Host');
  const guest = join(manager, host.room.roomCode, 'triple-s2', 'Guest');
  manager.setReady('triple-s1', true);
  manager.setReady('triple-s2', true);
  manager.startRoom('triple-s1');
  const game = manager.getGameState(host.room.roomCode);
  const player = game.state.players[0];
  player.pos = 7;
  player.consecutiveDoubles = 2;
  game.state.consecutiveDoubles = 2;

  const result = manager.requestRoll('triple-s1', {turnId: 1});
  assert.equal(result.ok, true);
  assert.equal(result.result.phase, 'JAILING');
  assert.equal(result.result.tripleDouble, true);
  assert.equal(result.result.consecutiveDoubles, 3);
  assert.equal('movement' in result.result, false);
  assert.equal(result.result.jailPenalty.kind, 'THREE_DOUBLES_JAIL');
  assert.equal(player.pos, 10);
  assert.equal(player.status, 'IN_JAIL');
  assert.equal(player.inJail, true);
  assert.equal(player.consecutiveDoubles, 0);
  assert.equal(game.state.consecutiveDoubles, 0);
  assert.equal(game.state.activePlayerId, guest.playerId);
  assert.equal(game.state.turnId, 2);
});
