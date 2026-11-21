export function initRentResolutionSync({client, store, getActiveRoom, logger = console}) {
  return client.on('game:rent-resolved', payload => {
    const room = getActiveRoom?.();
    const state = store.getState();
    const rent = payload?.rent;
    const tenant = state.getPlayerById(payload?.playerId);
    const owner = state.getPlayerById(rent?.ownerId);
    const property = store.getProperty(rent?.propertyPos);
    const valid = room?.status === 'started' && room.roomCode === payload?.roomCode &&
      state.phase === 'WAITING_TILE_RESOLUTION' && payload.previousTurnId === state.turnId &&
      payload.playerId === state.activePlayerId && tenant && tenant.playerId === rent?.tenantId &&
      owner && tenant.name === rent?.tenantName && owner.name === rent?.ownerName &&
      owner.playerId !== tenant.playerId && tenant.pos === rent?.propertyPos &&
      property && property.owner === owner.playerId && property.id === rent.propertyId &&
      property.name === rent.propertyName && property.type === rent.propertyType &&
      payload.movementId === store.lastMovementId && typeof payload.resolutionId === 'string' &&
      rent.resolutionId === payload.resolutionId && typeof rent.amount === 'number' &&
      ['PAID', 'MORTGAGED', 'INSUFFICIENT_FUNDS'].includes(rent.outcome);
    if (!valid || !store.applyRentResolution({...payload})) {
      logger.warn?.('Hasil sewa diabaikan karena room, giliran, properti, atau pemilik tidak cocok.');
      return false;
    }
    return true;
  });
}
