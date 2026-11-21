export function initMultiplayerChanceResolution({client, store, modalManager, getActiveRoom, getLocalPlayerId,
  eventTarget = globalThis.window}) {
  const queuedResolutions = [];
  const seenPresentationIds = new Set();
  let blockingModalOpen = false;
  let activeChanceCard = false;
  let activePresentationId = null;

  const enqueue = event => {
    const presentationId = event?.presentationId;
    if (!presentationId || seenPresentationIds.has(presentationId)) return;
    seenPresentationIds.add(presentationId);
    queuedResolutions.push({...event, card: {...event.card}});
  };
  const updatePending = () => {
    const pending = activeChanceCard || queuedResolutions.length > 0;
    if (store.presentation.chancePending === pending) return;
    store.presentation.chancePending = pending;
    if (!pending) store.notify({type: 'chance-presentation-complete'});
  };
  const continuePresentation = async event => {
    const room = getActiveRoom?.();
    const localPlayerId = getLocalPlayerId?.();
    const state = store.getState();
    const pending = store.pendingChancePresentation;
    if (room?.status !== 'started' || !client?.isConnected?.() || localPlayerId !== event.playerId ||
        state.phase !== 'CHANCE_PRESENTATION' || state.activePlayerId !== localPlayerId ||
        pending?.presentationId !== event.presentationId) {
      return {ok: false, message: 'Kartu sudah tidak menunggu tindakan atau koneksi terputus.'};
    }
    const actionId = `chance-continue-${event.presentationId}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    const response = await client.request('game:chance-continue', {
      turnId: event.turnId, resolutionId: event.resolutionId, presentationId: event.presentationId, actionId
    });
    return response?.ok ? {ok: true} : {ok: false,
      message: response?.error?.message || 'Server belum dapat melanjutkan kartu.'};
  };
  const present = () => {
    const movementInProgress = [...(store.presentation.movements?.values?.() || [])]
      .some(movement => movement?.status === 'ANIMATING') || store.presentation.movement?.status === 'ANIMATING';
    if (!queuedResolutions.length || blockingModalOpen || movementInProgress || modalManager.isOpen()) return;
    const event = queuedResolutions.shift();
    const canContinue = event.playerId === getLocalPlayerId?.();
    if (modalManager.showAuthoritativeChanceCard(event, {canContinue,
      onContinue: () => continuePresentation(event)})) {
      activeChanceCard = true;
      activePresentationId = event.presentationId;
    } else present();
    updatePending();
  };
  const unsubscribe = store.subscribe(({change}) => {
    if (change.type === 'chance-presented') {
      enqueue(change.detail);
      updatePending();
      present();
    } else if (change.type === 'snapshot' || change.type === 'debt-resolved' || change.type === 'debt-updated') {
      const pending = change.detail?.pendingChancePresentation || store.pendingChancePresentation;
      const room = getActiveRoom?.();
      if (pending?.pendingPlayerIds?.includes(getLocalPlayerId?.()) &&
          pending.event?.roomCode === room?.roomCode) {
        enqueue(pending.event);
        updatePending();
        present();
      }
    } else if (change.type === 'movement-animation-complete' || change.type === 'tile:resolved') {
      present();
    }
  });
  const onModalOpened = () => { blockingModalOpen = true; };
  const onTileModalClosed = () => {
    activeChanceCard = false;
    activePresentationId = null;
    present();
    updatePending();
  };
  const onModalClosed = () => { blockingModalOpen = false; present(); };
  eventTarget?.addEventListener?.('tilemodal:closed', onTileModalClosed);
  eventTarget?.addEventListener?.('tile:resolved', present);
  eventTarget?.addEventListener?.('modal:opened', onModalOpened);
  eventTarget?.addEventListener?.('modal:closed', onModalClosed);
  return () => {
    unsubscribe();
    eventTarget?.removeEventListener?.('tilemodal:closed', onTileModalClosed);
    eventTarget?.removeEventListener?.('tile:resolved', present);
    eventTarget?.removeEventListener?.('modal:opened', onModalOpened);
    eventTarget?.removeEventListener?.('modal:closed', onModalClosed);
  };
}
