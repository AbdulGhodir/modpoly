import {createServerGameState} from '../src/game/ServerGameState.js';

const iterations = Number(process.env.BENCH_ITERATIONS || 2000);
const makeRoom = (roomIndex, playerCount) => createServerGameState({
  roomCode: `BENCH${String(roomIndex).padStart(2, '0')}`,
  roster: Array.from({length: playerCount}, (_, seat) => ({
    playerId: `room-${roomIndex}-player-${seat + 1}`,
    playerName: `Player ${seat + 1}`
  }))
});

function measureSnapshots(label, rooms) {
  const byteSamples = [];
  const startHeap = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  let snapshots = 0;
  for (let i = 0; i < iterations; i++) {
    for (const room of rooms) {
      const player = room.state.players[i % room.state.players.length];
      player.pos = (player.pos + 1) % 40;
      const snapshot = room.toPublicSnapshot({viewerPlayerId: player.playerId});
      const serialized = JSON.stringify(snapshot);
      if (i < 20) byteSamples.push(Buffer.byteLength(serialized));
      snapshots++;
    }
  }
  const elapsedMs = performance.now() - startedAt;
  const heapDeltaBytes = process.memoryUsage().heapUsed - startHeap;
  const meanBytes = byteSamples.reduce((sum, value) => sum + value, 0) / Math.max(1, byteSamples.length);
  console.log(JSON.stringify({
    scenario: label,
    rooms: rooms.length,
    playersPerRoom: rooms.map(room => room.state.players.length),
    snapshots,
    meanSnapshotBytes: Math.round(meanBytes),
    meanSnapshotMs: +(elapsedMs / snapshots).toFixed(4),
    snapshotsPerSecond: Math.round(snapshots * 1000 / elapsedMs),
    heapDeltaBytes: heapDeltaBytes
  }));
}

measureSnapshots('one-room-two-players', [makeRoom(1, 2)]);
measureSnapshots('one-room-four-players', [makeRoom(2, 4)]);
measureSnapshots('two-active-rooms', [makeRoom(3, 2), makeRoom(4, 4)]);
measureSnapshots('sixteen-active-rooms', Array.from({length: 16}, (_, index) => makeRoom(index + 5, index % 2 ? 4 : 2)));
