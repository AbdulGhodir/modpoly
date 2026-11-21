import {CHANCE_CARDS} from '../data/cards.js';

export function initChanceResolutionSync({client, store, getActiveRoom, tiles, logger = console}) {
  return client.on('game:chance-resolved', payload => {
    const room = getActiveRoom?.();
    const state = store.getState();
    const player = state.getPlayerById(payload?.playerId);
    const card = CHANCE_CARDS.find(item => item.id === payload?.card?.id);
    // Successful resolutions use landedPosition; held/unsupported card events
    // use position. Both values originate from the authoritative server.
    const position = Number.isInteger(payload?.position) ? payload.position : payload?.landedPosition;
    const hasMovementChain = Array.isArray(payload?.movements) && payload.movements.length > 0;
    const chanceOrigin = hasMovementChain ? payload.initialPosition : position;
    const isChanceTile = Array.isArray(tiles) && tiles.some(tile => tile.pos === chanceOrigin && tile.type === 'chance');
    const cards = Array.isArray(payload?.cards) ? payload.cards : [payload?.card];
    const knownCards = cards.map(item => CHANCE_CARDS.find(cardItem => cardItem.id === item?.id));
    const cardDataValid = cards.length > 0 && knownCards.every((item, index) => item && item.type === cards[index].type && item.desc === cards[index].desc);
    let expectedPos = chanceOrigin;
    let movementIndex = 0;
    let routeValid = hasMovementChain;
    if (hasMovementChain && cardDataValid) for (const cardItem of knownCards) {
      if (cardItem.type !== 'MOVE_TO' && cardItem.type !== 'MOVE_BACKWARD') continue;
      const movement = payload.movements[movementIndex++];
      const backward = cardItem.type === 'MOVE_BACKWARD';
      const steps = backward ? cardItem.steps : ((cardItem.targetPos - expectedPos + 40) % 40 || 40);
      const endPos = (expectedPos + (backward ? -steps : steps) + 400) % 40;
      const passedStart = !backward && Math.floor((expectedPos + steps) / 40) > 0;
      if (!movement || movement.startPos !== expectedPos || movement.steps !== steps || movement.endPos !== endPos ||
          movement.direction !== (backward ? 'backward' : 'forward') || movement.startBonus !== (passedStart ? 200 : 0) ||
          movement.passedStart !== (backward ? undefined : passedStart)) routeValid = false;
      expectedPos = endPos;
    }
    if (hasMovementChain && (movementIndex !== payload.movements.length || expectedPos !== position)) routeValid = false;
    const valid = room?.status === 'started' && room.roomCode === payload?.roomCode &&
      state.phase === 'CHANCE_PRESENTATION' && payload.previousTurnId === state.turnId &&
      payload.playerId === state.activePlayerId && player && player.seat === payload.seat &&
      (hasMovementChain ? player.pos === chanceOrigin : player.pos === position) &&
      (payload.sourceMovementId || payload.movementId) === store.lastMovementId &&
      store.pendingChancePresentation?.presentationId === payload.presentationId && isChanceTile && cardDataValid &&
      card && card.type === payload.card.type && card.desc === payload.card.desc && (!hasMovementChain || routeValid) &&
      typeof payload.resolutionId === 'string' && payload.resolutionId.length > 0 &&
      typeof payload.supported === 'boolean' && typeof payload.message === 'string';
    if (!valid || !store.applyChanceResolution({...payload, position, card: {...card}, cards: knownCards.map(item => ({...item}))})) {
      logger.warn?.('Hasil kartu Kesempatan diabaikan karena room, giliran, petak, atau kartunya tidak cocok.');
      return false;
    }
    return true;
  });
}
