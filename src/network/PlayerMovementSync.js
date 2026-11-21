import {calculateMovement} from '../logic/movement.js';

export function initPlayerMovementSync({client, store, getActiveRoom, tileCount, logger = console}) {
  return client.on('game:player-moved', payload => {
    const room = getActiveRoom?.();
    const state = store.getState();
    const player = state.getPlayerById(payload?.playerId);
    let expected;
    try {
      expected = calculateMovement(payload?.startPos, payload?.steps, tileCount);
    } catch {
      expected = null;
    }
    const shared = room?.status === 'started' && room.roomCode === payload?.roomCode &&
      typeof payload.movementId === 'string' && payload.movementId.length > 0 &&
      (!payload.movementType || payload.movementType === 'FREE_PARKING_TRAVEL') &&
      payload.turnId === state.turnId && payload.playerId === state.activePlayerId &&
      player && player.seat === payload.seat && player.pos === payload.startPos &&
      expected?.endPos === payload.endPos && expected?.passedStart === payload.passedStart &&
      payload.startBonus === (expected?.passedStart ? 200 : 0) &&
      Number.isFinite(payload.balance) && payload.phase === 'WAITING_TILE_RESOLUTION';
    const travel = payload?.movementType === 'FREE_PARKING_TRAVEL';
    const travelTransactions = payload?.transactions;
    const expectedTravelTransactions = payload?.startBonus
      ? [{id: `tx_free_parking_${payload.travelActionId}`, type: 'PARKING_TRAVEL', amount: 50},
        {id: `tx_free_parking_${payload.travelActionId}_start`, type: 'SALARY', amount: 200}]
      : [{id: `tx_free_parking_${payload.travelActionId}`, type: 'PARKING_TRAVEL', amount: 50}];
    const travelValid = !travel || (state.phase === 'MOVING' && payload.startPos === 20 && payload.endPos !== 20 &&
      store.pendingFreeParkingDecision === null && state.lastRoll?.movementType === 'FREE_PARKING_TRAVEL' &&
      state.lastRoll.travelActionId === payload.travelActionId && state.lastRoll.total === payload.steps &&
      payload.diceTotal === payload.steps && payload.travelCost === 50 &&
      payload.balance === player.money - 50 + payload.startBonus && Array.isArray(travelTransactions) &&
      travelTransactions.length === expectedTravelTransactions.length && travelTransactions.every((tx, index) =>
        tx?.id === expectedTravelTransactions[index].id && tx.type === expectedTravelTransactions[index].type &&
        tx.amount === expectedTravelTransactions[index].amount));
    const diceValid = travel || (state.phase === 'MOVING' && state.lastRoll?.total === payload.diceTotal &&
      payload.steps === payload.diceTotal && payload.balance === player.money + payload.startBonus);
    const ordinaryTransactions = payload?.transactions || [];
    const ordinaryTransactionValid = travel || (payload.startBonus
      ? ordinaryTransactions.length === 1 && ordinaryTransactions[0]?.id === `tx_start_${payload.turnId}_${payload.movementId}` &&
        ordinaryTransactions[0]?.type === 'SALARY' && ordinaryTransactions[0]?.amount === 200
      : ordinaryTransactions.length === 0);
    const valid = shared && diceValid && travelValid && ordinaryTransactionValid;
    if (!valid) {
      logger.warn?.('Pergerakan pemain diabaikan karena room, giliran, atau datanya tidak cocok.');
      return false;
    }
    const applied = store.applyPlayerMovement({...payload});
    if (!applied) logger.warn?.('Pergerakan pemain duplikat diabaikan.');
    return applied;
  });
}
