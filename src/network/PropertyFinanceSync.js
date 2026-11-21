export function initPropertyFinanceSync({client, store, getActiveRoom, logger = console}) {
  return client.on('game:property-finance-resolved', payload => {
    const room = getActiveRoom?.();
    const state = store.getState();
    const player = state.getPlayerById(payload?.playerId);
    const property = store.getProperty(payload?.propertyPos);
    const valid = room?.status === 'started' && room.roomCode === payload?.roomCode &&
      ['WAITING_ROLL', 'PLAYER_ACTION'].includes(state.phase) && payload.phase === state.phase && payload.turnId === state.turnId &&
      payload.currentTurn === state.currentTurn && payload.activePlayerId === state.activePlayerId &&
      payload.playerId === state.activePlayerId && player && property && property.owner === player.playerId &&
      payload.propertyId === property.id && payload.propertyName === property.name &&
      typeof payload.resolutionId === 'string' && payload.resolutionId.length > 0 &&
      ['MORTGAGE', 'UNMORTGAGE'].includes(payload.action);
    if (!valid || !store.applyPropertyFinanceResolution({...payload})) {
      logger.warn?.('Hasil gadai properti diabaikan karena room, giliran, kepemilikan, atau nilainya tidak cocok.');
      return false;
    }
    return true;
  });
}
