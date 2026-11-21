export function initFreeParkingResolutionSync({client, store, getActiveRoom, logger = console}) {
  return client.on('game:free-parking-action-resolved', event => {
    const room = getActiveRoom?.();
    const valid = room?.status === 'started' && event?.roomCode === room.roomCode &&
      typeof event.actionId === 'string' && event.actionId.length > 0;
    if (!valid || !store.applyFreeParkingDecision({...event})) {
      logger.warn?.('Pilihan Parkir Bebas diabaikan karena room, giliran, atau status tidak cocok.');
      return false;
    }
    return true;
  });
}
