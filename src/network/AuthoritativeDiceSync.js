/** Accept only a server dice result matching the currently active room and turn. */
export function initAuthoritativeDiceSync({client, store, getActiveRoom, logger = console}) {
  return client.on('game:dice-rolled', payload => {
    const room = getActiveRoom?.();
    const state = store.getState();
    const player = state.getPlayerById(payload?.playerId);
    const dice = [payload?.die1, payload?.die2];
    const isDouble = dice[0] === dice[1];
    const jailAttempt = payload?.jailAttempt === true;
    const jailed = player?.status === 'IN_JAIL' || player?.inJail === true;
    const extraRollAttempt = state.phase === 'PLAYER_ACTION' && store.getExtraRollAvailable?.() === true;
    const expectedDoubles = jailAttempt ? 0 : isDouble ? (player?.consecutiveDoubles || 0) + 1 : 0;
    const tripleDouble = !jailAttempt && isDouble && expectedDoubles === 3;
    const valid = room?.status === 'started' && room.roomCode === payload?.roomCode &&
      Number.isInteger(payload.turnId) && payload.turnId === state.turnId &&
      payload.playerId === state.activePlayerId &&
      player && payload.seat === player.seat && payload.seat === state.currentTurn &&
      (state.phase === 'WAITING_ROLL' || extraRollAttempt) &&
      dice.every(value => Number.isInteger(value) && value >= 1 && value <= 6) &&
      payload.total === dice[0] + dice[1] && payload.isDouble === isDouble &&
      payload.consecutiveDoubles === expectedDoubles && payload.tripleDouble === tripleDouble &&
      (jailAttempt ? jailed && typeof payload.jailReleased === 'boolean' &&
        payload.phase === (payload.jailReleased ? 'MOVING' : 'JAIL_ATTEMPT') : !jailed && payload.phase === (tripleDouble ? 'JAILING' : 'MOVING'));
    if (!valid) {
      logger.warn?.('Hasil dadu diabaikan karena room, giliran, atau nilainya tidak cocok.');
      return false;
    }
    store.applyDiceResult({...payload});
    return true;
  });
}
