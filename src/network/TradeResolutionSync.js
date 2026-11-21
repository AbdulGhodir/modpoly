export function initTradeResolutionSync({client, store, getActiveRoom, logger = console}) {
  return client.on('game:trade-state', payload => {
    const room = getActiveRoom?.();
    if (room?.status !== 'started' || room.roomCode !== payload?.roomCode || !store.applyTradeEvent(payload)) {
      logger.warn?.('Status trade diabaikan karena room atau datanya tidak cocok.');
      return false;
    }
    return true;
  });
}
