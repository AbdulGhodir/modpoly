function roomMatches(payload, room) {
  return room?.status === 'started' && payload?.roomCode === room.roomCode;
}

function playerActionMatches(state, payload) {
  const extraRollAllowed = payload.extraRollAllowed === true;
  return payload.previousTurnId === state.turnId && payload.turnId === state.turnId + (extraRollAllowed ? 1 : 0) &&
    payload.currentTurn === state.currentTurn && payload.activePlayerId === state.activePlayerId &&
    payload.round === state.round && payload.phase === 'PLAYER_ACTION' &&
    payload.consecutiveDoubles === (extraRollAllowed ? state.consecutiveDoubles : 0) &&
    (!extraRollAllowed || (state.lastRoll?.isDouble === true && state.consecutiveDoubles > 0 && state.consecutiveDoubles < 3));
}

export function initPropertyResolutionSync({client, store, getActiveRoom, logger = console}) {
  const removers = [
    client.on('game:property-offer', payload => {
      const room = getActiveRoom?.();
      const state = store.getState();
      const player = state.getPlayerById(payload?.playerId);
      const property = store.getProperty(payload?.propertyPos);
      const valid = roomMatches(payload, room) && state.phase === 'WAITING_TILE_RESOLUTION' &&
        Number.isInteger(payload.turnId) && payload.turnId === state.turnId &&
        payload.playerId === state.activePlayerId && player && player.seat === payload.seat &&
        player.pos === payload.propertyPos && property && ['prop', 'rail', 'util'].includes(property.type) &&
        property.owner === null && property.id === payload.propertyId && property.name === payload.propertyName &&
        property.price === payload.price && player.money === payload.balance &&
        typeof payload.resolutionId === 'string' && payload.resolutionId.length > 0 &&
        payload.phase === 'WAITING_PROPERTY_DECISION';
      if (!valid || !store.applyPropertyOffer({...payload})) {
        logger.warn?.('Penawaran properti diabaikan karena room, giliran, atau datanya tidak cocok.');
        return false;
      }
      return true;
    }),
    client.on('game:tile-resolution-unsupported', payload => {
      const room = getActiveRoom?.();
      const state = store.getState();
      const player = state.getPlayerById(payload?.playerId);
      const valid = roomMatches(payload, room) && state.phase === 'WAITING_TILE_RESOLUTION' &&
        payload.turnId === state.turnId && payload.playerId === state.activePlayerId &&
        player?.seat === payload.seat && player.pos === payload.position &&
        payload.movementId === store.lastMovementId &&
        typeof payload.resolutionId === 'string' && payload.resolutionId.length > 0 &&
        typeof payload.tileName === 'string' && typeof payload.tileType === 'string' &&
        payload.phase === 'WAITING_TILE_RESOLUTION' && typeof payload.message === 'string';
      if (!valid || !store.applyUnsupportedTile({...payload})) {
        logger.warn?.('Status resolusi petak diabaikan karena room atau giliran tidak cocok.');
        return false;
      }
      return true;
    }),
    client.on('game:tile-resolution-complete', payload => {
      const room = getActiveRoom?.();
      const state = store.getState();
      const player = state.getPlayerById(payload?.playerId);
      const sharedValid = roomMatches(payload, room) && state.phase === 'WAITING_TILE_RESOLUTION' &&
        payload.previousTurnId === state.turnId && payload.movementId === store.lastMovementId &&
        payload.playerId === state.activePlayerId && player?.seat === payload.seat &&
        payload.landedPosition === player.pos && Number.isInteger(payload.resultingPosition) &&
        Number.isFinite(payload.balance) && typeof payload.resolutionId === 'string' &&
        payload.resolutionId.length > 0 && typeof payload.message === 'string' &&
        playerActionMatches(state, payload);
      let outcomeValid = false;
      if (payload?.kind === 'TAX_PAID') {
        outcomeValid = [4, 38].includes(payload.landedPosition) && Number.isInteger(payload.taxAmount) &&
          payload.taxAmount > 0 && player?.money - payload.taxAmount === payload.balance &&
          payload.resultingPosition === payload.landedPosition && payload.status === player?.status &&
          payload.inJail === (player?.inJail === true) && payload.transaction?.type === 'TAX' &&
          payload.transaction?.amount === payload.taxAmount && payload.transaction?.id === `tx_${payload.resolutionId}`;
      } else if (payload?.kind === 'START') {
        outcomeValid = payload.landedPosition === 0 && payload.resultingPosition === 0 && player?.pos === 0 &&
          payload.balance === player?.money && payload.status === player?.status &&
          payload.inJail === (player?.inJail === true) && payload.taxAmount === null && payload.transaction === null;
      } else if (payload?.kind === 'JAIL_VISIT') {
        outcomeValid = payload.landedPosition === 10 && payload.resultingPosition === 10 &&
          payload.balance === player?.money && payload.status === player?.status &&
          payload.inJail === (player?.inJail === true) && player?.status !== 'IN_JAIL';
      } else if (payload?.kind === 'JAILED') {
        outcomeValid = payload.landedPosition === 30 && payload.resultingPosition === 10 &&
          payload.balance === player?.money && payload.status === 'IN_JAIL' && payload.inJail === true &&
          payload.jailTurns === 0;
      } else if (payload?.kind === 'FREE_PARKING') {
        outcomeValid = payload.landedPosition === 20 && payload.resultingPosition === 20 &&
          payload.balance === player?.money && payload.status === player?.status &&
          payload.inJail === (player?.inJail === true) && payload.taxAmount === null && payload.transaction === null;
      } else if (payload?.kind === 'OWN_PROPERTY') {
        const property = store.getProperty(payload.landedPosition);
        outcomeValid = property?.owner === player?.playerId && payload.resultingPosition === payload.landedPosition &&
          player?.pos === payload.landedPosition && payload.balance === player?.money &&
          payload.status === player?.status && payload.inJail === (player?.inJail === true) &&
          payload.taxAmount === null && payload.transaction === null;
      }
      if (!sharedValid || !outcomeValid || !store.applyTileResolution({...payload})) {
        logger.warn?.('Hasil resolusi petak diabaikan karena room, giliran, atau datanya tidak cocok.');
        return false;
      }
      return true;
    }),
    client.on('game:jail-penalty', payload => {
      const room = getActiveRoom?.();
      const state = store.getState();
      const player = state.getPlayerById(payload?.playerId);
      const expectedNext = (state.currentTurn + 1) % state.players.length;
      const expectedRound = expectedNext === 0 ? state.round + 1 : state.round;
      const valid = roomMatches(payload, room) && state.phase === 'JAILING' &&
        payload.previousTurnId === state.turnId && payload.playerId === state.activePlayerId &&
        player?.seat === payload.seat && payload.previousPosition === player.pos &&
        state.lastRoll?.tripleDouble === true && state.consecutiveDoubles === 3 &&
        payload.kind === 'THREE_DOUBLES_JAIL' && payload.resultingPosition === 10 &&
        payload.status === 'IN_JAIL' && payload.inJail === true && payload.jailTurns === 0 &&
        payload.consecutiveDoubles === 0 && typeof payload.resolutionId === 'string' &&
        payload.turnId === state.turnId + 1 && payload.currentTurn === expectedNext &&
        payload.activePlayerId === state.players[expectedNext]?.playerId && payload.round === expectedRound &&
        payload.phase === 'WAITING_ROLL' && typeof payload.message === 'string';
      if (!valid || !store.applyJailPenalty({...payload})) {
        logger.warn?.('Hukuman tiga kali dobel diabaikan karena room, giliran, atau datanya tidak cocok.');
        return false;
      }
      return true;
    }),
    client.on('game:property-resolution-complete', payload => {
      const room = getActiveRoom?.();
      const state = store.getState();
      const pending = store.pendingResolution;
      const player = state.getPlayerById(payload?.playerId);
      const property = pending ? store.getProperty(pending.propertyPos) : null;
      const purchased = payload?.decision === 'BUY';
      const expectedBalance = player && (purchased ? player.money - pending?.price : player.money);
      const valid = roomMatches(payload, room) && pending && player && property &&
        payload.resolutionId === pending.resolutionId && payload.previousTurnId === state.turnId &&
        payload.playerId === state.activePlayerId && pending.playerId === payload.playerId &&
        Number.isInteger(payload.turnId) && Number.isInteger(payload.currentTurn) &&
        Number.isInteger(payload.round) && payload.activePlayerId === state.players[payload.currentTurn]?.playerId &&
        payload.phase === 'PLAYER_ACTION' && payload.balance === expectedBalance &&
        playerActionMatches(state, payload) &&
        (purchased
          ? property.owner === null && payload.property?.id === property.id && payload.property?.pos === property.pos &&
            payload.property?.owner === player.playerId && payload.transaction?.amount === property.price &&
            payload.transaction?.type === 'BUY_PROP'
          : payload.decision === 'DECLINE' && payload.property === null && payload.transaction === null);
      if (!valid || !store.applyPropertyResolution({...payload})) {
        logger.warn?.('Hasil keputusan properti diabaikan karena data resolusi tidak cocok.');
        return false;
      }
      return true;
    })
  ];

  return () => removers.forEach(remove => remove());
}
