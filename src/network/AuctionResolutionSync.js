export function initAuctionResolutionSync({client, store, getActiveRoom, logger = console}) {
  const listeners = [
    ['game:auction-started', 'STARTED'],
    ['game:auction-updated', 'UPDATED'],
    ['game:auction-ended', 'ENDED']
  ].map(([eventName, type]) => client.on(eventName, payload => {
    const room = getActiveRoom?.();
    if (room?.status !== 'started' || room.roomCode !== payload?.roomCode ||
        !store.applyAuctionEvent(payload, type)) {
      logger.warn?.(`Event lelang ${type.toLowerCase()} diabaikan karena room, fase, atau datanya tidak cocok.`);
      return false;
    }
    return true;
  }));
  return () => listeners.forEach(remove => remove());
}
