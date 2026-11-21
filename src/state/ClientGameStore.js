import {gameState, PlayerStatus} from '../logic/GameState.js';
import {getMortgageEligibility, getUnmortgageEligibility} from '../logic/mortgage.js';
import {BAIL_COST} from '../logic/jailRules.js';

function playerActionCompletionMatches(state, payload) {
  const extraRollAllowed = payload?.extraRollAllowed === true;
  const active = state.players[state.currentTurn];
  return payload?.previousTurnId === state.turnId &&
    payload.turnId === state.turnId + (extraRollAllowed ? 1 : 0) &&
    payload.currentTurn === state.currentTurn && payload.activePlayerId === state.activePlayerId &&
    payload.activePlayerId === active?.playerId && payload.round === state.round &&
    payload.phase === 'PLAYER_ACTION' && payload.consecutiveDoubles ===
      (extraRollAllowed ? state.consecutiveDoubles : 0) &&
    (!extraRollAllowed || (state.lastRoll?.isDouble === true && state.lastRoll?.jailAttempt !== true &&
      active?.status !== PlayerStatus.IN_JAIL && active?.inJail !== true &&
      state.consecutiveDoubles > 0 && state.consecutiveDoubles < 3));
}

/** Read facade over a GameState instance; no UI or engine objects are stored here. */
export class ClientGameStore {
  constructor(state = gameState) {
    this.state = state;
    this.listeners = new Set();
    this.revision = 0;
    this.appliedMovementIds = new Set();
    this.pendingBalancePresentations = new Map();
    this.presentation = {movement: null, movements: new Map(), chancePending: false, rentPending: false};
    this.diceAnimation = null;
    this.pendingResolution = null;
    this.lastMovementId = null;
    this.unsupportedTile = null;
    this.appliedTileResolutionIds = new Set();
    this.appliedChanceResolutionIds = new Set();
    this.appliedRentResolutionIds = new Set();
    this.appliedPropertyFinanceResolutionIds = new Set();
    this.chanceResolution = null;
    this.pendingChancePresentation = null;
    this.pendingDebt = null;
    this.roomCode = null;
    this.activeAuction = null;
    this.lastAuctionResult = null;
    this.trades = new Map();
    this.appliedBuildingActionIds = new Set();
    this.appliedJailActionIds = new Set();
    this.appliedFreeParkingActionIds = new Set();
    this.appliedTurnEndActionIds = new Set();
    this.pendingFreeParkingDecision = null;
    this.extraRollAvailable = false;
    this._observedTurnKey = this._currentTurnKey();
  }

  getState() { return this.state; }
  getPlayers() { return this.state.players; }
  getPlayer(playerId) { return this.state.getPlayerById(playerId); }
  getPlayerAtIndex(index) { return this.state.players[index] || null; }
  getPlayerIndex(playerId) { return this.state.getPlayerIndexById(playerId); }
  getSeat(playerId) { return this.state.getSeatByPlayerId(playerId); }
  getCurrentTurn() { return this.state.currentTurn; }
  getActivePlayer() { return this.state.getActivePlayer(); }
  getPhase() { return this.state.phase; }
  getGameStatus() { return this.state.gameStatus; }
  getRound() { return this.state.round; }
  getExtraRollAvailable() { return this.extraRollAvailable; }
  getBalance(playerId) { return this.getPlayer(playerId)?.money ?? null; }
  getDisplayedBalance(playerId) {
    const balance = this.getBalance(playerId);
    if (balance === null) return null;
    const pendingDelta = [...this.pendingBalancePresentations.values()]
      .filter(item => item.playerId === playerId)
      .reduce((total, item) => total + item.delta, 0);
    return balance - pendingDelta;
  }
  _queueBalancePresentation(movementId, playerId, delta, kind, id = `${movementId}:${kind}`) {
    if (!movementId || !Number.isFinite(delta) || delta === 0) return false;
    const movement = this.presentation.movements.get(movementId);
    if (movement?.status !== 'ANIMATING') return false;
    this.pendingBalancePresentations.set(id, {movementId, playerId, delta, kind});
    return true;
  }
  presentMovementBalance(movementId, kind) {
    let changed = false;
    for (const [id, item] of this.pendingBalancePresentations) {
      if (item.movementId === movementId && (!kind || item.kind === kind)) {
        this.pendingBalancePresentations.delete(id);
        changed = true;
      }
    }
    if (changed) this.notify({type: 'balance-presentation-complete', detail: {movementId, kind}});
    return changed;
  }
  getProperty(pos) { return this.state.properties.get(pos) || null; }
  getProperties() { return Array.from(this.state.properties.values()); }
  getSnapshot() { return this.state.toSnapshot(); }

  _restoreSnapshot(snapshot) {
    if (!snapshot || (snapshot.roomCode === this.roomCode && snapshot.turnId < this.state.turnId)) return false;
    this.state.restoreSnapshot(snapshot);
    this.extraRollAvailable = snapshot.extraRollAvailable === true;
    this.lastMovementId = snapshot.pendingChancePresentation?.event?.movementId || snapshot.lastRoll?.movementId || null;
    return true;
  }

  _currentTurnKey() { return `${this.state.turnId}:${this.state.activePlayerId}`; }

  setSnapshot(snapshot) {
    if (!snapshot || (snapshot.roomCode === this.roomCode && snapshot.turnId < this.state.turnId)) return false;
    this.state.restoreSnapshot(snapshot);
    this.roomCode = snapshot?.roomCode || null;
    this.extraRollAvailable = snapshot?.extraRollAvailable === true;
    this.pendingFreeParkingDecision = snapshot?.pendingFreeParkingDecision ? {...snapshot.pendingFreeParkingDecision} : null;
    this._observedTurnKey = this._currentTurnKey();
    this.diceAnimation?.resolve?.();
    this.diceAnimation = null;
    this.presentation = {movement: null, movements: new Map(), chancePending: false, rentPending: false};
    this.pendingBalancePresentations.clear();
    this.lastMovementId = snapshot.pendingChancePresentation?.event?.movementId || snapshot.lastRoll?.movementId || null;
    this.unsupportedTile = null;
    this.chanceResolution = null;
    this.pendingResolution = snapshot?.pendingPropertyOffer ? {...snapshot.pendingPropertyOffer} : null;
    this.pendingDebt = snapshot?.pendingDebt ? {...snapshot.pendingDebt} : null;
    this.pendingChancePresentation = snapshot?.pendingChancePresentation ? structuredClone(snapshot.pendingChancePresentation) : null;
    this.activeAuction = snapshot?.activeAuction ? structuredClone(snapshot.activeAuction) : null;
    this.lastAuctionResult = null;
    this.trades = new Map((Array.isArray(snapshot?.trades) ? snapshot.trades : []).map(trade =>
      [trade.tradeId, structuredClone(trade)]));
    this.notify({type: 'snapshot', detail: {recovered: true, pendingChancePresentation: this.pendingChancePresentation}});
    return true;
  }

  applyTurnEnded(event) {
    const snapshot = event?.snapshot;
    const actionId = event?.actionId;
    if (!event || typeof actionId !== 'string' || !actionId || this.appliedTurnEndActionIds.has(actionId) ||
        event.roomCode !== this.roomCode || snapshot?.roomCode !== this.roomCode ||
        this.state.gameStatus !== 'IN_GAME' || this.state.phase !== 'PLAYER_ACTION' ||
        event.previousPlayerId !== this.state.activePlayerId || event.previousTurnId !== this.state.turnId ||
        event.turnId !== this.state.turnId + 1 || !Number.isInteger(snapshot.currentTurn) ||
        snapshot.currentTurn < 0 || snapshot.currentTurn >= this.state.players.length ||
        snapshot.turnId !== event.turnId || snapshot.activePlayerId !== event.activePlayerId ||
        snapshot.players?.[snapshot.currentTurn]?.playerId !== event.activePlayerId ||
        snapshot.phase !== event.phase || snapshot.gameStatus !== event.gameStatus ||
        snapshot.round !== event.round || snapshot.extraRollAvailable !== false ||
        !['WAITING_ROLL', 'GAME_OVER'].includes(snapshot.phase) ||
        !Array.isArray(snapshot.players) || snapshot.players.length !== this.state.players.length ||
        snapshot.players.some((player, seat) => player.playerId !== this.state.players[seat]?.playerId)) return false;
    if (snapshot.phase === 'GAME_OVER') {
      if (snapshot.gameStatus !== 'FINISHED' || event.winner?.playerId !== event.activePlayerId) return false;
    } else if (snapshot.gameStatus !== 'IN_GAME' || event.winner !== null) return false;
    if (!this._restoreSnapshot(snapshot)) return false;
    this.appliedTurnEndActionIds.add(actionId);
    this.extraRollAvailable = false;
    this.pendingResolution = snapshot.pendingPropertyOffer ? {...snapshot.pendingPropertyOffer} : null;
    this.pendingDebt = snapshot.pendingDebt ? {...snapshot.pendingDebt} : null;
    this.pendingChancePresentation = snapshot.pendingChancePresentation ? structuredClone(snapshot.pendingChancePresentation) : null;
    this.pendingFreeParkingDecision = snapshot.pendingFreeParkingDecision ? {...snapshot.pendingFreeParkingDecision} : null;
    this.activeAuction = snapshot.activeAuction ? structuredClone(snapshot.activeAuction) : null;
    this.unsupportedTile = null;
    this.chanceResolution = null;
    this.lastMovementId = null;
    this.presentation = {movement: null, movements: new Map(), chancePending: false, rentPending: false};
    this.pendingBalancePresentations.clear();
    this.notify({type: 'turn-ended', detail: {...event, duplicate: false}});
    return true;
  }

  applyTradeEvent(payload) {
    const trade = payload?.trade;
    const validStatuses = new Set(['PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED', 'INVALIDATED']);
    if (!payload || payload.roomCode !== this.roomCode || payload.snapshot?.roomCode !== this.roomCode ||
        !trade || trade.roomCode !== this.roomCode || typeof trade.tradeId !== 'string' ||
        !validStatuses.has(trade.status) || payload.type !== trade.status || trade.fromPlayerId === trade.toPlayerId ||
        !trade.offer || !Array.isArray(trade.offer.givePropPositions) || !Array.isArray(trade.offer.receivePropPositions)) return false;
    const prior = this.trades.get(trade.tradeId);
    if (prior?.status === trade.status) return false;
    if (prior && (prior.status !== 'PENDING' || !['COMPLETED', 'REJECTED', 'CANCELLED', 'INVALIDATED'].includes(trade.status))) return false;
    if (!prior && trade.status !== 'PENDING') return false;
    const from = this.getPlayer(trade.fromPlayerId), to = this.getPlayer(trade.toPlayerId);
    if (!from || !to || from.status === PlayerStatus.BANKRUPT || to.status === PlayerStatus.BANKRUPT) return false;
    if (trade.status === 'COMPLETED') {
      const {giveMoney = 0, receiveMoney = 0, giveJailCards = 0, receiveJailCards = 0,
        givePropPositions, receivePropPositions} = trade.offer;
      const snapshot = payload.snapshot;
      const players = new Map(snapshot.players?.map(player => [player.playerId, player]) || []);
      const fromAfter = players.get(from.playerId), toAfter = players.get(to.playerId);
      if (!fromAfter || !toAfter || fromAfter.money !== from.money - giveMoney + receiveMoney ||
          toAfter.money !== to.money - receiveMoney + giveMoney ||
          fromAfter.hasGetOutOfJailCard !== (from.hasGetOutOfJailCard || 0) - giveJailCards + receiveJailCards ||
          toAfter.hasGetOutOfJailCard !== (to.hasGetOutOfJailCard || 0) - receiveJailCards + giveJailCards ||
          !Array.isArray(snapshot.properties) || !Array.isArray(snapshot.transactions)) return false;
      const properties = new Map(snapshot.properties);
      if (givePropPositions.some(position => properties.get(position)?.owner !== to.playerId) ||
          receivePropPositions.some(position => properties.get(position)?.owner !== from.playerId)) return false;
      if ((giveMoney > 0 && !snapshot.transactions.some(tx => tx.id === `tx_${trade.tradeId}_give` && tx.amount === giveMoney && tx.type === 'TRADE')) ||
          (receiveMoney > 0 && !snapshot.transactions.some(tx => tx.id === `tx_${trade.tradeId}_receive` && tx.amount === receiveMoney && tx.type === 'TRADE'))) return false;
      if (!this._restoreSnapshot(snapshot)) return false;
      this.pendingDebt = snapshot.pendingDebt ? {...snapshot.pendingDebt} : null;
    }
    this.trades.set(trade.tradeId, structuredClone(trade));
    this.notify({type: trade.status === 'COMPLETED' ? 'trade-completed' : 'trade-updated',
      detail: {type: payload.type, trade: structuredClone(trade), duplicate: payload.duplicate === true}});
    return true;
  }

  applyAuctionEvent(payload, type) {
    if (!payload || payload.roomCode !== this.roomCode || !payload.snapshot ||
        payload.snapshot.roomCode !== this.roomCode || !['STARTED', 'UPDATED', 'ENDED'].includes(type)) return false;
    if (type === 'STARTED') {
      const auction = payload.auction;
      const pending = this.pendingResolution;
      const property = pending ? this.getProperty(pending.propertyPos) : null;
      if (this.state.phase !== 'WAITING_PROPERTY_DECISION' || !pending || !property ||
          pending.resolutionId !== auction?.resolutionId || pending.turnId !== this.state.turnId ||
          pending.playerId !== this.state.activePlayerId || property.owner !== null ||
          auction?.turnId !== this.state.turnId || auction?.propertyPos !== pending.propertyPos ||
          !Array.isArray(auction.activeBidders) || !auction.activeBidders.length ||
          auction.currentBidderId !== auction.activeBidders[0]?.playerId ||
          payload.snapshot.phase !== 'WAITING_AUCTION_ACTION') return false;
      this.activeAuction = structuredClone(auction);
      this.state.phase = 'WAITING_AUCTION_ACTION';
      this.notify({type: 'auction-started', detail: structuredClone(auction)});
      return true;
    }
    if (type === 'UPDATED') {
      const auction = payload.auction;
      if (!this.activeAuction || this.state.phase !== 'WAITING_AUCTION_ACTION' ||
          auction?.auctionId !== this.activeAuction.auctionId || auction.turnId !== this.state.turnId ||
          !Number.isInteger(auction.revision) || auction.revision <= this.activeAuction.revision ||
          !Array.isArray(auction.activeBidders) || auction.currentBidderId !==
            auction.activeBidders[auction.currentBidderIndex]?.playerId || payload.snapshot.phase !== 'WAITING_AUCTION_ACTION') return false;
      this.activeAuction = structuredClone(auction);
      this.notify({type: 'auction-updated', detail: structuredClone(auction)});
      return true;
    }
    const current = this.activeAuction;
    const result = payload;
    if (!current || this.state.phase !== 'WAITING_AUCTION_ACTION' || result.auctionId !== current.auctionId ||
        result.previousTurnId !== this.state.turnId || payload.snapshot.activeAuction !== null ||
        !playerActionCompletionMatches(this.state, result) || !Array.isArray(payload.snapshot.players) ||
        !Array.isArray(payload.snapshot.properties) || !Array.isArray(payload.snapshot.transactions)) return false;
    const propertyEntry = payload.snapshot.properties.find(([position]) => position === current.propertyPos);
    const expectedOwner = result.winner?.playerId || null;
    if (!propertyEntry || propertyEntry[1]?.owner !== expectedOwner ||
        (expectedOwner && (!result.transaction || result.transaction.type !== 'AUCTION' ||
          result.transaction.amount !== result.amount || !payload.snapshot.transactions.some(tx => tx.id === result.transaction.id)))) return false;
    if (!this._restoreSnapshot(payload.snapshot)) return false;
    this.pendingResolution = null;
    this.activeAuction = null;
    this.lastAuctionResult = structuredClone(result);
    this.presentation = {movement: null, movements: new Map(), chancePending: false, rentPending: false};
    this.pendingBalancePresentations.clear();
    this.notify({type: 'auction-ended', detail: structuredClone(result)});
    return true;
  }

  applyDiceResult({die1, die2, total, phase, turnId, playerId, consecutiveDoubles = 0, tripleDouble = false,
    jailAttempt = false, jailReleased = false}) {
    this.state.lastRoll = {dice: [die1, die2], total, isDouble: die1 === die2, consecutiveDoubles, tripleDouble,
      ...(jailAttempt ? {jailAttempt: true, jailReleased} : {})};
    this.state.phase = phase;
    this.state.turnId = turnId;
    this.state.activePlayerId = playerId;
    this.extraRollAvailable = false;
    const player = this.getPlayer(playerId);
    if (player) player.consecutiveDoubles = consecutiveDoubles;
    this.state.consecutiveDoubles = consecutiveDoubles;
    this.notify({type: 'dice-rolled', detail: {die1, die2, total, phase, turnId, playerId, consecutiveDoubles, tripleDouble, jailAttempt, jailReleased}});
  }

  applyFreeParkingDecision(event) {
    const player = this.getPlayer(event?.playerId);
    const id = event?.actionId;
    const pending = this.pendingFreeParkingDecision;
    if (!event || event.roomCode !== this.roomCode || !player || typeof id !== 'string' || !id ||
        this.appliedFreeParkingActionIds.has(id) || !pending || pending.playerId !== event.playerId ||
        pending.turnId !== event.turnId || this.state.turnId !== event.turnId || this.state.activePlayerId !== event.playerId ||
        this.state.phase !== 'WAITING_ROLL' || player.pos !== 20) return false;
    if (event.outcome === 'STAY') {
      const snapshot = event.snapshot;
      if (event.action !== 'STAY' || event.balance !== player.money || snapshot?.pendingFreeParkingDecision !== null ||
          snapshot?.turnId !== this.state.turnId || snapshot?.activePlayerId !== event.playerId || snapshot?.phase !== 'WAITING_ROLL' ||
          snapshot.players?.[snapshot.currentTurn]?.pos !== 20) return false;
      if (!this._restoreSnapshot(snapshot)) return false;
      this.pendingFreeParkingDecision = null;
    } else if (event.outcome === 'TRAVEL_STARTED') {
      const expectedSteps = event.targetPos > 20 ? event.targetPos - 20 : event.targetPos + 20;
      if (event.action !== 'TRAVEL' || event.startPos !== 20 || event.targetPos === 20 ||
          !Number.isInteger(event.targetPos) || event.steps !== expectedSteps || event.cost !== 50 || event.phase !== 'MOVING') return false;
      this.pendingFreeParkingDecision = null;
      this.state.lastRoll = {dice: [], total: event.steps, isDouble: false, consecutiveDoubles: 0,
        tripleDouble: false, movementType: 'FREE_PARKING_TRAVEL', travelActionId: id};
      this.state.phase = 'MOVING';
    } else return false;
    this.appliedFreeParkingActionIds.add(id);
    this.notify({type: 'free-parking-decision-resolved', detail: {...event}});
    return true;
  }

  applyJailResolution(event) {
    const snapshot = event?.snapshot;
    const id = event?.actionId;
    const player = this.getPlayer(event?.playerId);
    const after = snapshot?.players?.find(candidate => candidate.playerId === event?.playerId);
    if (!event || event.roomCode !== this.roomCode || !snapshot || snapshot.roomCode !== this.roomCode ||
        !player || !after || typeof id !== 'string' || !id || this.appliedJailActionIds.has(id) ||
        !Array.isArray(snapshot.transactions) || !Array.isArray(snapshot.players)) return false;
    const action = event.action;
    if (action === 'PAY_BAIL' || action === 'USE_CARD') {
      if (this.state.phase !== 'WAITING_ROLL' || this.state.turnId !== event.turnId || this.state.activePlayerId !== event.playerId ||
          player.status !== PlayerStatus.IN_JAIL || after.status !== PlayerStatus.ACTIVE || after.inJail !== false ||
          after.jailTurns !== 0 || after.money !== player.money - (action === 'PAY_BAIL' ? BAIL_COST : 0) ||
          after.hasGetOutOfJailCard !== (player.hasGetOutOfJailCard || 0) - (action === 'USE_CARD' ? 1 : 0) ||
          (action === 'PAY_BAIL' && !snapshot.transactions.some(tx => tx.id === `tx_jail_action_${id}` && tx.type === 'BAIL' && tx.amount === BAIL_COST))) return false;
    } else if (event.outcome === 'DOUBLE' || event.outcome === 'FORCED_BAIL') {
      if (this.state.phase !== 'MOVING' || this.state.turnId !== event.previousTurnId || this.state.activePlayerId !== event.playerId ||
          !this.state.lastRoll?.jailAttempt || after.status !== PlayerStatus.ACTIVE || after.inJail !== false || after.jailTurns !== 0 ||
          after.pos !== player.pos || (event.outcome === 'FORCED_BAIL' && (after.money !== player.money - BAIL_COST ||
            !snapshot.transactions.some(tx => tx.id === `tx_jail_roll_${id}` && tx.type === 'BAIL' && tx.amount === BAIL_COST))) ||
          (event.outcome === 'DOUBLE' && after.money !== player.money)) return false;
    } else if (event.outcome === 'FAILED') {
      if (this.state.phase !== 'JAIL_ATTEMPT' || this.state.turnId !== event.previousTurnId ||
          this.state.activePlayerId !== event.playerId || after.status !== PlayerStatus.IN_JAIL || after.inJail !== true ||
          after.jailTurns !== player.jailTurns + 1 || after.money !== player.money ||
          snapshot.turnId !== this.state.turnId + 1 || snapshot.activePlayerId !== snapshot.players[snapshot.currentTurn]?.playerId) return false;
    } else return false;
    this.appliedJailActionIds.add(id);
    if (!this._restoreSnapshot(snapshot)) return false;
    this.pendingDebt = snapshot.pendingDebt ? {...snapshot.pendingDebt} : null;
    this.notify({type: 'jail-action-resolved', detail: {...event}});
    return true;
  }

  beginDiceAnimation(turnId) {
    if (this.diceAnimation?.turnId === turnId) return this.diceAnimation.promise;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    this.diceAnimation = {turnId, promise, resolve, complete: false};
    return promise;
  }

  completeDiceAnimation(turnId) {
    const animation = this.diceAnimation;
    if (!animation || animation.turnId !== turnId || animation.complete) return false;
    animation.complete = true;
    animation.resolve();
    this.notify({type: 'dice-animation-complete', detail: {turnId}});
    return true;
  }

  waitForDiceAnimation(turnId) {
    const animation = this.diceAnimation;
    return animation?.turnId === turnId ? animation.promise : Promise.resolve();
  }

  applyPlayerMovement(movement) {
    if (this.appliedMovementIds.has(movement.movementId)) return false;
    const player = this.getPlayer(movement.playerId);
    if (!player) return false;
    this.appliedMovementIds.add(movement.movementId);
    this.lastMovementId = movement.movementId;
    player.pos = movement.endPos;
    player.money = movement.balance;
    if (movement.movementType === 'FREE_PARKING_TRAVEL') {
      for (const tx of movement.transactions || []) if (!this.state.transactions.some(existing => existing.id === tx.id)) {
        this.state.transactions.push({...tx, players: [...tx.players]});
      }
      if (this.state.lastRoll?.movementType === 'FREE_PARKING_TRAVEL') this.state.lastRoll.total = null;
    }
    this.state.phase = movement.phase;
    this.presentation.movement = {movementId: movement.movementId, status: 'ANIMATING'};
    this.presentation.movements.set(movement.movementId, this.presentation.movement);
    if (movement.startBonus > 0) this._queueBalancePresentation(movement.movementId, player.playerId,
      movement.startBonus, 'start');
    this.notify({type: 'player-moved', detail: {...movement}});
    return true;
  }

  completeMovement(movementId) {
    const active = this.presentation.movements.get(movementId);
    if (!active || active.status !== 'ANIMATING') return false;
    active.status = 'COMPLETE';
    this.presentMovementBalance(movementId);
    if (this.presentation.movement?.movementId === movementId) {
      this.presentation.movement = [...this.presentation.movements.values()].find(item => item.status === 'ANIMATING') || active;
    }
    this.notify({type: 'movement-animation-complete', detail: {movementId}});
    return true;
  }

  applyPropertyOffer(offer) {
    if (this.pendingResolution || this.state.phase !== 'WAITING_TILE_RESOLUTION') return false;
    this.pendingResolution = {...offer};
    this.state.phase = 'WAITING_PROPERTY_DECISION';
    this.unsupportedTile = null;
    this.notify({type: 'property-offer', detail: {...offer}});
    return true;
  }

  applyChanceResolution(event) {
    const presentation = this.pendingChancePresentation;
    const resolutionKey = event?.presentationId || event?.resolutionId;
    if (!event || this.state.phase !== 'CHANCE_PRESENTATION' || event.previousTurnId !== this.state.turnId ||
        event.playerId !== this.state.activePlayerId || (event.sourceMovementId || event.movementId) !== this.lastMovementId ||
        typeof event.resolutionId !== 'string' || !presentation || presentation.presentationId !== event.presentationId ||
        presentation.event?.playerId !== event.playerId || this.appliedChanceResolutionIds.has(resolutionKey)) return false;
    const player = this.getPlayer(event.playerId);
    if (Array.isArray(event.movements) && event.movements.length) {
      if (!player || player.seat !== event.seat || player.pos !== event.initialPosition ||
          !Number.isInteger(event.position) || event.position < 0 || event.position > 39 ||
          !Array.isArray(event.cards) || !event.cards.length || event.card?.id !== event.cards[0]?.id ||
          !Array.isArray(event.balances)) return false;
      const balances = new Map(event.balances.map(item => [item.playerId, item.money]));
      if (balances.size !== this.state.players.length || this.state.players.some(item => !Number.isFinite(balances.get(item.playerId))) ||
          event.balance !== balances.get(player.playerId)) return false;
      let expectedPos = player.pos;
      let expectedBalance = player.money;
      const movementIds = new Set();
      for (const movement of event.movements) {
        if (!movement || movement.startPos !== expectedPos || !Number.isInteger(movement.steps) || movement.steps < 1 ||
            !['forward', 'backward'].includes(movement.direction) || typeof movement.movementId !== 'string' ||
            movementIds.has(movement.movementId)) return false;
        expectedPos = (expectedPos + (movement.direction === 'forward' ? movement.steps : -movement.steps) + 400) % 40;
        if (movement.endPos !== expectedPos || ![0, 200].includes(movement.startBonus) || !Number.isFinite(movement.balance)) return false;
        expectedBalance += movement.startBonus;
        if (movement.balance !== expectedBalance) return false;
        movementIds.add(movement.movementId);
      }
      if (expectedPos !== event.position || event.movements.at(-1).movementId === this.lastMovementId) return false;
      this.state.players.forEach(item => { item.money = balances.get(item.playerId); });
      player.pos = event.position;
      const storedJailCards = event.cards.filter(card => card?.type === 'GET_OUT_OF_JAIL').length;
      if (storedJailCards) player.hasGetOutOfJailCard = (player.hasGetOutOfJailCard || 0) + storedJailCards;
      this.lastMovementId = event.movements.at(-1).movementId;
      this.state.phase = event.destinationResolution === 'CHANCE_PRESENTATION' ? 'CHANCE_PRESENTATION' : 'WAITING_TILE_RESOLUTION';
      for (const movement of event.movements) {
        if (this.appliedMovementIds.has(movement.movementId)) continue;
        this.appliedMovementIds.add(movement.movementId);
        const presentation = {movementId: movement.movementId, status: 'ANIMATING'};
        this.presentation.movements.set(movement.movementId, presentation);
        this.presentation.movement = presentation;
        if (movement.startBonus > 0) this._queueBalancePresentation(movement.movementId, player.playerId,
          movement.startBonus, 'start');
        this.notify({type: 'player-moved', detail: {...movement, roomCode: event.roomCode, playerId: event.playerId,
          seat: event.seat, turnId: event.previousTurnId, cardMovement: true}});
      }
      for (const tx of event.transactions || []) if (!this.state.transactions.some(existing => existing.id === tx.id)) {
        this.state.transactions.push({...tx, players: [...tx.players]});
      }
      this.pendingChancePresentation = null;
      this.appliedChanceResolutionIds.add(resolutionKey);
      this.chanceResolution = {...event};
      this.notify({type: 'chance-resolved', detail: {...event}});
      return true;
    }
    if (!player || player.seat !== event.seat || player.pos !== event.position || !Array.isArray(event.balances)) return false;
    const balances = new Map(event.balances.map(item => [item.playerId, item.money]));
    if (balances.size !== this.state.players.length || this.state.players.some(item => !Number.isFinite(balances.get(item.playerId)))) return false;
    if (event.supported === true) {
        if (event.phase === 'DEBT_RESOLUTION') {
          if (!event.debt || event.debt.playerId !== player.playerId || event.debt.originResolutionId !== event.resolutionId ||
              event.debt.status !== 'OPEN' || event.debt.amount !== event.amount || event.balance !== balances.get(player.playerId) ||
              event.debt.turnId !== this.state.turnId) return false;
          this.state.players.forEach(item => { item.money = balances.get(item.playerId); });
          this.state.phase = 'DEBT_RESOLUTION';
          this.pendingDebt = {...event.debt};
          for (const tx of event.transactions || []) if (!this.state.transactions.some(existing => existing.id === tx.id)) {
            this.state.transactions.push({...tx, players: [...tx.players]});
          }
          this.unsupportedTile = null;
          this.pendingChancePresentation = null;
          this.appliedChanceResolutionIds.add(resolutionKey);
          this.appliedTileResolutionIds.add(event.resolutionId);
          this.chanceResolution = {...event};
          this.notify({type: 'chance-resolved', detail: {...event}});
          return true;
        }
      if (!playerActionCompletionMatches(this.state, event) || event.balance !== balances.get(player.playerId) ||
          event.landedPosition !== player.pos || !Array.isArray(event.transactions)) return false;
      this.state.players.forEach(item => { item.money = balances.get(item.playerId); });
      if (event.card?.type === 'GET_OUT_OF_JAIL') player.hasGetOutOfJailCard = (player.hasGetOutOfJailCard || 0) + 1;
      for (const tx of event.transactions) {
        if (!this.state.transactions.some(existing => existing.id === tx.id)) {
          this.state.transactions.push({...tx, players: [...tx.players]});
        }
      }
      this.state.currentTurn = event.currentTurn;
      this.state.round = event.round;
      this.state.turnId = event.turnId;
      this.state.activePlayerId = event.activePlayerId;
      this.state.phase = event.phase;
      this.state.lastRoll = null;
      this.state.consecutiveDoubles = event.consecutiveDoubles;
      player.consecutiveDoubles = event.consecutiveDoubles;
      this.extraRollAvailable = event.extraRollAllowed === true;
      if (!this.extraRollAvailable) player.consecutiveDoubles = 0;
      this.unsupportedTile = null;
    } else if (event.supported === false) {
      if (event.phase !== 'WAITING_TILE_RESOLUTION' || event.balance !== player.money) return false;
      this.unsupportedTile = {...event};
    } else return false;
    this.pendingChancePresentation = null;
    this.appliedTileResolutionIds.add(event.resolutionId);
    this.appliedChanceResolutionIds.add(resolutionKey);
    this.chanceResolution = {...event};
    this.notify({type: 'chance-resolved', detail: {...event}});
    return true;
  }

  applyChancePresentation(event) {
    const player = this.getPlayer(event?.playerId);
    if (event?.presentationId && this.pendingChancePresentation?.presentationId === event.presentationId) return true;
    if (!event || this.state.gameStatus !== 'IN_GAME' ||
        !['WAITING_TILE_RESOLUTION', 'CHANCE_PRESENTATION'].includes(this.state.phase) ||
        event.phase !== 'CHANCE_PRESENTATION' || event.turnId !== this.state.turnId ||
        event.previousTurnId !== this.state.turnId || event.playerId !== this.state.activePlayerId ||
        event.recipientPlayerId !== event.playerId || player?.seat !== event.seat ||
        player.pos !== event.position || event.movementId !== this.lastMovementId ||
        typeof event.resolutionId !== 'string' || typeof event.presentationId !== 'string' ||
        this.pendingChancePresentation?.presentationId === event.presentationId) return false;
    this.pendingChancePresentation = {presentationId: event.presentationId,
      event: structuredClone(event), pendingPlayerIds: [event.playerId]};
    this.state.phase = 'CHANCE_PRESENTATION';
    this.notify({type: 'chance-presented', detail: structuredClone(event)});
    return true;
  }

  applyRentResolution(event) {
    const rent = event?.rent;
    const player = this.getPlayer(event?.playerId);
    const owner = rent && this.getPlayer(rent.ownerId);
    const property = rent && this.getProperty(rent.propertyPos);
    if (!rent || !player || !owner || !property || this.state.phase !== 'WAITING_TILE_RESOLUTION' ||
        event.previousTurnId !== this.state.turnId || event.playerId !== this.state.activePlayerId ||
        event.movementId !== this.lastMovementId || player.pos !== rent.propertyPos ||
        rent.tenantId !== player.playerId || rent.tenantName !== player.name || rent.ownerName !== owner.name ||
        rent.ownerId === player.playerId || rent.ownerId !== property.owner ||
        rent.propertyId !== property.id || rent.propertyName !== property.name || rent.propertyType !== property.type ||
        typeof event.resolutionId !== 'string' || rent.resolutionId !== event.resolutionId ||
        this.appliedRentResolutionIds.has(event.resolutionId) || !Array.isArray(event.balances)) return false;
    const balances = new Map(event.balances.map(item => [item.playerId, item.money]));
    if (balances.size !== this.state.players.length || this.state.players.some(item => !Number.isFinite(balances.get(item.playerId)))) return false;

    if (rent.outcome === 'INSUFFICIENT_FUNDS') {
      if (!Number.isInteger(rent.amount) || rent.amount <= player.money || rent.tenantBalance !== player.money ||
          rent.ownerBalance !== owner.money || rent.transaction !== null || event.phase !== 'DEBT_RESOLUTION' ||
          event.turnId !== this.state.turnId || event.balance !== player.money ||
          event.debt?.playerId !== player.playerId || event.debt?.debtType !== 'RENT' ||
          event.debt?.amount !== rent.amount || event.debt?.creditorId !== owner.playerId ||
          this.state.players.some(item => balances.get(item.playerId) !== item.money)) return false;
      this.appliedRentResolutionIds.add(event.resolutionId);
      this.pendingDebt = {...event.debt};
      this.state.phase = 'DEBT_RESOLUTION';
      this.unsupportedTile = null;
      this.notify({type: 'rent-resolved', detail: {...event}});
      return true;
    }

    const mortgageWaiver = rent.outcome === 'MORTGAGED';
    if (!['PAID', 'MORTGAGED'].includes(rent.outcome) ||
        (mortgageWaiver && (rent.amount !== 0 || rent.transaction !== null)) ||
        (!mortgageWaiver && (!Number.isInteger(rent.amount) || rent.amount <= 0 ||
          rent.tenantBalance !== player.money - rent.amount || rent.ownerBalance !== owner.money + rent.amount ||
          rent.transaction?.id !== `tx_${event.resolutionId}` || rent.transaction?.type !== 'RENT' ||
          rent.transaction?.amount !== rent.amount))) return false;
    const extraRollAllowed = event.extraRollAllowed === true;
    if (!playerActionCompletionMatches(this.state, event) || event.balance !== rent.tenantBalance) return false;
    const expectedBalances = new Map(this.state.players.map(item => [item.playerId, item.money]));
    expectedBalances.set(player.playerId, rent.tenantBalance);
    expectedBalances.set(owner.playerId, rent.ownerBalance);
    if (this.state.players.some(item => balances.get(item.playerId) !== expectedBalances.get(item.playerId))) return false;

    this.appliedRentResolutionIds.add(event.resolutionId);
    this.appliedTileResolutionIds.add(event.resolutionId);
    this.state.players.forEach(item => { item.money = balances.get(item.playerId); });
    if (rent.transaction && !this.state.transactions.some(item => item.id === rent.transaction.id)) {
      this.state.transactions.push({...rent.transaction, players: [...rent.transaction.players]});
    }
    this.state.currentTurn = event.currentTurn;
    this.state.round = event.round;
    this.state.turnId = event.turnId;
    this.state.activePlayerId = event.activePlayerId;
    this.state.phase = event.phase;
    this.state.lastRoll = null;
    this.state.consecutiveDoubles = event.consecutiveDoubles;
    player.consecutiveDoubles = event.consecutiveDoubles;
    this.extraRollAvailable = extraRollAllowed;
    if (!extraRollAllowed) player.consecutiveDoubles = 0;
    this.unsupportedTile = null;
    this.notify({type: 'rent-resolved', detail: {...event}});
    return true;
  }

  applyPropertyFinanceResolution(event) {
    const player = this.getPlayer(event?.playerId);
    const property = this.getProperty(event?.propertyPos);
    if (!player || !property || !['WAITING_ROLL', 'PLAYER_ACTION'].includes(this.state.phase) ||
        event.turnId !== this.state.turnId || event.currentTurn !== this.state.currentTurn ||
        event.activePlayerId !== this.state.activePlayerId || event.playerId !== this.state.activePlayerId ||
        player.seat !== event.seat || player.name !== event.playerName || property.owner !== player.playerId ||
        event.owner !== player.playerId || event.propertyId !== property.id || event.propertyName !== property.name ||
        event.resolutionId === '' || typeof event.resolutionId !== 'string' ||
        this.appliedPropertyFinanceResolutionIds.has(event.resolutionId) ||
        event.phase !== this.state.phase || !Array.isArray(event.balances)) return false;
    const balances = new Map(event.balances.map(item => [item.playerId, item.money]));
    if (balances.size !== this.state.players.length || this.state.players.some(item => !Number.isFinite(balances.get(item.playerId)))) return false;

    let expectedAmount, transactionType, expectedStatus;
    if (event.action === 'MORTGAGE') {
      const eligibility = getMortgageEligibility(property, this.state.properties);
      if (!eligibility.success || event.statusBefore !== false || event.statusAfter !== true) return false;
      expectedAmount = eligibility.value;
      transactionType = 'MORTGAGE';
      expectedStatus = true;
    } else if (event.action === 'UNMORTGAGE') {
      const eligibility = getUnmortgageEligibility(property, this.state.properties, player.money);
      if (!eligibility.success || event.statusBefore !== true || event.statusAfter !== false) return false;
      expectedAmount = eligibility.totalCost;
      transactionType = 'UNMORTGAGE';
      expectedStatus = false;
    } else return false;

    const expectedBalance = player.money + (event.action === 'MORTGAGE' ? expectedAmount : -expectedAmount);
    const transaction = event.transaction;
    if (event.amount !== expectedAmount || event.balance !== expectedBalance ||
        transaction?.id !== `tx_${event.resolutionId}` || transaction?.type !== transactionType ||
        transaction.amount !== expectedAmount || !Array.isArray(transaction.players) ||
        transaction.players[0] !== player.name || transaction.players[1] !== 'Bank' ||
        event.property?.id !== property.id || event.property?.owner !== player.playerId ||
        event.property?.isMortgaged !== expectedStatus ||
        this.state.players.some(item => balances.get(item.playerId) !== (item.playerId === player.playerId ? expectedBalance : item.money))) return false;

    this.appliedPropertyFinanceResolutionIds.add(event.resolutionId);
    property.isMortgaged = expectedStatus;
    player.money = expectedBalance;
    if (!this.state.transactions.some(item => item.id === transaction.id)) {
      this.state.transactions.push({...transaction, players: [...transaction.players]});
    }
    this.notify({type: 'property-finance-resolved', detail: {...event}});
    return true;
  }

  applyBuildingResolution(event) {
    const player = this.getPlayer(event?.playerId);
    const property = this.getProperty(event?.propertyPos);
    const snapshot = event?.snapshot;
    if (!player || !property || !snapshot || snapshot.roomCode !== this.roomCode ||
        !['WAITING_ROLL', 'PLAYER_ACTION'].includes(this.state.phase) || event.phase !== this.state.phase ||
        snapshot.phase !== this.state.phase ||
        event.turnId !== this.state.turnId || event.currentTurn !== this.state.currentTurn ||
        event.activePlayerId !== this.state.activePlayerId || event.playerId !== this.state.activePlayerId ||
        player.seat !== event.seat || player.name !== event.playerName || property.owner !== player.playerId ||
        property.id !== event.propertyId || property.name !== event.propertyName ||
        !['BUILD_HOUSE', 'BUILD_HOTEL', 'SELL_HOUSE', 'SELL_HOTEL'].includes(event.action) ||
        typeof event.actionId !== 'string' || !event.actionId ||
        this.state.transactions.some(item => item.id === `tx_building_${event.actionId}`) ||
        !Array.isArray(snapshot.players) || !Array.isArray(snapshot.properties) || !Array.isArray(snapshot.transactions)) return false;
    const afterPlayer = snapshot.players.find(item => item.playerId === player.playerId);
    const afterProperty = new Map(snapshot.properties).get(property.pos);
    const buying = event.action === 'BUILD_HOUSE' || event.action === 'BUILD_HOTEL';
    const expectedBalance = player.money + (buying ? -event.amount : event.amount);
    const expectedHouses = event.action === 'BUILD_HOUSE' ? property.houses + 1
      : event.action === 'BUILD_HOTEL' ? 0
        : event.action === 'SELL_HOUSE' ? property.houses - 1
          : (event.bankHousesBefore >= 4 ? 4 : 0);
    const expectedHotel = event.action === 'BUILD_HOTEL' ? true
      : event.action === 'SELL_HOTEL' ? false : property.hasHotel === true;
    const transactionType = buying ? 'BUILD' : 'SELL_BUILD';
    const transaction = snapshot.transactions.find(item => item.id === `tx_building_${event.actionId}`);
    const balances = new Map(snapshot.players.map(item => [item.playerId, item.money]));
    if (!Number.isFinite(event.amount) || event.amount <= 0 || !afterPlayer || afterPlayer.money !== expectedBalance ||
        event.balance !== expectedBalance || event.bankHouses !== snapshot.bankHouses || event.bankHotels !== snapshot.bankHotels ||
        !Number.isInteger(event.bankHousesBefore) || !Number.isInteger(event.bankHotelsBefore) ||
        !Number.isInteger(snapshot.bankHouses) || snapshot.bankHouses < 0 || snapshot.bankHouses > 32 ||
        !Number.isInteger(snapshot.bankHotels) || snapshot.bankHotels < 0 || snapshot.bankHotels > 12 ||
        !afterProperty || afterProperty.owner !== player.playerId || afterProperty.houses !== expectedHouses ||
        afterProperty.hasHotel !== expectedHotel || event.property?.id !== afterProperty.id ||
        event.property?.owner !== afterProperty.owner || event.property?.houses !== afterProperty.houses ||
        event.property?.hasHotel !== afterProperty.hasHotel || event.property?.isMortgaged !== afterProperty.isMortgaged ||
        !transaction || transaction.type !== transactionType || transaction.amount !== event.amount ||
        !Array.isArray(transaction.players) || transaction.players[0] !== player.name || transaction.players[1] !== 'Bank' ||
        this.state.players.some(item => balances.get(item.playerId) !== (item.playerId === player.playerId ? expectedBalance : item.money))) return false;
    const stockDelta = event.action === 'BUILD_HOUSE' ? [-1, 0]
      : event.action === 'BUILD_HOTEL' ? [4, -1]
        : event.action === 'SELL_HOUSE' ? [1, 0]
          : [(expectedHouses === 4 ? -4 : 0), 1];
    if (event.bankHousesBefore + stockDelta[0] !== event.bankHouses ||
        event.bankHotelsBefore + stockDelta[1] !== event.bankHotels) return false;
    if ((event.action === 'BUILD_HOUSE' && (transaction.amount !== (property.housePrice || 50) || property.isMortgaged || property.houses >= 4)) ||
        (event.action === 'BUILD_HOTEL' && (transaction.amount !== (property.hotelPrice || property.housePrice || 50) || property.isMortgaged || property.houses !== 4 || property.hasHotel)) ||
        (event.action === 'SELL_HOUSE' && event.amount !== Math.floor((property.housePrice || 50) * 0.5)) ||
        (event.action === 'SELL_HOTEL' && event.amount !== Math.floor((property.hotelPrice || property.housePrice || 50) * 0.5))) return false;
    if (this.appliedBuildingActionIds.has(event.actionId)) return false;
    this.appliedBuildingActionIds.add(event.actionId);
    if (!this._restoreSnapshot(snapshot)) return false;
    this.notify({type: 'building-resolved', detail: {...event}});
    return true;
  }

  applyDebtState(payload) {
    const snapshot = payload?.snapshot;
    const debt = snapshot?.pendingDebt;
    if (!snapshot || !['IN_GAME', 'FINISHED'].includes(snapshot.gameStatus) ||
        !Array.isArray(snapshot.players) || !Array.isArray(snapshot.properties) ||
        !Number.isInteger(snapshot.turnId) || snapshot.turnId < this.state.turnId ||
        !Number.isInteger(snapshot.currentTurn) || snapshot.currentTurn < 0 || snapshot.currentTurn >= snapshot.players.length ||
        snapshot.activePlayerId !== snapshot.players[snapshot.currentTurn]?.playerId ||
        (debt && (snapshot.phase !== 'DEBT_RESOLUTION' || debt.status !== 'OPEN' ||
          debt.playerId !== snapshot.activePlayerId || !Number.isInteger(debt.amount) || debt.amount < 0)) ||
        (!debt && payload.type !== 'RESOLVED')) return false;
    if (!this._restoreSnapshot(snapshot)) return false;
    this.pendingDebt = debt ? {...debt} : null;
    this.pendingChancePresentation = snapshot.pendingChancePresentation ? structuredClone(snapshot.pendingChancePresentation) : null;
    this.unsupportedTile = null;
    this.notify({type: payload.type === 'CREATED' ? 'debt-created' : payload.type === 'UPDATED' ? 'debt-updated' : 'debt-resolved',
      detail: {...payload, pendingDebt: this.pendingDebt, pendingChancePresentation: this.pendingChancePresentation}});
    return true;
  }

  applyUnsupportedTile(tile) {
    if (this.state.phase !== 'WAITING_TILE_RESOLUTION') return false;
    if (tile.resolutionId && this.unsupportedTile?.resolutionId === tile.resolutionId) return false;
    this.unsupportedTile = {...tile};
    this.notify({type: 'tile-unsupported', detail: {...tile}});
    return true;
  }

  applyTileResolution(result) {
    const player = this.getPlayer(result.playerId);
    if (!player || this.state.phase !== 'WAITING_TILE_RESOLUTION' ||
        result.previousTurnId !== this.state.turnId || result.movementId !== this.lastMovementId ||
        typeof result.resolutionId !== 'string' || this.appliedTileResolutionIds.has(result.resolutionId)) return false;

    const extraRollAllowed = result.extraRollAllowed === true;
    if (!playerActionCompletionMatches(this.state, result)) return false;

    if (result.kind === 'TAX_PAID') {
      const tx = result.transaction;
      if (!Number.isInteger(result.taxAmount) || result.taxAmount <= 0 ||
          player.money - result.taxAmount !== result.balance || tx?.type !== 'TAX' ||
          tx.amount !== result.taxAmount || tx.id !== `tx_${result.resolutionId}` ||
          !Array.isArray(tx.players) || extraRollAllowed !== (this.state.lastRoll?.isDouble === true)) return false;
      this._queueBalancePresentation(result.movementId, player.playerId, -result.taxAmount, 'tax',
        `${result.resolutionId}:tax`);
      player.money = result.balance;
      if (!this.state.transactions.some(item => item.id === tx.id)) {
        this.state.transactions.push({...tx, players: [...tx.players]});
      }
    } else if (result.kind === 'START') {
      if (player.pos !== 0 || result.landedPosition !== 0 || result.resultingPosition !== 0 ||
          result.balance !== player.money || result.status !== player.status ||
          result.inJail !== (player.inJail === true) || result.taxAmount !== null || result.transaction !== null) return false;
    } else if (result.kind === 'JAILED') {
      if (player.pos !== 30 || result.landedPosition !== 30 || result.resultingPosition !== 10 ||
          result.status !== PlayerStatus.IN_JAIL || result.inJail !== true || result.jailTurns !== 0 ||
          result.balance !== player.money || extraRollAllowed || result.consecutiveDoubles !== 0) return false;
      player.pos = 10;
      player.status = PlayerStatus.IN_JAIL;
      player.inJail = true;
      player.jailTurns = 0;
      player.consecutiveDoubles = 0;
    } else if (result.kind === 'JAIL_VISIT') {
      if (player.pos !== 10 || result.landedPosition !== 10 || result.resultingPosition !== 10 ||
          player.status === PlayerStatus.IN_JAIL || result.status !== player.status ||
          result.inJail !== (player.inJail === true) || result.balance !== player.money ||
          extraRollAllowed !== (this.state.lastRoll?.isDouble === true)) return false;
    } else if (result.kind === 'FREE_PARKING') {
      if (player.pos !== 20 || result.landedPosition !== 20 || result.resultingPosition !== 20 ||
          result.balance !== player.money || result.taxAmount !== null || result.transaction !== null ||
          extraRollAllowed) return false;
    } else if (result.kind === 'OWN_PROPERTY') {
      const property = this.getProperty(result.landedPosition);
      if (!property || property.owner !== player.playerId || player.pos !== result.landedPosition ||
          result.resultingPosition !== result.landedPosition || result.balance !== player.money ||
          result.taxAmount !== null || result.transaction !== null || result.status !== player.status ||
          result.inJail !== (player.inJail === true) || extraRollAllowed !== (this.state.lastRoll?.isDouble === true)) return false;
    } else {
      return false;
    }

    this.appliedTileResolutionIds.add(result.resolutionId);
    this.state.currentTurn = result.currentTurn;
    this.state.round = result.round;
    this.state.turnId = result.turnId;
    this.state.activePlayerId = result.activePlayerId;
    this.state.phase = result.phase;
    this.state.lastRoll = null;
    this.state.consecutiveDoubles = result.consecutiveDoubles;
    player.consecutiveDoubles = result.consecutiveDoubles;
    this.extraRollAvailable = extraRollAllowed;
    if (!extraRollAllowed) player.consecutiveDoubles = 0;
    this.unsupportedTile = null;
    this.notify({type: 'tile-resolved', detail: {...result}});
    return true;
  }

  applyJailPenalty(event) {
    const player = this.getPlayer(event.playerId);
    const nextIndex = (this.state.currentTurn + 1) % this.state.players.length;
    const nextRound = nextIndex === 0 ? this.state.round + 1 : this.state.round;
    if (!player || this.state.phase !== 'JAILING' || event.previousTurnId !== this.state.turnId ||
        event.seat !== player.seat || event.previousPosition !== player.pos || event.resultingPosition !== 10 ||
        event.status !== PlayerStatus.IN_JAIL || event.inJail !== true || event.jailTurns !== 0 ||
        event.consecutiveDoubles !== 0 || typeof event.resolutionId !== 'string' ||
        this.appliedTileResolutionIds.has(event.resolutionId) || event.turnId !== this.state.turnId + 1 ||
        event.currentTurn !== nextIndex || event.activePlayerId !== this.state.players[nextIndex]?.playerId ||
        event.round !== nextRound || event.phase !== 'WAITING_ROLL') return false;
    player.pos = 10;
    player.status = PlayerStatus.IN_JAIL;
    player.inJail = true;
    player.jailTurns = 0;
    player.consecutiveDoubles = 0;
    this.state.consecutiveDoubles = 0;
    this.state.currentTurn = event.currentTurn;
    this.state.round = event.round;
    this.state.turnId = event.turnId;
    this.state.activePlayerId = event.activePlayerId;
    this.state.phase = event.phase;
    this.state.lastRoll = null;
    this.appliedTileResolutionIds.add(event.resolutionId);
    this.state.players[nextIndex].consecutiveDoubles = 0;
    this.notify({type: 'player-jailed', detail: {...event}});
    return true;
  }

  applyPropertyResolution(result) {
    const pending = this.pendingResolution;
    if (!pending || pending.resolutionId !== result.resolutionId ||
        pending.turnId !== result.previousTurnId || pending.playerId !== result.playerId) return false;
    const player = this.getPlayer(result.playerId);
    if (!player) return false;

    if (result.decision === 'BUY') {
      const property = this.getProperty(pending.propertyPos);
      if (!property || property.id !== pending.propertyId || property.owner !== null ||
          result.property?.owner !== player.playerId || result.property?.id !== property.id) return false;
      property.owner = player.playerId;
      if (!player.properties.includes(property.id)) player.properties.push(property.id);
      player.money = result.balance;
      if (result.transaction && !this.state.transactions.some(tx => tx.id === result.transaction.id)) {
        this.state.transactions.push({...result.transaction, players: [...result.transaction.players]});
      }
    } else if (result.decision === 'DECLINE') {
      if (result.property !== null || result.balance !== player.money) return false;
    } else {
      return false;
    }

    this.state.currentTurn = result.currentTurn;
    this.state.round = result.round;
    this.state.turnId = result.turnId;
    this.state.activePlayerId = result.activePlayerId;
    this.state.phase = result.phase;
    this.state.lastRoll = null;
    this.state.consecutiveDoubles = result.consecutiveDoubles;
    player.consecutiveDoubles = result.consecutiveDoubles;
    this.extraRollAvailable = result.extraRollAllowed === true;
    if (result.extraRollAllowed !== true) this.state.players[result.currentTurn].consecutiveDoubles = 0;
    this.pendingResolution = null;
    this.unsupportedTile = null;
    this.notify({type: 'property-resolved', detail: {...result}});
    return true;
  }

  applyTurnAdvance(event) {
    if (event.movementId !== this.lastMovementId || event.previousTurnId !== this.state.turnId ||
        this.state.phase !== 'WAITING_TILE_RESOLUTION') return false;
    const nextIndex = (this.state.currentTurn + 1) % this.state.players.length;
    const extraRollAllowed = event.extraRollAllowed === true;
    const expectedIndex = extraRollAllowed ? this.state.currentTurn : nextIndex;
    const expectedRound = extraRollAllowed ? this.state.round : (nextIndex === 0 ? this.state.round + 1 : this.state.round);
    if (event.turnId !== this.state.turnId + 1 || event.currentTurn !== expectedIndex ||
        event.activePlayerId !== this.state.players[expectedIndex]?.playerId || event.round !== expectedRound ||
        event.phase !== 'WAITING_ROLL' || event.consecutiveDoubles !== (extraRollAllowed ? this.state.consecutiveDoubles : 0)) return false;
    this.state.currentTurn = expectedIndex;
    this.state.round = event.round;
    this.state.turnId = event.turnId;
    this.state.activePlayerId = event.activePlayerId;
    this.state.phase = event.phase;
    this.state.lastRoll = null;
    this.state.consecutiveDoubles = event.consecutiveDoubles;
    if (!extraRollAllowed) this.state.players[expectedIndex].consecutiveDoubles = 0;
    this.unsupportedTile = null;
    this.notify({type: 'turn-advanced', detail: {...event}});
    return true;
  }

  notify(change = {type: 'state-changed'}) {
    const turnKey = this._currentTurnKey();
    if (turnKey !== this._observedTurnKey) {
      const active = this.getActivePlayer();
      this.pendingFreeParkingDecision = this.state.phase === 'WAITING_ROLL' && active?.pos === 20
        ? {playerId: active.playerId, turnId: this.state.turnId} : null;
      this._observedTurnKey = turnKey;
    }
    this.revision++;
    const update = {revision: this.revision, change, state: this.state};
    // Isolate listeners: one failing UI subscriber must not abort the rest, nor make an already
    // applied snapshot look failed (that broke reconnect with "snapshot tidak dapat diterapkan").
    for (const listener of [...this.listeners]) {
      try { listener(update); } catch (error) {
        console.error(`[ClientGameStore] subscriber gagal untuk perubahan "${change?.type}":`, error);
      }
    }
    return update;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Store subscriber must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Bind legacy browser events without making the store depend on window/DOM. */
  bindEvents(eventTarget) {
    if (!eventTarget?.addEventListener) return () => {};
    const events = [
      'phase:changed', 'dice:rolled', 'turn:ready', 'turn:action', 'tile:resolved',
      'economy:transaction', 'property:updated', 'property:mortgaged', 'property:unmortgaged',
      'building:updated', 'auction:started', 'auction:updated', 'auction:ended',
      'trade:completed', 'player:jailed', 'player:released', 'player:bankrupt', 'game:over'
    ];
    const handlers = new Map(events.map(type => {
      const handler = event => this.notify({type, detail: event.detail});
      eventTarget.addEventListener(type, handler);
      return [type, handler];
    }));
    return () => handlers.forEach((handler, type) => eventTarget.removeEventListener(type, handler));
  }
}

export const clientGameStore = new ClientGameStore(gameState);
