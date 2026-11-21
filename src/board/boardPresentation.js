/** Derive dice-step hints only from the current authoritative turn state. */
export function getDiceHintPresentation({state, store}) {
  if (!state || state.gameStatus !== 'IN_GAME') return null;
  const active = state.getActivePlayer?.();
  if (!active || active.playerId !== state.activePlayerId || active.status === 'BANKRUPT' ||
      active.status === 'IN_JAIL' || active.inJail === true) return null;

  const rollAvailable = state.phase === 'WAITING_ROLL' ||
    (state.phase === 'PLAYER_ACTION' && store?.extraRollAvailable === true);
  if (!rollAvailable || store?.pendingFreeParkingDecision?.playerId === active.playerId ||
      hasMovementAnimation(store)) return null;
  return {playerId: active.playerId, position: active.pos};
}

function hasMovementAnimation(store) {
  const movements = store?.presentation?.movements;
  return (movements instanceof Map && [...movements.values()].some(item => item?.status === 'ANIMATING')) ||
    store?.presentation?.movement?.status === 'ANIMATING';
}

/** Tracks accepted official movements and reveals only the latest settled destination. */
export class OfficialLandingTracker {
  constructor() {
    this.seen = new Set();
    this.pending = new Set();
    this.destinations = new Map();
    this.latestDestination = null;
  }

  begin(movement) {
    if (!movement || typeof movement.movementId !== 'string' || !movement.movementId ||
        !Number.isInteger(movement.endPos) || this.seen.has(movement.movementId)) return false;
    this.seen.add(movement.movementId);
    this.pending.add(movement.movementId);
    this.destinations.set(movement.movementId, movement.endPos);
    this.latestDestination = movement.endPos;
    if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value);
    return true;
  }

  complete(movementId) {
    if (!this.pending.delete(movementId)) return null;
    const destination = this.destinations.get(movementId);
    this.destinations.delete(movementId);
    return this.pending.size === 0 ? this.latestDestination ?? destination : null;
  }

  setDestination(position) {
    if (!Number.isInteger(position)) return null;
    this.pending.clear();
    this.destinations.clear();
    this.latestDestination = position;
    return position;
  }

  reset() {
    this.pending.clear();
    this.destinations.clear();
    this.latestDestination = null;
  }
}
