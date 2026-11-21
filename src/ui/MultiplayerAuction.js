function createActionId() {
  return globalThis.crypto?.randomUUID?.() || `auction-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getAuctionBidOptions(auction) {
  const highestBid = Number.isSafeInteger(auction?.highestBid) && auction.highestBid >= 0 ? auction.highestBid : 0;
  const hasHighestBidder = typeof auction?.highestBidderId === 'string' && auction.highestBidderId.length > 0;
  const minimumBid = hasHighestBidder ? highestBid + 1 : 1;
  // Keep the single-player quick-bid rhythm: +10, +25, then +50 above the current bid.
  // On the first offer, start at the server's minimum of $1.
  const firstQuickBid = hasHighestBidder ? highestBid + 10 : 1;
  const quickBids = [firstQuickBid, firstQuickBid + 25, firstQuickBid + 50]
    .filter(amount => Number.isSafeInteger(amount) && amount >= minimumBid);
  return {minimumBid, quickBids};
}

export function isLocalAuctionBidder(auction, playerId) {
  return Boolean(playerId && auction?.currentBidderId === playerId);
}

export function parseCustomAuctionBid(value, minimumBid) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const amount = Number(text);
  return Number.isSafeInteger(amount) && amount >= minimumBid ? amount : null;
}

export function initMultiplayerAuction({client, store, modalManager, getActiveRoom, getLocalPlayerId}) {
  let shownAuctionId = null;
  let resultAuctionId = null;

  const render = change => {
    if (change?.type === 'auction-ended') {
      const result = change.detail;
      if (!result?.auctionId || resultAuctionId === result.auctionId) return;
      resultAuctionId = result.auctionId;
      shownAuctionId = result.auctionId;
      modalManager.showAuthoritativeAuctionResult(result);
      return;
    }
    const auction = store.activeAuction;
    if (!auction) {
      if (shownAuctionId) modalManager.closeAuthoritativeAuction(shownAuctionId);
      shownAuctionId = null;
      return;
    }
    if (resultAuctionId === auction.auctionId) return;
    shownAuctionId = auction.auctionId;
    modalManager.showAuthoritativeAuction(auction, {
      localPlayerId: getLocalPlayerId?.(),
      ...getAuctionBidOptions(auction),
      onAction: async (action, bidAmount, currentAuction) => {
        const room = getActiveRoom?.();
        const latest = store.activeAuction;
        const localPlayerId = getLocalPlayerId?.();
        const state = store.getState();
        const latestMinimumBid = getAuctionBidOptions(latest).minimumBid;
        if (room?.roomCode !== currentAuction.roomCode || latest?.auctionId !== currentAuction.auctionId ||
            latest?.turnId !== currentAuction.turnId || state.turnId !== currentAuction.turnId ||
            state.phase !== 'WAITING_AUCTION_ACTION' || latest?.currentBidderId !== localPlayerId) {
          return {ok: false, error: {message: 'Aksi ini bukan giliran lelang Anda.'}};
        }
        if (!['BID', 'PASS'].includes(action)) {
          return {ok: false, error: {message: 'Jenis aksi lelang tidak valid.'}};
        }
        if (action === 'BID' && (!Number.isSafeInteger(bidAmount) || bidAmount < latestMinimumBid)) {
          return {ok: false, error: {message: `Tawaran minimal $${latestMinimumBid.toLocaleString('id-ID')}.`}};
        }
        return client.request('game:auction-action', {
          auctionId: currentAuction.auctionId,
          turnId: currentAuction.turnId,
          actionId: createActionId(),
          action,
          ...(action === 'BID' ? {bidAmount} : {})
        });
      }
    });
  };
  const unsubscribe = store.subscribe(({change}) => {
    if (['auction-started', 'auction-updated', 'auction-ended', 'snapshot'].includes(change.type)) render(change);
  });
  return () => {
    unsubscribe();
    if (shownAuctionId) modalManager.closeAuthoritativeAuction(shownAuctionId);
  };
}
