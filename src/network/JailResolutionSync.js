/** Applies only server-authenticated jail actions and their authoritative snapshots. */
export function initJailResolutionSync({client, store, getActiveRoom, logger = console}) {
  return client.on('game:jail-action-resolved', event => {
    const room = getActiveRoom?.();
    const state = store.getState();
    const player = state.getPlayerById(event?.playerId);
    const direct = ['PAY_BAIL', 'USE_CARD'].includes(event?.action);
    const attempt = ['DOUBLE', 'FORCED_BAIL', 'FAILED'].includes(event?.outcome);
    const valid = room?.status === 'started' && event?.roomCode === room.roomCode &&
      typeof event.actionId === 'string' && player && Number.isInteger(event.turnId) &&
      (direct ? event.turnId === state.turnId && event.playerId === state.activePlayerId &&
        state.phase === 'WAITING_ROLL' && player.status === 'IN_JAIL' : attempt &&
        event.previousTurnId === state.turnId && event.playerId === state.activePlayerId &&
        state.lastRoll?.jailAttempt === true && state.lastRoll.total === event.total &&
        state.lastRoll.isDouble === event.isDouble && state.phase === (event.outcome === 'FAILED' ? 'JAIL_ATTEMPT' : 'MOVING'));
    if (!valid || !store.applyJailResolution({...event})) {
      logger.warn?.('Hasil aksi penjara diabaikan karena room, giliran, atau status tidak cocok.');
      return false;
    }
    return true;
  });
}
