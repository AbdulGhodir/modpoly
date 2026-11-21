const expiredCodes = new Set(['STALE_TURN', 'STALE_RESOLUTION', 'PROPERTY_UNAVAILABLE', 'NOT_ACTIVE_PLAYER']);

export function initMultiplayerPropertyOffer({client, store, getActiveRoom, getLocalPlayerId, modalManager}) {
  let activePromptId = null;

  const openPendingOffer = () => {
    const offer = store.pendingResolution;
    if (store.getPhase() !== 'WAITING_PROPERTY_DECISION' || store.activeAuction ||
        !offer || offer.playerId !== getLocalPlayerId() || activePromptId === offer.resolutionId) return;
    if (store.presentation.movement?.status === 'ANIMATING' || store.presentation.chancePending ||
        store.presentation.rentPending || modalManager.isOpen()) return;
    const property = store.getProperty(offer.propertyPos);
    const player = store.getPlayer(offer.playerId);
    if (!property || !player || property.owner !== null || player.seat !== offer.seat) return;

    activePromptId = offer.resolutionId;
    modalManager.promptPurchase(property, player, {
      onDecision: async decision => {
        const currentRoom = getActiveRoom?.();
        if (currentRoom?.roomCode !== offer.roomCode || store.pendingResolution?.resolutionId !== offer.resolutionId ||
            store.getState().turnId !== offer.turnId || store.getState().activePlayerId !== getLocalPlayerId()) {
          return {ok: false, expired: true, error: {message: 'Penawaran ini sudah kedaluwarsa.'}};
        }
        const response = await client.request('game:property-decision', {
          turnId: offer.turnId,
          resolutionId: offer.resolutionId,
          decision
        });
        if (!response.ok) {
          return {
            ok: false,
            expired: expiredCodes.has(response.error?.code),
            error: response.error
          };
        }
        return {ok: true, result: response.result, auctionStarted: response.result?.type === 'STARTED'};
      }
    }).finally(() => {
      if (activePromptId === offer.resolutionId) activePromptId = null;
    });
  };

  const unsubscribe = store.subscribe(({change}) => {
    if (change.type === 'property-offer' || change.type === 'movement-animation-complete' ||
        change.type === 'chance-presentation-complete' || change.type === 'rent-presentation-complete' ||
        change.type === 'snapshot') openPendingOffer();
  });
  const onModalClosed = () => openPendingOffer();
  globalThis.window?.addEventListener?.('tilemodal:closed', onModalClosed);
  return () => {
    unsubscribe();
    globalThis.window?.removeEventListener?.('tilemodal:closed', onModalClosed);
  };
}
