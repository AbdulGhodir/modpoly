import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {SocketClient} from '../../src/network/SocketClient.js';
import {createBackendServer} from '../src/app.js';
import {RoomManager} from '../src/RoomManager.js';
import {CHANCE_CARDS} from '../../src/data/cards.js';

async function startBackend(t, roomManager, options = {}) {
  const backend = createBackendServer({port: 0, allowedOrigins: ['http://localhost:5173'],
    ...(roomManager ? {roomManager} : {}), ...options});
  backend.httpServer.listen(0, '127.0.0.1');
  await once(backend.httpServer, 'listening');
  const {port} = backend.httpServer.address();
  t.after(() => new Promise(resolve => backend.io.close(resolve)));
  return {backend, url: `http://127.0.0.1:${port}`};
}

function connectClient(t, url) {
  const client = new SocketClient({url});
  t.after(() => client.disconnect());
  const connected = client.getStatus() === 'connected'
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Socket connect timeout')); }, 5000);
      const unsubscribe = client.onStatusChange(status => {
        if (status !== 'connected') return;
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      });
    });
  client.connect();
  return {client, connected};
}

function waitForEvent(client, eventName, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error(`Timeout waiting for ${eventName}`)); }, 5000);
    const unsubscribe = client.on(eventName, payload => {
      if (!predicate(payload)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(payload);
    });
  });
}

test('Socket.IO rate limits are categorized, acknowledged, recover after refill, and reject extra lobby fields', async t => {
  const {backend, url} = await startBackend(t, null, {rateLimits: {
    room: {capacity: 1, refillPerSecond: 20}, gameplay: {capacity: 1, refillPerSecond: 20},
    ping: {capacity: 1, refillPerSecond: 0.01}, roomIp: {capacity: 1, refillPerSecond: 2}
  }});
  const hostConnection = connectClient(t, url);
  const guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const {client: host} = hostConnection;
  const {client: guest} = guestConnection;
  assert.equal(new Set([...backend.io.sockets.sockets.values()].map(socket => socket.handshake.address)).size, 1);

  const created = await host.request('room:create', {playerName: 'Host'});
  assert.equal(created.ok, true);
  assert.equal((await guest.request('room:join', {roomCode: created.room.roomCode, playerName: 'Guest'})).error.code,
    'RATE_LIMITED', 'create/join IP budget is shared across sockets');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal((await guest.request('room:join', {roomCode: created.room.roomCode, playerName: 'Guest'})).ok, true);
  assert.equal((await guest.request('room:get')).error.code, 'RATE_LIMITED', 'lobby events share a socket bucket');
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal((await guest.request('room:get')).ok, true, 'room requests resume after token refill');

  assert.equal((await host.request('game:roll-dice', {})).error.code, 'INVALID_PAYLOAD');
  assert.equal((await host.request('game:roll-dice', {})).error.code, 'RATE_LIMITED');

  const pingError = waitForEvent(host, 'connection:error', payload => payload.error?.code === 'RATE_LIMITED');
  assert.equal(host.ping('first'), true);
  assert.equal(host.ping('second'), true);
  assert.equal((await pingError).error.code, 'RATE_LIMITED');
});

test('multiple clients create, join, ready, and start a private room', async t => {
  const {backend, url} = await startBackend(t);
  const hostConnection = connectClient(t, url);
  const guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const {client: host} = hostConnection;
  const {client: guest} = guestConnection;

  const created = await host.request('room:create', {playerName: 'Host'});
  assert.equal(created.ok, true);
  assert.match(created.sessionToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal('sessionToken' in created.room, false);
  assert.match(created.room.roomCode, /^[A-HJ-KM-NP-Z2-9]{6}$/);

  const guestUpdate = waitForEvent(guest, 'room:updated', room => room.players.length === 2);
  const joined = await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode.toLowerCase()});
  assert.equal(joined.ok, true);
  assert.equal((await guestUpdate).players.length, 2);

  // A client-supplied player identity is ignored; server uses the identity tied to its socket.
  const hostReadyUpdate = waitForEvent(host, 'room:updated', room =>
    room.players.some(player => player.playerId === joined.playerId && player.isReady));
  await guest.request('room:ready', {playerId: created.playerId, isReady: false});
  assert.equal((await hostReadyUpdate).players.find(player => player.playerId === joined.playerId).isReady, true);
  let current = await guest.request('room:get');
  assert.equal(current.room.players.find(player => player.playerId === joined.playerId).isReady, true);
  assert.equal(current.room.players.find(player => player.playerId === created.playerId).isReady, false);

  assert.equal((await guest.request('room:start')).error.code, 'HOST_ONLY');
  await host.request('room:ready');
  const hostStarted = waitForEvent(host, 'room:started');
  const guestStarted = waitForEvent(guest, 'room:started');
  const hostSnapshot = waitForEvent(host, 'game:initial-snapshot');
  const guestSnapshot = waitForEvent(guest, 'game:initial-snapshot');
  const started = await host.request('room:start');
  assert.equal(started.ok, true);
  assert.equal(started.room.status, 'started');
  assert.equal('gameState' in started.room, false, 'gameplay state stays out of public room events');
  const storedState = backend.roomManager.getGameState(created.room.roomCode);
  assert.deepEqual(storedState.state.players.map(player => player.playerId), [created.playerId, joined.playerId]);
  assert.deepEqual(storedState.state.players.map(player => player.seat), [0, 1]);
  assert.equal((await hostStarted).status, 'started');
  assert.equal((await guestStarted).status, 'started');
  const snapshots = await Promise.all([hostSnapshot, guestSnapshot]);
  assert.deepEqual(snapshots[0], snapshots[1]);
  assert.equal(snapshots[0].roomCode, created.room.roomCode);
  assert.equal(snapshots[0].snapshot.players.length, 2);
  assert.equal(snapshots[0].snapshot.properties.length, 28);
  assert.equal(JSON.stringify(snapshots[0]).includes(host.socket.id), false);
  assert.equal(JSON.stringify(snapshots[0]).includes(guest.socket.id), false);

  const late = connectClient(t, url);
  await late.connected;
  let outsiderSnapshotCount = 0;
  late.client.on('game:initial-snapshot', () => outsiderSnapshotCount++);
  assert.equal((await late.client.request('room:join', {playerName: 'Late', roomCode: created.room.roomCode})).error.code, 'ROOM_STARTED');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(outsiderSnapshotCount, 0);
  assert.equal(backend.roomManager.getPublicRoom(created.room.roomCode).players.length, 2);
});

test('a socket cannot create/join multiple identities and host leave transfers ownership', async t => {
  const {backend, url} = await startBackend(t);
  const hostConnection = connectClient(t, url);
  const guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const {client: host} = hostConnection;
  const {client: guest} = guestConnection;

  const created = await host.request('room:create', {playerName: 'Host'});
  const joined = await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  assert.equal((await host.request('room:create', {playerName: 'Second identity'})).error.code, 'ALREADY_IN_ROOM');
  assert.equal((await guest.request('room:join', {playerName: 'Duplicate', roomCode: created.room.roomCode})).error.code, 'ALREADY_IN_ROOM');

  const transfer = waitForEvent(guest, 'room:updated', room => room.hostPlayerId === joined.playerId);
  await host.request('room:leave');
  assert.equal((await transfer).hostPlayerId, joined.playerId);
  assert.equal(backend.roomManager.getPublicRoom(created.room.roomCode).players.length, 1);
  const empty = await guest.request('room:leave');
  assert.equal(empty.deleted, true);
  assert.equal(backend.roomManager.getPublicRoom(created.room.roomCode), null);
});

test('lobby disconnect keeps the host and reconnect restores the same player session', async t => {
  const {backend, url} = await startBackend(t);
  const hostConnection = connectClient(t, url);
  const guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const created = await hostConnection.client.request('room:create', {playerName: 'Host'});
  const joined = await guestConnection.client.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});

  await hostConnection.client.request('room:ready');
  const updated = waitForEvent(guestConnection.client, 'room:updated', room =>
    room.players.some(player => player.playerId === created.playerId && player.isConnected === false));
  const hostSocketId = hostConnection.client.socket.id;
  hostConnection.client.disconnect();
  const room = await updated;
  assert.equal(room.hostPlayerId, created.playerId);
  assert.equal(room.players.length, 2);
  assert.equal(room.players[0].isReady, true);
  assert.equal(backend.roomManager.getMembership(hostSocketId), null);
  const resumedConnection = connectClient(t, url);
  await resumedConnection.connected;
  const resumed = await resumedConnection.client.request('room:resume', {sessionToken: created.sessionToken,
    roomCode: created.room.roomCode});
  assert.equal(resumed.ok, true);
  assert.equal(resumed.playerId, created.playerId);
  assert.equal(resumed.room.hostPlayerId, created.playerId);
  assert.equal(resumed.room.players[0].isConnected, true);
  assert.equal(resumed.room.players[0].isReady, true);
  assert.notEqual(resumed.sessionToken, created.sessionToken);
  assert.equal(backend.roomManager.getMembership(hostSocketId), null);
  assert.equal(backend.roomManager.getMembership(resumedConnection.client.socket.id).playerId, created.playerId);
  assert.equal((await hostConnection.client.request('room:resume', {sessionToken: created.sessionToken})).ok, false);
});

test('disconnect after start retains the player, seat, and room state as offline', async t => {
  const {backend, url} = await startBackend(t, new RoomManager({diceRoller: () => [1, 2]}));
  const hostConnection = connectClient(t, url);
  const guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const created = await hostConnection.client.request('room:create', {playerName: 'Host'});
  const joined = await guestConnection.client.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await hostConnection.client.request('room:ready');
  await guestConnection.client.request('room:ready');
  await hostConnection.client.request('room:start');
  const gameState = backend.roomManager.getGameState(created.room.roomCode);
  gameState.state.players[1].money = 987;
  const rolled = await hostConnection.client.request('game:roll-dice', {turnId: 1});
  assert.equal(rolled.ok, true);
  const hostPosition = gameState.state.players[0].pos;
  const hostBalance = gameState.state.players[0].money;
  const playerIds = gameState.state.players.map(player => player.playerId);
  const hostSocketId = hostConnection.client.socket.id;

  const roomUpdated = waitForEvent(guestConnection.client, 'room:updated', room =>
    room.status === 'started' && room.players.some(player => player.playerId === created.playerId && player.isConnected === false));
  hostConnection.client.disconnect();
  const room = await roomUpdated;

  assert.equal(room.players.length, 2);
  assert.equal(room.players.find(player => player.playerId === created.playerId).isConnected, false);
  assert.equal(backend.roomManager.getMembership(hostSocketId), null);
  assert.equal(backend.roomManager.getGameState(created.room.roomCode), gameState);
  assert.deepEqual(gameState.state.players.map(player => player.playerId), playerIds);
  assert.deepEqual(gameState.state.players.map(player => player.seat), [0, 1]);
  assert.equal(gameState.state.players[1].money, 987);
  assert.equal(gameState.state.players[0].pos, hostPosition);
  assert.equal(gameState.state.players[0].money, hostBalance);
  assert.equal(gameState.state.currentTurn, 0);
  assert.equal(gameState.state.activePlayerId, created.playerId);
  assert.equal(backend.roomManager.requestRoll(hostSocketId, {turnId: 1}).error.code, 'NOT_IN_ROOM');
  assert.equal(backend.roomManager.requestRoll(guestConnection.client.socket.id, {turnId: 1}).error.code, 'NOT_ACTIVE_PLAYER');
});

test('started room reconnect returns the latest Chance debt snapshot without replaying effects', async t => {
  const {backend, url} = await startBackend(t, new RoomManager({diceRoller: () => [1, 2]}));
  const hostConnection = connectClient(t, url);
  const guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const host = hostConnection.client, guest = guestConnection.client;
  const created = await host.request('room:create', {playerName: 'Host'});
  const joined = await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready'); await guest.request('room:ready'); await host.request('room:start');
  const game = backend.roomManager.getGameState(created.room.roomCode);
  game.state.players[0].pos = 2;
  game.state.players[0].money = 10;
  game.state.phase = 'WAITING_TILE_RESOLUTION';
  game.state.lastRoll = {dice: [1, 2], total: 3, isDouble: false, consecutiveDoubles: 0, movementId: 'resume-debt-move'};
  game.chanceDeck = {draw: () => ({...CHANCE_CARDS.find(card => card.id === 'ch_2')})};
  const previousTransactionCount = game.state.transactions.length;
  const debt = game.resolveLandedTile({playerId: created.playerId, turnId: 1,
    movementId: 'resume-debt-move', resolutionId: 'resume-debt-origin'});
  assert.equal(debt.resolution.kind, 'CHANCE_PRESENTATION');
  assert.equal(game.state.players[0].money, 10);
  const continued = game.continueChancePresentation({playerId: created.playerId, turnId: 1,
    resolutionId: 'resume-debt-origin', presentationId: debt.resolution.event.presentationId,
    actionId: 'resume-debt-continue'});
  assert.equal(continued.ok, true);
  assert.equal(continued.result.resolution.event.phase, 'DEBT_RESOLUTION');
  assert.equal(continued.result.resolution.event.debt.chanceCard.id, 'ch_2');
  const offline = waitForEvent(guest, 'room:updated', room => room.players.some(player =>
    player.playerId === created.playerId && player.isConnected === false));
  host.disconnect();
  await offline;

  const replacement = connectClient(t, url);
  await replacement.connected;
  const resumed = await replacement.client.request('room:resume', {sessionToken: created.sessionToken,
    roomCode: created.room.roomCode});
  assert.equal(resumed.ok, true);
  assert.equal(resumed.playerId, created.playerId);
  assert.equal(resumed.snapshot.players[0].seat, 0);
  assert.equal(resumed.snapshot.players[0].money, 10);
  assert.equal(resumed.snapshot.players[0].pos, 2);
  assert.equal(resumed.snapshot.phase, 'DEBT_RESOLUTION');
  assert.equal(resumed.snapshot.pendingDebt.debtId, continued.result.resolution.event.debt.debtId);
  assert.equal(resumed.snapshot.pendingDebt.chanceCard.id, 'ch_2');
  assert.equal(resumed.snapshot.transactions.length, previousTransactionCount);
  assert.equal(JSON.stringify(resumed.snapshot).includes(created.sessionToken), false);
  assert.deepEqual(resumed.snapshot.players.map(player => player.playerId), [created.playerId, joined.playerId]);
});

test('reconnect restores a pending property offer so the same player can continue the decision', async t => {
  const {backend, url} = await startBackend(t);
  const hostConnection = connectClient(t, url), guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const host = hostConnection.client, guest = guestConnection.client;
  const created = await host.request('room:create', {playerName: 'Host'});
  await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready'); await guest.request('room:ready'); await host.request('room:start');
  const game = backend.roomManager.getGameState(created.room.roomCode);
  game.state.players[0].pos = 1;
  game.state.phase = 'WAITING_TILE_RESOLUTION';
  game.state.lastRoll = {dice: [1, 2], total: 3, isDouble: false, consecutiveDoubles: 0, movementId: 'offer-move'};
  const offer = game.resolveLandedTile({playerId: created.playerId, turnId: 1,
    movementId: 'offer-move', resolutionId: 'offer-origin'});
  assert.equal(offer.resolution.kind, 'PROPERTY_OFFER');
  const offline = waitForEvent(guest, 'room:updated', room => room.players.some(player =>
    player.playerId === created.playerId && player.isConnected === false));
  host.disconnect(); await offline;
  const replacement = connectClient(t, url); await replacement.connected;
  const resumed = await replacement.client.request('room:resume', {sessionToken: created.sessionToken});
  assert.equal(resumed.ok, true);
  assert.equal(resumed.snapshot.phase, 'WAITING_PROPERTY_DECISION');
  assert.equal(resumed.snapshot.pendingPropertyOffer.resolutionId, 'offer-origin');
  assert.equal(resumed.snapshot.pendingPropertyOffer.playerId, created.playerId);
  assert.equal(resumed.snapshot.pendingPropertyOffer.propertyPos, 1);
  assert.equal(resumed.snapshot.pendingPropertyOffer.price, game.state.properties.get(1).price);
});

test('disconnect during auction leaves bidding paused and reconnect returns the same auction snapshot', async t => {
  const {backend, url} = await startBackend(t);
  const hostConnection = connectClient(t, url), guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const host = hostConnection.client, guest = guestConnection.client;
  const created = await host.request('room:create', {playerName: 'Host'});
  await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready'); await guest.request('room:ready'); await host.request('room:start');
  const game = backend.roomManager.getGameState(created.room.roomCode);
  game.state.players[0].pos = 1;
  game.state.phase = 'WAITING_TILE_RESOLUTION';
  game.state.lastRoll = {dice: [1, 2], total: 3, isDouble: false, consecutiveDoubles: 0, movementId: 'auction-resume-move'};
  const offer = game.resolveLandedTile({playerId: created.playerId, turnId: 1,
    movementId: 'auction-resume-move', resolutionId: 'auction-resume-origin'});
  const started = game.respondToPropertyOffer({playerId: created.playerId, turnId: 1,
    resolutionId: offer.resolution.offer.resolutionId, decision: 'DECLINE'});
  assert.equal(started.result.type, 'STARTED');
  assert.equal(game.state.phase, 'WAITING_AUCTION_ACTION');
  const offline = waitForEvent(guest, 'room:updated', room => room.players.some(player =>
    player.playerId === created.playerId && player.isConnected === false));
  host.disconnect(); await offline;
  assert.equal(game.state.phase, 'WAITING_AUCTION_ACTION', 'disconnect does not auto-pass');
  const replacement = connectClient(t, url); await replacement.connected;
  const resumed = await replacement.client.request('room:resume', {sessionToken: created.sessionToken});
  assert.equal(resumed.ok, true);
  assert.equal(resumed.snapshot.phase, 'WAITING_AUCTION_ACTION');
  assert.equal(resumed.snapshot.activeAuction.auctionId, started.result.auction.auctionId);
  assert.equal(resumed.snapshot.activeAuction.currentBidderId, created.playerId);
});

test('session takeover invalidates the old socket and the previous token cannot take over twice', async t => {
  const {backend, url} = await startBackend(t);
  const originalConnection = connectClient(t, url);
  await originalConnection.connected;
  const original = originalConnection.client;
  const created = await original.request('room:create', {playerName: 'Host'});
  const originalSocketId = original.socket.id;
  const forgedIdentity = connectClient(t, url);
  await forgedIdentity.connected;
  const forged = await forgedIdentity.client.request('room:resume', {sessionToken: created.sessionToken, playerId: 'forged-player'});
  assert.equal(forged.ok, false);
  assert.equal(forged.error.code, 'INVALID_PAYLOAD');
  const replacement = connectClient(t, url);
  await replacement.connected;
  const moved = await replacement.client.request('room:resume', {sessionToken: created.sessionToken});
  assert.equal(moved.ok, true);
  assert.equal(moved.playerId, created.playerId);
  assert.equal(original.getStatus(), 'disconnected');
  assert.equal(backend.roomManager.getMembership(originalSocketId), null);
  const third = connectClient(t, url);
  await third.connected;
  const replay = await third.client.request('room:resume', {sessionToken: created.sessionToken});
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, 'SESSION_ALREADY_MOVED');

  const nextToken = moved.sessionToken;
  replacement.client.disconnect();
  const resumedAgain = connectClient(t, url);
  await resumedAgain.connected;
  const again = await resumedAgain.client.request('room:resume', {sessionToken: nextToken});
  assert.equal(again.ok, true);
  assert.equal(again.playerId, created.playerId);
  assert.equal(again.room.players.length, 1);
});

test('failed room GameState factory emits no initial snapshot', async t => {
  const roomManager = new RoomManager({gameStateFactory: () => { throw new Error('expected factory failure'); }});
  const {url} = await startBackend(t, roomManager);
  const hostConnection = connectClient(t, url);
  const guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const host = hostConnection.client;
  const guest = guestConnection.client;
  const created = await host.request('room:create', {playerName: 'Host'});
  await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready');
  await guest.request('room:ready');
  let snapshots = 0;
  host.on('game:initial-snapshot', () => snapshots++);
  guest.on('game:initial-snapshot', () => snapshots++);

  const result = await host.request('room:start');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(result.error.code, 'GAME_STATE_CREATION_FAILED');
  assert.equal(snapshots, 0);
  assert.equal(roomManager.getGameState(created.room.roomCode), null);
});

test('server-authoritative dice broadcasts one official result only to the requesting room', async t => {
  let nextId = 0;
  const roomManager = new RoomManager({
    idGenerator: () => `dice-player-${++nextId}`,
    diceRoller: () => [2, 5]
  });
  const {url} = await startBackend(t, roomManager);
  const connections = Array.from({length: 4}, () => connectClient(t, url));
  await Promise.all(connections.map(connection => connection.connected));
  const [host, guest, otherHost, otherGuest] = connections.map(connection => connection.client);

  const roomA = await host.request('room:create', {playerName: 'Host A'});
  await guest.request('room:join', {playerName: 'Guest A', roomCode: roomA.room.roomCode});
  const roomB = await otherHost.request('room:create', {playerName: 'Host B'});
  await otherGuest.request('room:join', {playerName: 'Guest B', roomCode: roomB.room.roomCode});
  for (const client of [host, guest, otherHost, otherGuest]) await client.request('room:ready');
  await host.request('room:start');
  await otherHost.request('room:start');

  let roomBResults = 0;
  otherHost.on('game:dice-rolled', () => roomBResults++);
  otherGuest.on('game:dice-rolled', () => roomBResults++);
  otherHost.on('game:player-moved', () => roomBResults++);
  otherGuest.on('game:player-moved', () => roomBResults++);
  const hostResult = waitForEvent(host, 'game:dice-rolled');
  const guestResult = waitForEvent(guest, 'game:dice-rolled');
  const hostMovement = waitForEvent(host, 'game:player-moved');
  const guestMovement = waitForEvent(guest, 'game:player-moved');

  const wrongRoom = await otherHost.request('game:roll-dice', {turnId: 1, roomCode: roomA.room.roomCode});
  assert.equal(wrongRoom.error.code, 'INVALID_PAYLOAD');
  assert.equal((await guest.request('game:roll-dice', {turnId: 1})).error.code, 'NOT_ACTIVE_PLAYER');
  const accepted = await host.request('game:roll-dice', {turnId: 1});
  assert.equal(accepted.ok, true);
  const [toHost, toGuest] = await Promise.all([hostResult, guestResult]);
  assert.deepEqual(toHost, toGuest);
  const [movementToHost, movementToGuest] = await Promise.all([hostMovement, guestMovement]);
  assert.deepEqual(movementToHost, movementToGuest);
  assert.deepEqual(toHost, Object.fromEntries(Object.entries(accepted.result).filter(([key]) => !['movement', 'tileResolution'].includes(key))));
  assert.deepEqual(movementToHost, accepted.result.movement);
  assert.equal(toHost.roomCode, roomA.room.roomCode);
  assert.equal(toHost.playerId, roomA.playerId);
  assert.equal(toHost.seat, 0);
  assert.ok(toHost.die1 >= 1 && toHost.die1 <= 6);
  assert.ok(toHost.die2 >= 1 && toHost.die2 <= 6);
  assert.equal(toHost.total, toHost.die1 + toHost.die2);
  assert.equal(toHost.turnId, 1);
  assert.equal(toHost.phase, 'MOVING');
  assert.equal(movementToHost.playerId, roomA.playerId);
  assert.equal(movementToHost.seat, 0);
  assert.equal(movementToHost.turnId, 1);
  assert.equal(movementToHost.startPos, 0);
  assert.equal(movementToHost.endPos, toHost.total);
  assert.equal(movementToHost.steps, toHost.total);
  assert.equal(movementToHost.diceTotal, toHost.total);
  assert.equal(movementToHost.passedStart, false);
  assert.equal(movementToHost.startBonus, 0);
  assert.equal(movementToHost.phase, 'WAITING_TILE_RESOLUTION');
  assert.ok(['ROLL_NOT_ALLOWED', 'NOT_ACTIVE_PLAYER', 'STALE_TURN'].includes(
    (await host.request('game:roll-dice', {turnId: 1})).error.code
  ));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(roomBResults, 0);
});

test('Chance card is chosen once by the server and broadcast identically to both room clients', async t => {
  const roomManager = new RoomManager({diceRoller: () => [1, 1]});
  const {url} = await startBackend(t, roomManager);
  const hostConnection = connectClient(t, url);
  const guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const {client: host} = hostConnection;
  const {client: guest} = guestConnection;
  const created = await host.request('room:create', {playerName: 'Host'});
  await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready');
  await guest.request('room:ready');
  await host.request('room:start');
  roomManager.getGameState(created.room.roomCode).chanceDeck = {draw: () => ({
    id: 'ch_1', title: 'KARTU KESEMPATAN', desc: 'Hadiah dari bank.', amount: 100, type: 'MONEY_GAIN', icon: '🎨'
  })};

  const hostCard = waitForEvent(host, 'game:chance-presented');
  const guestCard = waitForEvent(guest, 'game:chance-presented');
  const accepted = await host.request('game:roll-dice', {turnId: 1});
  const [toHost, toGuest] = await Promise.all([hostCard, guestCard]);
  assert.deepEqual(toHost, toGuest);
  assert.equal(toHost.card.id, 'ch_1');
  assert.equal(toHost.phase, 'CHANCE_PRESENTATION');
  assert.equal(accepted.result.tileResolution.kind, 'CHANCE_PRESENTATION');
  assert.equal(roomManager.getGameState(created.room.roomCode).state.players[0].money, 1500);
  assert.equal((await guest.request('game:chance-continue', {turnId: toHost.turnId, resolutionId: toHost.resolutionId,
    presentationId: toHost.presentationId, actionId: 'guest-continue'})).ok, false);
  const hostResolved = waitForEvent(host, 'game:chance-resolved');
  const guestResolved = waitForEvent(guest, 'game:chance-resolved');
  const continuePayload = {turnId: toHost.turnId, resolutionId: toHost.resolutionId,
    presentationId: toHost.presentationId, actionId: 'host-continue'};
  const continued = await host.request('game:chance-continue', continuePayload);
  const [hostResult, guestResult] = await Promise.all([hostResolved, guestResolved]);
  assert.deepEqual(hostResult, guestResult);
  assert.equal(hostResult.card.id, 'ch_1');
  assert.equal(hostResult.balance, 1600);
  assert.equal(continued.ok, true);
  assert.equal(roomManager.getGameState(created.room.roomCode).state.players[0].money, 1600);
  assert.equal((await host.request('game:chance-continue', continuePayload)).result.duplicate, true);
  assert.equal(roomManager.getGameState(created.room.roomCode).state.players[0].money, 1600);
  assert.equal((await host.request('game:roll-dice', {turnId: 1})).ok, false);

  const disconnected = waitForEvent(guest, 'room:updated', room => room.players.some(player =>
    player.playerId === created.playerId && !player.isConnected));
  const token = created.sessionToken;
  host.disconnect();
  await disconnected;
  const resumedClient = connectClient(t, url);
  await resumedClient.connected;
  const resumed = await resumedClient.client.request('room:resume', {sessionToken: token, roomCode: created.room.roomCode});
  assert.equal(resumed.ok, true);
  assert.equal(resumed.snapshot.pendingChancePresentation, null);
  assert.equal(resumed.snapshot.players[0].money, 1600);
  assert.equal(resumed.snapshot.transactions.filter(tx => tx.type === 'CARD_REWARD').length, 1);
});

test('Chance presentation remains pending across recipient reconnect until that recipient continues', async t => {
  const {backend, url} = await startBackend(t);
  const hostConnection = connectClient(t, url), guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const host = hostConnection.client, guest = guestConnection.client;
  const created = await host.request('room:create', {playerName: 'Host'});
  await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready'); await guest.request('room:ready'); await host.request('room:start');
  const game = backend.roomManager.getGameState(created.room.roomCode);
  game.state.players[0].pos = 2;
  game.state.phase = 'WAITING_TILE_RESOLUTION';
  game.state.lastRoll = {dice: [1, 2], total: 3, isDouble: false, consecutiveDoubles: 0, movementId: 'resume-presentation-move'};
  game.chanceDeck = {draw: () => ({...CHANCE_CARDS.find(card => card.id === 'ch_1')})};
  const opened = game.resolveLandedTile({playerId: created.playerId, turnId: 1,
    movementId: 'resume-presentation-move', resolutionId: 'resume-presentation'}).resolution.event;
  assert.equal(game.state.players[0].money, 1500);
  const offline = waitForEvent(guest, 'room:updated', room => room.players.some(player =>
    player.playerId === created.playerId && player.isConnected === false));
  host.disconnect(); await offline;
  const replacement = connectClient(t, url); await replacement.connected;
  const resumed = await replacement.client.request('room:resume', {sessionToken: created.sessionToken,
    roomCode: created.room.roomCode});
  assert.equal(resumed.ok, true);
  assert.equal(resumed.snapshot.phase, 'CHANCE_PRESENTATION');
  assert.equal(resumed.snapshot.players[0].money, 1500);
  assert.equal(resumed.snapshot.pendingChancePresentation.event.presentationId, opened.presentationId);
  const continued = await replacement.client.request('game:chance-continue', {turnId: 1,
    resolutionId: opened.resolutionId, presentationId: opened.presentationId, actionId: 'resumed-chance-continue'});
  assert.equal(continued.ok, true);
  assert.equal(backend.roomManager.getGameState(created.room.roomCode).state.players[0].money, 1600);
  assert.equal(backend.roomManager.getGameState(created.room.roomCode).state.transactions.filter(tx => tx.type === 'CARD_REWARD').length, 1);
});

test('movement Chance card broadcasts one official path and its unowned destination offer to the room', async t => {
  const roomManager = new RoomManager({diceRoller: () => [1, 1]});
  const {url} = await startBackend(t, roomManager);
  const hostConnection = connectClient(t, url), guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const {client: host} = hostConnection, {client: guest} = guestConnection;
  const created = await host.request('room:create', {playerName: 'Host'});
  await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready'); await guest.request('room:ready'); await host.request('room:start');
  const card = CHANCE_CARDS.find(item => item.id === 'ch_4');
  roomManager.getGameState(created.room.roomCode).chanceDeck = {draw: () => ({...card})};
  const hostChance = waitForEvent(host, 'game:chance-presented');
  const guestChance = waitForEvent(guest, 'game:chance-presented');
  await host.request('game:roll-dice', {turnId: 1});
  const [presented1, presented2] = await Promise.all([hostChance, guestChance]);
  assert.deepEqual(presented1, presented2);
  assert.equal(presented1.card.id, 'ch_4');
  assert.equal(roomManager.getGameState(created.room.roomCode).state.players[0].pos, 2);
  const hostResolved = waitForEvent(host, 'game:chance-resolved');
  const guestResolved = waitForEvent(guest, 'game:chance-resolved');
  const hostOffer = waitForEvent(host, 'game:property-offer');
  const guestOffer = waitForEvent(guest, 'game:property-offer');
  await host.request('game:chance-continue', {turnId: presented1.turnId, resolutionId: presented1.resolutionId,
    presentationId: presented1.presentationId, actionId: 'move-chance-continue'});
  const [left, right, offer1, offer2] = await Promise.all([hostResolved, guestResolved, hostOffer, guestOffer]);
  assert.deepEqual(left, right);
  assert.deepEqual(offer1, offer2);
  assert.equal(left.card.id, 'ch_4');
  assert.deepEqual(left.movements.map(move => [move.startPos, move.endPos, move.steps]), [[2, 5, 3]]);
  assert.equal(left.destinationResolution, 'PROPERTY_OFFER');
  assert.equal(offer1.propertyPos, 5);
  assert.equal(offer1.movementId, left.movements[0].movementId);
  assert.equal(roomManager.getGameState(created.room.roomCode).state.players[0].pos, 5);
});

test('rent is broadcast with official balances to both clients and paid only once', async t => {
  const roomManager = new RoomManager({diceRoller: () => [1, 2]});
  const {url} = await startBackend(t, roomManager);
  const hostConnection = connectClient(t, url), guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const {client: host} = hostConnection, {client: guest} = guestConnection;
  const created = await host.request('room:create', {playerName: 'Host'});
  const joined = await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready'); await guest.request('room:ready'); await host.request('room:start');
  const game = roomManager.getGameState(created.room.roomCode);
  const property = game.state.properties.get(3);
  property.owner = joined.playerId;
  const amount = property.rent.base;
  const hostRent = waitForEvent(host, 'game:rent-resolved');
  const guestRent = waitForEvent(guest, 'game:rent-resolved');
  const response = await host.request('game:roll-dice', {turnId: 1});
  const [toHost, toGuest] = await Promise.all([hostRent, guestRent]);
  assert.deepEqual(toHost, toGuest);
  assert.equal(toHost.rent.tenantId, created.playerId);
  assert.equal(toHost.rent.ownerId, joined.playerId);
  assert.equal(toHost.rent.amount, amount);
  assert.equal(toHost.rent.outcome, 'PAID');
  assert.equal(toHost.balances.find(item => item.playerId === created.playerId).money, 1500 - amount);
  assert.equal(toHost.balances.find(item => item.playerId === joined.playerId).money, 1500 + amount);
  assert.equal(response.result.tileResolution.kind, 'RENT_RESOLVED');
  assert.equal(game.state.transactions.filter(item => item.type === 'RENT').length, 1);
});

test('Chance card movement broadcasts card, then authoritative rent result to room clients', async t => {
  const roomManager = new RoomManager({diceRoller: () => [1, 1]});
  const {url} = await startBackend(t, roomManager);
  const hostConnection = connectClient(t, url), guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const {client: host} = hostConnection, {client: guest} = guestConnection;
  const created = await host.request('room:create', {playerName: 'Host'});
  const joined = await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready'); await guest.request('room:ready'); await host.request('room:start');
  const game = roomManager.getGameState(created.room.roomCode);
  game.state.properties.get(24).owner = joined.playerId;
  game.chanceDeck = {draw: () => ({...CHANCE_CARDS.find(item => item.id === 'ch_5')})};
  const pending = [waitForEvent(host, 'game:chance-presented'), waitForEvent(guest, 'game:chance-presented')];
  await host.request('game:roll-dice', {turnId: 1});
  const [presented1, presented2] = await Promise.all(pending);
  assert.deepEqual(presented1, presented2);
  assert.equal(game.state.players[0].pos, 2);
  const resolutions = [
    waitForEvent(host, 'game:chance-resolved'), waitForEvent(guest, 'game:chance-resolved'),
    waitForEvent(host, 'game:rent-resolved'), waitForEvent(guest, 'game:rent-resolved')
  ];
  await host.request('game:chance-continue', {turnId: presented1.turnId, resolutionId: presented1.resolutionId,
    presentationId: presented1.presentationId, actionId: 'chance-rent-continue'});
  const [chance1, chance2, rent1, rent2] = await Promise.all(resolutions);
  assert.deepEqual(chance1, chance2);
  assert.deepEqual(rent1, rent2);
  assert.equal(chance1.card.id, 'ch_5');
  assert.equal(chance1.destinationResolution, 'RENT_RESOLVED');
  assert.equal(rent1.rent.propertyPos, 24);
  assert.equal(rent1.rent.outcome, 'PAID');
  assert.equal(chance1.balances.find(item => item.playerId === created.playerId).money, 1500,
    'card event carries pre-rent balances before the rent event is applied');
  assert.equal(rent1.balances.find(item => item.playerId === created.playerId).money, rent1.rent.tenantBalance);
  assert.equal(game.state.transactions.filter(item => item.type === 'RENT').length, 1);
});

test('mortgage and redemption are authoritative and broadcast property status to both room clients', async t => {
  const roomManager = new RoomManager();
  const {url} = await startBackend(t, roomManager);
  const hostConnection = connectClient(t, url), guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const {client: host} = hostConnection, {client: guest} = guestConnection;
  const created = await host.request('room:create', {playerName: 'Host'});
  await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready'); await guest.request('room:ready'); await host.request('room:start');
  const property = roomManager.getGameState(created.room.roomCode).state.properties.get(3);
  property.owner = created.playerId;
  const forgedAmount = await host.request('game:property-mortgage', {
    turnId: 1, propertyPos: 3, resolutionId: 'socket-mortgage-forged', amount: 999
  });
  assert.equal(forgedAmount.ok, false);
  assert.equal(forgedAmount.error.code, 'INVALID_PAYLOAD');
  assert.equal(property.isMortgaged, false);
  const hostMortgaged = waitForEvent(host, 'game:property-finance-resolved');
  const guestMortgaged = waitForEvent(guest, 'game:property-finance-resolved');
  const mortgageResponse = await host.request('game:property-mortgage', {turnId: 1, propertyPos: 3, resolutionId: 'socket-mortgage-1'});
  const [mortgage1, mortgage2] = await Promise.all([hostMortgaged, guestMortgaged]);
  assert.equal(mortgageResponse.ok, true);
  assert.deepEqual(mortgage1, mortgage2);
  assert.equal(mortgage1.action, 'MORTGAGE');
  assert.equal(mortgage1.property.isMortgaged, true);
  assert.equal(mortgage1.amount, property.mortgageValue);
  assert.equal(mortgage1.phase, 'WAITING_ROLL');

  const unauthorized = await guest.request('game:property-unmortgage', {turnId: 1, propertyPos: 3, resolutionId: 'guest-unmortgage'});
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.error.code, 'NOT_ACTIVE_PLAYER');

  const hostRedeemed = waitForEvent(host, 'game:property-finance-resolved');
  const guestRedeemed = waitForEvent(guest, 'game:property-finance-resolved');
  const redemptionResponse = await host.request('game:property-unmortgage', {turnId: 1, propertyPos: 3, resolutionId: 'socket-redemption-1'});
  const [redemption1, redemption2] = await Promise.all([hostRedeemed, guestRedeemed]);
  assert.equal(redemptionResponse.ok, true);
  assert.deepEqual(redemption1, redemption2);
  assert.equal(redemption1.action, 'UNMORTGAGE');
  assert.equal(redemption1.property.isMortgaged, false);
  assert.equal(redemption1.transaction.type, 'UNMORTGAGE');
  assert.equal(roomManager.getGameState(created.room.roomCode).state.turnId, 1);
});

test('debt actions are player-bound, server priced, broadcast to room, and survive a disconnect snapshot', async t => {
  const roomManager = new RoomManager();
  const {url} = await startBackend(t, roomManager);
  const hostConnection = connectClient(t, url), guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const {client: host} = hostConnection, {client: guest} = guestConnection;
  const created = await host.request('room:create', {playerName: 'Host'});
  await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready'); await guest.request('room:ready'); await host.request('room:start');
  const game = roomManager.getGameState(created.room.roomCode);
  const debtor = game.state.players[0];
  debtor.money = 1500;
  const debtResult = game._createDebt({player: debtor, turnId: 1, movementId: 'm', resolutionId: 'socket-debt',
    debtType: 'TAX', amount: 100, creditorId: 'BANK', creditorName: 'Bank', position: 4, tileName: 'Pajak', description: 'Pajak'});
  const debtId = debtResult.event.debt.debtId;
  const spoofed = await host.request('game:debt-action', {turnId: 1, debtId, actionId: 'spoof-debt', action: 'PAY', amount: 1});
  assert.equal(spoofed.ok, false);
  assert.equal(spoofed.error.code, 'INVALID_PAYLOAD');
  const unauthorized = await guest.request('game:debt-action', {turnId: 1, debtId, actionId: 'guest-debt', action: 'PAY'});
  assert.equal(unauthorized.ok, false);

  const hostUpdate = waitForEvent(host, 'game:debt-state');
  const guestUpdate = waitForEvent(guest, 'game:debt-state');
  const paid = await host.request('game:debt-action', {turnId: 1, debtId, actionId: 'host-pay-debt', action: 'PAY'});
  assert.equal(paid.ok, true);
  const [hostEvent, guestEvent] = await Promise.all([hostUpdate, guestUpdate]);
  assert.deepEqual(hostEvent, guestEvent);
  assert.equal(hostEvent.type, 'RESOLVED');
  assert.equal(hostEvent.result.type, 'PAID');
  assert.equal(hostEvent.snapshot.phase, 'PLAYER_ACTION');
  assert.equal(game.state.players[0].money, 1400);
  assert.equal(game.pendingDebt, null);

  const newDebt = game._createDebt({player: game.state.players[1], turnId: game.state.turnId, movementId: 'm2',
    resolutionId: 'disconnect-debt', debtType: 'TAX', amount: 5000, creditorId: 'BANK', creditorName: 'Bank',
    position: 4, tileName: 'Pajak', description: 'Pajak'});
  guest.disconnect();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(game.pendingDebt.debtId, newDebt.event.debt.debtId);
  const restored = (await import('../src/game/ServerGameState.js')).ServerGameState.fromSnapshot(game.toSnapshot());
  assert.equal(restored.pendingDebt.debtId, game.pendingDebt.debtId);
  assert.equal(restored.toPublicSnapshot().pendingDebt.debtId, game.pendingDebt.debtId);
});

test('insufficient tax creates and broadcasts the same debt state to both room clients', async t => {
  const roomManager = new RoomManager({diceRoller: () => [1, 2]});
  const {url} = await startBackend(t, roomManager);
  const hostConnection = connectClient(t, url), guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const {client: host} = hostConnection, {client: guest} = guestConnection;
  const created = await host.request('room:create', {playerName: 'Host'});
  await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready'); await guest.request('room:ready'); await host.request('room:start');
  const game = roomManager.getGameState(created.room.roomCode);
  game.state.players[0].pos = 1;
  game.state.players[0].money = 30;
  const hostDebt = waitForEvent(host, 'game:debt-created');
  const guestDebt = waitForEvent(guest, 'game:debt-created');
  await host.request('game:roll-dice', {turnId: 1});
  const [one, two] = await Promise.all([hostDebt, guestDebt]);
  assert.deepEqual(one, two);
  assert.equal(one.pendingDebt.debtType, 'TAX');
  assert.equal(one.pendingDebt.amount, 200);
  assert.equal(one.snapshot.phase, 'DEBT_RESOLUTION');
  assert.equal(one.snapshot.players[0].money, 30);
  assert.equal(game.state.currentTurn, 0);
  assert.equal(game.pendingDebt.debtId, one.pendingDebt.debtId);
});

test('unowned property offer and purchase decision are authoritative and broadcast to both room clients', async t => {
  let nextId = 0;
  const roomManager = new RoomManager({
    idGenerator: () => `property-player-${++nextId}`,
    diceRoller: () => [1, 2],
    movementIdGenerator: () => 'movement-property-1',
    resolutionIdGenerator: () => 'resolution-property-1'
  });
  const {backend, url} = await startBackend(t, roomManager);
  const hostConnection = connectClient(t, url);
  const guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const host = hostConnection.client;
  const guest = guestConnection.client;
  const created = await host.request('room:create', {playerName: 'Host'});
  const joined = await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready');
  await guest.request('room:ready');
  await host.request('room:start');

  const hostOffer = waitForEvent(host, 'game:property-offer');
  const guestOffer = waitForEvent(guest, 'game:property-offer');
  const accepted = await host.request('game:roll-dice', {turnId: 1});
  assert.equal(accepted.ok, true);
  assert.equal(accepted.result.tileResolution.kind, 'PROPERTY_OFFER');
  const [offerA, offerB] = await Promise.all([hostOffer, guestOffer]);
  assert.deepEqual(offerA, offerB);
  assert.equal(offerA.playerId, created.playerId);
  assert.equal(offerA.propertyPos, 3);
  assert.equal(offerA.price, 60);

  const before = backend.roomManager.getGameState(created.room.roomCode);
  const rejected = await host.request('game:property-decision', {
    turnId: 1, resolutionId: offerA.resolutionId, decision: 'BUY', price: 1, balance: 999999
  });
  assert.equal(rejected.error.code, 'INVALID_PAYLOAD');
  assert.equal(before.state.players[0].money, 1500);
  assert.equal(before.state.properties.get(3).owner, null);
  assert.equal((await guest.request('game:property-decision', {
    turnId: 1, resolutionId: offerA.resolutionId, decision: 'BUY'
  })).error.code, 'NOT_ACTIVE_PLAYER');

  const hostDone = waitForEvent(host, 'game:property-resolution-complete');
  const guestDone = waitForEvent(guest, 'game:property-resolution-complete');
  const purchased = await host.request('game:property-decision', {
    turnId: 1, resolutionId: offerA.resolutionId, decision: 'BUY'
  });
  assert.equal(purchased.ok, true);
  const [doneA, doneB] = await Promise.all([hostDone, guestDone]);
  assert.deepEqual(doneA, doneB);
  assert.equal(doneA.balance, 1440);
  assert.equal(doneA.property.owner, created.playerId);
  assert.equal(doneA.activePlayerId, created.playerId);
  assert.equal(doneA.turnId, 1);
  assert.equal(doneA.phase, 'PLAYER_ACTION');
  assert.equal(before.state.players[0].money, 1440);
  assert.equal(before.state.properties.get(3).owner, created.playerId);
});

test('server-authoritative auction broadcasts identical state, enforces socket identity, and stays room-local', async t => {
  let nextId = 0;
  const roomManager = new RoomManager({idGenerator: () => `auction-player-${++nextId}`, diceRoller: () => [1, 2]});
  const {backend, url} = await startBackend(t, roomManager);
  const connections = Array.from({length: 4}, () => connectClient(t, url));
  await Promise.all(connections.map(connection => connection.connected));
  const [host, guest, otherHost, otherGuest] = connections.map(connection => connection.client);
  const roomA = await host.request('room:create', {playerName: 'Auction Host'});
  const roomAGuest = await guest.request('room:join', {playerName: 'Auction Guest', roomCode: roomA.room.roomCode});
  const roomB = await otherHost.request('room:create', {playerName: 'Other Host'});
  await otherGuest.request('room:join', {playerName: 'Other Guest', roomCode: roomB.room.roomCode});
  for (const client of [host, guest, otherHost, otherGuest]) await client.request('room:ready');
  await host.request('room:start');
  await otherHost.request('room:start');
  let eventsInOtherRoom = 0;
  const stopOtherRoomListener = otherHost.on('game:auction-started', () => eventsInOtherRoom++);
  const stopOtherGuestListener = otherGuest.on('game:auction-started', () => eventsInOtherRoom++);
  t.after(() => { stopOtherRoomListener(); stopOtherGuestListener(); });

  const offerReceived = waitForEvent(guest, 'game:property-offer');
  const rolled = await host.request('game:roll-dice', {turnId: 1});
  assert.equal(rolled.result.tileResolution.kind, 'PROPERTY_OFFER');
  const offer = await offerReceived;
  const startedHost = waitForEvent(host, 'game:auction-started');
  const startedGuest = waitForEvent(guest, 'game:auction-started');
  const decline = await host.request('game:property-decision', {
    turnId: 1, resolutionId: offer.resolutionId, decision: 'DECLINE'
  });
  assert.equal(decline.ok, true);
  assert.equal(decline.result.type, 'STARTED');
  const [eventA, eventB] = await Promise.all([startedHost, startedGuest]);
  assert.deepEqual(eventA, eventB);
  assert.equal(eventA.snapshot.phase, 'WAITING_AUCTION_ACTION');
  assert.equal(eventA.auction.currentBidderId, roomA.playerId);
  assert.equal(eventsInOtherRoom, 0);

  assert.equal((await host.request('game:auction-action', {
    turnId: 1, auctionId: eventA.auction.auctionId, actionId: 'forged', action: 'BID', bidAmount: 100,
    playerId: roomAGuest.playerId, money: 999999
  })).error.code, 'INVALID_PAYLOAD');
  assert.equal((await otherGuest.request('game:auction-action', {
    turnId: 1, auctionId: eventA.auction.auctionId, actionId: 'cross-room', action: 'BID', bidAmount: 100
  })).error.code, 'AUCTION_NOT_ACTIVE');

  const updatedA = waitForEvent(host, 'game:auction-updated', event => event.auction?.revision === 2);
  const updatedB = waitForEvent(guest, 'game:auction-updated', event => event.auction?.revision === 2);
  await host.request('game:auction-action', {turnId: 1, auctionId: eventA.auction.auctionId,
    actionId: 'host-bid', action: 'BID', bidAmount: 80});
  assert.deepEqual(await updatedA, await updatedB);
  const nextUpdateA = waitForEvent(host, 'game:auction-updated', event => event.auction?.revision === 3);
  const nextUpdateB = waitForEvent(guest, 'game:auction-updated', event => event.auction?.revision === 3);
  await guest.request('game:auction-action', {turnId: 1, auctionId: eventA.auction.auctionId,
    actionId: 'guest-bid', action: 'BID', bidAmount: 100});
  await Promise.all([nextUpdateA, nextUpdateB]);
  const endA = waitForEvent(host, 'game:auction-ended');
  const endB = waitForEvent(guest, 'game:auction-ended');
  await host.request('game:auction-action', {turnId: 1, auctionId: eventA.auction.auctionId,
    actionId: 'host-pass', action: 'PASS'});
  const endPayloads = await Promise.all([endA, endB]);
  assert.deepEqual(endPayloads[0], endPayloads[1]);
  assert.equal(endPayloads[0].winner.playerId, roomAGuest.playerId);
  assert.equal(endPayloads[0].amount, 100);
  assert.equal(backend.roomManager.getGameState(roomA.room.roomCode).state.properties.get(3).owner, roomAGuest.playerId);
  assert.equal(backend.roomManager.getGameState(roomB.room.roomCode).state.properties.get(3).owner, null);
  assert.equal(eventsInOtherRoom, 0);
});

test('server-authoritative trade persists through disconnect/reconnect, validates socket identity, and broadcasts once', async t => {
  let nextId = 0;
  const roomManager = new RoomManager({idGenerator: () => `trade-player-${++nextId}`});
  const {backend, url} = await startBackend(t, roomManager);
  const hostConnection = connectClient(t, url), guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const host = hostConnection.client, guest = guestConnection.client;
  const created = await host.request('room:create', {playerName: 'Trade Host'});
  const joined = await guest.request('room:join', {playerName: 'Trade Guest', roomCode: created.room.roomCode});
  const spectatorConnection = connectClient(t, url);
  await spectatorConnection.connected;
  const spectator = spectatorConnection.client;
  const spectatorJoined = await spectator.request('room:join', {playerName: 'Observer', roomCode: created.room.roomCode});
  await host.request('room:ready'); await guest.request('room:ready'); await spectator.request('room:ready'); await host.request('room:start');
  const guestSocketId = guest.socket.id;
  const game = roomManager.getGameState(created.room.roomCode);
  const property = game.state.properties.get(3);
  property.owner = created.playerId; game.state.players[0].properties.push(property.id);

  let eventsInOtherRoom = 0;
  const outsiderConnection = connectClient(t, url);
  await outsiderConnection.connected;
  const outsider = outsiderConnection.client;
  const otherRoom = await outsider.request('room:create', {playerName: 'Outsider'});
  const outsiderListener = outsider.on('game:trade-state', () => eventsInOtherRoom++);
  let privateOfferLeaks = 0;
  const spectatorListener = spectator.on('game:trade-state', () => privateOfferLeaks++);
  t.after(outsiderListener);
  t.after(spectatorListener);

  const invalid = await host.request('game:trade-create', {turnId: 1, actionId: 'forged', toPlayerId: joined.playerId,
    playerId: joined.playerId, offer: {giveMoney: 10}});
  assert.equal(invalid.error.code, 'INVALID_PAYLOAD');
  const hostPending = waitForEvent(host, 'game:trade-state');
  const guestPending = waitForEvent(guest, 'game:trade-state');
  const createdTrade = await host.request('game:trade-create', {turnId: 1, actionId: 'trade-create-socket',
    toPlayerId: joined.playerId, offer: {giveMoney: 100, givePropPositions: [3]}});
  assert.equal(createdTrade.ok, true);
  const pendingEvents = await Promise.all([hostPending, guestPending]);
  assert.deepEqual(pendingEvents[0], pendingEvents[1]);
  assert.equal(pendingEvents[0].trade.status, 'PENDING');
  assert.equal(privateOfferLeaks, 0, 'a nonparticipant does not receive the private offer event');
  assert.equal(game.toPublicSnapshot({viewerPlayerId: spectatorJoined.playerId}).trades.length, 0);
  assert.equal(game.state.players[0].money, 1500);
  assert.equal(game.state.properties.get(3).owner, created.playerId);

  const sessionToken = joined.sessionToken;
  guest.disconnect();
  const replacement = connectClient(t, url);
  await replacement.connected;
  const resumed = await replacement.client.request('room:resume', {sessionToken});
  assert.equal(resumed.ok, true);
  assert.equal(resumed.snapshot.trades[0].tradeId, createdTrade.result.trade.tradeId);
  assert.equal(resumed.snapshot.trades[0].status, 'PENDING');
  const spectatorToken = spectatorJoined.sessionToken;
  spectator.disconnect();
  const spectatorReplacement = connectClient(t, url);
  await spectatorReplacement.connected;
  const spectatorResumed = await spectatorReplacement.client.request('room:resume', {sessionToken: spectatorToken});
  assert.equal(spectatorResumed.ok, true);
  assert.deepEqual(spectatorResumed.snapshot.trades, [], 'reconnect snapshot hides another pair’s offer');
  assert.equal(roomManager.resolveTradeAction(guestSocketId, {tradeId: createdTrade.result.trade.tradeId,
    actionId: 'old-socket', action: 'ACCEPT'}).ok, false);

  const finalHost = waitForEvent(host, 'game:trade-state', event => event.type === 'COMPLETED');
  const finalGuest = waitForEvent(replacement.client, 'game:trade-state', event => event.type === 'COMPLETED');
  const accepted = await replacement.client.request('game:trade-action', {tradeId: createdTrade.result.trade.tradeId,
    actionId: 'trade-accept-socket', action: 'ACCEPT'});
  assert.equal(accepted.ok, true);
  const finalEvents = await Promise.all([finalHost, finalGuest]);
  assert.deepEqual(finalEvents[0], finalEvents[1]);
  assert.equal(finalEvents[0].snapshot.players.find(player => player.playerId === created.playerId).money, 1400);
  assert.equal(finalEvents[0].snapshot.players.find(player => player.playerId === joined.playerId).money, 1600);
  assert.equal(finalEvents[0].snapshot.properties.find(([, item]) => item.pos === 3)[1].owner, joined.playerId);
  assert.equal(finalEvents[0].snapshot.transactions.filter(tx => tx.type === 'TRADE').length, 1);
  assert.equal(backend.roomManager.getGameState(otherRoom.room.roomCode), null, 'waiting outsider room has no game state');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(eventsInOtherRoom, 0);
});

test('server-authoritative building broadcasts official build/sale state and recovers stock after reconnect', async t => {
  let nextId = 0;
  const roomManager = new RoomManager({idGenerator: () => `building-player-${++nextId}`});
  const {backend, url} = await startBackend(t, roomManager);
  const hostConnection = connectClient(t, url), guestConnection = connectClient(t, url);
  const outsiderConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected, outsiderConnection.connected]);
  const host = hostConnection.client, guest = guestConnection.client;
  const outsider = outsiderConnection.client;
  const created = await host.request('room:create', {playerName: 'Builder'});
  await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  const otherRoom = await outsider.request('room:create', {playerName: 'Other room'});
  await host.request('room:ready'); await guest.request('room:ready'); await host.request('room:start');
  const game = roomManager.getGameState(created.room.roomCode);
  for (const pos of [1, 3]) {
    const property = game.state.properties.get(pos);
    property.owner = created.playerId;
    game.state.players[0].properties.push(property.id);
  }
  const hostOldSocket = host.socket.id;
  let crossRoomEvents = 0;
  const stopOtherRoomListener = outsider.on('game:building-state', () => crossRoomEvents++);
  t.after(stopOtherRoomListener);
  const builtHost = waitForEvent(host, 'game:building-state');
  const builtGuest = waitForEvent(guest, 'game:building-state');
  const build = await host.request('game:building-action', {turnId: 1, actionId: 'socket-build',
    action: 'BUILD_HOUSE', propertyPos: 1});
  assert.equal(build.ok, true);
  const [builtA, builtB] = await Promise.all([builtHost, builtGuest]);
  assert.deepEqual(builtA, builtB);
  assert.equal(builtA.property.houses, 1);
  assert.equal(builtA.snapshot.bankHouses, 31);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(crossRoomEvents, 0);
  assert.equal((await host.request('game:building-action', {turnId: 1, actionId: 'forged-building', action: 'BUILD_HOUSE',
    propertyPos: 1, amount: 1, houses: 4})).error.code, 'INVALID_PAYLOAD');
  assert.equal((await guest.request('game:building-action', {turnId: 1, actionId: 'wrong-player-building',
    action: 'BUILD_HOUSE', propertyPos: 1})).error.code, 'NOT_ACTIVE_PLAYER');

  const sessionToken = created.sessionToken;
  host.disconnect();
  const replacement = connectClient(t, url);
  await replacement.connected;
  const resumed = await replacement.client.request('room:resume', {sessionToken});
  assert.equal(resumed.ok, true);
  assert.equal(resumed.snapshot.properties.find(([, item]) => item.pos === 1)[1].houses, 1);
  assert.equal(resumed.snapshot.bankHouses, 31);
  assert.equal(roomManager.resolveBuildingAction(hostOldSocket, {turnId: 1, actionId: 'old-socket-building',
    action: 'SELL_HOUSE', propertyPos: 1}).ok, false);

  const soldHost = waitForEvent(replacement.client, 'game:building-state');
  const soldGuest = waitForEvent(guest, 'game:building-state');
  const sold = await replacement.client.request('game:building-action', {turnId: 1, actionId: 'socket-sell',
    action: 'SELL_HOUSE', propertyPos: 1});
  assert.equal(sold.ok, true);
  const [soldA, soldB] = await Promise.all([soldHost, soldGuest]);
  assert.deepEqual(soldA, soldB);
  assert.equal(soldA.property.houses, 0);
  assert.equal(soldA.snapshot.bankHouses, 32);
  assert.equal(game.state.transactions.filter(tx => ['BUILD', 'SELL_BUILD'].includes(tx.type)).length, 2);
  assert.equal(backend.roomManager.getGameState(created.room.roomCode).state.players[0].money, 1475);
  assert.equal(backend.roomManager.getGameState(otherRoom.room.roomCode), null);
});

test('tax payment broadcasts the same authoritative balance and does not affect another room', async t => {
  let nextId = 0;
  const roomManager = new RoomManager({idGenerator: () => `tax-player-${++nextId}`, diceRoller: () => [2, 2]});
  const {backend, url} = await startBackend(t, roomManager);
  const connections = Array.from({length: 4}, () => connectClient(t, url));
  await Promise.all(connections.map(connection => connection.connected));
  const [hostA, guestA, hostB, guestB] = connections.map(connection => connection.client);
  const roomA = await hostA.request('room:create', {playerName: 'Tax Host'});
  await guestA.request('room:join', {playerName: 'Tax Guest', roomCode: roomA.room.roomCode});
  const roomB = await hostB.request('room:create', {playerName: 'Other Host'});
  await guestB.request('room:join', {playerName: 'Other Guest', roomCode: roomB.room.roomCode});
  for (const client of [hostA, guestA, hostB, guestB]) await client.request('room:ready');
  await hostA.request('room:start');
  await hostB.request('room:start');

  let roomBResolutionCount = 0;
  hostB.on('game:tile-resolution-complete', () => roomBResolutionCount++);
  guestB.on('game:tile-resolution-complete', () => roomBResolutionCount++);
  const resolutionA = waitForEvent(hostA, 'game:tile-resolution-complete');
  const resolutionGuestA = waitForEvent(guestA, 'game:tile-resolution-complete');
  const rolled = await hostA.request('game:roll-dice', {turnId: 1});
  assert.equal(rolled.result.movement.endPos, 4);
  assert.equal(rolled.result.tileResolution.kind, 'TILE_RESOLVED');
  const [eventHost, eventGuest] = await Promise.all([resolutionA, resolutionGuestA]);
  assert.deepEqual(eventHost, eventGuest);
  assert.equal(eventHost.kind, 'TAX_PAID');
  assert.equal(eventHost.taxAmount, 200);
  assert.equal(eventHost.balance, 1300);
  assert.equal(eventHost.transaction.type, 'TAX');
  assert.equal(backend.roomManager.getGameState(roomA.room.roomCode).state.players[0].money, 1300);
  assert.equal(backend.roomManager.getGameState(roomB.room.roomCode).state.players[0].money, 1500);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(roomBResolutionCount, 0);
});

test('third double broadcasts jail penalty to both clients without a movement event', async t => {
  let nextId = 0;
  const roomManager = new RoomManager({
    idGenerator: () => `jail-player-${++nextId}`,
    diceRoller: () => [3, 3]
  });
  const {backend, url} = await startBackend(t, roomManager);
  const hostConnection = connectClient(t, url);
  const guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const host = hostConnection.client;
  const guest = guestConnection.client;
  const created = await host.request('room:create', {playerName: 'Host'});
  const joined = await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready');
  await guest.request('room:ready');
  await host.request('room:start');
  const serverState = backend.roomManager.getGameState(created.room.roomCode);
  serverState.state.players[0].pos = 7;
  serverState.state.players[0].consecutiveDoubles = 2;
  serverState.state.consecutiveDoubles = 2;

  let movementEvents = 0;
  host.on('game:player-moved', () => movementEvents++);
  guest.on('game:player-moved', () => movementEvents++);
  const diceHost = waitForEvent(host, 'game:dice-rolled');
  const diceGuest = waitForEvent(guest, 'game:dice-rolled');
  const jailHost = waitForEvent(host, 'game:jail-penalty');
  const jailGuest = waitForEvent(guest, 'game:jail-penalty');
  const request = await host.request('game:roll-dice', {turnId: 1});
  assert.equal(request.ok, true);
  assert.equal('movement' in request.result, false);
  const [diceA, diceB] = await Promise.all([diceHost, diceGuest]);
  assert.deepEqual(diceA, diceB);
  assert.equal(diceA.phase, 'JAILING');
  assert.equal(diceA.tripleDouble, true);
  const [penaltyA, penaltyB] = await Promise.all([jailHost, jailGuest]);
  assert.deepEqual(penaltyA, penaltyB);
  assert.equal(penaltyA.kind, 'THREE_DOUBLES_JAIL');
  assert.equal(penaltyA.resultingPosition, 10);
  assert.equal(penaltyA.activePlayerId, joined.playerId);
  assert.equal(serverState.state.players[0].pos, 10);
  assert.equal(serverState.state.players[0].status, 'IN_JAIL');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(movementEvents, 0);
});

test('server jail bail action and jail doubles are broadcast identically to both room clients', async t => {
  let nextId = 0;
  const roomManager = new RoomManager({idGenerator: () => `jail-action-player-${++nextId}`, diceRoller: () => [3, 3]});
  const {backend, url} = await startBackend(t, roomManager);
  const hostConnection = connectClient(t, url), guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const host = hostConnection.client, guest = guestConnection.client;
  const created = await host.request('room:create', {playerName: 'Host'});
  await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready'); await guest.request('room:ready'); await host.request('room:start');
  const game = backend.roomManager.getGameState(created.room.roomCode);
  const jailed = game.state.players[0];
  jailed.status = 'IN_JAIL'; jailed.inJail = true; jailed.pos = 10; jailed.money = 100;

  const bailHost = waitForEvent(host, 'game:jail-action-resolved');
  const bailGuest = waitForEvent(guest, 'game:jail-action-resolved');
  const bail = await host.request('game:jail-action', {turnId: game.state.turnId, actionId: 'socket-bail-1', action: 'PAY_BAIL'});
  assert.equal(bail.ok, true);
  const [paidA, paidB] = await Promise.all([bailHost, bailGuest]);
  assert.deepEqual(paidA, paidB);
  assert.equal(paidA.balance, 50);
  assert.equal(game.state.players[0].status, 'ACTIVE');
  assert.equal((await guest.request('game:jail-action', {turnId: game.state.turnId, actionId: 'wrong-turn', action: 'USE_CARD'})).error.code,
    'NOT_ACTIVE_PLAYER');

  jailed.status = 'IN_JAIL'; jailed.inJail = true; jailed.jailTurns = 0; game.state.phase = 'WAITING_ROLL';
  const diceHost = waitForEvent(host, 'game:dice-rolled', event => event.jailAttempt === true);
  const diceGuest = waitForEvent(guest, 'game:dice-rolled', event => event.jailAttempt === true);
  const releaseHost = waitForEvent(host, 'game:jail-action-resolved', event => event.outcome === 'DOUBLE');
  const releaseGuest = waitForEvent(guest, 'game:jail-action-resolved', event => event.outcome === 'DOUBLE');
  const movedHost = waitForEvent(host, 'game:player-moved');
  const movedGuest = waitForEvent(guest, 'game:player-moved');
  const roll = await host.request('game:roll-dice', {turnId: game.state.turnId, actionId: 'socket-jail-roll-1'});
  assert.equal(roll.ok, true);
  assert.equal((await Promise.all([diceHost, diceGuest])).every(event => event.total === 6), true);
  assert.deepEqual(...await Promise.all([releaseHost, releaseGuest]));
  const [moveA, moveB] = await Promise.all([movedHost, movedGuest]);
  assert.deepEqual(moveA, moveB);
  assert.equal(game.state.players[0].status, 'ACTIVE');
  assert.equal(game.state.players[0].pos, 16);
});

test('Free Parking travel is server-priced and broadcasts the same movement and property offer to room clients', async t => {
  let nextId = 0;
  const roomManager = new RoomManager({idGenerator: () => `parking-player-${++nextId}`});
  const {backend, url} = await startBackend(t, roomManager);
  const hostConnection = connectClient(t, url), guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const host = hostConnection.client, guest = guestConnection.client;
  const created = await host.request('room:create', {playerName: 'Host'});
  await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready'); await guest.request('room:ready'); await host.request('room:start');
  const game = backend.roomManager.getGameState(created.room.roomCode);
  const player = game.state.players[0];
  player.pos = 20;
  game.pendingFreeParkingDecision = {playerId: player.playerId, turnId: game.state.turnId};
  const response = await host.request('game:free-parking-action', {turnId: game.state.turnId,
    actionId: 'socket-parking-travel-1', action: 'TRAVEL', targetPos: 1, cost: 1, endPos: 99});
  assert.equal(response.ok, false, 'client cannot send fee or destination position override');
  assert.equal((await guest.request('game:free-parking-action', {turnId: game.state.turnId,
    actionId: 'socket-parking-wrong-player', action: 'STAY'})).error.code, 'NOT_ACTIVE_PLAYER');
  const retryHost = waitForEvent(host, 'game:free-parking-action-resolved');
  const retryGuest = waitForEvent(guest, 'game:free-parking-action-resolved');
  const moveHost = waitForEvent(host, 'game:player-moved');
  const moveGuest = waitForEvent(guest, 'game:player-moved');
  const offerHost = waitForEvent(host, 'game:property-offer');
  const offerGuest = waitForEvent(guest, 'game:property-offer');
  const accepted = await host.request('game:free-parking-action', {turnId: game.state.turnId,
    actionId: 'socket-parking-travel-2', action: 'TRAVEL', targetPos: 1});
  assert.equal(accepted.ok, true);
  const [decisionA, decisionB] = await Promise.all([retryHost, retryGuest]);
  assert.deepEqual(decisionA, decisionB);
  const [moveA, moveB] = await Promise.all([moveHost, moveGuest]);
  assert.deepEqual(moveA, moveB);
  assert.equal(moveA.startPos, 20);
  assert.equal(moveA.endPos, 1);
  assert.equal(moveA.startBonus, 200);
  assert.equal(moveA.balance, 1650);
  assert.equal(moveA.transactions.find(tx => tx.type === 'PARKING_TRAVEL').amount, 50);
  const [offerA, offerB] = await Promise.all([offerHost, offerGuest]);
  assert.deepEqual(offerA, offerB);
  assert.equal(game.state.players[0].money, 1650);
  assert.equal(game.state.phase, 'WAITING_PROPERTY_DECISION');
  assert.equal(game.state.transactions.filter(tx => tx.type === 'PARKING_TRAVEL').length, 1);
});

test('Free Parking STAY broadcasts the full resolved event to every room client', async t => {
  let nextId = 0;
  const roomManager = new RoomManager({idGenerator: () => `parking-stay-player-${++nextId}`});
  const {backend, url} = await startBackend(t, roomManager);
  const hostConnection = connectClient(t, url), guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const host = hostConnection.client, guest = guestConnection.client;
  const created = await host.request('room:create', {playerName: 'Host'});
  await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready'); await guest.request('room:ready'); await host.request('room:start');
  const game = backend.roomManager.getGameState(created.room.roomCode);
  // Turn order is shuffled at start, so act as whichever member is the active player.
  const player = game.state.players[game.state.currentTurn];
  const actor = player.name === 'Host' ? host : guest;
  player.pos = 20;
  player.money = 10; // cannot afford travel: the client sends STAY automatically
  game.pendingFreeParkingDecision = {playerId: player.playerId, turnId: game.state.turnId};
  const resolvedHost = waitForEvent(host, 'game:free-parking-action-resolved');
  const resolvedGuest = waitForEvent(guest, 'game:free-parking-action-resolved');
  const accepted = await actor.request('game:free-parking-action', {turnId: game.state.turnId,
    actionId: 'socket-parking-stay-1', action: 'STAY'});
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const [eventA, eventB] = await Promise.all([resolvedHost, resolvedGuest]);
  assert.deepEqual(eventA, eventB);
  assert.equal(eventA.outcome, 'STAY');
  assert.equal(eventA.actionId, 'socket-parking-stay-1');
  assert.equal(eventA.roomCode, created.room.roomCode);
  assert.equal(eventA.playerId, player.playerId);
  assert.equal(eventA.balance, 10);
  assert.equal(eventA.snapshot.pendingFreeParkingDecision, null);
  assert.equal(game.pendingFreeParkingDecision, null);
});

test('room events validate payloads and return consistent unauthorized errors', async t => {
  const {url} = await startBackend(t);
  const connection = connectClient(t, url);
  await connection.connected;

  const badName = await connection.client.request('room:create', {playerName: '   '});
  assert.equal(badName.ok, false);
  assert.equal(badName.error.code, 'INVALID_PAYLOAD');
  assert.equal((await connection.client.request('room:create', {playerName: 'Player', money: 1_000_000})).error.code,
    'INVALID_PAYLOAD', 'unknown client fields cannot be smuggled through room creation');
  const badJoin = await connection.client.request('room:join', {playerName: 'Player', roomCode: 'O0I1'});
  assert.equal(badJoin.error.code, 'INVALID_ROOM_CODE');
  assert.equal((await connection.client.request('room:ready')).error.code, 'NOT_IN_ROOM');
  assert.equal((await connection.client.request('room:start')).error.code, 'NOT_IN_ROOM');
  assert.equal((await connection.client.request('room:get')).error.code, 'NOT_IN_ROOM');
});

test('game:end-turn validates the active player and broadcasts one idempotent turn transition', async t => {
  let playerId = 0;
  const roomManager = new RoomManager({idGenerator: () => `end-turn-player-${++playerId}`, diceRoller: () => [1, 2]});
  const {backend, url} = await startBackend(t, roomManager);
  const hostConnection = connectClient(t, url), guestConnection = connectClient(t, url);
  await Promise.all([hostConnection.connected, guestConnection.connected]);
  const host = hostConnection.client, guest = guestConnection.client;
  const created = await host.request('room:create', {playerName: 'Host'});
  const joined = await guest.request('room:join', {playerName: 'Guest', roomCode: created.room.roomCode});
  await host.request('room:ready'); await guest.request('room:ready'); await host.request('room:start');
  const offer = await host.request('game:roll-dice', {turnId: 1});
  assert.equal(offer.result.tileResolution.kind, 'PROPERTY_OFFER');
  const bought = await host.request('game:property-decision', {
    turnId: 1, resolutionId: offer.result.tileResolution.offer.resolutionId, decision: 'BUY'
  });
  assert.equal(bought.ok, true);
  const game = backend.roomManager.getGameState(created.room.roomCode);
  assert.equal(game.state.phase, 'PLAYER_ACTION');
  assert.equal((await guest.request('game:end-turn', {turnId: 1, actionId: 'wrong-turn-owner'})).error.code,
    'NOT_ACTIVE_PLAYER');

  let eventCount = 0;
  host.on('game:turn-ended', () => eventCount++);
  guest.on('game:turn-ended', () => eventCount++);
  const hostEvent = waitForEvent(host, 'game:turn-ended');
  const guestEvent = waitForEvent(guest, 'game:turn-ended');
  const ended = await host.request('game:end-turn', {turnId: 1, actionId: 'end-turn-socket-once'});
  assert.equal(ended.ok, true);
  const [eventA, eventB] = await Promise.all([hostEvent, guestEvent]);
  assert.deepEqual(eventA, eventB);
  assert.equal(eventA.activePlayerId, joined.playerId);
  assert.equal(eventA.phase, 'WAITING_ROLL');
  assert.equal((await host.request('game:end-turn', {turnId: 1, actionId: 'end-turn-socket-once'})).result.duplicate, true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(eventCount, 2, 'duplicate ACK must not broadcast a second turn transition');
  assert.equal(game.state.turnId, 2);
});
