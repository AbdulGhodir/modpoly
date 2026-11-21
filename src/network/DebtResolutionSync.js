export function initDebtResolutionSync({client, store, getActiveRoom, logger = console}) {
  const apply = (payload, expectedType) => {
    const room = getActiveRoom?.();
    const snapshot = payload?.snapshot;
    if (room?.status !== 'started' || room.roomCode !== payload?.roomCode ||
        snapshot?.roomCode !== room.roomCode || snapshot?.phase !== 'DEBT_RESOLUTION' ||
        snapshot?.pendingDebt?.debtId !== payload?.pendingDebt?.debtId ||
        !store.applyDebtState({...payload, type: expectedType})) {
      logger.warn?.('Utang resmi diabaikan karena room atau snapshot tidak cocok.');
      return false;
    }
    return true;
  };
  const offCreated = client.on('game:debt-created', payload => apply(payload, 'CREATED'));
  const offUpdated = client.on('game:debt-state', payload => {
    const room = getActiveRoom?.();
    const snapshot = payload?.snapshot;
    if (room?.status !== 'started' || room.roomCode !== payload?.roomCode || snapshot?.roomCode !== room.roomCode ||
        !['UPDATED', 'RESOLVED'].includes(payload?.type) ||
        (payload.type === 'UPDATED' && (snapshot.phase !== 'DEBT_RESOLUTION' ||
          snapshot.pendingDebt?.debtId !== payload.pendingDebt?.debtId)) ||
        !store.applyDebtState(payload)) {
      logger.warn?.('Perubahan utang resmi diabaikan karena room atau snapshot tidak cocok.');
      return false;
    }
    return true;
  });
  return () => { offCreated?.(); offUpdated?.(); };
}
