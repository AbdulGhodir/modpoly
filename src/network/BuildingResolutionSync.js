export function initBuildingResolutionSync({client, store, getActiveRoom, logger = console}) {
  return client.on('game:building-state', payload => {
    const room = getActiveRoom?.();
    if (room?.status !== 'started' || room.roomCode !== payload?.roomCode ||
        !store.applyBuildingResolution(payload)) {
      logger.warn?.('Aksi bangunan diabaikan karena room, giliran, atau data server tidak cocok.');
      return false;
    }
    return true;
  });
}
