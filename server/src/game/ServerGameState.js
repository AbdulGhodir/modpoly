import {randomUUID} from 'node:crypto';
import {GameState, GameStatus, PlayerStatus, createGameState} from '../../../src/logic/GameStateCore.js';
import {ROOM_MAX_PLAYERS, ROOM_MIN_PLAYERS} from './constants.js';
import {initializePropertyState} from '../../../src/logic/propertyState.js';
import {loadBoardCatalog} from './loadBoardCatalog.js';
import {calculateMovement} from '../../../src/logic/movement.js';
import {ChanceDeck} from './ChanceDeck.js';
import {calculatePropertyRent} from '../../../src/logic/rent.js';
import {getMortgageEligibility, getUnmortgageEligibility, getBuildingSaleEligibility, mortgageValue} from '../../../src/logic/mortgage.js';
import {BAIL_COST, MAX_JAIL_TURNS} from '../../../src/logic/jailRules.js';

function validateRoster(roster) {
  if (!Array.isArray(roster) || roster.length < ROOM_MIN_PLAYERS || roster.length > ROOM_MAX_PLAYERS) {
    throw new Error(`Roster harus berisi ${ROOM_MIN_PLAYERS} sampai ${ROOM_MAX_PLAYERS} pemain.`);
  }
  const playerIds = roster.map(player => player?.playerId);
  if (playerIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(playerIds).size !== playerIds.length) {
    throw new Error('Setiap pemain harus memiliki playerId unik yang valid.');
  }
  if (roster.some(player => typeof player.playerName !== 'string' || !player.playerName.trim())) {
    throw new Error('Setiap pemain harus memiliki nama yang valid.');
  }
}

function validateSeats(players) {
  const seats = players.map(player => player.seat);
  if (seats.some((seat, index) => !Number.isInteger(seat) || seat !== index || seat < 0 || seat >= ROOM_MAX_PLAYERS)) {
    throw new Error('Seat snapshot harus unik, berurutan, dan berada dalam batas GameState.');
  }
}

export class ServerGameState {
  constructor({roomCode, roster, chanceDeck = new ChanceDeck(), tradeIdGenerator = randomUUID}) {
    if (typeof roomCode !== 'string' || !roomCode.trim()) throw new Error('Kode room wajib diisi.');
    validateRoster(roster);

    const snapshot = createGameState().toSnapshot();
    snapshot.players = roster.map((member, seat) => ({
      ...snapshot.players[seat],
      id: seat + 1,
      playerId: member.playerId,
      seat,
      isBot: member.isBot === true,
      name: member.playerName.trim(),
      status: PlayerStatus.ACTIVE,
      properties: [],
      money: snapshot.players[seat].money,
      pos: 0,
      jailTurns: 0,
      inJail: false,
      hasGetOutOfJailCard: 0,
      consecutiveDoubles: 0
    }));

    this.roomCode = roomCode;
    this.state = GameState.fromSnapshot(snapshot);
    initializePropertyState(this.state, loadBoardCatalog().TILES);
    validateSeats(this.state.players);
    this.state.activePlayerId = this.state.players[this.state.currentTurn]?.playerId || null;
    this._rollInProgress = false;
    this.extraRollAvailable = false;
    this.processedEndTurnActions = new Map();
    this.pendingResolution = null;
    this.activeAuction = null;
    this.processedAuctionActionIds = new Set();
    this.pendingDebt = null;
    this.pendingChanceResolution = null;
    this.pendingChancePresentation = null;
    this.completedDebts = [];
    this.chanceDeck = chanceDeck;
    this.processedChanceResolutionIds = new Set();
    this.processedChanceContinueActions = new Map();
    this.processedRentResolutionIds = new Set();
    this.processedPropertyFinanceResolutionIds = new Set();
    this.processedBuildingActionIds = new Set();
    this.processedJailActionIds = new Set();
    this.pendingFreeParkingDecision = null;
    this.processedFreeParkingActionIds = new Set();
    this.processedDebtActionIds = new Set();
    this.tradeIdGenerator = tradeIdGenerator;
    this.trades = new Map();
    this.processedTradeActions = new Map();
  }

  _tradeView(trade) {
    if (!trade) return null;
    const fromPlayer = this.state.getPlayerById(trade.fromPlayerId);
    const toPlayer = this.state.getPlayerById(trade.toPlayerId);
    return {...trade, offer: {...trade.offer,
      givePropPositions: [...trade.offer.givePropPositions],
      receivePropPositions: [...trade.offer.receivePropPositions]},
      fromPlayerName: fromPlayer?.name || trade.fromPlayerName,
      toPlayerName: toPlayer?.name || trade.toPlayerName};
  }

  _validateTradeOffer({fromPlayerId, toPlayerId, offer}) {
    const fromPlayer = this.state.getPlayerById(fromPlayerId);
    const toPlayer = this.state.getPlayerById(toPlayerId);
    if (!fromPlayer || !toPlayer) return {ok: false, code: 'PLAYER_NOT_FOUND', message: 'Pemain trade tidak ditemukan di room.'};
    if (fromPlayerId === toPlayerId) return {ok: false, code: 'SELF_TRADE', message: 'Tidak dapat berdagang dengan diri sendiri.'};
    if (this.state.gameStatus === GameStatus.FINISHED) return {ok: false, code: 'GAME_FINISHED', message: 'Permainan telah selesai.'};
    if (fromPlayer.status === PlayerStatus.BANKRUPT || toPlayer.status === PlayerStatus.BANKRUPT) {
      return {ok: false, code: 'PLAYER_INELIGIBLE', message: 'Pemain bangkrut tidak dapat berdagang.'};
    }
    if (!offer || typeof offer !== 'object' || Array.isArray(offer) ||
        Object.keys(offer).some(key => !['giveMoney', 'receiveMoney', 'givePropPositions', 'receivePropPositions', 'giveJailCards', 'receiveJailCards'].includes(key))) {
      return {ok: false, code: 'INVALID_TRADE_OFFER', message: 'Isi penawaran trade tidak valid.'};
    }
    const giveMoney = offer.giveMoney ?? 0, receiveMoney = offer.receiveMoney ?? 0;
    const giveJailCards = offer.giveJailCards ?? 0, receiveJailCards = offer.receiveJailCards ?? 0;
    const givePropPositions = offer.givePropPositions ?? [], receivePropPositions = offer.receivePropPositions ?? [];
    if (![giveMoney, receiveMoney].every(value => Number.isSafeInteger(value) && value >= 0) ||
        ![giveJailCards, receiveJailCards].every(value => Number.isInteger(value) && value >= 0) ||
        !Array.isArray(givePropPositions) || !Array.isArray(receivePropPositions) ||
        givePropPositions.length > 40 || receivePropPositions.length > 40 ||
        givePropPositions.some(position => !Number.isInteger(position) || position < 0 || position >= 40) ||
        receivePropPositions.some(position => !Number.isInteger(position) || position < 0 || position >= 40)) {
      return {ok: false, code: 'INVALID_TRADE_ASSET', message: 'Nominal atau daftar aset trade tidak valid.'};
    }
    if (!giveMoney && !receiveMoney && !givePropPositions.length && !receivePropPositions.length && !giveJailCards && !receiveJailCards) {
      return {ok: false, code: 'EMPTY_TRADE', message: 'Penawaran harus berisi setidaknya satu aset.'};
    }
    if (new Set(givePropPositions).size !== givePropPositions.length || new Set(receivePropPositions).size !== receivePropPositions.length) {
      return {ok: false, code: 'DUPLICATE_ASSET', message: 'Properti yang sama tidak boleh dicantumkan lebih dari sekali.'};
    }
    if (fromPlayer.money < giveMoney || toPlayer.money < receiveMoney) {
      return {ok: false, code: 'INSUFFICIENT_FUNDS', message: 'Saldo pemain tidak cukup untuk penawaran ini.'};
    }
    if ((fromPlayer.hasGetOutOfJailCard || 0) < giveJailCards || (toPlayer.hasGetOutOfJailCard || 0) < receiveJailCards) {
      return {ok: false, code: 'INSUFFICIENT_JAIL_CARDS', message: 'Jumlah Kartu Bebas Penjara tidak mencukupi.'};
    }
    for (const [positions, owner, ownerName] of [[givePropPositions, fromPlayer, fromPlayer.name],
      [receivePropPositions, toPlayer, toPlayer.name]]) {
      for (const position of positions) {
        const property = this.state.properties.get(position);
        if (!property || property.owner !== owner.playerId) {
          return {ok: false, code: 'PROPERTY_NOT_OWNED', message: `Properti ${property?.name || position} bukan milik ${ownerName}.`};
        }
        if ((property.houses || 0) > 0 || property.hasHotel) {
          return {ok: false, code: 'PROPERTY_HAS_BUILDINGS', message: `${property.name} masih memiliki bangunan.`};
        }
        if (property.type === 'prop') {
          const groupHasBuildings = [...this.state.properties.values()].some(candidate => candidate.type === 'prop' &&
            candidate.group === property.group && ((candidate.houses || 0) > 0 || candidate.hasHotel));
          if (groupHasBuildings) return {ok: false, code: 'GROUP_HAS_BUILDINGS', message: `Kelompok ${property.group} masih memiliki bangunan.`};
        }
      }
    }
    return {ok: true, offer: {giveMoney, receiveMoney, givePropPositions: [...givePropPositions],
      receivePropPositions: [...receivePropPositions], giveJailCards, receiveJailCards}};
  }

  _tradeActionReplay(actionId, playerId, action) {
    const prior = this.processedTradeActions.get(actionId);
    if (!prior) return null;
    if (prior.playerId !== playerId || prior.action !== action) {
      return {ok: false, error: {code: 'DUPLICATE_ACTION', message: 'Identitas aksi trade sudah digunakan.'}};
    }
    const trade = this.trades.get(prior.tradeId);
    return trade ? {ok: true, result: {roomCode: this.roomCode, type: trade.status,
      trade: this._tradeView(trade), duplicate: true, snapshot: this.toPublicSnapshot()}} :
      {ok: false, error: {code: 'TRADE_NOT_FOUND', message: 'Trade sebelumnya sudah tidak tersedia.'}};
  }

  createTradeOffer({playerId, turnId, actionId, toPlayerId, offer}) {
    if (typeof actionId !== 'string' || !actionId || actionId.length > 128) {
      return {ok: false, error: {code: 'INVALID_ACTION_ID', message: 'Identitas aksi trade tidak valid.'}};
    }
    const replay = this._tradeActionReplay(actionId, playerId, 'CREATE');
    if (replay) return replay;
    const active = this.state.players[this.state.currentTurn];
    if (!active || active.playerId !== playerId || this.state.activePlayerId !== playerId ||
        !Number.isInteger(turnId) || turnId !== this.state.turnId) {
      return {ok: false, error: {code: 'NOT_ACTIVE_PLAYER', message: 'Hanya pemain yang sedang mendapat giliran dapat mengirim trade.'}};
    }
    const validation = this._validateTradeOffer({fromPlayerId: playerId, toPlayerId, offer});
    if (!validation.ok) return {ok: false, error: {code: validation.code, message: validation.message}};
    const fromPlayer = this.state.getPlayerById(playerId), toPlayer = this.state.getPlayerById(toPlayerId);
    let tradeId = this.tradeIdGenerator();
    while (!tradeId || this.trades.has(tradeId)) tradeId = this.tradeIdGenerator();
    const now = new Date().toISOString();
    const trade = {tradeId, roomCode: this.roomCode, fromPlayerId: playerId, toPlayerId,
      fromPlayerName: fromPlayer.name, toPlayerName: toPlayer.name, createdTurnId: turnId,
      status: 'PENDING', offer: validation.offer, createdAt: now, updatedAt: now, reason: null};
    this.trades.set(tradeId, trade);
    this.processedTradeActions.set(actionId, {playerId, action: 'CREATE', tradeId});
    return {ok: true, result: {roomCode: this.roomCode, type: 'PENDING', trade: this._tradeView(trade),
      snapshot: this.toPublicSnapshot()}};
  }

  _invalidatePendingTrades(playerId = null, reason = 'PLAYER_BANKRUPT') {
    const updated = [];
    for (const trade of this.trades.values()) {
      if (trade.status !== 'PENDING' || (playerId && trade.fromPlayerId !== playerId && trade.toPlayerId !== playerId)) continue;
      trade.status = 'INVALIDATED';
      trade.reason = reason;
      trade.updatedAt = new Date().toISOString();
      updated.push(this._tradeView(trade));
    }
    return updated;
  }

  resolveTradeAction({playerId, tradeId, actionId, action}) {
    if (typeof actionId !== 'string' || !actionId || actionId.length > 128 ||
        typeof tradeId !== 'string' || !tradeId || !['ACCEPT', 'REJECT', 'CANCEL'].includes(action)) {
      return {ok: false, error: {code: 'INVALID_TRADE_ACTION', message: 'Aksi trade tidak valid.'}};
    }
    const replay = this._tradeActionReplay(actionId, playerId, action);
    if (replay) return replay;
    const trade = this.trades.get(tradeId);
    if (!trade || trade.roomCode !== this.roomCode) return {ok: false, error: {code: 'TRADE_NOT_FOUND', message: 'Penawaran trade tidak ditemukan.'}};
    if (trade.status !== 'PENDING') return {ok: false, error: {code: 'TRADE_NOT_PENDING', message: 'Penawaran trade sudah tidak aktif.'}};
    if ((action === 'CANCEL' && playerId !== trade.fromPlayerId) ||
        (action !== 'CANCEL' && playerId !== trade.toPlayerId)) {
      return {ok: false, error: {code: 'TRADE_ACTION_FORBIDDEN', message: 'Pemain ini tidak berhak mengubah status penawaran.'}};
    }
    let type = action === 'ACCEPT' ? 'COMPLETED' : action === 'REJECT' ? 'REJECTED' : 'CANCELLED';
    if (action === 'ACCEPT') {
      const validation = this._validateTradeOffer({fromPlayerId: trade.fromPlayerId,
        toPlayerId: trade.toPlayerId, offer: trade.offer});
      if (!validation.ok) {
        trade.status = 'INVALIDATED';
        trade.reason = validation.code;
        trade.updatedAt = new Date().toISOString();
        type = 'INVALIDATED';
      } else {
        const {giveMoney, receiveMoney, giveJailCards, receiveJailCards, givePropPositions, receivePropPositions} = validation.offer;
        const fromPlayer = this.state.getPlayerById(trade.fromPlayerId), toPlayer = this.state.getPlayerById(trade.toPlayerId);
        fromPlayer.money = fromPlayer.money - giveMoney + receiveMoney;
        toPlayer.money = toPlayer.money - receiveMoney + giveMoney;
        fromPlayer.hasGetOutOfJailCard = (fromPlayer.hasGetOutOfJailCard || 0) - giveJailCards + receiveJailCards;
        toPlayer.hasGetOutOfJailCard = (toPlayer.hasGetOutOfJailCard || 0) - receiveJailCards + giveJailCards;
        for (const position of givePropPositions) {
          const property = this.state.properties.get(position);
          property.owner = toPlayer.playerId;
          fromPlayer.properties = fromPlayer.properties.filter(id => id !== property.id);
          if (!toPlayer.properties.includes(property.id)) toPlayer.properties.push(property.id);
        }
        for (const position of receivePropPositions) {
          const property = this.state.properties.get(position);
          property.owner = fromPlayer.playerId;
          toPlayer.properties = toPlayer.properties.filter(id => id !== property.id);
          if (!fromPlayer.properties.includes(property.id)) fromPlayer.properties.push(property.id);
        }
        const description = `Perdagangan aset (Trade): ${fromPlayer.name} ↔ ${toPlayer.name}`;
        if (giveMoney > 0) this.state.transactions.push({id: `tx_${tradeId}_give`, time: new Date().toISOString(),
          players: [fromPlayer.name, toPlayer.name], amount: giveMoney, type: 'TRADE', description});
        if (receiveMoney > 0) this.state.transactions.push({id: `tx_${tradeId}_receive`, time: new Date().toISOString(),
          players: [toPlayer.name, fromPlayer.name], amount: receiveMoney, type: 'TRADE', description});
        trade.status = 'COMPLETED';
        trade.reason = null;
        trade.completedAt = new Date().toISOString();
        trade.updatedAt = trade.completedAt;
      }
    } else {
      trade.status = type;
      trade.updatedAt = new Date().toISOString();
    }
    this.processedTradeActions.set(actionId, {playerId, action, tradeId});
    return {ok: true, result: {roomCode: this.roomCode, type, trade: this._tradeView(trade),
      snapshot: this.toPublicSnapshot()}};
  }

  resolveJailAction({playerId, turnId, actionId, action}) {
    if (typeof actionId !== 'string' || !actionId.trim() || actionId.length > 128 ||
        !['PAY_BAIL', 'USE_CARD'].includes(action)) {
      return {ok: false, error: {code: 'INVALID_JAIL_ACTION', message: 'Aksi penjara tidak valid.'}};
    }
    if (this.processedJailActionIds.has(actionId)) {
      return {ok: false, error: {code: 'DUPLICATE_ACTION', message: 'Aksi penjara ini sudah pernah diproses.'}};
    }
    const player = this.state.players[this.state.currentTurn];
    if (this.state.gameStatus !== GameStatus.IN_GAME) {
      return {ok: false, error: {code: 'GAME_NOT_ACTIVE', message: 'Permainan tidak sedang berjalan.'}};
    }
    if (!player || player.playerId !== playerId || this.state.activePlayerId !== playerId) {
      return {ok: false, error: {code: 'NOT_ACTIVE_PLAYER', message: 'Giliran ini milik pemain lain.'}};
    }
    if (turnId !== this.state.turnId) return {ok: false, error: {code: 'STALE_TURN', message: 'Giliran sudah berubah.'}};
    if (this.state.phase !== 'WAITING_ROLL' || player.status !== PlayerStatus.IN_JAIL || player.inJail !== true) {
      return {ok: false, error: {code: 'JAIL_ACTION_NOT_ALLOWED', message: 'Aksi ini tidak tersedia pada fase atau status pemain saat ini.'}};
    }
    if (action === 'PAY_BAIL' && player.money < BAIL_COST) {
      return {ok: false, error: {code: 'INSUFFICIENT_FUNDS', message: `Saldo tidak cukup untuk membayar denda $${BAIL_COST}.`}};
    }
    if (action === 'USE_CARD' && (player.hasGetOutOfJailCard || 0) < 1) {
      return {ok: false, error: {code: 'NO_JAIL_CARD', message: 'Pemain tidak memiliki Kartu Bebas Penjara.'}};
    }
    this.processedJailActionIds.add(actionId);
    if (action === 'PAY_BAIL') {
      player.money -= BAIL_COST;
      this.state.transactions.push({id: `tx_jail_action_${actionId}`, time: new Date().toISOString(), players: [player.name],
        amount: BAIL_COST, type: 'BAIL', description: `Denda keluar dari Penjara: -$${BAIL_COST}`});
    } else {
      player.hasGetOutOfJailCard--;
      this.chanceDeck.returnGetOutOfJailCard();
    }
    player.status = PlayerStatus.ACTIVE;
    player.inJail = false;
    player.jailTurns = 0;
    player.consecutiveDoubles = 0;
    this.state.consecutiveDoubles = 0;
    this.state.phase = 'WAITING_ROLL';
    const event = {roomCode: this.roomCode, actionId, action, playerId, playerName: player.name, turnId,
      cost: action === 'PAY_BAIL' ? BAIL_COST : 0, balance: player.money, hasGetOutOfJailCard: player.hasGetOutOfJailCard,
      jailTurns: 0, status: player.status, inJail: false, phase: this.state.phase, snapshot: this.toPublicSnapshot()};
    return {ok: true, result: event};
  }

  resolveFreeParkingAction({playerId, turnId, actionId, action, targetPos, movementId, resolutionId}) {
    if (typeof actionId !== 'string' || !actionId.trim() || actionId.length > 128 ||
        !['STAY', 'TRAVEL'].includes(action) || (action === 'TRAVEL' &&
          (!Number.isInteger(targetPos) || targetPos < 0 || targetPos >= 40 || targetPos === 20))) {
      return {ok: false, error: {code: 'INVALID_FREE_PARKING_ACTION', message: 'Pilihan perjalanan Parkir Bebas tidak valid.'}};
    }
    if (this.processedFreeParkingActionIds.has(actionId)) {
      return {ok: false, error: {code: 'DUPLICATE_ACTION', message: 'Pilihan Parkir Bebas ini sudah pernah diproses.'}};
    }
    const player = this.state.players[this.state.currentTurn];
    const pending = this.pendingFreeParkingDecision;
    if (this.state.gameStatus !== GameStatus.IN_GAME || !player || player.playerId !== playerId ||
        this.state.activePlayerId !== playerId) {
      return {ok: false, error: {code: 'NOT_ACTIVE_PLAYER', message: 'Giliran ini milik pemain lain.'}};
    }
    if (turnId !== this.state.turnId || pending?.playerId !== playerId || pending?.turnId !== turnId) {
      return {ok: false, error: {code: 'STALE_TURN', message: 'Keputusan Parkir Bebas sudah kedaluwarsa.'}};
    }
    if (this.state.phase !== 'WAITING_ROLL' || player.pos !== 20 || player.status !== PlayerStatus.ACTIVE ||
        player.inJail === true || player.status === PlayerStatus.IN_JAIL) {
      return {ok: false, error: {code: 'FREE_PARKING_NOT_ALLOWED', message: 'Pemain tidak sedang memulai giliran di Parkir Bebas.'}};
    }
    if (action === 'TRAVEL' && player.money < 50) {
      return {ok: false, error: {code: 'INSUFFICIENT_FUNDS', message: 'Saldo tidak cukup untuk membayar biaya Travel $50.'}};
    }
    if (action === 'TRAVEL' && (typeof movementId !== 'string' || !movementId ||
        typeof resolutionId !== 'string' || !resolutionId)) {
      return {ok: false, error: {code: 'INVALID_MOVEMENT_ID', message: 'Identitas perjalanan tidak valid.'}};
    }

    this.processedFreeParkingActionIds.add(actionId);
    this.pendingFreeParkingDecision = null;
    if (action === 'STAY') {
      return {ok: true, result: {roomCode: this.roomCode, actionId, action, outcome: 'STAY', playerId,
        playerName: player.name, turnId, balance: player.money, phase: this.state.phase,
        pendingFreeParkingDecision: null, snapshot: this.toPublicSnapshot()}};
    }

    const tileCount = loadBoardCatalog().TILES.length;
    const steps = (targetPos - player.pos + tileCount) % tileCount;
    const selectedRoute = calculateMovement(player.pos, steps, tileCount);
    if (selectedRoute.endPos !== targetPos || steps < 1) {
      return {ok: false, error: {code: 'INVALID_DESTINATION', message: 'Tujuan perjalanan tidak dapat dicapai searah jarum jam.'}};
    }
    const travelTransaction = {id: `tx_free_parking_${actionId}`, time: new Date().toISOString(), players: [player.name], amount: 50,
      type: 'PARKING_TRAVEL', description: `Layanan Travel Parkir Bebas ke ${loadBoardCatalog().TILES.find(tile => tile.pos === targetPos)?.nama || `Petak ${targetPos}`}`};
    player.money -= 50;
    this.state.transactions.push(travelTransaction);
    this.state.lastRoll = {dice: [], total: steps, isDouble: false, consecutiveDoubles: 0, tripleDouble: false,
      movementType: 'FREE_PARKING_TRAVEL', travelCost: 50, travelActionId: actionId, travelTransactions: [travelTransaction]};
    this.state.phase = 'MOVING';
    const acceptedEvent = {roomCode: this.roomCode, actionId, action, outcome: 'TRAVEL_STARTED', playerId,
      playerName: player.name, turnId, startPos: 20, targetPos, steps, cost: 50, phase: this.state.phase,
      pendingFreeParkingDecision: null};
    const moved = this.moveCurrentPlayer({playerId, turnId, movementId});
    if (!moved.ok) return moved;
    if (moved.movement.startBonus) {
      const salary = {id: `tx_free_parking_${actionId}_start`, time: new Date().toISOString(), players: [player.name],
        amount: moved.movement.startBonus, type: 'SALARY', description: 'Bonus melewati Start: +$200'};
      this.state.transactions.push(salary);
      this.state.lastRoll.travelTransactions.push(salary);
      moved.movement.transactions = this.state.lastRoll.travelTransactions.map(tx => ({...tx, players: [...tx.players]}));
    } else {
      moved.movement.transactions = this.state.lastRoll.travelTransactions.map(tx => ({...tx, players: [...tx.players]}));
    }
    // Travel has no dice roll. Keep movement steps for presentation, but use the same
    // rent fallback as single-player, where no roll exists (7 for utility rent).
    this.state.lastRoll.total = null;
    const tile = this.resolveLandedTile({playerId, turnId, movementId, resolutionId});
    if (!tile.ok) return tile;
    return {ok: true, result: {roomCode: this.roomCode, action: 'TRAVEL', event: acceptedEvent,
      movement: moved.movement, tileResolution: tile.resolution}};
  }

  rollDice({playerId, turnId, diceRoller, actionId}) {
    const activePlayer = this.state.players[this.state.currentTurn];
    if (this.state.gameStatus !== GameStatus.IN_GAME) {
      return {ok: false, error: {code: 'GAME_NOT_ACTIVE', message: 'Permainan tidak sedang berjalan.'}};
    }
    if (!activePlayer || playerId !== activePlayer.playerId) {
      return {ok: false, error: {code: 'NOT_ACTIVE_PLAYER', message: 'Giliran ini milik pemain lain.'}};
    }
    if (!Number.isInteger(turnId) || turnId !== this.state.turnId) {
      return {ok: false, error: {code: 'STALE_TURN', message: 'Identitas giliran sudah berubah. Perbarui permainan lalu coba lagi.'}};
    }
    if (this.pendingFreeParkingDecision?.playerId === playerId && this.pendingFreeParkingDecision.turnId === turnId) {
      return {ok: false, error: {code: 'FREE_PARKING_DECISION_REQUIRED', message: 'Pilih tujuan Travel atau Tetap di Sini terlebih dahulu.'}};
    }
    const jailAttempt = activePlayer.status === PlayerStatus.IN_JAIL || activePlayer.inJail === true;
    if (jailAttempt && (typeof actionId !== 'string' || !actionId.trim() || actionId.length > 128 || this.processedJailActionIds.has(actionId)))
      return {ok: false, error: {code: 'INVALID_JAIL_ACTION', message: 'Identitas percobaan penjara tidak valid atau sudah digunakan.'}};
    const extraRollAttempt = this.state.phase === 'PLAYER_ACTION' && this.extraRollAvailable === true;
    if (this._rollInProgress || !(this.state.phase === 'WAITING_ROLL' || extraRollAttempt)) {
      return {ok: false, error: {code: 'ROLL_NOT_ALLOWED', message: 'Dadu tidak dapat dilempar pada fase permainan ini.'}};
    }

    this.extraRollAvailable = false;
    this._rollInProgress = true;
    this.state.phase = 'ROLLING';
    try {
      const dice = diceRoller();
      if (!Array.isArray(dice) || dice.length !== 2 || dice.some(value => !Number.isInteger(value) || value < 1 || value > 6)) {
        throw new Error('Dice roller must return two integers from 1 to 6.');
      }
      const [die1, die2] = dice;
      const total = die1 + die2;
      const isDouble = die1 === die2;
      if (jailAttempt) {
        activePlayer.consecutiveDoubles = 0;
        this.state.consecutiveDoubles = 0;
        const previousJailTurns = activePlayer.jailTurns || 0;
        let outcome = 'FAILED';
        let released = false;
        let forcedBail = false;
        let transaction = null;
        if (isDouble) {
          outcome = 'DOUBLE'; released = true;
        } else {
          activePlayer.jailTurns = previousJailTurns + 1;
          if (activePlayer.jailTurns >= MAX_JAIL_TURNS && activePlayer.money >= BAIL_COST) {
            activePlayer.money -= BAIL_COST;
            activePlayer.status = PlayerStatus.ACTIVE; activePlayer.inJail = false; activePlayer.jailTurns = 0;
            forcedBail = true; released = true; outcome = 'FORCED_BAIL';
            transaction = {id: `tx_jail_roll_${actionId}`, time: new Date().toISOString(), players: [activePlayer.name],
              amount: BAIL_COST, type: 'BAIL', description: `Denda wajib giliran ke-3 Penjara: -$${BAIL_COST}`};
            this.state.transactions.push(transaction);
          }
        }
        if (released) { activePlayer.status = PlayerStatus.ACTIVE; activePlayer.inJail = false; activePlayer.jailTurns = 0; }
        this.processedJailActionIds.add(actionId);
        const lastRoll = {dice: [die1, die2], total, isDouble, consecutiveDoubles: 0, tripleDouble: false, jailAttempt: true, jailReleased: released};
        this.state.lastRoll = lastRoll;
        this.state.phase = released ? 'MOVING' : 'JAIL_ATTEMPT';
        const diceEvent = {roomCode: this.roomCode, playerId: activePlayer.playerId, seat: activePlayer.seat,
          die1, die2, total, isDouble, consecutiveDoubles: 0, tripleDouble: false, jailAttempt: true,
          jailReleased: released, turnId: this.state.turnId, phase: this.state.phase};
        if (!released) {
          const nextPlayer = this.state.players[(this.state.currentTurn + 1) % this.state.players.length];
          this.state.phase = 'PLAYER_ACTION';
          this.advanceTurn({playerId, turnId});
        }
        const jailResolution = {roomCode: this.roomCode, actionId, playerId, playerName: activePlayer.name,
          turnId: this.state.turnId, previousTurnId: turnId, outcome, released, forcedBail, transaction,
          die1, die2, total, isDouble, jailTurns: activePlayer.jailTurns || 0, status: activePlayer.status,
          inJail: activePlayer.inJail === true, balance: activePlayer.money, phase: this.state.phase,
          snapshot: this.toPublicSnapshot()};
        return {ok: true, result: {...diceEvent, jailResolution}};
      }
      activePlayer.consecutiveDoubles = isDouble ? Math.min(3, (activePlayer.consecutiveDoubles || 0) + 1) : 0;
      this.state.consecutiveDoubles = activePlayer.consecutiveDoubles;
      const tripleDouble = isDouble && activePlayer.consecutiveDoubles >= 3;
      const lastRoll = {
        dice: [die1, die2], total, isDouble,
        consecutiveDoubles: activePlayer.consecutiveDoubles,
        tripleDouble
      };
      this.state.lastRoll = lastRoll;
      this.state.phase = tripleDouble ? 'JAILING' : 'MOVING';
      this.state.activePlayerId = activePlayer.playerId;
      return {ok: true, result: {
        roomCode: this.roomCode,
        playerId: activePlayer.playerId,
        seat: activePlayer.seat,
        die1,
        die2,
        total,
        isDouble,
        consecutiveDoubles: activePlayer.consecutiveDoubles,
        tripleDouble,
        turnId: this.state.turnId,
        phase: this.state.phase
      }};
    } catch (error) {
      this.state.phase = extraRollAttempt ? 'PLAYER_ACTION' : 'WAITING_ROLL';
      this.extraRollAvailable = extraRollAttempt;
      return {ok: false, error: {code: 'DICE_ROLL_FAILED', message: 'Hasil dadu gagal dibuat. Silakan coba lagi.'}};
    } finally {
      this._rollInProgress = false;
    }
  }

  /** Advance state only after the current turn's gameplay work is complete. */
  advanceTurn({playerId, turnId}) {
    if (playerId !== this.state.activePlayerId || turnId !== this.state.turnId || this.state.phase !== 'PLAYER_ACTION') {
      return false;
    }
    const outgoingPlayer = this.state.players[this.state.currentTurn];
    if (outgoingPlayer) outgoingPlayer.consecutiveDoubles = 0;
    this.extraRollAvailable = false;
    const activePlayers = this.state.players.filter(player => player.status !== PlayerStatus.BANKRUPT);
    if (activePlayers.length <= 1) {
      const winner = activePlayers[0] || null;
      if (winner) this.state.currentTurn = winner.seat;
      this.state.gameStatus = GameStatus.FINISHED;
      this.state.phase = 'GAME_OVER';
      this.pendingFreeParkingDecision = null;
      this.state.turnId++;
      this.state.activePlayerId = winner?.playerId || null;
      this.state.lastRoll = null;
      this.state.consecutiveDoubles = 0;
      return true;
    }
    let nextTurn = (this.state.currentTurn + 1) % this.state.players.length;
    let attempts = 0;
    while (this.state.players[nextTurn]?.status === PlayerStatus.BANKRUPT && attempts < this.state.players.length) {
      nextTurn = (nextTurn + 1) % this.state.players.length;
      attempts++;
    }
    this.state.currentTurn = nextTurn;
    if (this.state.currentTurn === 0) this.state.round++;
    this.state.turnId++;
    this.state.activePlayerId = this.state.players[this.state.currentTurn]?.playerId || null;
    if (this.state.players[this.state.currentTurn]) this.state.players[this.state.currentTurn].consecutiveDoubles = 0;
    this.state.lastRoll = null;
    this.state.consecutiveDoubles = 0;
    this.state.phase = 'WAITING_ROLL';
    const nextPlayer = this.state.players[this.state.currentTurn];
    this.pendingFreeParkingDecision = nextPlayer?.status === PlayerStatus.ACTIVE && nextPlayer.pos === 20
      ? {playerId: nextPlayer.playerId, turnId: this.state.turnId} : null;
    return true;
  }

  sendToJailForThirdDouble({playerId, turnId, resolutionId}) {
    const player = this.state.players[this.state.currentTurn];
    if (!player || player.playerId !== playerId || playerId !== this.state.activePlayerId) {
      return {ok: false, error: {code: 'NOT_ACTIVE_PLAYER', message: 'Giliran ini milik pemain lain.'}};
    }
    if (turnId !== this.state.turnId) {
      return {ok: false, error: {code: 'STALE_TURN', message: 'Giliran sudah berubah.'}};
    }
    if (this.state.phase !== 'JAILING' || !this.state.lastRoll?.tripleDouble ||
        this.state.lastRoll.consecutiveDoubles !== 3 || typeof resolutionId !== 'string' || !resolutionId) {
      return {ok: false, error: {code: 'JAIL_NOT_READY', message: 'Hukuman tiga kali dobel tidak tersedia.'}};
    }

    const previousPosition = player.pos;
    player.pos = 10;
    player.status = PlayerStatus.IN_JAIL;
    player.inJail = true;
    player.jailTurns = 0;
    player.consecutiveDoubles = 0;
    this.state.consecutiveDoubles = 0;
    this.state.phase = 'PLAYER_ACTION';
    this.extraRollAvailable = false;
    if (!this.advanceTurn({playerId, turnId})) {
      return {ok: false, error: {code: 'TURN_ADVANCE_FAILED', message: 'Giliran berikutnya belum dapat dimulai.'}};
    }
    return {ok: true, event: {
      roomCode: this.roomCode,
      resolutionId,
      kind: 'THREE_DOUBLES_JAIL',
      playerId,
      seat: player.seat,
      previousTurnId: turnId,
      previousPosition,
      resultingPosition: 10,
      status: player.status,
      inJail: player.inJail,
      jailTurns: player.jailTurns,
      consecutiveDoubles: 0,
      turnId: this.state.turnId,
      currentTurn: this.state.currentTurn,
      round: this.state.round,
      activePlayerId: this.state.activePlayerId,
      phase: this.state.phase,
      message: `${player.name} mendapat dobel tiga kali dan langsung masuk Penjara.`
    }};
  }

  _completeCurrentRoll({player, turnId, forceEndTurn = false}) {
    const lastRoll = this.state.lastRoll;
    const extraRollAllowed = !forceEndTurn && lastRoll?.jailAttempt !== true && player.status !== PlayerStatus.IN_JAIL &&
      player.inJail !== true && lastRoll?.isDouble === true &&
      (player.consecutiveDoubles || 0) < 3;
    this.state.phase = 'PLAYER_ACTION';
    this.extraRollAvailable = extraRollAllowed;

    if (extraRollAllowed) {
      this.state.turnId++;
      this.state.activePlayerId = player.playerId;
      return {
        extraRollAllowed: true,
        consecutiveDoubles: player.consecutiveDoubles || 0,
        turnId: this.state.turnId,
        currentTurn: this.state.currentTurn,
        round: this.state.round,
        activePlayerId: this.state.activePlayerId,
        phase: 'PLAYER_ACTION'
      };
    }

    player.consecutiveDoubles = 0;
    this.state.consecutiveDoubles = 0;
    return {
      extraRollAllowed: false,
      consecutiveDoubles: 0,
      turnId: this.state.turnId,
      currentTurn: this.state.currentTurn,
      round: this.state.round,
      activePlayerId: this.state.activePlayerId,
      phase: 'PLAYER_ACTION'
    };
  }

  endTurn({playerId, turnId, actionId}) {
    if (!Number.isSafeInteger(turnId) || turnId < 1 || typeof actionId !== 'string' || !actionId.trim() || actionId.length > 128) {
      return {ok: false, error: {code: 'INVALID_ACTION', message: 'Identitas aksi selesai giliran tidak valid.'}};
    }
    const prior = this.processedEndTurnActions.get(actionId);
    if (prior) {
      if (prior.playerId !== playerId || prior.turnId !== turnId) {
        return {ok: false, error: {code: 'DUPLICATE_ACTION', message: 'Action ID ini sudah digunakan.'}};
      }
      return {ok: true, result: {...prior.result, duplicate: true}};
    }
    const player = this.state.players[this.state.currentTurn];
    if (!player || player.playerId !== playerId || this.state.activePlayerId !== playerId) {
      return {ok: false, error: {code: 'NOT_ACTIVE_PLAYER', message: 'Hanya pemain aktif yang dapat mengakhiri giliran.'}};
    }
    if (turnId !== this.state.turnId) return {ok: false, error: {code: 'STALE_TURN', message: 'Giliran sudah berubah.'}};
    if (this.state.gameStatus !== GameStatus.IN_GAME || this.state.phase !== 'PLAYER_ACTION') {
      return {ok: false, error: {code: 'END_TURN_NOT_ALLOWED', message: 'Giliran belum siap diakhiri.'}};
    }
    if (this.extraRollAvailable === true) {
      return {ok: false, error: {code: 'EXTRA_ROLL_REQUIRED', message: 'Double memberi hak lempar lagi sebelum giliran dapat diakhiri.'}};
    }
    if (this.pendingResolution || this.pendingDebt || this.activeAuction || this.pendingFreeParkingDecision ||
        this.pendingChancePresentation) {
      return {ok: false, error: {code: 'PENDING_ACTION', message: 'Selesaikan semua keputusan wajib sebelum mengakhiri giliran.'}};
    }
    if (!this.advanceTurn({playerId, turnId})) {
      return {ok: false, error: {code: 'TURN_ADVANCE_FAILED', message: 'Giliran belum dapat diakhiri.'}};
    }
    const winner = this.state.gameStatus === GameStatus.FINISHED
      ? this.state.players.find(candidate => candidate.status !== PlayerStatus.BANKRUPT) || null : null;
    const result = {roomCode: this.roomCode, actionId, previousPlayerId: playerId, previousTurnId: turnId,
      turnId: this.state.turnId, currentTurn: this.state.currentTurn, round: this.state.round,
      activePlayerId: this.state.activePlayerId, phase: this.state.phase, gameStatus: this.state.gameStatus,
      winner: winner ? {playerId: winner.playerId, seat: winner.seat, name: winner.name} : null,
      extraRollAvailable: false, snapshot: this.toPublicSnapshot()};
    this.processedEndTurnActions.set(actionId, {playerId, turnId, result});
    return {ok: true, result};
  }

  moveCurrentPlayer({playerId, turnId, movementId}) {
    const player = this.state.players[this.state.currentTurn];
    if (!player || playerId !== player.playerId || playerId !== this.state.activePlayerId) {
      return {ok: false, error: {code: 'NOT_ACTIVE_PLAYER', message: 'Giliran ini milik pemain lain.'}};
    }
    if (!Number.isInteger(turnId) || turnId !== this.state.turnId) {
      return {ok: false, error: {code: 'STALE_TURN', message: 'Identitas giliran sudah berubah.'}};
    }
    const roll = this.state.lastRoll;
    if (this.state.phase !== 'MOVING' || !roll || roll.movementId) {
      return {ok: false, error: {code: 'MOVEMENT_NOT_ALLOWED', message: 'Hasil dadu ini sudah diproses atau belum tersedia.'}};
    }
    if (typeof movementId !== 'string' || !movementId) {
      return {ok: false, error: {code: 'INVALID_MOVEMENT_ID', message: 'Identitas pergerakan tidak valid.'}};
    }

    const tiles = loadBoardCatalog().TILES;
    const movement = calculateMovement(player.pos, roll.total, tiles.length);
    const startBonus = movement.passedStart ? 200 : 0;
    player.pos = movement.endPos;
    if (startBonus) player.money += startBonus;
    const transactions = [];
    if (startBonus && roll.movementType !== 'FREE_PARKING_TRAVEL') {
      const salary = {id: `tx_start_${turnId}_${movementId}`, time: new Date().toISOString(), players: [player.name],
        amount: startBonus, type: 'SALARY', description: 'Bonus melewati Start: +$200'};
      this.state.transactions.push(salary);
      transactions.push(salary);
    }
    roll.movementId = movementId;
    this.state.phase = 'WAITING_TILE_RESOLUTION';

    return {ok: true, movement: {
      roomCode: this.roomCode,
      movementId,
      playerId: player.playerId,
      seat: player.seat,
      turnId: this.state.turnId,
      startPos: movement.startPos,
      endPos: movement.endPos,
      steps: movement.steps,
      diceTotal: roll.total,
      passedStart: movement.passedStart,
      startBonus,
      balance: player.money,
      phase: this.state.phase,
      transactions: transactions.map(transaction => ({...transaction, players: [...transaction.players]})),
      ...(roll.movementType === 'FREE_PARKING_TRAVEL' ? {
        movementType: roll.movementType, travelCost: roll.travelCost, travelActionId: roll.travelActionId,
        transactions: (roll.travelTransactions || []).map(tx => ({...tx, players: [...tx.players]}))
      } : {})
    }};
  }

  resolveLandedTile({playerId, turnId, movementId, resolutionId}) {
    const player = this.state.players[this.state.currentTurn];
    if (!player || player.playerId !== playerId || player.playerId !== this.state.activePlayerId) {
      return {ok: false, error: {code: 'NOT_ACTIVE_PLAYER', message: 'Pemain ini tidak sedang mendapat giliran.'}};
    }
    if (turnId !== this.state.turnId) {
      return {ok: false, error: {code: 'STALE_TURN', message: 'Giliran sudah berubah.'}};
    }
    if (typeof resolutionId !== 'string' || !resolutionId) {
      return {ok: false, error: {code: 'INVALID_RESOLUTION_ID', message: 'Identitas resolusi tidak valid.'}};
    }
    if (this.processedRentResolutionIds.has(resolutionId)) {
      return {ok: false, error: {code: 'STALE_RESOLUTION', message: 'Resolusi sewa ini sudah pernah diproses.'}};
    }
    if (this.state.phase !== 'WAITING_TILE_RESOLUTION' || this.state.lastRoll?.movementId !== movementId) {
      return {ok: false, error: {code: 'TILE_NOT_READY', message: 'Pergerakan belum selesai atau petak sudah diproses.'}};
    }

    const tile = loadBoardCatalog().TILES.find(candidate => candidate.pos === player.pos);
    if (tile?.type === 'chance') {
      if (this.processedChanceResolutionIds.has(resolutionId)) {
        return {ok: false, error: {code: 'STALE_RESOLUTION', message: 'Resolusi kartu ini sudah diproses.'}};
      }
      this.processedChanceResolutionIds.add(resolutionId);
      const card = this.chanceDeck.draw();
      if (!card) return {ok: false, error: {code: 'CHANCE_DECK_EMPTY', message: 'Tumpukan kartu Kesempatan kosong.'}};
      const presentation = this._createChancePresentation({player, turnId, movementId, resolutionId, card});
      return presentation
        ? {ok: true, resolution: {kind: 'CHANCE_PRESENTATION', event: presentation}}
        : {ok: false, error: {code: 'CHANCE_PRESENTATION_FAILED', message: 'Kartu Kesempatan belum dapat ditampilkan.'}};
    }
    if (tile?.type === 'corner' && tile.pos === 0) {
      const event = this._completeTileResolution({
        player, turnId, movementId, resolutionId, kind: 'START', landedPosition: 0,
        resultingPosition: 0, message: `${player.name} berhenti di START.`
      });
      if (!event) {
        return {ok: false, error: {code: 'TURN_ADVANCE_FAILED', message: 'Giliran berikutnya belum dapat dimulai.'}};
      }
      return {ok: true, resolution: {kind: 'TILE_RESOLVED', event}};
    }

    const property = this.state.properties.get(player.pos);
    if (tile && ['prop', 'rail', 'util'].includes(tile.type) && property && property.owner === null) {
      this.pendingResolution = {
        resolutionId,
        playerId,
        seat: player.seat,
        turnId,
        propertyPos: property.pos,
        propertyId: property.id,
        price: property.price
      };
      this.state.phase = 'WAITING_PROPERTY_DECISION';
      return {ok: true, resolution: {kind: 'PROPERTY_OFFER', offer: {
        roomCode: this.roomCode,
        playerId,
        seat: player.seat,
        turnId,
        resolutionId,
        propertyPos: property.pos,
        propertyId: property.id,
        propertyName: property.name,
        price: property.price,
        balance: player.money,
        phase: this.state.phase
      }}};
    }

    if (tile && ['prop', 'rail', 'util'].includes(tile.type) && property && property.owner !== null) {
      return {ok: true, resolution: this._resolveOwnedProperty({player, property, turnId, movementId, resolutionId})};
    }

    if (tile?.type === 'tax') {
      const taxAmount = Number(tile.price || 0);
      if (player.money < taxAmount) {
        return {ok: true, resolution: this._createDebt({player, turnId, movementId, resolutionId,
          debtType: 'TAX', amount: taxAmount, creditorId: 'BANK', creditorName: 'Bank',
          position: player.pos, tileName: tile.nama, description: `Pajak ${tile.nama}`})};
      }

      player.money -= taxAmount;
      const transaction = {
        id: `tx_${resolutionId}`,
        time: new Date().toISOString(),
        players: [player.name, 'Bank'],
        amount: taxAmount,
        type: 'TAX',
        description: `Bayar ${tile.nama}`
      };
      this.state.transactions.push(transaction);
      const event = this._completeTileResolution({
        player, turnId, movementId, resolutionId, kind: 'TAX_PAID', landedPosition: tile.pos,
        transaction, taxAmount, message: `${player.name} membayar ${tile.nama} $${taxAmount}.`
      });
      return event
        ? {ok: true, resolution: {kind: 'TILE_RESOLVED', event}}
        : {ok: false, error: {code: 'TURN_ADVANCE_FAILED', message: 'Giliran berikutnya belum dapat dimulai.'}};
    }

    if (tile?.type === 'corner' && tile.pos === 10) {
      const event = this._completeTileResolution({
        player, turnId, movementId, resolutionId, kind: 'JAIL_VISIT', landedPosition: 10,
        message: `${player.name} hanya berkunjung di Penjara.`
      });
      return event
        ? {ok: true, resolution: {kind: 'TILE_RESOLVED', event}}
        : {ok: false, error: {code: 'TURN_ADVANCE_FAILED', message: 'Giliran berikutnya belum dapat dimulai.'}};
    }

    if (tile?.type === 'corner' && tile.pos === 20) {
      const event = this._completeTileResolution({
        player, turnId, movementId, resolutionId, kind: 'FREE_PARKING', landedPosition: 20,
        forceEndTurn: true,
        message: `${player.name} beristirahat di Parkir Bebas. Tidak ada hadiah uang.`
      });
      return event
        ? {ok: true, resolution: {kind: 'TILE_RESOLVED', event}}
        : {ok: false, error: {code: 'TURN_ADVANCE_FAILED', message: 'Giliran berikutnya belum dapat dimulai.'}};
    }

    if (tile?.type === 'corner' && tile.pos === 30) {
      player.pos = 10;
      player.status = PlayerStatus.IN_JAIL;
      player.inJail = true;
      player.jailTurns = 0;
      player.consecutiveDoubles = 0;
      this.state.consecutiveDoubles = 0;
      const event = this._completeTileResolution({
        player, turnId, movementId, resolutionId, kind: 'JAILED', landedPosition: 30,
        resultingPosition: 10,
        message: `${player.name} masuk Penjara dan dipindahkan ke petak Penjara.`
      });
      return event
        ? {ok: true, resolution: {kind: 'TILE_RESOLVED', event}}
        : {ok: false, error: {code: 'TURN_ADVANCE_FAILED', message: 'Giliran berikutnya belum dapat dimulai.'}};
    }

    this.state.phase = 'WAITING_TILE_RESOLUTION';
    return {ok: true, resolution: {kind: 'UNSUPPORTED', event: {
      roomCode: this.roomCode,
      playerId,
      seat: player.seat,
      turnId,
      resolutionId,
      movementId,
      position: player.pos,
      tileName: tile?.nama || `Petak ${player.pos}`,
      tileType: tile?.type || 'unknown',
      phase: this.state.phase,
      message: `Resolusi petak ${tile?.nama || 'ini'} belum tersedia. Giliran tetap menunggu.`
    }}};
  }

  _resolveChanceCard({player, turnId, movementId, resolutionId, card, presentationId}) {
    const unsupported = message => {
      this.state.phase = 'WAITING_TILE_RESOLUTION';
      return {kind: 'CHANCE', event: {
        roomCode: this.roomCode, resolutionId, movementId, playerId: player.playerId, seat: player.seat,
        previousTurnId: turnId, position: player.pos, card, supported: false, balance: player.money,
        balances: this.state.players.map(item => ({playerId: item.playerId, money: item.money})),
        phase: this.state.phase, message
      }};
    };
    if (!card) return unsupported('Tumpukan kartu Kesempatan kosong; resolusi ditahan.');

    let transactions = [];
    let amount = 0;
    if (card.type === 'MONEY_GAIN') {
      amount = card.amount;
      player.money += amount;
      transactions.push(this._chanceTransaction(resolutionId, 'CARD_REWARD', amount, [player.name, 'Bank'], card.desc));
    } else if (card.type === 'MONEY_LOSS') {
      if (player.money < card.amount) return this._createChanceDebt({player, turnId, movementId, resolutionId, card,
        amount: card.amount, description: card.desc});
      amount = card.amount;
      player.money -= amount;
      transactions.push(this._chanceTransaction(resolutionId, 'CARD_PENALTY', amount, [player.name, 'Bank'], card.desc));
    } else if (card.type === 'REPAIR_BUILDINGS') {
      let houses = 0;
      let hotels = 0;
      for (const property of this.state.properties.values()) {
        if (property.owner !== player.playerId) continue;
        if (property.hasHotel) hotels++;
        else houses += property.houses || 0;
      }
      amount = houses * card.houseCost + hotels * card.hotelCost;
      if (player.money < amount) return this._createChanceDebt({player, turnId, movementId, resolutionId, card,
        amount, description: `${card.desc} (${houses} rumah, ${hotels} hotel)`});
      if (amount) {
        player.money -= amount;
        transactions.push(this._chanceTransaction(resolutionId, 'CARD_PENALTY', amount, [player.name, 'Bank'], card.desc));
      }
    } else if (card.type === 'GET_OUT_OF_JAIL') {
      player.hasGetOutOfJailCard = (player.hasGetOutOfJailCard || 0) + 1;
    } else if (card.type === 'COLLECT_FROM_EACH_PLAYER') {
      const opponents = this.state.players.filter(other => other.playerId !== player.playerId && other.status === PlayerStatus.ACTIVE);
      for (const opponent of opponents) {
        const paid = Math.min(opponent.money, card.amount);
        if (!paid) continue;
        opponent.money -= paid;
        player.money += paid;
        transactions.push(this._chanceTransaction(`${resolutionId}_${opponent.seat}`, 'CARD_REWARD', paid, [opponent.name, player.name], card.desc));
        amount += paid;
      }
    } else if (card.type === 'PAY_EACH_PLAYER') {
      const opponents = this.state.players.filter(other => other.playerId !== player.playerId && other.status === PlayerStatus.ACTIVE);
      const total = opponents.length * card.amount;
      if (player.money < total) {
        const recipients = opponents.map(opponent => ({playerId: opponent.playerId, name: opponent.name,
          seat: opponent.seat, amount: card.amount}));
        return this._createChanceDebt({player, turnId, movementId, resolutionId, card, amount: total,
          creditorId: 'MULTIPLE', creditorName: `${recipients.length} pemain aktif`, paymentRecipients: recipients,
          description: card.desc});
      }
      for (const opponent of opponents) {
        player.money -= card.amount;
        opponent.money += card.amount;
        transactions.push(this._chanceTransaction(`${resolutionId}_${opponent.seat}`, 'CARD_PENALTY', card.amount, [player.name, opponent.name], card.desc));
      }
      amount = total;
    } else if (card.type === 'MOVE_TO' || card.type === 'MOVE_BACKWARD') {
      const result = this._resolveChanceMovement({player, turnId, movementId, resolutionId, card,
        presentationId, cardIndex: 1});
      return result;
    } else {
      return unsupported('Efek kartu ini belum didukung; giliran tertahan.');
    }

    for (const transaction of transactions) this.state.transactions.push(transaction);
    const completion = this._completeTileResolution({
      player, turnId, movementId, resolutionId, kind: 'CHANCE_RESOLVED', landedPosition: player.pos,
      transaction: transactions[0] || null, message: `${card.desc}${amount ? ` ($${amount})` : ''}`
    });
    if (!completion) return unsupported('Pergantian giliran setelah kartu gagal; resolusi ditahan.');
    return {kind: 'CHANCE', event: {
      ...completion, card, supported: true, amount, transactions,
      balances: this.state.players.map(item => ({playerId: item.playerId, money: item.money})),
      collectedFrom: card.type === 'COLLECT_FROM_EACH_PLAYER' ? transactions.map(tx => ({name: tx.players[0], amount: tx.amount})) : []
    }};
  }

  _chanceTransaction(id, type, amount, players, description) {
    return {id: `tx_${id}`, time: new Date().toISOString(), players, amount, type, description};
  }

  _chancePresentationView(presentation = this.pendingChancePresentation) {
    if (!presentation) return null;
    return {presentationId: presentation.presentationId, event: JSON.parse(JSON.stringify(presentation.event)),
      pendingPlayerIds: [...presentation.pendingPlayerIds]};
  }

  _createChancePresentation({player, turnId, movementId, resolutionId, card, depth = 0, context = null}) {
    if (!player || !card || player.playerId !== this.state.activePlayerId || turnId !== this.state.turnId ||
        this.pendingChancePresentation) return null;
    const cardIndex = context?.cardIndex || 1;
    const presentationId = `chance-${randomUUID()}`;
    const event = {roomCode: this.roomCode, playerId: player.playerId, seat: player.seat, turnId,
      previousTurnId: turnId, movementId, resolutionId, presentationId, position: player.pos,
      card: {...card}, cards: [{...card}], phase: 'CHANCE_PRESENTATION', recipientPlayerId: player.playerId};
    const pending = {presentationId, event, pendingPlayerIds: [player.playerId],
      context: context ? JSON.parse(JSON.stringify(context)) : {
        kind: 'SINGLE', playerId: player.playerId, turnId, movementId, resolutionId,
        initialPosition: player.pos, depth, cardIndex, card: {...card}
      }};
    this.state.phase = 'CHANCE_PRESENTATION';
    this.pendingChancePresentation = pending;
    return JSON.parse(JSON.stringify(event));
  }

  continueChancePresentation({playerId, turnId, resolutionId, presentationId, actionId}) {
    if (typeof actionId !== 'string' || !actionId.trim() || actionId.length > 128) {
      return {ok: false, error: {code: 'INVALID_ACTION', message: 'Identitas aksi Lanjutkan tidak valid.'}};
    }
    const prior = this.processedChanceContinueActions.get(actionId);
    if (prior) {
      if (prior.playerId !== playerId || prior.turnId !== turnId || prior.presentationId !== presentationId ||
          prior.resolutionId !== resolutionId) {
        return {ok: false, error: {code: 'DUPLICATE_ACTION', message: 'Action ID ini sudah digunakan.'}};
      }
      return {ok: true, result: {...JSON.parse(JSON.stringify(prior.result)), duplicate: true}};
    }
    const pending = this.pendingChancePresentation;
    const context = pending?.context;
    const player = this.state.getPlayerById(playerId);
    if (!pending || !context || this.state.phase !== 'CHANCE_PRESENTATION' ||
        !pending.pendingPlayerIds.includes(playerId) || pending.presentationId !== presentationId ||
        pending.event.resolutionId !== resolutionId || pending.event.turnId !== turnId ||
        playerId !== this.state.activePlayerId || player?.seat !== pending.event.seat ||
        playerId !== context.playerId || context.turnId !== turnId || context.resolutionId !== resolutionId) {
      return {ok: false, error: {code: 'CHANCE_NOT_PENDING', message: 'Kartu Kesempatan ini sudah tidak menunggu tindakan.'}};
    }

    this.pendingChancePresentation = null;
    let resolution;
    if (context.kind === 'CHAIN') {
      resolution = this._continueChanceMovement({...context, current: {...context.card}, skipCurrentEffect: false});
    } else {
      resolution = this._resolveChanceCard({player, turnId, movementId: context.movementId,
        resolutionId, card: {...context.card}, presentationId});
    }
    if (resolution?.event) resolution.event.presentationId = presentationId;
    const nextPresentation = this._chancePresentationView();
    const result = {roomCode: this.roomCode, actionId, playerId, turnId, resolutionId, presentationId,
      resolution, nextPresentation};
    this.processedChanceContinueActions.set(actionId, {playerId, turnId, resolutionId, presentationId,
      result: JSON.parse(JSON.stringify(result))});
    while (this.processedChanceContinueActions.size > 256) {
      this.processedChanceContinueActions.delete(this.processedChanceContinueActions.keys().next().value);
    }
    return {ok: true, result};
  }

  _createChanceDebt({player, turnId, movementId, resolutionId, card, amount, description,
    creditorId = 'BANK', creditorName = 'Bank', paymentRecipients = null}) {
    this.pendingChanceResolution = {kind: 'SINGLE', playerId: player.playerId, turnId, movementId, resolutionId,
      position: player.pos, card: {...card}};
    const created = this._createDebt({player, turnId, movementId, resolutionId,
      debtType: paymentRecipients ? 'CHANCE_MULTI' : 'CHANCE', amount, creditorId, creditorName,
      position: player.pos, tileName: 'Kartu Kesempatan', description, chanceCard: {...card}, paymentRecipients});
    const debt = created.event?.debt;
    return {kind: 'CHANCE', event: {roomCode: this.roomCode, resolutionId, movementId, playerId: player.playerId,
      seat: player.seat, previousTurnId: turnId, position: player.pos, landedPosition: player.pos,
      card, supported: true, amount, debt, balance: player.money,
      balances: this.state.players.map(item => ({playerId: item.playerId, money: item.money})),
      transactions: [], phase: 'DEBT_RESOLUTION', message: `${description}. Utang menunggu penyelesaian.`}};
  }

  _resolveChanceMovement({player, turnId, movementId, resolutionId, card, presentationId, cardIndex = 1}) {
    const initialPosition = player.pos;
    const cards = [];
    const movements = [];
    const transactions = [];
    return this._continueChanceMovement({playerId: player.playerId, turnId, movementId, resolutionId, initialPosition,
      cards, movements, transactions, depth: 0, current: card, skipCurrentEffect: false, presentationId, cardIndex});
  }

  _continueChanceMovement(context) {
    const {playerId, turnId, movementId, resolutionId, initialPosition, cards, movements, transactions} = context;
    const player = this.state.getPlayerById(playerId);
    let {depth, current, skipCurrentEffect, presentationId, cardIndex = 1} = context;
    if (!player || this.state.gameStatus !== GameStatus.IN_GAME) return {kind: 'UNSUPPORTED', event: {message: 'Resolusi Chance tidak dapat dilanjutkan.'}};
    const move = currentCard => {
      if (currentCard.type === 'MOVE_BACKWARD') {
        const steps = currentCard.steps;
        const endPos = (player.pos - steps + 40) % 40;
        movements.push({movementId: `${resolutionId}:card:${cardIndex}`, startPos: player.pos, endPos, steps,
          direction: 'backward', startBonus: 0, balance: player.money});
        player.pos = endPos;
      } else {
        const target = currentCard.targetPos;
        const steps = (target - player.pos + 40) % 40 || 40;
        const endPos = (player.pos + steps) % 40;
        const passedStart = Math.floor((player.pos + steps) / 40) > 0;
        const startBonus = passedStart ? 200 : 0;
        player.pos = endPos;
        player.money += startBonus;
        if (startBonus) {
          const salary = this._chanceTransaction(`${resolutionId}_card_${cardIndex}_start`, 'SALARY', startBonus,
            [player.name], 'Bonus melewati Start dari kartu Kesempatan: +$200');
          transactions.push(salary);
          this.state.transactions.push(salary);
        }
        movements.push({movementId: `${resolutionId}:card:${cardIndex}`,
          startPos: movements.length ? movements.at(-1).endPos : initialPosition, endPos, steps,
          direction: 'forward', passedStart, startBonus, balance: player.money});
      }
      movements[movements.length - 1].balance = player.money;
      cards.push(currentCard);
    };
    while (true) {
      if (skipCurrentEffect) {
        skipCurrentEffect = false;
      } else if (current.type === 'MOVE_TO' || current.type === 'MOVE_BACKWARD') {
        move(current);
      } else {
        const effect = this._applyChanceEffect({player, card: current, resolutionId: `${resolutionId}:card:${cards.length + 1}`});
        if (effect.debt) {
          cards.push(current);
          this.pendingChanceResolution = {kind: 'CHAIN', playerId, turnId, movementId, resolutionId,
            initialPosition, cards: cards.map(item => ({...item})), movements: movements.map(item => ({...item})),
            transactions: transactions.map(item => ({...item, players: [...item.players]})), depth, cardIndex,
            presentationId};
          const created = this._createDebt({player, turnId, movementId: movements.at(-1)?.movementId || movementId,
            resolutionId, debtType: effect.debt.paymentRecipients ? 'CHANCE_MULTI' : 'CHANCE',
            amount: effect.debt.amount, creditorId: effect.debt.creditorId || 'BANK',
            creditorName: effect.debt.creditorName || 'Bank', position: player.pos, tileName: 'Kartu Kesempatan',
            description: effect.debt.description, chanceCard: {...current}, paymentRecipients: effect.debt.paymentRecipients});
          return {kind: 'CHANCE', event: this._chanceMovementEvent({player, turnId, movementId, resolutionId, initialPosition,
            cards, movements, transactions, supported: true, destinationResolution: created,
            message: `${effect.debt.description}. Utang menunggu penyelesaian.`})};
        }
        if (!effect.supported) {
          cards.push(current);
          return {kind: 'CHANCE', event: this._chanceMovementEvent({player, turnId, movementId, resolutionId, initialPosition,
            cards, movements, transactions, supported: false, message: effect.message})};
        }
        cards.push(current);
        transactions.push(...effect.transactions);
      }

      const destination = loadBoardCatalog().TILES.find(item => item.pos === player.pos);
      if (destination?.type === 'chance') {
        if (depth >= 1) {
          const completion = this._completeTileResolution({player, turnId, movementId: movements.at(-1)?.movementId || movementId,
            resolutionId, kind: 'CHANCE_LIMIT', landedPosition: player.pos, message: 'Batas pengambilan kartu Kesempatan berantai tercapai.'});
          return {kind: 'CHANCE', event: this._chanceMovementEvent({player, turnId, movementId, resolutionId, initialPosition,
            cards, movements, transactions, supported: true, completion, destinationResolution: {kind: 'TILE_RESOLVED', event: completion},
            message: 'Batas pengambilan kartu Kesempatan berantai tercapai.'})};
        }
        const nextCard = this.chanceDeck.draw();
        if (!nextCard) return {kind: 'CHANCE', event: this._chanceMovementEvent({player, turnId, movementId, resolutionId, initialPosition,
          cards, movements, transactions, supported: false, message: 'Tumpukan kartu Kesempatan kosong; resolusi ditahan.'})};
        const nextMovementId = movements.at(-1)?.movementId || movementId;
        const nextPresentation = this._createChancePresentation({player, turnId, movementId: nextMovementId, resolutionId,
          card: nextCard, context: {kind: 'CHAIN', playerId, turnId, movementId: nextMovementId, resolutionId,
            initialPosition: player.pos, depth: depth + 1, cardIndex: cardIndex + 1, card: {...nextCard},
            cards: [], movements: [], transactions: [], sourceMovementId: nextMovementId}});
        const event = this._chanceMovementEvent({player, turnId, movementId, resolutionId, initialPosition,
          cards, movements, transactions, supported: true,
          destinationResolution: {kind: 'CHANCE_PRESENTATION', event: nextPresentation},
          presentationId, sourceMovementId: context.sourceMovementId || movementId,
          message: 'Bidak tiba di petak Kesempatan; kartu berikutnya menunggu dilanjutkan.'});
        return {kind: 'CHANCE', event, nextPresentation};
      }

      const resolution = this._resolveCardDestination({player, turnId, movementId: movements.at(-1).movementId, resolutionId, tile: destination});
      if (resolution.kind === 'DEBT_CREATED' && this.pendingDebt && cards.length) {
        this.pendingDebt.chanceCard = {...cards.at(-1)};
        this.pendingDebt.chanceResolutionId = resolutionId;
        if (resolution.event) resolution.event.debt = this._debtView();
      }
      return {kind: 'CHANCE', event: this._chanceMovementEvent({player, turnId, movementId, resolutionId, initialPosition,
        cards, movements, transactions, supported: resolution.kind !== 'UNSUPPORTED', destinationResolution: resolution,
        completion: resolution.kind === 'TILE_RESOLVED' ? resolution.event : null,
        offer: resolution.offer, message: resolution.event?.message || 'Kartu Kesempatan selesai.'})};
    }
  }

  _applyChanceEffect({player, card, resolutionId}) {
    const transactions = [];
    if (card.type === 'MONEY_GAIN') {
      player.money += card.amount;
      transactions.push(this._chanceTransaction(resolutionId, 'CARD_REWARD', card.amount, [player.name, 'Bank'], card.desc));
    } else if (card.type === 'MONEY_LOSS') {
      if (player.money < card.amount) return {supported: false, transactions, debt: {amount: card.amount,
        description: card.desc}, message: `Saldo tidak cukup untuk membayar kartu $${card.amount}.`};
      player.money -= card.amount;
      transactions.push(this._chanceTransaction(resolutionId, 'CARD_PENALTY', card.amount, [player.name, 'Bank'], card.desc));
    } else if (card.type === 'GET_OUT_OF_JAIL') {
      player.hasGetOutOfJailCard = (player.hasGetOutOfJailCard || 0) + 1;
    } else if (card.type === 'REPAIR_BUILDINGS') {
      let houses = 0, hotels = 0;
      for (const property of this.state.properties.values()) if (property.owner === player.playerId) {
        if (property.hasHotel) hotels++; else houses += property.houses || 0;
      }
      const amount = houses * card.houseCost + hotels * card.hotelCost;
      if (player.money < amount) return {supported: false, transactions, debt: {amount,
        description: `${card.desc} (${houses} rumah, ${hotels} hotel)`}, message: `Saldo tidak cukup untuk membayar biaya renovasi $${amount}.`};
      if (amount) { player.money -= amount; transactions.push(this._chanceTransaction(resolutionId, 'CARD_PENALTY', amount, [player.name, 'Bank'], card.desc)); }
    } else if (card.type === 'COLLECT_FROM_EACH_PLAYER' || card.type === 'PAY_EACH_PLAYER') {
      const others = this.state.players.filter(other => other.playerId !== player.playerId && other.status === PlayerStatus.ACTIVE);
      const total = others.length * card.amount;
      if (card.type === 'PAY_EACH_PLAYER' && player.money < total) return {supported: false, transactions,
        debt: {amount: total, creditorId: 'MULTIPLE', creditorName: `${others.length} pemain aktif`,
          paymentRecipients: others.map(other => ({playerId: other.playerId, name: other.name, seat: other.seat, amount: card.amount})),
          description: card.desc}, message: `Saldo tidak cukup untuk membayar semua pemain ($${total}).`};
      for (const other of others) {
        if (card.type === 'COLLECT_FROM_EACH_PLAYER') {
          const amount = Math.min(other.money, card.amount);
          other.money -= amount; player.money += amount;
          if (amount) transactions.push(this._chanceTransaction(`${resolutionId}_${other.seat}`, 'CARD_REWARD', amount, [other.name, player.name], card.desc));
        } else {
          player.money -= card.amount; other.money += card.amount;
          transactions.push(this._chanceTransaction(`${resolutionId}_${other.seat}`, 'CARD_PENALTY', card.amount, [player.name, other.name], card.desc));
        }
      }
    } else {
      return {supported: false, transactions, message: 'Efek kartu Kesempatan berantai ini belum didukung; giliran tertahan.'};
    }
    this.state.transactions.push(...transactions);
    return {supported: true, transactions};
  }

  _resolveCardDestination({player, turnId, movementId, resolutionId, tile}) {
    if (tile?.type === 'corner' && tile.pos === 0) {
      const event = this._completeTileResolution({player, turnId, movementId, resolutionId, kind: 'START', landedPosition: 0, message: 'Berhenti di START.'});
      return event ? {kind: 'TILE_RESOLVED', event} : {kind: 'UNSUPPORTED', event: {message: 'Resolusi petak gagal.'}};
    }
    const property = this.state.properties.get(player.pos);
    if (tile && ['prop', 'rail', 'util'].includes(tile.type) && property) {
      if (property.owner === null) {
        this.pendingResolution = {resolutionId, playerId: player.playerId, seat: player.seat, turnId,
          propertyPos: property.pos, propertyId: property.id, price: property.price};
        this.state.phase = 'WAITING_PROPERTY_DECISION';
        return {kind: 'PROPERTY_OFFER', offer: {roomCode: this.roomCode, playerId: player.playerId, seat: player.seat,
          turnId, resolutionId, movementId, propertyPos: property.pos, propertyId: property.id,
          propertyName: property.name, price: property.price, balance: player.money, phase: this.state.phase}};
      }
      return this._resolveOwnedProperty({player, property, turnId, movementId, resolutionId});
    }
    if (tile?.type === 'tax') {
      const taxAmount = Number(tile.price || 0);
      if (player.money < taxAmount) return this._createDebt({player, turnId, movementId, resolutionId,
        debtType: 'TAX', amount: taxAmount, creditorId: 'BANK', creditorName: 'Bank',
        position: player.pos, tileName: tile.nama, description: `Pajak ${tile.nama}`});
      player.money -= taxAmount;
      const transaction = {id: `tx_${resolutionId}`, time: new Date().toISOString(), players: [player.name, 'Bank'],
        amount: taxAmount, type: 'TAX', description: `Bayar ${tile.nama}`};
      this.state.transactions.push(transaction);
      const event = this._completeTileResolution({player, turnId, movementId, resolutionId, kind: 'TAX_PAID', landedPosition: tile.pos,
        transaction, taxAmount, message: `${player.name} membayar ${tile.nama} $${taxAmount}.`});
      return event ? {kind: 'TILE_RESOLVED', event} : {kind: 'UNSUPPORTED', event: {message: 'Resolusi petak gagal.'}};
    }
    if (tile?.type === 'corner' && tile.pos === 10) {
      const event = this._completeTileResolution({player, turnId, movementId, resolutionId, kind: 'JAIL_VISIT', landedPosition: 10, message: `${player.name} hanya berkunjung di Penjara.`});
      return event ? {kind: 'TILE_RESOLVED', event} : {kind: 'UNSUPPORTED', event: {message: 'Resolusi petak gagal.'}};
    }
    if (tile?.type === 'corner' && tile.pos === 20) {
      const event = this._completeTileResolution({player, turnId, movementId, resolutionId, kind: 'FREE_PARKING', landedPosition: 20,
        forceEndTurn: true, message: `${player.name} beristirahat di Parkir Bebas. Tidak ada hadiah uang.`});
      return event ? {kind: 'TILE_RESOLVED', event} : {kind: 'UNSUPPORTED', event: {message: 'Resolusi petak gagal.'}};
    }
    if (tile?.type === 'corner' && tile.pos === 30) {
      player.pos = 10; player.status = PlayerStatus.IN_JAIL; player.inJail = true; player.jailTurns = 0;
      player.consecutiveDoubles = 0; this.state.consecutiveDoubles = 0;
      const event = this._completeTileResolution({player, turnId, movementId, resolutionId, kind: 'JAILED', landedPosition: 30,
        resultingPosition: 10, message: `${player.name} masuk Penjara dan dipindahkan ke petak Penjara.`});
      return event ? {kind: 'TILE_RESOLVED', event} : {kind: 'UNSUPPORTED', event: {message: 'Resolusi petak gagal.'}};
    }
    return {kind: 'UNSUPPORTED', event: {roomCode: this.roomCode, playerId: player.playerId, seat: player.seat,
      turnId, resolutionId, movementId, position: player.pos, tileName: tile?.nama || `Petak ${player.pos}`,
      tileType: tile?.type || 'unknown', phase: 'WAITING_TILE_RESOLUTION', message: `Resolusi petak ${tile?.nama || 'ini'} belum tersedia. Giliran tetap menunggu.`}};
  }

  _resolveOwnedProperty({player, property, turnId, movementId, resolutionId}) {
    if (property.owner === player.playerId) {
      const event = this._completeTileResolution({player, turnId, movementId, resolutionId,
        kind: 'OWN_PROPERTY', landedPosition: player.pos, message: `${player.name} mendarat di properti miliknya sendiri.`});
      return event ? {kind: 'TILE_RESOLVED', event} : {kind: 'UNSUPPORTED', event: {message: 'Resolusi petak gagal.'}};
    }
    if (this.processedRentResolutionIds.has(resolutionId)) {
      return {kind: 'UNSUPPORTED', event: {roomCode: this.roomCode, playerId: player.playerId, seat: player.seat,
        turnId, resolutionId, movementId, position: player.pos, tileName: property.name, tileType: property.type,
        phase: 'WAITING_TILE_RESOLUTION', message: 'Resolusi sewa ini sudah pernah diproses.'}};
    }
    const owner = this.state.getPlayerById(property.owner);
    if (!owner || owner.playerId === player.playerId) {
      return {kind: 'UNSUPPORTED', event: {roomCode: this.roomCode, playerId: player.playerId, seat: player.seat,
        turnId, resolutionId, movementId, position: player.pos, tileName: property.name, tileType: property.type,
        phase: 'WAITING_TILE_RESOLUTION', message: 'Data pemilik properti tidak valid; resolusi ditahan.'}};
    }
    this.processedRentResolutionIds.add(resolutionId);
    const amount = property.isMortgaged ? 0 : calculatePropertyRent(property, this.state.properties, this.state.lastRoll?.total || 7);
    const rent = {resolutionId, propertyPos: property.pos, propertyId: property.id, propertyName: property.name,
      propertyType: property.type, tenantId: player.playerId, tenantName: player.name,
      ownerId: owner.playerId, ownerName: owner.name, amount, outcome: property.isMortgaged ? 'MORTGAGED' : 'PAID',
      tenantBalance: player.money, ownerBalance: owner.money, transaction: null};
    const balancesBefore = this.state.players.map(item => ({playerId: item.playerId, money: item.money}));

    if (property.isMortgaged) {
      const event = this._completeTileResolution({player, turnId, movementId, resolutionId, kind: 'RENT_WAIVED',
        landedPosition: player.pos, message: `${property.name} sedang digadaikan; sewa dibebaskan.`});
      if (!event) return {kind: 'UNSUPPORTED', event: {message: 'Resolusi petak gagal.'}};
      return {kind: 'RENT_RESOLVED', event: {...event, rent, balances: balancesBefore}};
    }

    if (player.money < amount) {
      rent.outcome = 'INSUFFICIENT_FUNDS';
      const debtResolution = this._createDebt({player, turnId, movementId, resolutionId,
        debtType: 'RENT', amount, creditorId: owner.playerId, creditorName: owner.name,
        position: property.pos, tileName: property.name, description: `Sewa ${property.name}`});
      return {kind: 'RENT_RESOLVED', event: {roomCode: this.roomCode, resolutionId, movementId,
        playerId: player.playerId, seat: player.seat, previousTurnId: turnId, turnId,
        currentTurn: this.state.currentTurn, round: this.state.round, activePlayerId: this.state.activePlayerId,
        phase: this.state.phase, balance: player.money, rent, debt: debtResolution.event.debt,
        balances: balancesBefore, preRentBalances: balancesBefore,
        message: `${player.name} belum memiliki saldo cukup untuk membayar sewa $${amount}.`, debtEvent: debtResolution.event}};
    }

    player.money -= amount;
    owner.money += amount;
    const transaction = {id: `tx_${resolutionId}`, time: new Date().toISOString(),
      players: [player.name, owner.name], amount, type: 'RENT', description: `${player.name} membayar sewa ${property.name} kepada ${owner.name}`};
    this.state.transactions.push(transaction);
    rent.tenantBalance = player.money;
    rent.ownerBalance = owner.money;
    rent.transaction = transaction;
    const event = this._completeTileResolution({player, turnId, movementId, resolutionId, kind: 'RENT_PAID',
      landedPosition: player.pos, transaction, message: `${player.name} membayar sewa $${amount} kepada ${owner.name}.`});
    if (!event) return {kind: 'UNSUPPORTED', event: {message: 'Resolusi petak gagal.'}};
    return {kind: 'RENT_RESOLVED', event: {...event, rent, preRentBalances: balancesBefore,
      balances: this.state.players.map(item => ({playerId: item.playerId, money: item.money}))}};
  }

  _createDebt({player, turnId, movementId, resolutionId, debtType, amount, creditorId, creditorName, position, tileName,
    description, chanceCard = null, paymentRecipients = null}) {
    if (this.pendingDebt) return {kind: 'UNSUPPORTED', event: {roomCode: this.roomCode, playerId: player.playerId,
      turnId, resolutionId, movementId, position, tileName, tileType: debtType, phase: this.state.phase,
      message: 'Masih ada penyelesaian utang yang belum selesai.'}};
    const debt = {debtId: `debt_${resolutionId}`, playerId: player.playerId, playerName: player.name,
      debtType, amount, creditorId, creditorName, originResolutionId: resolutionId, movementId, turnId,
      position, tileName, description, chanceCard: chanceCard ? {...chanceCard} : null,
      paymentRecipients: paymentRecipients?.map(item => ({...item})) || null, status: 'OPEN'};
    this.pendingDebt = debt;
    this.state.phase = 'DEBT_RESOLUTION';
    const event = {roomCode: this.roomCode, kind: 'DEBT_CREATED', debt: {...debt}, phase: this.state.phase,
      playerId: player.playerId, seat: player.seat, turnId, currentTurn: this.state.currentTurn,
      activePlayerId: this.state.activePlayerId, balance: player.money,
      balances: this.state.players.map(item => ({playerId: item.playerId, money: item.money})),
      message: `${player.name} berutang $${amount} kepada ${creditorName}.`};
    event.debt = this._debtView();
    return {kind: 'DEBT_CREATED', event};
  }

  _chanceMovementEvent({player, turnId, movementId, resolutionId, initialPosition, cards, movements, transactions,
    supported, completion, destinationResolution, offer, presentationId, sourceMovementId = movementId, message}) {
    const presentationPhase = completion?.phase || (destinationResolution?.kind === 'CHANCE_PRESENTATION'
      ? 'CHANCE_PRESENTATION' : offer ? 'WAITING_PROPERTY_DECISION' :
        destinationResolution?.kind === 'DEBT_CREATED' ? 'DEBT_RESOLUTION' : 'WAITING_TILE_RESOLUTION');
    const balances = destinationResolution?.event?.preRentBalances ||
      this.state.players.map(item => ({playerId: item.playerId, money: item.money}));
    const event = {roomCode: this.roomCode, resolutionId, movementId, playerId: player.playerId, seat: player.seat,
      previousTurnId: turnId, initialPosition, position: movements.at(-1)?.endPos ?? player.pos,
      sourceMovementId, ...(presentationId ? {presentationId} : {}),
      resultingPosition: player.pos, landedPosition: movements.at(-1)?.endPos ?? player.pos,
      card: cards[0], cards, movements, destinationResolution: destinationResolution?.kind || null,
      destinationOffer: offer || null, destinationEvent: completion || destinationResolution?.event || null,
      supported, balance: balances.find(item => item.playerId === player.playerId)?.money ?? player.money, balances,
      transactions, phase: presentationPhase, message};
    if (destinationResolution?.event?.debt) event.debt = destinationResolution.event.debt;
    if (completion) Object.assign(event, completion, {movementId: movements.at(-1)?.movementId || movementId,
      resolutionId, previousTurnId: turnId, playerId: player.playerId, seat: player.seat, initialPosition,
      position: movements.at(-1)?.endPos ?? player.pos, resultingPosition: player.pos,
      landedPosition: completion.landedPosition ?? movements.at(-1)?.endPos ?? player.pos, card: cards[0], cards, movements,
      sourceMovementId,
      destinationResolution: destinationResolution?.kind || null, destinationOffer: offer || null,
      destinationEvent: completion, supported: true,
      balances: this.state.players.map(item => ({playerId: item.playerId, money: item.money})), transactions,
      message: message || completion.message});
    return event;
  }

  _completeTileResolution({player, turnId, movementId, resolutionId, kind, landedPosition, resultingPosition = player.pos,
    transaction = null, taxAmount = null, forceEndTurn = false, message}) {
    const completion = this._completeCurrentRoll({player, turnId, forceEndTurn});
    if (!completion) return null;
    return {
      roomCode: this.roomCode,
      resolutionId,
      movementId,
      kind,
      playerId: player.playerId,
      seat: player.seat,
      previousTurnId: turnId,
      landedPosition,
      resultingPosition,
      balance: player.money,
      status: player.status,
      inJail: player.inJail === true,
      jailTurns: player.jailTurns || 0,
      taxAmount,
      transaction,
      message,
      ...completion
    };
  }

  skipPropertyOffer({playerId, turnId, resolutionId}) {
    return this.respondToPropertyOffer({playerId, turnId, resolutionId, decision: 'DECLINE', skipAuction: true});
  }

  respondToPropertyOffer({playerId, turnId, resolutionId, decision, skipAuction = false}) {
    const player = this.state.players[this.state.currentTurn];
    if (!player || player.playerId !== playerId || player.playerId !== this.state.activePlayerId) {
      return {ok: false, error: {code: 'NOT_ACTIVE_PLAYER', message: 'Hanya pemain aktif yang dapat memutuskan penawaran.'}};
    }
    if (!Number.isInteger(turnId) || turnId !== this.state.turnId) {
      return {ok: false, error: {code: 'STALE_TURN', message: 'Giliran sudah berubah.'}};
    }
    const pending = this.pendingResolution;
    if (!pending || this.state.phase !== 'WAITING_PROPERTY_DECISION' ||
        pending.playerId !== playerId || pending.turnId !== turnId || pending.resolutionId !== resolutionId) {
      return {ok: false, error: {code: 'STALE_RESOLUTION', message: 'Penawaran ini sudah kedaluwarsa atau tidak aktif.'}};
    }
    if (decision !== 'BUY' && decision !== 'DECLINE') {
      return {ok: false, error: {code: 'INVALID_DECISION', message: 'Keputusan pembelian tidak valid.'}};
    }

    const property = this.state.properties.get(pending.propertyPos);
    if (!property || property.id !== pending.propertyId || property.owner !== null || property.price !== pending.price) {
      return {ok: false, error: {code: 'PROPERTY_UNAVAILABLE', message: 'Properti sudah tidak tersedia.'}};
    }

    let transaction = null;
    if (decision === 'DECLINE' && !skipAuction) {
      const participants = this.state.players.filter(candidate => candidate.status !== PlayerStatus.BANKRUPT);
      this.activeAuction = {
        auctionId: `${resolutionId}:auction`, roomCode: this.roomCode, resolutionId, turnId,
        initiatorId: player.playerId, propertyPos: property.pos, propertyId: property.id,
        propertyName: property.name, propertyPrice: property.price,
        participantIds: participants.map(candidate => candidate.playerId),
        activeBidderIds: participants.map(candidate => candidate.playerId),
        currentBidderIndex: 0, highestBid: 0, highestBidderId: null, revision: 1
      };
      this.state.phase = 'WAITING_AUCTION_ACTION';
      return {ok: true, result: {roomCode: this.roomCode, type: 'STARTED', auction: this._auctionView(),
        snapshot: this.toPublicSnapshot()}};
    }

    if (decision === 'BUY') {
      if (player.money < property.price) {
        return {ok: false, error: {code: 'INSUFFICIENT_FUNDS', message: 'Saldo tidak cukup untuk membeli properti.'}};
      }
      player.money -= property.price;
      property.owner = player.playerId;
      if (!player.properties.includes(property.id)) player.properties.push(property.id);
      transaction = {
        id: `tx_${resolutionId}`,
        time: new Date().toISOString(),
        players: [player.name],
        amount: property.price,
        type: 'BUY_PROP',
        description: `Membeli properti ${property.name} seharga $${property.price}`
      };
      this.state.transactions.push(transaction);
    }

    this.pendingResolution = null;
    const completion = this._completeCurrentRoll({player, turnId});
    if (!completion) {
      return {ok: false, error: {code: 'TURN_ADVANCE_FAILED', message: 'Giliran berikutnya belum dapat dimulai.'}};
    }

    return {ok: true, result: {
      roomCode: this.roomCode,
      resolutionId,
      decision,
      playerId,
      property: decision === 'BUY' ? {id: property.id, pos: property.pos, name: property.name, owner: property.owner} : null,
      transaction,
      balance: player.money,
      previousTurnId: turnId,
      ...completion
    }};
  }

  _auctionView() {
    const auction = this.activeAuction;
    if (!auction) return null;
    const bidder = id => {
      const player = this.state.players.find(candidate => candidate.playerId === id);
      return player ? {playerId: player.playerId, name: player.name, seat: player.seat, color: player.color,
        money: player.money, status: player.status} : null;
    };
    return {...auction,
      participants: auction.participantIds.map(bidder).filter(Boolean),
      activeBidders: auction.activeBidderIds.map(bidder).filter(Boolean),
      currentBidderId: auction.activeBidderIds[auction.currentBidderIndex] || null,
      highestBidder: bidder(auction.highestBidderId)};
  }

  resolveAuctionAction({playerId, turnId, auctionId, actionId, action, bidAmount}) {
    const auction = this.activeAuction;
    if (!auction || this.state.phase !== 'WAITING_AUCTION_ACTION') {
      return {ok: false, error: {code: 'AUCTION_NOT_ACTIVE', message: 'Tidak ada lelang yang sedang berjalan.'}};
    }
    if (typeof actionId !== 'string' || !actionId || this.processedAuctionActionIds.has(actionId)) {
      return {ok: false, error: {code: 'DUPLICATE_ACTION', message: 'Aksi lelang ini sudah diproses.'}};
    }
    if (auction.auctionId !== auctionId || auction.turnId !== turnId || this.state.turnId !== turnId) {
      return {ok: false, error: {code: 'STALE_AUCTION', message: 'Lelang atau giliran sudah berubah.'}};
    }
    if (auction.activeBidderIds[auction.currentBidderIndex] !== playerId) {
      return {ok: false, error: {code: 'NOT_CURRENT_BIDDER', message: 'Saat ini giliran pemain lain untuk menawar.'}};
    }
    const player = this.state.players.find(candidate => candidate.playerId === playerId);
    if (!player || player.status === PlayerStatus.BANKRUPT) {
      return {ok: false, error: {code: 'BIDDER_INELIGIBLE', message: 'Pemain ini tidak dapat mengikuti lelang.'}};
    }
    if (action !== 'BID' && action !== 'PASS') {
      return {ok: false, error: {code: 'INVALID_AUCTION_ACTION', message: 'Aksi lelang tidak valid.'}};
    }
    if (action === 'BID') {
      if (!Number.isSafeInteger(bidAmount) || bidAmount < 1 || bidAmount <= auction.highestBid) {
        return {ok: false, error: {code: 'INVALID_BID', message: 'Tawaran harus minimal $1 dan lebih tinggi dari tawaran saat ini.'}};
      }
      if (player.money < bidAmount) {
        return {ok: false, error: {code: 'INSUFFICIENT_FUNDS', message: 'Saldo tidak cukup untuk tawaran ini.'}};
      }
      auction.highestBid = bidAmount;
      auction.highestBidderId = playerId;
    }
    this.processedAuctionActionIds.add(actionId);
    if (action === 'PASS') {
      auction.activeBidderIds.splice(auction.currentBidderIndex, 1);
      if (auction.currentBidderIndex >= auction.activeBidderIds.length) auction.currentBidderIndex = 0;
    } else if (auction.activeBidderIds.length > 1) {
      auction.currentBidderIndex = (auction.currentBidderIndex + 1) % auction.activeBidderIds.length;
    }
    auction.revision++;
    if (auction.activeBidderIds.length <= 1 && auction.highestBidderId) return this._finishAuction();
    if (auction.activeBidderIds.length === 0) return this._finishAuction();
    return {ok: true, result: {roomCode: this.roomCode, type: 'UPDATED', auction: this._auctionView(),
      snapshot: this.toPublicSnapshot()}};
  }

  _finishAuction() {
    const auction = this.activeAuction;
    if (!auction) return {ok: false, error: {code: 'AUCTION_NOT_ACTIVE', message: 'Lelang sudah selesai.'}};
    const property = this.state.properties.get(auction.propertyPos);
    const winner = auction.highestBidderId
      ? this.state.players.find(candidate => candidate.playerId === auction.highestBidderId) : null;
    const initiator = this.state.players.find(candidate => candidate.playerId === auction.initiatorId);
    if (!property || property.id !== auction.propertyId || property.owner !== null) {
      return {ok: false, error: {code: 'PROPERTY_UNAVAILABLE', message: 'Properti lelang tidak lagi tersedia.'}};
    }
    if (!initiator || initiator.playerId !== this.state.activePlayerId || this.state.turnId !== auction.turnId) {
      return {ok: false, error: {code: 'STALE_AUCTION', message: 'Giliran lelang sudah berubah.'}};
    }
    let transaction = null;
    if (winner) {
      if (winner.money < auction.highestBid) {
        return {ok: false, error: {code: 'INSUFFICIENT_FUNDS', message: 'Saldo pemenang berubah dan tidak cukup untuk membayar.'}};
      }
      winner.money -= auction.highestBid;
      property.owner = winner.playerId;
      if (!winner.properties.includes(property.id)) winner.properties.push(property.id);
      transaction = {id: `tx_${auction.auctionId}`, time: new Date().toISOString(), players: [winner.name],
        amount: auction.highestBid, type: 'AUCTION', description: `Menang lelang ${property.name} seharga $${auction.highestBid}`};
      this.state.transactions.push(transaction);
    }
    const previousTurnId = auction.turnId;
    this.activeAuction = null;
    this.pendingResolution = null;
    const completion = this._completeCurrentRoll({player: initiator, turnId: previousTurnId});
    if (!completion) return {ok: false, error: {code: 'TURN_ADVANCE_FAILED', message: 'Giliran berikutnya belum dapat dimulai.'}};
    const result = {roomCode: this.roomCode, auctionId: auction.auctionId, resolutionId: auction.resolutionId,
      type: 'ENDED', property: {id: property.id, pos: property.pos, name: property.name, owner: property.owner},
      winner: winner ? {playerId: winner.playerId, name: winner.name, seat: winner.seat} : null,
      amount: winner ? auction.highestBid : 0, transaction, previousTurnId,
      balances: this.state.players.map(candidate => ({playerId: candidate.playerId, money: candidate.money})),
      ...completion};
    return {ok: true, result: {...result, snapshot: this.toPublicSnapshot()}};
  }

  mortgageProperty({playerId, turnId, resolutionId, propertyPos}) {
    return this._resolveMortgageAction({action: 'MORTGAGE', playerId, turnId, resolutionId, propertyPos});
  }

  unmortgageProperty({playerId, turnId, resolutionId, propertyPos}) {
    return this._resolveMortgageAction({action: 'UNMORTGAGE', playerId, turnId, resolutionId, propertyPos});
  }

  _resolveMortgageAction({action, playerId, turnId, resolutionId, propertyPos}) {
    const player = this.state.players[this.state.currentTurn];
    if (!player || player.playerId !== playerId || player.playerId !== this.state.activePlayerId ||
        player.status !== PlayerStatus.ACTIVE) {
      return {ok: false, error: {code: 'NOT_ACTIVE_PLAYER', message: 'Hanya pemain aktif yang dapat mengelola properti.'}};
    }
    if (!Number.isInteger(turnId) || turnId !== this.state.turnId) {
      return {ok: false, error: {code: 'STALE_TURN', message: 'Giliran sudah berubah.'}};
    }
    if (this.state.gameStatus !== GameStatus.IN_GAME || !['WAITING_ROLL', 'PLAYER_ACTION'].includes(this.state.phase)) {
      return {ok: false, error: {code: 'PROPERTY_ACTION_NOT_ALLOWED', message: 'Gadai dan tebus gadai hanya tersedia pada fase aksi pemain.'}};
    }
    if (typeof resolutionId !== 'string' || !resolutionId.trim() || !Number.isInteger(propertyPos)) {
      return {ok: false, error: {code: 'INVALID_PAYLOAD', message: 'Identitas resolusi atau properti tidak valid.'}};
    }
    if (this.processedPropertyFinanceResolutionIds.has(resolutionId)) {
      return {ok: false, error: {code: 'STALE_RESOLUTION', message: 'Transaksi properti ini sudah pernah diproses.'}};
    }
    this.processedPropertyFinanceResolutionIds.add(resolutionId);
    const property = this.state.properties.get(propertyPos);
    if (!property || property.owner !== player.playerId) {
      return {ok: false, error: {code: 'NOT_PROPERTY_OWNER', message: 'Properti ini bukan milik pemain aktif.'}};
    }

    const before = property.isMortgaged === true;
    let amount, transactionType, description;
    if (action === 'MORTGAGE') {
      const eligibility = getMortgageEligibility(property, this.state.properties);
      if (!eligibility.success) return {ok: false, error: {code: 'MORTGAGE_NOT_ALLOWED', message: eligibility.reason}};
      amount = eligibility.value;
      property.isMortgaged = true;
      player.money += amount;
      transactionType = 'MORTGAGE';
      description = `Gadai ${property.name}: +$${amount}`;
    } else if (action === 'UNMORTGAGE') {
      const eligibility = getUnmortgageEligibility(property, this.state.properties, player.money);
      if (!eligibility.success) return {ok: false, error: {code: 'UNMORTGAGE_NOT_ALLOWED', message: eligibility.reason}};
      amount = eligibility.totalCost;
      player.money -= amount;
      property.isMortgaged = false;
      transactionType = 'UNMORTGAGE';
      description = `Tebus gadai ${property.name}: -$${amount}`;
    } else {
      return {ok: false, error: {code: 'INVALID_ACTION', message: 'Aksi properti tidak dikenal.'}};
    }

    const transaction = {id: `tx_${resolutionId}`, time: new Date().toISOString(),
      players: [player.name, 'Bank'], amount, type: transactionType, description};
    this.state.transactions.push(transaction);
    return {ok: true, result: {roomCode: this.roomCode, resolutionId, action, playerId: player.playerId,
      playerName: player.name, seat: player.seat, turnId, currentTurn: this.state.currentTurn,
      activePlayerId: this.state.activePlayerId, phase: this.state.phase, propertyPos, propertyId: property.id,
      propertyName: property.name, owner: property.owner, statusBefore: before, statusAfter: property.isMortgaged,
      amount, balance: player.money, transaction,
      property: {id: property.id, pos: property.pos, name: property.name, owner: property.owner,
        isMortgaged: property.isMortgaged, houses: property.houses || 0, hasHotel: property.hasHotel === true},
      balances: this.state.players.map(item => ({playerId: item.playerId, money: item.money})),
      message: action === 'MORTGAGE'
        ? `${property.name} digadaikan; ${player.name} menerima $${amount}.`
        : `${property.name} ditebus sebesar $${amount} termasuk bunga 10%.`}};
  }

  resolveBuildingAction({playerId, turnId, actionId, action, propertyPos}) {
    const player = this.state.players[this.state.currentTurn];
    if (!player || player.playerId !== playerId || player.playerId !== this.state.activePlayerId ||
        player.status !== PlayerStatus.ACTIVE) {
      return {ok: false, error: {code: 'NOT_ACTIVE_PLAYER', message: 'Hanya pemain aktif yang dapat mengelola bangunan.'}};
    }
    if (!Number.isInteger(turnId) || turnId !== this.state.turnId) {
      return {ok: false, error: {code: 'STALE_TURN', message: 'Giliran sudah berubah.'}};
    }
    if (this.state.gameStatus !== GameStatus.IN_GAME || !['WAITING_ROLL', 'PLAYER_ACTION'].includes(this.state.phase)) {
      return {ok: false, error: {code: 'BUILDING_ACTION_NOT_ALLOWED', message: 'Bangunan hanya dapat dikelola pada fase aksi pemain.'}};
    }
    if (typeof actionId !== 'string' || !actionId.trim() || actionId.length > 128 ||
        !['BUILD_HOUSE', 'BUILD_HOTEL', 'SELL_HOUSE', 'SELL_HOTEL'].includes(action) || !Number.isInteger(propertyPos)) {
      return {ok: false, error: {code: 'INVALID_BUILDING_ACTION', message: 'Data aksi bangunan tidak valid.'}};
    }
    if (this.processedBuildingActionIds.has(actionId)) {
      return {ok: false, error: {code: 'DUPLICATE_ACTION', message: 'Aksi bangunan ini sudah pernah diproses.'}};
    }
    const property = this.state.properties.get(propertyPos);
    if (!property || property.type !== 'prop' || property.owner !== player.playerId) {
      return {ok: false, error: {code: 'NOT_PROPERTY_OWNER', message: 'Kota ini bukan milik pemain aktif.'}};
    }
    const bankHousesBefore = this.state.bankHouses;
    const bankHotelsBefore = this.state.bankHotels;
    let amount, transactionType, description, buildingType;
    if (action === 'BUILD_HOUSE' || action === 'BUILD_HOTEL') {
      const group = [...this.state.properties.values()].filter(candidate => candidate.type === 'prop' && candidate.group === property.group);
      if (action === 'BUILD_HOUSE') {
        if (property.isMortgaged) return {ok: false, error: {code: 'BUILDING_NOT_ALLOWED', message: 'Properti sedang digadaikan.'}};
        if (group.length === 0 || group.some(candidate => candidate.owner !== player.playerId)) return {ok: false, error: {code: 'BUILDING_NOT_ALLOWED', message: 'Wajib memiliki seluruh kota dalam kelompok warna yang sama.'}};
        if (group.some(candidate => candidate.isMortgaged)) return {ok: false, error: {code: 'BUILDING_NOT_ALLOWED', message: 'Ada properti dalam kelompok warna ini yang sedang digadaikan.'}};
        if (property.hasHotel || property.houses >= 4) return {ok: false, error: {code: 'BUILDING_NOT_ALLOWED', message: 'Properti sudah mencapai batas rumah.'}};
        if (property.houses > Math.min(...group.map(candidate => candidate.hasHotel ? 5 : candidate.houses))) return {ok: false, error: {code: 'BUILDING_NOT_ALLOWED', message: 'Pembangunan harus merata.'}};
        if (this.state.bankHouses <= 0) return {ok: false, error: {code: 'BUILDING_STOCK_EMPTY', message: 'Persediaan rumah di Bank telah habis.'}};
        amount = property.housePrice || 50;
        if (player.money < amount) return {ok: false, error: {code: 'INSUFFICIENT_FUNDS', message: `Saldo tidak cukup untuk membangun rumah ($${amount}).`}};
        property.houses++;
        this.state.bankHouses--;
        buildingType = 'HOUSE';
        description = `Membangun 1 rumah di ${property.name}: -$${amount}`;
      } else {
        if (property.isMortgaged) return {ok: false, error: {code: 'BUILDING_NOT_ALLOWED', message: 'Properti sedang digadaikan.'}};
        if (group.length === 0 || group.some(candidate => candidate.owner !== player.playerId)) return {ok: false, error: {code: 'BUILDING_NOT_ALLOWED', message: 'Wajib memiliki seluruh kota dalam kelompok warna yang sama.'}};
        if (group.some(candidate => candidate.isMortgaged)) return {ok: false, error: {code: 'BUILDING_NOT_ALLOWED', message: 'Ada properti dalam kelompok warna ini yang sedang digadaikan.'}};
        if (property.hasHotel || property.houses !== 4 || !group.every(candidate => candidate.houses === 4 || candidate.hasHotel)) return {ok: false, error: {code: 'BUILDING_NOT_ALLOWED', message: 'Seluruh kota dalam kelompok harus memiliki 4 rumah sebelum membangun hotel.'}};
        if (this.state.bankHotels <= 0) return {ok: false, error: {code: 'BUILDING_STOCK_EMPTY', message: 'Persediaan hotel di Bank telah habis.'}};
        amount = property.hotelPrice || property.housePrice || 50;
        if (player.money < amount) return {ok: false, error: {code: 'INSUFFICIENT_FUNDS', message: `Saldo tidak cukup untuk membangun hotel ($${amount}).`}};
        property.houses = 0;
        property.hasHotel = true;
        this.state.bankHouses += 4;
        this.state.bankHotels--;
        buildingType = 'HOTEL';
        description = `Membangun Hotel di ${property.name}: -$${amount}`;
      }
      player.money -= amount;
      transactionType = 'BUILD';
    } else {
      const eligibility = getBuildingSaleEligibility(property, this.state.properties, this.state.bankHouses, action);
      if (!eligibility.success) return {ok: false, error: {code: 'BUILDING_SALE_NOT_ALLOWED', message: eligibility.reason}};
      if (this.state.bankHotels + eligibility.hotelReturned > 12 ||
          this.state.bankHouses + eligibility.bankHouseDelta > 32) {
        return {ok: false, error: {code: 'BUILDING_STOCK_INVALID', message: 'Stok bangunan Bank tidak dapat melebihi jumlah awal.'}};
      }
      amount = eligibility.refund;
      property.houses = eligibility.resultingHouses;
      if (action === 'SELL_HOTEL') property.hasHotel = false;
      this.state.bankHouses += eligibility.bankHouseDelta;
      this.state.bankHotels += eligibility.hotelReturned;
      player.money += amount;
      transactionType = 'SELL_BUILD';
      buildingType = action === 'SELL_HOTEL' ? 'SELL_HOTEL' : 'SELL_HOUSE';
      description = action === 'SELL_HOTEL' ? `Jual Hotel di ${property.name}: +$${amount}` : `Jual 1 rumah di ${property.name}: +$${amount}`;
    }
    const transaction = {id: `tx_building_${actionId}`, time: new Date().toISOString(), players: [player.name, 'Bank'], amount,
      type: transactionType, description};
    this.state.transactions.push(transaction);
    this.processedBuildingActionIds.add(actionId);
    const result = {roomCode: this.roomCode, action, actionId, playerId: player.playerId, playerName: player.name,
      seat: player.seat, turnId, propertyPos, propertyId: property.id, propertyName: property.name, amount,
      balance: player.money, bankHousesBefore, bankHotelsBefore,
      bankHouses: this.state.bankHouses, bankHotels: this.state.bankHotels,
      property: {...property}, transaction, phase: this.state.phase, currentTurn: this.state.currentTurn,
      activePlayerId: this.state.activePlayerId, snapshot: this.toPublicSnapshot(),
      message: `${description}. Saldo sekarang $${player.money}.`};
    return {ok: true, result};
  }

  _debtView() {
    const debt = this.pendingDebt;
    if (!debt) return null;
    const player = this.state.getPlayerById(debt.playerId);
    const owned = [...this.state.properties.values()].filter(property => property.owner === debt.playerId);
    const sellActions = owned.flatMap(property => {
      if (property.hasHotel) {
        const eligibility = getBuildingSaleEligibility(property, this.state.properties, this.state.bankHouses, 'SELL_HOTEL');
        return eligibility.success ? [{action: 'SELL_HOTEL', propertyPos: property.pos, refund: eligibility.refund}] : [];
      }
      const eligibility = getBuildingSaleEligibility(property, this.state.properties, this.state.bankHouses, 'SELL_HOUSE');
      return eligibility.success ? [{action: 'SELL_HOUSE', propertyPos: property.pos, refund: eligibility.refund}] : [];
    });
    const mortgageActions = owned.flatMap(property => {
      const eligibility = getMortgageEligibility(property, this.state.properties);
      return eligibility.success ? [{action: 'MORTGAGE', propertyPos: property.pos, amount: eligibility.value}] : [];
    });
    const estimatedFunds = (player?.money || 0) + owned.reduce((total, property) => {
      if (property.hasHotel) total += Math.floor((property.hotelPrice || property.housePrice || 50) * 0.5);
      if (property.houses > 0) total += Math.floor((property.housePrice || 50) * 0.5) * property.houses;
      if (!property.isMortgaged) total += mortgageValue(property);
      return total;
    }, 0);
    return {...debt, status: 'OPEN', playerBalance: player?.money ?? 0,
      canPay: (player?.money ?? 0) >= debt.amount,
      canDeclareBankruptcy: estimatedFunds < debt.amount,
      sellActions, mortgageActions};
  }

  resolveDebtAction({playerId, turnId, debtId, actionId, action, propertyPos}) {
    const debt = this.pendingDebt;
    const player = this.state.players[this.state.currentTurn];
    if (!debt || !player || debt.playerId !== playerId || player.playerId !== this.state.activePlayerId ||
        player.status === PlayerStatus.BANKRUPT) {
      return {ok: false, error: {code: 'NO_ACTIVE_DEBT', message: 'Pemain ini tidak memiliki utang aktif.'}};
    }
    if (!Number.isInteger(turnId) || turnId !== debt.turnId || turnId !== this.state.turnId || debtId !== debt.debtId) {
      return {ok: false, error: {code: 'STALE_DEBT', message: 'Utang atau giliran ini sudah kedaluwarsa.'}};
    }
    if (this.state.gameStatus !== GameStatus.IN_GAME || this.state.phase !== 'DEBT_RESOLUTION' ||
        typeof actionId !== 'string' || !actionId.trim() || this.processedDebtActionIds.has(actionId)) {
      return {ok: false, error: {code: 'INVALID_DEBT_ACTION', message: 'Aksi penyelesaian utang tidak valid atau sudah diproses.'}};
    }
    if (!['SELL_HOUSE', 'SELL_HOTEL', 'MORTGAGE', 'PAY', 'BANKRUPTCY'].includes(action) ||
        (['SELL_HOUSE', 'SELL_HOTEL', 'MORTGAGE'].includes(action) && !Number.isInteger(propertyPos)) ||
        (!['SELL_HOUSE', 'SELL_HOTEL', 'MORTGAGE'].includes(action) && propertyPos !== undefined)) {
      return {ok: false, error: {code: 'INVALID_DEBT_ACTION', message: 'Data aksi utang tidak valid.'}};
    }
    this.processedDebtActionIds.add(actionId);
    const txId = `tx_debt_${actionId}`;
    let transaction = null, propertyUpdate = null, outcome = 'UPDATED';
    const extraTransactions = [];
    let invalidatedTrades = [];

    if (action === 'SELL_HOUSE' || action === 'SELL_HOTEL') {
      const property = this.state.properties.get(propertyPos);
      if (!property || property.owner !== player.playerId || property.type !== 'prop') {
        return {ok: false, error: {code: 'NOT_PROPERTY_OWNER', message: 'Bangunan ini bukan milik pemain yang berutang.'}};
      }
      const eligibility = getBuildingSaleEligibility(property, this.state.properties, this.state.bankHouses, action);
      if (!eligibility.success) return {ok: false, error: {code: 'BUILDING_SALE_NOT_ALLOWED', message: eligibility.reason}};
      if (this.state.bankHouses + eligibility.bankHouseDelta > 32 ||
          this.state.bankHotels + eligibility.hotelReturned > 12) {
        return {ok: false, error: {code: 'BUILDING_STOCK_INVALID', message: 'Stok bangunan Bank tidak dapat melebihi jumlah awal.'}};
      }
      property.houses = eligibility.resultingHouses;
      property.hasHotel = action === 'SELL_HOTEL' ? false : property.hasHotel;
      this.state.bankHouses = (this.state.bankHouses ?? 32) + eligibility.bankHouseDelta;
      this.state.bankHotels = (this.state.bankHotels ?? 12) + eligibility.hotelReturned;
      player.money += eligibility.refund;
      transaction = {id: txId, time: new Date().toISOString(), players: [player.name, 'Bank'],
        amount: eligibility.refund, type: 'SELL_BUILD',
        description: action === 'SELL_HOUSE' ? `Jual 1 rumah di ${property.name}` : `Jual Hotel di ${property.name}`};
      propertyUpdate = {id: property.id, pos: property.pos, owner: property.owner, houses: property.houses,
        hasHotel: property.hasHotel, isMortgaged: property.isMortgaged};
    } else if (action === 'MORTGAGE') {
      const property = this.state.properties.get(propertyPos);
      if (!property || property.owner !== player.playerId) {
        return {ok: false, error: {code: 'NOT_PROPERTY_OWNER', message: 'Properti ini bukan milik pemain yang berutang.'}};
      }
      const eligibility = getMortgageEligibility(property, this.state.properties);
      if (!eligibility.success) return {ok: false, error: {code: 'MORTGAGE_NOT_ALLOWED', message: eligibility.reason}};
      player.money += eligibility.value;
      property.isMortgaged = true;
      transaction = {id: txId, time: new Date().toISOString(), players: [player.name, 'Bank'],
        amount: eligibility.value, type: 'MORTGAGE', description: `Gadai ${property.name}`};
      propertyUpdate = {id: property.id, pos: property.pos, owner: property.owner, houses: property.houses,
        hasHotel: property.hasHotel, isMortgaged: true};
    } else if (action === 'PAY') {
      if (player.money < debt.amount) return {ok: false, error: {code: 'INSUFFICIENT_FUNDS', message: 'Saldo belum cukup untuk melunasi utang.'}};
      const creditor = ['BANK', 'MULTIPLE'].includes(debt.creditorId) ? null : this.state.getPlayerById(debt.creditorId);
      if (!['BANK', 'MULTIPLE'].includes(debt.creditorId) && (!creditor || creditor.status === PlayerStatus.BANKRUPT)) {
        return {ok: false, error: {code: 'CREDITOR_UNAVAILABLE', message: 'Kreditur tidak tersedia.'}};
      }
      player.money -= debt.amount;
      if (debt.creditorId === 'MULTIPLE') {
        const recipients = debt.paymentRecipients;
        if (!Array.isArray(recipients) || recipients.reduce((sum, item) => sum + item.amount, 0) !== debt.amount ||
            recipients.some(item => !Number.isInteger(item.amount) || item.amount < 0 ||
              !this.state.getPlayerById(item.playerId) || this.state.getPlayerById(item.playerId).status !== PlayerStatus.ACTIVE)) {
          player.money += debt.amount;
          return {ok: false, error: {code: 'INVALID_DEBT_RECIPIENTS', message: 'Daftar penerima utang Chance tidak valid.'}};
        }
        for (const recipient of recipients) {
          const payee = this.state.getPlayerById(recipient.playerId);
          payee.money += recipient.amount;
          extraTransactions.push(this._chanceTransaction(`${actionId}_${recipient.seat}`, 'CARD_PENALTY',
            recipient.amount, [player.name, payee.name], debt.description));
        }
      } else {
        if (creditor) creditor.money += debt.amount;
        const transactionType = debt.debtType === 'RENT' ? 'RENT' : debt.debtType === 'TAX' ? 'TAX' : 'CARD_PENALTY';
        transaction = {id: txId, time: new Date().toISOString(), players: [player.name, creditor?.name || 'Bank'],
          amount: debt.amount, type: transactionType, description: `Melunasi ${debt.description}`};
      }
      outcome = 'PAID';
    } else {
      const estimatedFunds = this._debtView();
      if (!estimatedFunds?.canDeclareBankruptcy) {
        return {ok: false, error: {code: 'BANKRUPTCY_NOT_ALLOWED', message: 'Masih ada aset yang secara aturan dapat digunakan untuk melunasi utang.'}};
      }
      // Single-player Chance PAY_EACH_PLAYER routes insolvency through its generic Bank debt path.
      const creditor = ['BANK', 'MULTIPLE'].includes(debt.creditorId) ? null : this.state.getPlayerById(debt.creditorId);
      const debtorProperties = [...this.state.properties.values()].filter(property => property.owner === player.playerId);
      const jailCards = player.hasGetOutOfJailCard || 0;
      let buildingCash = 0;
      for (const property of debtorProperties) {
        if (property.hasHotel) {
          buildingCash += Math.floor((property.hotelPrice || 50) * 0.5);
          property.hasHotel = false;
          this.state.bankHotels = (this.state.bankHotels ?? 12) + 1;
        }
        if (property.houses > 0) {
          buildingCash += Math.floor((property.housePrice || 50) * 0.5) * property.houses;
          this.state.bankHouses = (this.state.bankHouses ?? 32) + property.houses;
          property.houses = 0;
        }
      }
      const totalCash = player.money + buildingCash;
      player.money = 0;
      player.status = PlayerStatus.BANKRUPT;
      invalidatedTrades = this._invalidatePendingTrades(player.playerId);
      player.consecutiveDoubles = 0;
      player.hasGetOutOfJailCard = 0;
      player.inJail = false;
      player.jailTurns = 0;
      if (creditor) {
        creditor.money += totalCash;
        if (jailCards > 0) creditor.hasGetOutOfJailCard = (creditor.hasGetOutOfJailCard || 0) + jailCards;
        for (const property of debtorProperties) {
          const mortgaged = property.isMortgaged;
          property.owner = creditor.playerId;
          if (!creditor.properties.includes(property.id)) creditor.properties.push(property.id);
          player.properties = player.properties.filter(id => id !== property.id);
          if (mortgaged) {
            const interest = Math.round(mortgageValue(property) * 0.1);
            if (interest > 0 && creditor.money >= interest) {
              creditor.money -= interest;
              const interestTransaction = {id: `${txId}_interest_${property.pos}`, time: new Date().toISOString(),
                players: [creditor.name, 'Bank'], amount: interest, type: 'MORTGAGE',
                description: `Bunga 10% atas penerimaan properti tergadai: ${property.name}`};
              extraTransactions.push(interestTransaction);
            }
          }
        }
      } else {
        for (const property of debtorProperties) {
          property.owner = null;
          property.isMortgaged = false;
          player.properties = player.properties.filter(id => id !== property.id);
        }
      }
      if (totalCash > 0) {
        transaction = {id: txId, time: new Date().toISOString(), players: [player.name, creditor?.name || 'Bank'],
          amount: totalCash, type: 'BANKRUPTCY', description: `${player.name} bangkrut dan menyerahkan sisa dana.`};
      }
      outcome = 'BANKRUPTCY';
    }

    this.state.transactions.push(...extraTransactions);
    if (transaction) this.state.transactions.push(transaction);
    let completedDebt = null, completion, chanceContinuation = null;
    if (outcome === 'UPDATED') {
      this.state.phase = 'DEBT_RESOLUTION';
      completion = {turnId: this.state.turnId, currentTurn: this.state.currentTurn,
        round: this.state.round, activePlayerId: this.state.activePlayerId, phase: this.state.phase};
    } else {
      completedDebt = {...debt, status: outcome, settledByActionId: actionId};
      this.completedDebts.push(completedDebt);
      this.pendingDebt = null;
      const chance = this.pendingChanceResolution;
      this.pendingChanceResolution = null;
      if (outcome === 'BANKRUPTCY' && this.state.players.filter(item => item.status !== PlayerStatus.BANKRUPT).length <= 1) {
        invalidatedTrades.push(...this._invalidatePendingTrades(null, 'GAME_FINISHED'));
        const winner = this.state.players.find(item => item.status !== PlayerStatus.BANKRUPT) || null;
        this.state.gameStatus = GameStatus.FINISHED;
        this.state.phase = 'GAME_OVER';
        this.state.lastRoll = null;
        this.state.consecutiveDoubles = 0;
        completion = {turnId: this.state.turnId, currentTurn: this.state.currentTurn,
          round: this.state.round, activePlayerId: this.state.activePlayerId, phase: 'GAME_OVER',
          gameStatus: GameStatus.FINISHED, winner: winner ? {playerId: winner.playerId, seat: winner.seat, name: winner.name} : null};
      } else {
        if (chance && outcome === 'PAID') {
          if (chance.kind === 'CHAIN') {
            chanceContinuation = this._continueChanceMovement({...chance, current: chance.cards.at(-1), skipCurrentEffect: true});
            completion = chanceContinuation.event || null;
            if (chanceContinuation.kind === 'DEBT_CREATED' || this.pendingDebt) {
              // A resumed chain may create another debt; retain the new authoritative debt.
              this.state.phase = 'DEBT_RESOLUTION';
            }
          } else {
            completion = this._completeTileResolution({player, turnId, movementId: chance.movementId,
              resolutionId: chance.resolutionId, kind: 'CHANCE_RESOLVED', landedPosition: chance.position,
              message: `${chance.card.desc} selesai dibayar.`});
          }
        } else {
          this.state.phase = 'PLAYER_ACTION';
          const advanced = outcome === 'BANKRUPTCY'
            ? (() => {
              this.extraRollAvailable = false;
              if (!this.advanceTurn({playerId: player.playerId, turnId})) return null;
              return {turnId: this.state.turnId, currentTurn: this.state.currentTurn, round: this.state.round,
                activePlayerId: this.state.activePlayerId, phase: this.state.phase,
                gameStatus: this.state.gameStatus, extraRollAllowed: false};
            })()
            : this._completeCurrentRoll({player, turnId});
          if (!advanced) return {ok: false, error: {code: 'TURN_ADVANCE_FAILED', message: 'Giliran berikutnya belum dapat dimulai.'}};
          completion = advanced;
        }
      }
    }
    return {ok: true, result: {roomCode: this.roomCode, type: outcome, actionId, completedDebt,
      debtId, playerId, playerName: player.name, creditorId: debt.creditorId, amount: debt.amount,
      transaction, property: propertyUpdate, balances: this.state.players.map(item => ({playerId: item.playerId, money: item.money})),
      snapshot: this.toPublicSnapshot(), chanceContinuation, invalidatedTrades, ...completion}};
  }

  debtStateEvent(type, result = null) {
    return {roomCode: this.roomCode, type, result, pendingDebt: this._debtView(),
      snapshot: this.toPublicSnapshot()};
  }

  toSnapshot() {
    return {
      version: 1,
      roomCode: this.roomCode,
      extraRollAvailable: this.extraRollAvailable,
      gameState: this.state.toSnapshot(),
      pendingDebt: this.pendingDebt ? {...this.pendingDebt} : null,
      pendingResolution: this.pendingResolution ? {...this.pendingResolution} : null,
      activeAuction: this.activeAuction ? JSON.parse(JSON.stringify(this.activeAuction)) : null,
      pendingChanceResolution: this.pendingChanceResolution ? JSON.parse(JSON.stringify(this.pendingChanceResolution)) : null,
      pendingChancePresentation: this.pendingChancePresentation ? JSON.parse(JSON.stringify(this.pendingChancePresentation)) : null,
      ...(typeof this.chanceDeck.toSnapshot === 'function' ? {chanceDeck: this.chanceDeck.toSnapshot()} : {}),
      completedDebts: this.completedDebts.map(debt => ({...debt})),
      processedDebtActionIds: [...this.processedDebtActionIds],
      processedChanceResolutionIds: [...this.processedChanceResolutionIds],
      processedChanceContinueActions: [...this.processedChanceContinueActions.entries()].map(([id, action]) =>
        [id, JSON.parse(JSON.stringify(action))]),
      processedRentResolutionIds: [...this.processedRentResolutionIds],
      processedPropertyFinanceResolutionIds: [...this.processedPropertyFinanceResolutionIds],
      processedAuctionActionIds: [...this.processedAuctionActionIds],
      processedBuildingActionIds: [...this.processedBuildingActionIds],
      processedJailActionIds: [...this.processedJailActionIds],
      pendingFreeParkingDecision: this.pendingFreeParkingDecision ? {...this.pendingFreeParkingDecision} : null,
      processedFreeParkingActionIds: [...this.processedFreeParkingActionIds],
      processedEndTurnActions: [...this.processedEndTurnActions.entries()].map(([id, action]) => [id, JSON.parse(JSON.stringify(action))]),
      trades: [...this.trades.values()].map(trade => JSON.parse(JSON.stringify(trade))),
      processedTradeActions: [...this.processedTradeActions.entries()].map(([id, action]) => [id, {...action}])
    };
  }

  /** Detached serializable view; excludes server-only room/socket membership details. */
  toPublicSnapshot({viewerPlayerId = null} = {}) {
    const snapshot = this.state.toSnapshot();
    return {
      version: snapshot.version,
      roomCode: this.roomCode,
      gameStatus: snapshot.gameStatus,
      round: snapshot.round,
      currentTurn: snapshot.currentTurn,
      turnId: snapshot.turnId,
      activePlayerId: snapshot.players[snapshot.currentTurn]?.playerId || null,
      consecutiveDoubles: snapshot.consecutiveDoubles,
      lastRoll: snapshot.lastRoll,
      phase: snapshot.phase,
      extraRollAvailable: this.extraRollAvailable,
      pendingChancePresentation: this._chancePresentationView(),
      pendingFreeParkingDecision: this.pendingFreeParkingDecision ? {...this.pendingFreeParkingDecision} : null,
      pendingPropertyOffer: this.pendingResolution && this.state.phase === 'WAITING_PROPERTY_DECISION' ? (() => {
        const property = this.state.properties.get(this.pendingResolution.propertyPos);
        return {roomCode: this.roomCode, ...this.pendingResolution,
          propertyName: property?.name || `Petak ${this.pendingResolution.propertyPos}`};
      })() : null,
      activeAuction: this._auctionView(),
      trades: viewerPlayerId ? [...this.trades.values()].filter(trade =>
        trade.fromPlayerId === viewerPlayerId || trade.toPlayerId === viewerPlayerId).map(trade => this._tradeView(trade)) : [],
      pendingDebt: this._debtView(),
      completedDebts: this.completedDebts.map(debt => ({...debt})),
      bankHouses: snapshot.bankHouses,
      bankHotels: snapshot.bankHotels,
      players: snapshot.players.map(player => ({
        id: player.id,
        playerId: player.playerId,
        seat: player.seat,
        name: player.name,
        isBot: player.isBot === true,
        cn: player.cn,
        color: player.color,
        dark: player.dark,
        money: player.money,
        pos: player.pos,
        status: player.status,
        properties: [...player.properties],
        jailTurns: player.jailTurns,
        inJail: player.inJail,
        hasGetOutOfJailCard: player.hasGetOutOfJailCard,
        consecutiveDoubles: player.consecutiveDoubles
      })),
      properties: snapshot.properties.map(([key, property]) => [key, property]),
      transactions: snapshot.transactions.map(transaction => ({...transaction, players: [...transaction.players]}))
    };
  }

  static fromSnapshot(snapshot) {
    const gameSnapshot = snapshot?.gameState || snapshot;
    validateRoster((gameSnapshot?.players || []).map(player => ({
      playerId: player.playerId,
      playerName: player.name
    })));
    const instance = Object.create(ServerGameState.prototype);
    instance.roomCode = snapshot?.roomCode || '';
    instance.state = GameState.fromSnapshot(gameSnapshot);
    instance._rollInProgress = false;
    instance.extraRollAvailable = snapshot?.extraRollAvailable === true;
    instance.processedEndTurnActions = new Map(Array.isArray(snapshot?.processedEndTurnActions)
      ? snapshot.processedEndTurnActions.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1]?.result)
      : []);
    instance.pendingResolution = snapshot?.pendingResolution ? {...snapshot.pendingResolution} : null;
    instance.activeAuction = snapshot?.activeAuction ? JSON.parse(JSON.stringify(snapshot.activeAuction)) : null;
    instance.pendingDebt = snapshot?.pendingDebt ? {...snapshot.pendingDebt} : null;
    instance.pendingChanceResolution = snapshot?.pendingChanceResolution ? JSON.parse(JSON.stringify(snapshot.pendingChanceResolution)) : null;
    instance.pendingChancePresentation = snapshot?.pendingChancePresentation ? JSON.parse(JSON.stringify(snapshot.pendingChancePresentation)) : null;
    instance.completedDebts = Array.isArray(snapshot?.completedDebts) ? snapshot.completedDebts.map(debt => ({...debt})) : [];
    instance.chanceDeck = snapshot?.chanceDeck ? ChanceDeck.fromSnapshot(snapshot.chanceDeck) : new ChanceDeck();
    instance.processedChanceResolutionIds = new Set(Array.isArray(snapshot?.processedChanceResolutionIds)
      ? snapshot.processedChanceResolutionIds.filter(id => typeof id === 'string') : []);
    instance.processedChanceContinueActions = new Map(Array.isArray(snapshot?.processedChanceContinueActions)
      ? snapshot.processedChanceContinueActions.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1]?.result)
        .map(([id, action]) => [id, JSON.parse(JSON.stringify(action))]) : []);
    instance.processedRentResolutionIds = new Set(Array.isArray(snapshot?.processedRentResolutionIds)
      ? snapshot.processedRentResolutionIds.filter(id => typeof id === 'string') : []);
    instance.processedPropertyFinanceResolutionIds = new Set(Array.isArray(snapshot?.processedPropertyFinanceResolutionIds)
      ? snapshot.processedPropertyFinanceResolutionIds.filter(id => typeof id === 'string') : []);
    instance.processedBuildingActionIds = new Set(Array.isArray(snapshot?.processedBuildingActionIds)
      ? snapshot.processedBuildingActionIds.filter(id => typeof id === 'string') : []);
    instance.processedJailActionIds = new Set(Array.isArray(snapshot?.processedJailActionIds)
      ? snapshot.processedJailActionIds.filter(id => typeof id === 'string') : []);
    instance.pendingFreeParkingDecision = snapshot?.pendingFreeParkingDecision &&
      typeof snapshot.pendingFreeParkingDecision.playerId === 'string' && Number.isInteger(snapshot.pendingFreeParkingDecision.turnId)
      ? {...snapshot.pendingFreeParkingDecision} : null;
    instance.processedFreeParkingActionIds = new Set(Array.isArray(snapshot?.processedFreeParkingActionIds)
      ? snapshot.processedFreeParkingActionIds.filter(id => typeof id === 'string') : []);
    instance.processedDebtActionIds = new Set();
    instance.processedAuctionActionIds = new Set();
    instance.tradeIdGenerator = randomUUID;
    instance.trades = new Map((Array.isArray(snapshot?.trades) ? snapshot.trades : []).map(trade => [trade.tradeId, {...trade,
      offer: {...trade.offer, givePropPositions: [...(trade.offer?.givePropPositions || [])],
        receivePropPositions: [...(trade.offer?.receivePropPositions || [])]}}]));
    instance.processedTradeActions = new Map(Array.isArray(snapshot?.processedTradeActions)
      ? snapshot.processedTradeActions.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1]?.tradeId)
      : []);
    if (Array.isArray(snapshot?.processedDebtActionIds)) {
      snapshot.processedDebtActionIds.filter(id => typeof id === 'string').forEach(id => instance.processedDebtActionIds.add(id));
    }
    if (Array.isArray(snapshot?.processedAuctionActionIds)) {
      snapshot.processedAuctionActionIds.filter(id => typeof id === 'string').forEach(id => instance.processedAuctionActionIds.add(id));
    }
    validateSeats(instance.state.players);
    if (instance.state.gameStatus !== GameStatus.IN_GAME && instance.state.gameStatus !== GameStatus.WAITING && instance.state.gameStatus !== GameStatus.FINISHED) {
      throw new Error('Status permainan pada snapshot tidak valid.');
    }
    return instance;
  }
}

export function createServerGameState(options) {
  return new ServerGameState(options);
}
