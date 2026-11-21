/** Apply authoritative end-turn transitions for the active room only. */
export function initTurnFlowSync({client, store, getActiveRoom, logger = console}) {
  return client.on('game:turn-ended', payload => {
    const room = getActiveRoom?.();
    if (room?.status !== 'started' || room.roomCode !== payload?.roomCode ||
        !store.applyTurnEnded({...payload})) {
      logger.warn?.('Penyelesaian giliran diabaikan karena room atau data giliran tidak cocok.');
      return false;
    }
    return true;
  });
}
