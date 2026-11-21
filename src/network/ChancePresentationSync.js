import {CHANCE_CARDS} from '../data/cards.js';

export function initChancePresentationSync({client, store, getActiveRoom, logger = console}) {
  return client.on('game:chance-presented', payload => {
    const room = getActiveRoom?.();
    const state = store.getState();
    const player = state.getPlayerById(payload?.playerId);
    const card = CHANCE_CARDS.find(item => item.id === payload?.card?.id);
    const valid = room?.status === 'started' && room.roomCode === payload?.roomCode &&
      state.gameStatus === 'IN_GAME' && ['WAITING_TILE_RESOLUTION', 'CHANCE_PRESENTATION'].includes(state.phase) &&
      payload.phase === 'CHANCE_PRESENTATION' && payload.turnId === state.turnId &&
      payload.previousTurnId === state.turnId && payload.playerId === state.activePlayerId &&
      payload.recipientPlayerId === payload.playerId && player?.seat === payload.seat &&
      player.pos === payload.position && payload.movementId === store.lastMovementId &&
      typeof payload.resolutionId === 'string' && payload.resolutionId.length > 0 &&
      typeof payload.presentationId === 'string' && payload.presentationId.length > 0 &&
      card && card.type === payload.card.type && card.title === payload.card.title && card.desc === payload.card.desc;
    if (!valid || !store.applyChancePresentation({...payload, card: {...card}})) {
      logger.warn?.('Presentasi kartu Kesempatan diabaikan karena room, giliran, atau kartunya tidak cocok.');
      return false;
    }
    return true;
  });
}
