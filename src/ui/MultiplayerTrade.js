function actionId() {
  return globalThis.crypto?.randomUUID?.() || `trade-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function initMultiplayerTrade({client, store, modalManager, getActiveRoom, getLocalPlayerId}) {
  let visibleTradeId = null;
  const show = trade => {
    const playerId = getLocalPlayerId?.();
    if (!trade || ![trade.fromPlayerId, trade.toPlayerId].includes(playerId)) return false;
    visibleTradeId = trade.tradeId;
    modalManager.showAuthoritativeTrade(trade, {
      localPlayerId: playerId,
      onAction: async (action, currentTrade) => {
        const room = getActiveRoom?.();
        const current = store.trades.get(currentTrade.tradeId);
        if (room?.roomCode !== currentTrade.roomCode || current?.status !== 'PENDING' ||
            (action === 'CANCEL' ? currentTrade.fromPlayerId !== playerId : currentTrade.toPlayerId !== playerId)) {
          return {ok: false, error: {message: 'Aksi ini tidak tersedia untuk penawaran tersebut.'}};
        }
        return client.request('game:trade-action', {tradeId: currentTrade.tradeId, actionId: actionId(), action});
      }
    });
    return true;
  };
  const onStoreUpdate = ({change}) => {
    if (change.type === 'trade-updated' || change.type === 'trade-completed') {
      show(change.detail?.trade);
      return;
    }
    if (change.type !== 'snapshot') return;
    const playerId = getLocalPlayerId?.();
    const pending = [...store.trades.values()].filter(trade => trade.status === 'PENDING' &&
      [trade.fromPlayerId, trade.toPlayerId].includes(playerId))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    if (pending) show(pending);
    else if (visibleTradeId) modalManager.closeAuthoritativeTrade(visibleTradeId);
  };
  const unsubscribe = store.subscribe(onStoreUpdate);
  return () => {
    unsubscribe();
    if (visibleTradeId) modalManager.closeAuthoritativeTrade(visibleTradeId);
  };
}
