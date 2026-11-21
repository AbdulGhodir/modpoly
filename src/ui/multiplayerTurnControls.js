function hasMovementAnimation(store) {
  const movementPresentations = store?.presentation?.movements;
  return (movementPresentations instanceof Map &&
    [...movementPresentations.values()].some(movement => movement?.status === 'ANIMATING')) ||
    store?.presentation?.movement?.status === 'ANIMATING';
}

function hasBlockingAction(store) {
  return Boolean(store?.pendingResolution || store?.pendingDebt || store?.activeAuction ||
    store?.pendingChancePresentation || store?.pendingFreeParkingDecision || store?.unsupportedTile ||
    hasMovementAnimation(store));
}

function isLocalActivePlayer({state, room, localPlayerId, connected}) {
  const roomPlayer = room?.players?.find(player => player.playerId === localPlayerId);
  const activePlayer = state?.getActivePlayer?.();
  return Boolean(localPlayerId && room?.status === 'started' && connected === true && roomPlayer?.isConnected === true &&
    state?.gameStatus === 'IN_GAME' && state.activePlayerId === localPlayerId &&
    activePlayer?.playerId === localPlayerId && activePlayer.status !== 'BANKRUPT');
}

/** A local menu is available only to the connected active player in an action-capable phase. */
export function canShowPlayerActionMenu({state, store, room, localPlayerId, connected}) {
  return isLocalActivePlayer({state, room, localPlayerId, connected}) &&
    ['WAITING_ROLL', 'PLAYER_ACTION'].includes(state.phase) && !hasBlockingAction(store);
}

/** Derive visible turn controls only from the authoritative multiplayer state. */
export function getMultiplayerTurnControls({state, store, room, localPlayerId, connected}) {
  const locallyActive = isLocalActivePlayer({state, room, localPlayerId, connected});
  const ready = locallyActive && state.phase === 'PLAYER_ACTION' && !hasBlockingAction(store);
  const extraRollAvailable = store?.extraRollAvailable === true;
  return {
    showEndTurn: ready && !extraRollAvailable,
    showRollAgain: ready && extraRollAvailable,
    waitingForPlayer: room?.status === 'started' && state?.gameStatus === 'IN_GAME' && !locallyActive
  };
}
