function isValidSnapshot(snapshot, roomCode, room) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  if (snapshot.version !== 1 || snapshot.roomCode !== roomCode) return false;
  if (!['IN_GAME', 'WAITING', 'FINISHED'].includes(snapshot.gameStatus)) return false;
  if (!Number.isInteger(snapshot.round) || snapshot.round < 1 ||
      !Number.isInteger(snapshot.turnId) || snapshot.turnId < 1 ||
      !Number.isInteger(snapshot.currentTurn) || !Array.isArray(snapshot.players) ||
      snapshot.players.length !== room.players.length || snapshot.currentTurn < 0 ||
      snapshot.currentTurn >= snapshot.players.length || typeof snapshot.phase !== 'string' || !snapshot.phase ||
      snapshot.activePlayerId !== snapshot.players[snapshot.currentTurn]?.playerId ||
      !Array.isArray(snapshot.properties) || !Array.isArray(snapshot.transactions)) return false;
  if (snapshot.extraRollAvailable !== undefined && typeof snapshot.extraRollAvailable !== 'boolean') return false;
  if (snapshot.properties.some(entry => !Array.isArray(entry) || entry.length !== 2 ||
      !Number.isInteger(entry[0]) || !entry[1] || typeof entry[1] !== 'object' || Array.isArray(entry[1]))) return false;
  if (snapshot.trades !== undefined && !Array.isArray(snapshot.trades)) return false;
  if (snapshot.pendingDebt !== undefined && snapshot.pendingDebt !== null &&
      (typeof snapshot.pendingDebt !== 'object' || Array.isArray(snapshot.pendingDebt))) return false;
  if (snapshot.pendingPropertyOffer !== undefined && snapshot.pendingPropertyOffer !== null &&
      (typeof snapshot.pendingPropertyOffer !== 'object' || Array.isArray(snapshot.pendingPropertyOffer))) return false;
  if (snapshot.activeAuction !== undefined && snapshot.activeAuction !== null &&
      (typeof snapshot.activeAuction !== 'object' || Array.isArray(snapshot.activeAuction))) return false;
  if (snapshot.pendingFreeParkingDecision !== undefined && snapshot.pendingFreeParkingDecision !== null &&
      (typeof snapshot.pendingFreeParkingDecision !== 'object' || Array.isArray(snapshot.pendingFreeParkingDecision))) return false;
  if (snapshot.pendingChancePresentation !== undefined && snapshot.pendingChancePresentation !== null &&
      (typeof snapshot.pendingChancePresentation !== 'object' || Array.isArray(snapshot.pendingChancePresentation))) return false;

  // The server owns these pending actions. The client checks only their container shape
  // here and restores them verbatim; duplicating server-side phase rules caused valid
  // reconnect snapshots to be rejected when a protocol added optional presentation data.
  const ids = new Set();
  for (let seat = 0; seat < snapshot.players.length; seat++) {
    const player = snapshot.players[seat];
    const member = room.players[seat];
    if (!player || player.seat !== seat || typeof player.playerId !== 'string' || ids.has(player.playerId) ||
        player.playerId !== member?.playerId || player.name !== member?.playerName ||
        !Number.isFinite(player.money) || !Number.isInteger(player.pos) ||
        !Array.isArray(player.properties)) return false;
    ids.add(player.playerId);
  }
  return true;
}

/** Apply only the initial state for the active, already-started lobby room. */
export function applyInitialSnapshot({payload, store, getActiveRoom, logger = console}) {
  const room = getActiveRoom?.();
  const roomCode = typeof payload?.roomCode === 'string' ? payload.roomCode : '';
  if (!room || room.status !== 'started' || room.roomCode !== roomCode ||
      !isValidSnapshot(payload.snapshot, roomCode, room)) {
    logger.warn?.('Snapshot awal diabaikan karena room atau datanya tidak valid.', {
      expectedRoomCode: room?.roomCode || null, receivedRoomCode: roomCode || null,
      roomStatus: room?.status || null, phase: payload?.snapshot?.phase || null,
      turnId: payload?.snapshot?.turnId ?? null
    });
    return false;
  }
  try {
    if (store.setSnapshot(payload.snapshot) === false) {
      const current = store.getState?.();
      if (store.roomCode === roomCode && current?.turnId >= payload.snapshot.turnId) {
        logger.info?.(`Snapshot room ${roomCode} sudah terlampaui oleh state client yang lebih baru.`);
        return true;
      }
      return false;
    }
    logger.info?.(`Snapshot room ${roomCode} diterapkan.`);
    return true;
  } catch (error) {
    logger.warn?.('Snapshot awal gagal diterapkan.', error);
    return false;
  }
}

export function initInitialSnapshotSync({client, store, getActiveRoom, logger = console}) {
  return client.on('game:initial-snapshot', payload =>
    applyInitialSnapshot({payload, store, getActiveRoom, logger}));
}
