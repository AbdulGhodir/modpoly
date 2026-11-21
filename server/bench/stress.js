import {once} from 'node:events';
import {SocketClient} from '../../src/network/SocketClient.js';
import {createBackendServer} from '../src/app.js';
import {RoomManager} from '../src/RoomManager.js';

const backend = createBackendServer({
  port: 0,
  allowedOrigins: [],
  roomManager: new RoomManager({diceRoller: () => [1, 2]}),
  rateLimits: {
    room: {capacity: 1000, refillPerSecond: 1000},
    gameplay: {capacity: 1000, refillPerSecond: 1000},
    ping: {capacity: 1000, refillPerSecond: 1000},
    roomIp: {capacity: 1000, refillPerSecond: 1000}
  }
});
const clients = [];
const counts = {requests: 0, accepted: 0, rejected: 0, events: 0, reconnects: 0, errors: 0, timeouts: 0};
const eventBytes = [];
const startedAt = performance.now();
const cpuStart = process.cpuUsage();
const memoryStart = process.memoryUsage();

function expect(condition, message) { if (!condition) throw new Error(message); }
function waitConnected(client) {
  if (client.isConnected()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('socket connect timed out')); }, 8000);
    const off = client.onStatusChange(status => {
      if (status !== 'connected') return;
      clearTimeout(timer); off(); resolve();
    });
  });
}
async function connect() {
  const client = new SocketClient({url: `http://127.0.0.1:${backend.httpServer.address().port}`});
  clients.push(client); client.connect(); await waitConnected(client); return client;
}
async function request(client, event, payload = {}) {
  counts.requests++;
  const before = performance.now();
  const result = await client.request(event, payload, 5000);
  counts.eventLatencySamples ??= [];
  counts.eventLatencySamples.push(performance.now() - before);
  if (result?.error?.code === 'TIMEOUT') counts.timeouts++;
  if (result?.ok) counts.accepted++; else counts.rejected++;
  return result;
}
function listen(client, event) {
  const records = [];
  const off = client.on(event, payload => {
    counts.events++;
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    eventBytes.push(bytes);
    records.push(payload);
  });
  return {records, off};
}

try {
  backend.httpServer.listen(0, '127.0.0.1');
  await once(backend.httpServer, 'listening');
  const specs = [2, 4, 2];
  const rooms = [];
  let playerNumber = 0;
  for (const [roomIndex, playerCount] of specs.entries()) {
    const roomClients = [];
    for (let i = 0; i < playerCount; i++) roomClients.push(await connect());
    const created = await request(roomClients[0], 'room:create', {playerName: `Stress ${++playerNumber}`});
    expect(created.ok, 'room creation failed');
    const members = [{client: roomClients[0], playerId: created.playerId, sessionToken: created.sessionToken}];
    for (let i = 1; i < playerCount; i++) {
      const joined = await request(roomClients[i], 'room:join', {
        playerName: `Stress ${++playerNumber}`, roomCode: created.room.roomCode
      });
      expect(joined.ok, 'room join failed');
      members.push({client: roomClients[i], playerId: joined.playerId, sessionToken: joined.sessionToken});
    }
    for (const member of members) expect((await request(member.client, 'room:ready')).ok, 'ready failed');
    const isolatedListeners = rooms.map(room => listen(room.members[0].client, 'game:dice-rolled'));
    const ownListeners = members.map(member => listen(member.client, 'game:dice-rolled'));
    expect((await request(members[0].client, 'room:start')).ok, 'start failed');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await request(members[0].client, 'game:roll-dice', {turnId: 1, actionId: `stress-roll-${roomIndex}`})).ok,
      'authoritative roll failed');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ownListeners.every(listener => listener.records.length === 1), 'roll event did not reach every room member exactly once');
    expect(isolatedListeners.every(listener => listener.records.length === 0), 'roll event leaked across rooms');
    for (const listener of [...ownListeners, ...isolatedListeners]) listener.off();

    const replay = await request(members[0].client, 'game:roll-dice', {turnId: 1, actionId: `stress-replay-${roomIndex}`});
    expect(!replay.ok, 'duplicate roll in a pending tile phase was accepted');
    const disconnectMember = members.at(-1);
    const {sessionToken} = disconnectMember;
    disconnectMember.client.disconnect();
    const replacement = await connect(); counts.reconnects++;
    const resumed = await request(replacement, 'room:resume', {sessionToken});
    expect(resumed.ok && resumed.snapshot?.roomCode === created.room.roomCode, 'reconnect snapshot did not restore the active room');
    expect(resumed.snapshot.players.length === playerCount, 'reconnect snapshot player count mismatch');
    expect(resumed.snapshot.phase === 'WAITING_PROPERTY_DECISION', 'reconnect snapshot lost pending property decision');
    members[members.length - 1] = {...disconnectMember, client: replacement};
    rooms.push({members, roomCode: created.room.roomCode});
  }

  const elapsedMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStart);
  const memory = process.memoryUsage();
  const latencies = counts.eventLatencySamples.sort((a, b) => a - b);
  console.log(JSON.stringify({
    result: 'PASS', scenario: 'three-active-rooms-2-4-2-players', simultaneousClients: rooms.reduce((n, room) => n + room.members.length, 0),
    totalConnectionsCreated: clients.length,
    simultaneousRooms: rooms.length, durationMs: +elapsedMs.toFixed(1),
    requests: counts.requests, accepted: counts.accepted, rejected: counts.rejected,
    eventDeliveries: counts.events, eventBytesMean: Math.round(eventBytes.reduce((a, b) => a + b, 0) / eventBytes.length),
    eventLatencyAckMs: {p50: +latencies[Math.floor(latencies.length * .5)].toFixed(2), p95: +latencies[Math.floor(latencies.length * .95)].toFixed(2)},
    disconnects: counts.reconnects, reconnects: counts.reconnects, timeouts: counts.timeouts, errors: counts.errors,
    cpuUserMs: Math.round(cpu.user / 1000), cpuSystemMs: Math.round(cpu.system / 1000),
    heapStartBytes: memoryStart.heapUsed, heapEndBytes: memory.heapUsed, heapDeltaBytes: memory.heapUsed - memoryStart.heapUsed
  }));
} catch (error) {
  counts.errors++;
  console.error(JSON.stringify({result: 'FAIL', message: error.message, counts}));
  process.exitCode = 1;
} finally {
  for (const client of clients) client.disconnect();
  await new Promise(resolve => backend.io.close(resolve));
}
