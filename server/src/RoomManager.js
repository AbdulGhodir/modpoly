import {createHash, randomBytes, randomInt, randomUUID} from 'node:crypto';
import {createServerGameState} from './game/ServerGameState.js';
import {ROOM_MAX_PLAYERS, ROOM_MIN_PLAYERS} from './game/constants.js';
import {hasOnlyKeys, isValidBoardPosition, isValidIdentifier, isValidTurnId} from './validation.js';

export {ROOM_MAX_PLAYERS, ROOM_MIN_PLAYERS} from './game/constants.js';
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const DEFAULT_SESSION_GRACE_PERIOD_MS = 15 * 60 * 1000;

const failure = (code, message) => ({ok: false, error: {code, message}});
const success = data => ({ok: true, ...data});

export class RoomManager {
  constructor({codeGenerator = () => this.generateRoomCode(), idGenerator = randomUUID, gameStateFactory = createServerGameState,
    diceRoller = () => [randomInt(1, 7), randomInt(1, 7)], movementIdGenerator = randomUUID,
    resolutionIdGenerator = randomUUID, sessionGracePeriodMs = DEFAULT_SESSION_GRACE_PERIOD_MS,
    maxRooms = 500, disconnectAutomationDelayMs = 650,
    onRoomUpdated = () => {}, onAutoAction = () => {}} = {}) {
    this.rooms = new Map();
    this.socketMembership = new Map();
    this.codeGenerator = codeGenerator;
    this.idGenerator = idGenerator;
    this.gameStateFactory = gameStateFactory;
    this.diceRoller = diceRoller;
    this.movementIdGenerator = movementIdGenerator;
    this.resolutionIdGenerator = resolutionIdGenerator;
    this.sessionGracePeriodMs = Number.isFinite(sessionGracePeriodMs) && sessionGracePeriodMs >= 0
      ? Math.floor(sessionGracePeriodMs) : DEFAULT_SESSION_GRACE_PERIOD_MS;
    this.maxRooms = Number.isSafeInteger(maxRooms) && maxRooms > 0 ? maxRooms : 500;
    this.onRoomUpdated = onRoomUpdated;
    this.onAutoAction = onAutoAction;
    this.disconnectAutomationDelayMs = Number.isFinite(disconnectAutomationDelayMs)
      ? Math.max(0, Math.floor(disconnectAutomationDelayMs)) : 650;
    this.disconnectAutomationTimers = new Map();
    this.disconnectJailRetryAttempts = new Map();
    this.sessionsByTokenHash = new Map();
    this.sessionsByPlayer = new Map();
    this.sessionExpiryTimers = new Map();
  }

  setRoomUpdateListener(listener) { this.onRoomUpdated = typeof listener === 'function' ? listener : () => {}; }
  setAutoActionListener(listener) { this.onAutoAction = typeof listener === 'function' ? listener : () => {}; }

  _clearDisconnectAutomation(roomCode) {
    const timer = this.disconnectAutomationTimers.get(roomCode);
    if (timer) clearTimeout(timer);
    this.disconnectAutomationTimers.delete(roomCode);
  }

  scheduleDisconnectedAutomation(roomCode) {
    const room = this.rooms.get(String(roomCode || '').toUpperCase());
    const game = room?.gameState;
    if (!room || room.status !== 'started' || !game || game.state.gameStatus !== 'IN_GAME') return false;
    const active = room.players.find(player => player.playerId === game.state.activePlayerId);
    const activeOffline = active && !active.isConnected &&
      ['WAITING_ROLL', 'PLAYER_ACTION', 'WAITING_PROPERTY_DECISION', 'CHANCE_PRESENTATION'].includes(game.state.phase);
    const auction = game.activeAuction;
    const currentBidderId = auction?.activeBidderIds?.[auction.currentBidderIndex];
    const bidder = currentBidderId && room.players.find(player => player.playerId === currentBidderId);
    const bidderOffline = bidder && !bidder.isConnected;
    if (!activeOffline && !bidderOffline) return false;
    if (this.disconnectAutomationTimers.has(room.roomCode)) return true;
    const timer = setTimeout(() => {
      this.disconnectAutomationTimers.delete(room.roomCode);
      this._runDisconnectedAutomation(room.roomCode).catch(error => {
        console.error(`[disconnect] auto action failed for ${room.roomCode}:`, error?.message || error);
      });
    }, this.disconnectAutomationDelayMs);
    timer.unref?.();
    this.disconnectAutomationTimers.set(room.roomCode, timer);
    return true;
  }

  async _runDisconnectedAutomation(roomCode) {
    const room = this.rooms.get(roomCode);
    const game = room?.gameState;
    if (!room || room.status !== 'started' || !game || game.state.gameStatus !== 'IN_GAME') return false;
    const emit = event => { try { this.onAutoAction(roomCode, event); } catch (error) {
      console.error(`[disconnect] unable to publish auto action for ${roomCode}:`, error?.message || error);
    }};
    const playerId = game.state.activePlayerId;
    const player = room.players.find(item => item.playerId === playerId);
    const turnId = game.state.turnId;
    const phase = game.state.phase;
    if (!player || player.isConnected || !turnId) {
      const auction = game.activeAuction;
      const bidderId = auction?.activeBidderIds?.[auction.currentBidderIndex];
      const bidder = room.players.find(item => item.playerId === bidderId);
      if (bidder?.isConnected === false && auction) {
        const passed = game.resolveAuctionAction({playerId: bidderId, turnId: auction.turnId,
          auctionId: auction.auctionId, actionId: `disconnect-pass-${randomUUID()}`, action: 'PASS'});
        if (passed.ok) emit({type: 'auction', result: passed.result});
        this.scheduleDisconnectedAutomation(roomCode);
        return passed.ok;
      }
      return false;
    }

    if (phase === 'WAITING_ROLL' && game.pendingFreeParkingDecision?.playerId === playerId) {
      const stayed = game.resolveFreeParkingAction({playerId, turnId, actionId: `disconnect-parking-${randomUUID()}`, action: 'STAY'});
      if (!stayed.ok) return false;
      emit({type: 'free-parking', result: stayed.result});
      this.scheduleDisconnectedAutomation(roomCode);
      return true;
    }
    if (phase === 'WAITING_PROPERTY_DECISION') {
      const pending = game.pendingResolution;
      if (!pending || pending.playerId !== playerId) return false;
      const declined = game.skipPropertyOffer({playerId, turnId, resolutionId: pending.resolutionId});
      if (declined.ok) emit({type: 'property', result: declined.result});
      this.scheduleDisconnectedAutomation(roomCode);
      return declined.ok;
    }
    if (phase === 'WAITING_AUCTION_ACTION') {
      const auction = game.activeAuction;
      const bidderId = auction?.activeBidderIds?.[auction.currentBidderIndex];
      const bidder = room.players.find(item => item.playerId === bidderId);
      if (bidder?.isConnected === false && auction) {
        const passed = game.resolveAuctionAction({playerId: bidderId, turnId: auction.turnId,
          auctionId: auction.auctionId, actionId: `disconnect-pass-${randomUUID()}`, action: 'PASS'});
        if (passed.ok) emit({type: 'auction', result: passed.result});
        this.scheduleDisconnectedAutomation(roomCode);
        return passed.ok;
      }
      return false;
    }
    if (phase === 'CHANCE_PRESENTATION') {
      const pending = game.pendingChancePresentation;
      if (!pending || pending.event.playerId !== playerId) return false;
      const continued = game.continueChancePresentation({playerId, turnId, resolutionId: pending.event.resolutionId,
        presentationId: pending.presentationId, actionId: `disconnect-chance-${randomUUID()}`});
      if (continued.ok) emit({type: 'chance-continue', result: continued.result});
      this.scheduleDisconnectedAutomation(roomCode);
      return continued.ok;
    }
    if (phase === 'PLAYER_ACTION' && game.extraRollAvailable !== true) {
      const ended = game.endTurn({playerId, turnId, actionId: `disconnect-end-${randomUUID()}`});
      if (ended.ok) emit({type: 'turn-ended', result: ended.result});
      this.scheduleDisconnectedAutomation(roomCode);
      return ended.ok;
    }
    if (!['WAITING_ROLL', 'PLAYER_ACTION'].includes(phase)) return false;

    const roll = game.rollDice({playerId, turnId, diceRoller: this.diceRoller,
      ...(player.status === 'IN_JAIL' || player.inJail ? {actionId: `disconnect-jail-roll-${randomUUID()}`} : {})});
    if (!roll.ok) {
      if ((player.status === 'IN_JAIL' || player.inJail === true) && phase === 'WAITING_ROLL') {
        const retryKey = `${turnId}:${playerId}`;
        const previous = this.disconnectJailRetryAttempts.get(roomCode);
        const attempts = previous?.key === retryKey ? previous.attempts + 1 : 1;
        if (attempts <= 3) {
          this.disconnectJailRetryAttempts.set(roomCode, {key: retryKey, attempts});
          this.scheduleDisconnectedAutomation(roomCode);
        } else {
          this.disconnectJailRetryAttempts.delete(roomCode);
          console.error(`[disconnect] jail auto-roll stopped after ${attempts - 1} retries for ${roomCode}/${playerId}: ${roll.error?.code || 'UNKNOWN'}`);
        }
      }
      return false;
    }
    this.disconnectJailRetryAttempts.delete(roomCode);
    if (roll.result.jailAttempt && !roll.result.jailReleased) {
      emit({type: 'jail-roll', result: roll.result});
      this.scheduleDisconnectedAutomation(roomCode);
      return true;
    }
    if (roll.result.tripleDouble) {
      const penalty = game.sendToJailForThirdDouble({playerId, turnId, resolutionId: randomUUID()});
      if (penalty.ok) emit({type: 'triple-double', dice: roll.result, penalty: penalty.event});
      this.scheduleDisconnectedAutomation(roomCode);
      return penalty.ok;
    }
    const moved = game.moveCurrentPlayer({playerId, turnId, movementId: this.movementIdGenerator()});
    if (!moved.ok) return false;
    const tile = game.resolveLandedTile({playerId, turnId, movementId: moved.movement.movementId,
      resolutionId: this.resolutionIdGenerator()});
    if (!tile.ok) return false;
    emit({type: 'roll', dice: roll.result, movement: moved.movement, tileResolution: tile.resolution});
    this.scheduleDisconnectedAutomation(roomCode);
    return true;
  }

  _sessionKey(roomCode, playerId) { return `${roomCode}:${playerId}`; }

  _hashSessionToken(token) { return createHash('sha256').update(token).digest('hex'); }

  _issueSession(roomCode, playerId, socketId) {
    const sessionToken = randomBytes(32).toString('base64url');
    const tokenHash = this._hashSessionToken(sessionToken);
    const session = {roomCode, playerId, socketId, sessionToken, tokenHash, previousTokenHash: null, expiresAt: null};
    this.sessionsByTokenHash.set(tokenHash, session);
    this.sessionsByPlayer.set(this._sessionKey(roomCode, playerId), session);
    return sessionToken;
  }

  _clearSessionTimer(key) {
    const timer = this.sessionExpiryTimers.get(key);
    if (timer) clearTimeout(timer);
    this.sessionExpiryTimers.delete(key);
  }

  _revokeSession(roomCode, playerId) {
    const key = this._sessionKey(roomCode, playerId);
    this._clearSessionTimer(key);
    const session = this.sessionsByPlayer.get(key);
    if (!session) return;
    this.sessionsByTokenHash.delete(session.tokenHash);
    if (session.previousTokenHash) this.sessionsByTokenHash.delete(session.previousTokenHash);
    this.sessionsByPlayer.delete(key);
  }

  _scheduleSessionExpiry(session) {
    const key = this._sessionKey(session.roomCode, session.playerId);
    this._clearSessionTimer(key);
    const expectedExpiry = session.expiresAt;
    const timer = setTimeout(() => this._expireSession(session, expectedExpiry), Math.max(0, expectedExpiry - Date.now()));
    timer.unref?.();
    this.sessionExpiryTimers.set(key, timer);
  }

  _expireSession(session, expectedExpiry = session.expiresAt) {
    if (!session || session.expiresAt !== expectedExpiry || expectedExpiry > Date.now()) return false;
    const key = this._sessionKey(session.roomCode, session.playerId);
    const room = this.rooms.get(session.roomCode);
    const player = room?.players.find(item => item.playerId === session.playerId);
    if (!room || !player || player.isConnected) return false;
    if (room.status === 'started' && room.gameState?.state?.gameStatus === 'IN_GAME') {
      // An in-game player cannot be removed without a quit/bankruptcy resolution.
      // Keep the bearer session recoverable so an interrupted turn cannot be orphaned.
      session.expiresAt = null;
      this.sessionExpiryTimers.delete(key);
      this.onRoomUpdated(this.getPublicRoom(room.roomCode), room.roomCode);
      return true;
    }
    this._revokeSession(session.roomCode, session.playerId);
    player.sessionExpired = true;
    if (room.status === 'waiting') {
      room.players = room.players.filter(item => item.playerId !== player.playerId);
      if (room.hostPlayerId === player.playerId && room.players.length) room.hostPlayerId = room.players[0].playerId;
      if (room.players.length === 0) {
        this.rooms.delete(room.roomCode);
        this.onRoomUpdated(null, room.roomCode);
        return true;
      }
    }
    this.sessionExpiryTimers.delete(key);
    this.onRoomUpdated(this.getPublicRoom(room.roomCode), room.roomCode);
    return true;
  }

  _disconnectMember(socketId, membership, room) {
    this.socketMembership.delete(socketId);
    const player = room?.players.find(item => item.playerId === membership.playerId);
    if (!player || player.socketId !== socketId) return null;
    player.socketId = null;
    player.isConnected = false;
    const session = this.sessionsByPlayer.get(this._sessionKey(room.roomCode, player.playerId));
    if (session) {
      session.socketId = null;
      session.expiresAt = Date.now() + this.sessionGracePeriodMs;
      this._scheduleSessionExpiry(session);
    }
    return player;
  }

  generateRoomCode() {
    let code = '';
    for (let index = 0; index < ROOM_CODE_LENGTH; index++) {
      code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    }
    return code;
  }

  _allocateRoomCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = String(this.codeGenerator()).trim().toUpperCase();
      if (/^[A-HJ-KM-NP-Z2-9]{6}$/.test(code) && !this.rooms.has(code)) return code;
    }
    return null;
  }

  _makePlayer(socketId, playerName) {
    const player = {
      playerId: this.idGenerator(),
      socketId,
      playerName,
      isReady: false,
      isConnected: true,
      joinedAt: new Date().toISOString()
    };
    return player;
  }

  createRoom({socketId, playerName}) {
    if (!socketId || this.socketMembership.has(socketId)) {
      return failure('ALREADY_IN_ROOM', 'Socket ini sudah menjadi anggota room.');
    }
    if (this.rooms.size >= this.maxRooms) return failure('ROOM_CAPACITY', 'Server sedang penuh. Coba buat room lagi nanti.');
    const roomCode = this._allocateRoomCode();
    if (!roomCode) return failure('ROOM_CODE_UNAVAILABLE', 'Kode room belum dapat dibuat. Coba lagi.');

    const host = this._makePlayer(socketId, playerName);
    const room = {
      roomCode,
      hostPlayerId: host.playerId,
      players: [host],
      status: 'waiting',
      createdAt: new Date().toISOString(),
      gameState: null
    };
    this.rooms.set(roomCode, room);
    this.socketMembership.set(socketId, {roomCode, playerId: host.playerId});
    const sessionToken = this._issueSession(roomCode, host.playerId, socketId);
    return success({room: this.getPublicRoom(roomCode), playerId: host.playerId, sessionToken});
  }

  joinRoom({socketId, roomCode, playerName}) {
    if (!socketId || this.socketMembership.has(socketId)) {
      return failure('ALREADY_IN_ROOM', 'Tinggalkan room saat ini sebelum bergabung ke room lain.');
    }
    const normalizedCode = String(roomCode || '').trim().toUpperCase();
    if (!/^[A-HJ-KM-NP-Z2-9]{6}$/.test(normalizedCode)) {
      return failure('INVALID_ROOM_CODE', 'Format kode room tidak valid.');
    }
    const room = this.rooms.get(normalizedCode);
    if (!room) return failure('ROOM_NOT_FOUND', 'Room tidak ditemukan atau sudah ditutup.');
    if (room.status !== 'waiting') return failure('ROOM_STARTED', 'Room sudah dimulai.');
    if (room.players.length >= ROOM_MAX_PLAYERS) return failure('ROOM_FULL', 'Room sudah penuh.');

    const player = this._makePlayer(socketId, playerName);
    room.players.push(player);
    this.socketMembership.set(socketId, {roomCode: normalizedCode, playerId: player.playerId});
    const sessionToken = this._issueSession(normalizedCode, player.playerId, socketId);
    return success({room: this.getPublicRoom(normalizedCode), playerId: player.playerId, sessionToken});
  }

  resumeSession({socketId, sessionToken, roomCode}) {
    if (typeof socketId !== 'string' || !socketId) return failure('INVALID_SOCKET', 'Koneksi Socket.IO tidak valid.');
    if (typeof sessionToken !== 'string' || sessionToken.length < 32 || sessionToken.length > 128) {
      return failure('INVALID_SESSION', 'Token sesi tidak valid atau sudah kedaluwarsa.');
    }
    const tokenHash = this._hashSessionToken(sessionToken);
    const session = this.sessionsByTokenHash.get(tokenHash);
    if (!session) return failure('INVALID_SESSION', 'Token sesi tidak valid atau sudah kedaluwarsa.');
    if (roomCode !== undefined && (typeof roomCode !== 'string' || roomCode.trim().toUpperCase() !== session.roomCode)) {
      return failure('SESSION_ROOM_MISMATCH', 'Token sesi tidak cocok dengan room yang diminta.');
    }
    const existingMembership = this.socketMembership.get(socketId);
    if (existingMembership) {
      if (existingMembership.roomCode === session.roomCode && existingMembership.playerId === session.playerId &&
          session.socketId === socketId) {
        const room = this.rooms.get(session.roomCode);
        return room ? success({room: this.getPublicRoom(session.roomCode), playerId: session.playerId,
          sessionToken: session.sessionToken, replacedSocketId: null,
          snapshot: room.status === 'started' && room.gameState ? room.gameState.toPublicSnapshot() : null})
          : failure('ROOM_NOT_FOUND', 'Room sesi sudah tidak tersedia.');
      }
      return failure('ALREADY_IN_ROOM', 'Socket ini sudah memiliki keanggotaan room.');
    }
    if (session.expiresAt !== null && session.expiresAt <= Date.now()) {
      this._expireSession(session, session.expiresAt);
      return failure('SESSION_EXPIRED', 'Masa pemulihan sesi sudah habis.');
    }
    const isPreviousToken = tokenHash === session.previousTokenHash;
    if (isPreviousToken) {
      if (session.socketId) return failure('SESSION_ALREADY_MOVED', 'Token sesi ini sudah dipindahkan ke koneksi lain.');
      // Permit an old token only after its replacement connection has disconnected;
      // this also recovers the client if the rotated-token acknowledgement was lost.
    }

    const room = this.rooms.get(session.roomCode);
    const player = room?.players.find(item => item.playerId === session.playerId);
    if (!room || !player || player.sessionExpired) {
      this._revokeSession(session.roomCode, session.playerId);
      return failure('SESSION_EXPIRED', 'Pemain tidak lagi terdaftar untuk pemulihan sesi.');
    }
    const replacedSocketId = player.isConnected && player.socketId ? player.socketId : null;
    if (replacedSocketId) this.socketMembership.delete(replacedSocketId);
    player.socketId = socketId;
    player.isConnected = true;
    session.socketId = socketId;
    session.expiresAt = null;
    const key = this._sessionKey(session.roomCode, session.playerId);
    this._clearSessionTimer(key);
    this._clearDisconnectAutomation(session.roomCode);
    this.disconnectJailRetryAttempts.delete(session.roomCode);

    // Rotate the bearer token. The immediately previous token is accepted only as an
    // idempotent retry from this same replacement socket, never as another takeover.
    if (session.previousTokenHash) this.sessionsByTokenHash.delete(session.previousTokenHash);
    const oldHash = session.tokenHash;
    const newToken = randomBytes(32).toString('base64url');
    const newHash = this._hashSessionToken(newToken);
    session.previousTokenHash = oldHash;
    session.tokenHash = newHash;
    session.sessionToken = newToken;
    this.sessionsByTokenHash.set(oldHash, session);
    this.sessionsByTokenHash.set(newHash, session);
    this.socketMembership.set(socketId, {roomCode: room.roomCode, playerId: player.playerId});
    const snapshot = room.status === 'started' && room.gameState ? room.gameState.toPublicSnapshot() : null;
    this.scheduleDisconnectedAutomation(room.roomCode);
    return success({room: this.getPublicRoom(room.roomCode), playerId: player.playerId, sessionToken: newToken,
      replacedSocketId, snapshot});
  }

  setReady(socketId, isReady) {
    if (typeof isReady !== 'boolean') return failure('INVALID_READY_STATE', 'Status ready tidak valid.');
    const membership = this.socketMembership.get(socketId);
    if (!membership) return failure('NOT_IN_ROOM', 'Pemain tidak sedang berada di room.');
    const room = this.rooms.get(membership.roomCode);
    if (!room) return failure('ROOM_NOT_FOUND', 'Room tidak ditemukan.');
    if (room.status !== 'waiting') return failure('ROOM_STARTED', 'Status ready tidak dapat diubah setelah permainan dimulai.');
    const player = room.players.find(item => item.playerId === membership.playerId);
    if (!player || player.socketId !== socketId) return failure('PLAYER_NOT_FOUND', 'Identitas pemain tidak valid.');
    player.isReady = isReady;
    return success({room: this.getPublicRoom(room.roomCode)});
  }

  startRoom(socketId) {
    const membership = this.socketMembership.get(socketId);
    if (!membership) return failure('NOT_IN_ROOM', 'Pemain tidak sedang berada di room.');
    const room = this.rooms.get(membership.roomCode);
    if (!room) return failure('ROOM_NOT_FOUND', 'Room tidak ditemukan.');
    if (membership.playerId !== room.hostPlayerId) return failure('HOST_ONLY', 'Hanya host yang dapat memulai permainan.');
    if (room.status !== 'waiting') return failure('ROOM_STARTED', 'Room sudah dimulai.');
    if (room.players.length < ROOM_MIN_PLAYERS) {
      return failure('NOT_ENOUGH_PLAYERS', `Minimal ${ROOM_MIN_PLAYERS} pemain diperlukan untuk memulai.`);
    }
    if (room.players.length > ROOM_MAX_PLAYERS) return failure('ROOM_FULL', 'Jumlah pemain melebihi kapasitas room.');
    if (room.players.some(player => !player.isReady)) {
      return failure('PLAYERS_NOT_READY', 'Semua pemain harus Ready sebelum permainan dimulai.');
    }

    // Acak urutan giliran pemain sebelum membuat GameState (Fisher-Yates shuffle)
    for (let i = room.players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [room.players[i], room.players[j]] = [room.players[j], room.players[i]];
    }

    let gameState;
    try {
      gameState = this.gameStateFactory({
        roomCode: room.roomCode,
        roster: room.players.map(({playerId, playerName}) => ({playerId, playerName}))
      });
      if (!gameState || !gameState.state || typeof gameState.toSnapshot !== 'function') {
        throw new Error('Factory tidak menghasilkan ServerGameState yang valid.');
      }
    } catch (error) {
      return failure('GAME_STATE_CREATION_FAILED', 'GameState room gagal dibuat. Room tetap menunggu dan dapat dicoba lagi.');
    }

    room.gameState = gameState;
    room.status = 'started';
    return success({room: this.getPublicRoom(room.roomCode)});
  }

  requestRoll(socketId, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !hasOnlyKeys(payload, ['turnId', 'actionId']) || !isValidTurnId(payload.turnId) ||
        (payload.actionId !== undefined && !isValidIdentifier(payload.actionId))) {
      return failure('INVALID_PAYLOAD', 'Permintaan dadu hanya boleh berisi turnId dan actionId opsional yang valid.');
    }
    const membership = this.socketMembership.get(socketId);
    if (!membership) return failure('NOT_IN_ROOM', 'Pemain tidak sedang terhubung sebagai anggota room.');
    const room = this.rooms.get(membership.roomCode);
    if (!room || room.status !== 'started' || !room.gameState) {
      return failure('ROOM_NOT_STARTED', 'Permainan room belum dimulai.');
    }
    const member = room.players.find(player => player.playerId === membership.playerId);
    if (!member || member.socketId !== socketId || member.isConnected !== true) {
      return failure('NOT_IN_ROOM', 'Identitas koneksi pemain tidak lagi aktif.');
    }
    const diceResult = room.gameState.rollDice({
      playerId: membership.playerId,
      turnId: payload.turnId,
      actionId: payload.actionId,
      diceRoller: this.diceRoller
    });
    if (!diceResult.ok) return diceResult;
    if (diceResult.result.jailAttempt && !diceResult.result.jailReleased) {
      return {ok: true, result: {...diceResult.result}};
    }
    if (diceResult.result.tripleDouble) {
      const jailPenalty = room.gameState.sendToJailForThirdDouble({
        playerId: membership.playerId,
        turnId: payload.turnId,
        resolutionId: this.resolutionIdGenerator()
      });
      if (!jailPenalty.ok) return jailPenalty;
      return {ok: true, result: {
        ...diceResult.result,
        jailPenalty: jailPenalty.event
      }};
    }
    const movementResult = room.gameState.moveCurrentPlayer({
      playerId: membership.playerId,
      turnId: payload.turnId,
      movementId: this.movementIdGenerator()
    });
    if (!movementResult.ok) return movementResult;
    const tileResolution = room.gameState.resolveLandedTile({
      playerId: membership.playerId,
      turnId: payload.turnId,
      movementId: movementResult.movement.movementId,
      resolutionId: this.resolutionIdGenerator()
    });
    if (!tileResolution.ok) return tileResolution;
    return {ok: true, result: {
      ...diceResult.result,
      movement: movementResult.movement,
      tileResolution: tileResolution.resolution
    }};
  }

  endTurn(socketId, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !hasOnlyKeys(payload, ['turnId', 'actionId']) || !isValidTurnId(payload.turnId) ||
        !isValidIdentifier(payload.actionId)) {
      return failure('INVALID_PAYLOAD', 'Permintaan selesai giliran harus berisi turnId dan actionId yang valid.');
    }
    const membership = this.socketMembership.get(socketId);
    if (!membership) return failure('NOT_IN_ROOM', 'Pemain tidak sedang terhubung sebagai anggota room.');
    const room = this.rooms.get(membership.roomCode);
    if (!room || room.status !== 'started' || !room.gameState) {
      return failure('ROOM_NOT_STARTED', 'Permainan room belum dimulai.');
    }
    const member = room.players.find(player => player.playerId === membership.playerId);
    if (!member || member.socketId !== socketId || member.isConnected !== true) {
      return failure('NOT_IN_ROOM', 'Identitas koneksi pemain tidak lagi aktif.');
    }
    return room.gameState.endTurn({...payload, playerId: membership.playerId});
  }

  resolveJailAction(socketId, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !hasOnlyKeys(payload, ['turnId', 'actionId', 'action']) ||
        !isValidTurnId(payload.turnId) || !isValidIdentifier(payload.actionId) ||
        !['PAY_BAIL', 'USE_CARD'].includes(payload.action)) {
      return failure('INVALID_PAYLOAD', 'Aksi penjara harus berisi turnId, actionId, dan action yang valid.');
    }
    const membership = this.socketMembership.get(socketId);
    if (!membership) return failure('NOT_IN_ROOM', 'Pemain tidak sedang terhubung sebagai anggota room.');
    const room = this.rooms.get(membership.roomCode);
    if (!room || room.status !== 'started' || !room.gameState) return failure('ROOM_NOT_STARTED', 'Permainan room belum dimulai.');
    const member = room.players.find(player => player.playerId === membership.playerId);
    if (!member || member.socketId !== socketId || member.isConnected !== true) return failure('NOT_IN_ROOM', 'Identitas koneksi pemain tidak lagi aktif.');
    const result = room.gameState.resolveJailAction({playerId: membership.playerId, ...payload});
    return result.ok ? {ok: true, result: {...result.result}} : result;
  }

  resolveFreeParkingAction(socketId, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !hasOnlyKeys(payload, ['turnId', 'actionId', 'action', 'targetPos']) ||
        !isValidTurnId(payload.turnId) || !isValidIdentifier(payload.actionId) || !['STAY', 'TRAVEL'].includes(payload.action) ||
        (payload.action === 'TRAVEL' && !isValidBoardPosition(payload.targetPos)) ||
        (payload.action === 'STAY' && Object.hasOwn(payload, 'targetPos'))) {
      return failure('INVALID_PAYLOAD', 'Aksi Parkir Bebas harus berisi turnId, actionId, pilihan, dan tujuan perjalanan yang valid.');
    }
    const membership = this.socketMembership.get(socketId);
    if (!membership) return failure('NOT_IN_ROOM', 'Pemain tidak sedang terhubung sebagai anggota room.');
    const room = this.rooms.get(membership.roomCode);
    if (!room || room.status !== 'started' || !room.gameState) return failure('ROOM_NOT_STARTED', 'Permainan room belum dimulai.');
    const member = room.players.find(player => player.playerId === membership.playerId);
    if (!member || member.socketId !== socketId || member.isConnected !== true) return failure('NOT_IN_ROOM', 'Identitas koneksi pemain tidak lagi aktif.');
    const result = room.gameState.resolveFreeParkingAction({playerId: membership.playerId, ...payload,
      movementId: payload.action === 'TRAVEL' ? this.movementIdGenerator() : undefined,
      resolutionId: payload.action === 'TRAVEL' ? this.resolutionIdGenerator() : undefined});
    return result.ok ? {ok: true, result: {...result.result}} : result;
  }

  continueChancePresentation(socketId, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !hasOnlyKeys(payload, ['turnId', 'resolutionId', 'presentationId', 'actionId']) ||
        !isValidTurnId(payload.turnId) || !isValidIdentifier(payload.resolutionId) ||
        !isValidIdentifier(payload.presentationId) || !isValidIdentifier(payload.actionId)) {
      return failure('INVALID_PAYLOAD', 'Lanjutkan harus berisi turnId, resolutionId, presentationId, dan actionId yang valid.');
    }
    const membership = this.socketMembership.get(socketId);
    if (!membership) return failure('NOT_IN_ROOM', 'Pemain tidak sedang terhubung sebagai anggota room.');
    const room = this.rooms.get(membership.roomCode);
    const member = room?.players.find(player => player.playerId === membership.playerId);
    if (!room || room.status !== 'started' || !room.gameState || !member || member.socketId !== socketId || !member.isConnected) {
      return failure('NOT_IN_ROOM', 'Identitas koneksi pemain tidak lagi aktif.');
    }
    return room.gameState.continueChancePresentation({...payload, playerId: membership.playerId});
  }

  resolvePropertyDecision(socketId, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !hasOnlyKeys(payload, ['turnId', 'resolutionId', 'decision']) ||
        !isValidTurnId(payload.turnId) || !isValidIdentifier(payload.resolutionId) ||
        !['BUY', 'DECLINE'].includes(payload.decision)) {
      return failure('INVALID_PAYLOAD', 'Keputusan hanya boleh berisi turnId, resolutionId, dan pilihan BUY atau DECLINE.');
    }
    const membership = this.socketMembership.get(socketId);
    if (!membership) return failure('NOT_IN_ROOM', 'Pemain tidak sedang terhubung sebagai anggota room.');
    const room = this.rooms.get(membership.roomCode);
    if (!room || room.status !== 'started' || !room.gameState) {
      return failure('ROOM_NOT_STARTED', 'Permainan room belum dimulai.');
    }
    const member = room.players.find(player => player.playerId === membership.playerId);
    if (!member || member.socketId !== socketId || member.isConnected !== true) {
      return failure('NOT_IN_ROOM', 'Identitas koneksi pemain tidak lagi aktif.');
    }
    return room.gameState.respondToPropertyOffer({
      playerId: membership.playerId,
      turnId: payload.turnId,
      resolutionId: payload.resolutionId,
      decision: payload.decision
    });
  }

  resolveAuctionAction(socketId, payload) {
    const allowed = ['turnId', 'auctionId', 'actionId', 'action', 'bidAmount'];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !hasOnlyKeys(payload, allowed) ||
        !isValidTurnId(payload.turnId) || !isValidIdentifier(payload.auctionId) ||
        !isValidIdentifier(payload.actionId) ||
        !['BID', 'PASS'].includes(payload.action) ||
        (payload.action === 'BID' && !Number.isSafeInteger(payload.bidAmount)) ||
        (payload.action === 'PASS' && Object.hasOwn(payload, 'bidAmount'))) {
      return failure('INVALID_PAYLOAD', 'Aksi lelang hanya boleh berisi turnId, auctionId, actionId, action, dan bidAmount yang valid.');
    }
    const membership = this.socketMembership.get(socketId);
    if (!membership) return failure('NOT_IN_ROOM', 'Pemain tidak sedang terhubung sebagai anggota room.');
    const room = this.rooms.get(membership.roomCode);
    if (!room || room.status !== 'started' || !room.gameState) {
      return failure('ROOM_NOT_STARTED', 'Permainan room belum dimulai.');
    }
    const member = room.players.find(player => player.playerId === membership.playerId);
    if (!member || member.socketId !== socketId || member.isConnected !== true) {
      return failure('NOT_IN_ROOM', 'Identitas koneksi pemain tidak lagi aktif.');
    }
    return room.gameState.resolveAuctionAction({...payload, playerId: membership.playerId});
  }

  createTradeOffer(socketId, payload) {
    const allowed = ['turnId', 'actionId', 'toPlayerId', 'offer'];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !hasOnlyKeys(payload, allowed) || !isValidTurnId(payload.turnId) ||
        !isValidIdentifier(payload.actionId) || !isValidIdentifier(payload.toPlayerId) ||
        !payload.offer || typeof payload.offer !== 'object' || Array.isArray(payload.offer)) {
      return failure('INVALID_PAYLOAD', 'Penawaran trade hanya boleh memuat turnId, actionId, penerima, dan aset yang ditawarkan.');
    }
    const membership = this.socketMembership.get(socketId);
    if (!membership) return failure('NOT_IN_ROOM', 'Pemain tidak sedang terhubung sebagai anggota room.');
    const room = this.rooms.get(membership.roomCode);
    if (!room || room.status !== 'started' || !room.gameState) {
      return failure('ROOM_NOT_STARTED', 'Permainan room belum dimulai.');
    }
    const member = room.players.find(player => player.playerId === membership.playerId);
    if (!member || member.socketId !== socketId || member.isConnected !== true) {
      return failure('NOT_IN_ROOM', 'Identitas koneksi pemain tidak lagi aktif.');
    }
    return room.gameState.createTradeOffer({...payload, playerId: membership.playerId});
  }

  resolveTradeAction(socketId, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !hasOnlyKeys(payload, ['tradeId', 'actionId', 'action']) ||
        !isValidIdentifier(payload.tradeId) || !isValidIdentifier(payload.actionId) ||
        !['ACCEPT', 'REJECT', 'CANCEL'].includes(payload.action)) {
      return failure('INVALID_PAYLOAD', 'Aksi trade hanya boleh memuat tradeId, actionId, dan ACCEPT, REJECT, atau CANCEL.');
    }
    const membership = this.socketMembership.get(socketId);
    if (!membership) return failure('NOT_IN_ROOM', 'Pemain tidak sedang terhubung sebagai anggota room.');
    const room = this.rooms.get(membership.roomCode);
    if (!room || room.status !== 'started' || !room.gameState) {
      return failure('ROOM_NOT_STARTED', 'Permainan room belum dimulai.');
    }
    const member = room.players.find(player => player.playerId === membership.playerId);
    if (!member || member.socketId !== socketId || member.isConnected !== true) {
      return failure('NOT_IN_ROOM', 'Identitas koneksi pemain tidak lagi aktif.');
    }
    return room.gameState.resolveTradeAction({...payload, playerId: membership.playerId});
  }

  resolveBuildingAction(socketId, payload) {
    const allowed = ['turnId', 'actionId', 'action', 'propertyPos'];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !hasOnlyKeys(payload, allowed) || !isValidTurnId(payload.turnId) ||
        !isValidIdentifier(payload.actionId) ||
        !['BUILD_HOUSE', 'BUILD_HOTEL', 'SELL_HOUSE', 'SELL_HOTEL'].includes(payload.action) ||
        !isValidBoardPosition(payload.propertyPos)) {
      return failure('INVALID_PAYLOAD', 'Aksi bangunan hanya boleh memuat giliran, actionId, jenis aksi, dan posisi properti.');
    }
    const membership = this.socketMembership.get(socketId);
    if (!membership) return failure('NOT_IN_ROOM', 'Pemain tidak sedang terhubung sebagai anggota room.');
    const room = this.rooms.get(membership.roomCode);
    if (!room || room.status !== 'started' || !room.gameState) {
      return failure('ROOM_NOT_STARTED', 'Permainan room belum dimulai.');
    }
    const member = room.players.find(player => player.playerId === membership.playerId);
    if (!member || member.socketId !== socketId || member.isConnected !== true) {
      return failure('NOT_IN_ROOM', 'Identitas koneksi pemain tidak lagi aktif.');
    }
    return room.gameState.resolveBuildingAction({...payload, playerId: membership.playerId});
  }

  resolveMortgageAction(socketId, payload, action) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !hasOnlyKeys(payload, ['turnId', 'resolutionId', 'propertyPos']) ||
        !isValidTurnId(payload.turnId) || !isValidIdentifier(payload.resolutionId) ||
        !isValidBoardPosition(payload.propertyPos) || !['MORTGAGE', 'UNMORTGAGE'].includes(action)) {
      return failure('INVALID_PAYLOAD', 'Aksi hanya boleh berisi turnId, resolutionId, dan propertyPos yang valid.');
    }
    const membership = this.socketMembership.get(socketId);
    if (!membership) return failure('NOT_IN_ROOM', 'Pemain tidak sedang terhubung sebagai anggota room.');
    const room = this.rooms.get(membership.roomCode);
    if (!room || room.status !== 'started' || !room.gameState) {
      return failure('ROOM_NOT_STARTED', 'Permainan room belum dimulai.');
    }
    const member = room.players.find(player => player.playerId === membership.playerId);
    if (!member || member.socketId !== socketId || member.isConnected !== true) {
      return failure('NOT_IN_ROOM', 'Identitas koneksi pemain tidak lagi aktif.');
    }
    const args = {playerId: membership.playerId, turnId: payload.turnId,
      resolutionId: payload.resolutionId, propertyPos: payload.propertyPos};
    return action === 'MORTGAGE'
      ? room.gameState.mortgageProperty(args)
      : room.gameState.unmortgageProperty(args);
  }

  resolveDebtAction(socketId, payload) {
    const allowedKeys = ['turnId', 'debtId', 'actionId', 'action', 'propertyPos'];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !hasOnlyKeys(payload, allowedKeys) || !isValidTurnId(payload.turnId) ||
        !isValidIdentifier(payload.debtId) || !isValidIdentifier(payload.actionId) ||
        !['SELL_HOUSE', 'SELL_HOTEL', 'MORTGAGE', 'PAY', 'BANKRUPTCY'].includes(payload.action) ||
        (['SELL_HOUSE', 'SELL_HOTEL', 'MORTGAGE'].includes(payload.action) && !isValidBoardPosition(payload.propertyPos)) ||
        (!['SELL_HOUSE', 'SELL_HOTEL', 'MORTGAGE'].includes(payload.action) && payload.propertyPos !== undefined)) {
      return failure('INVALID_PAYLOAD', 'Aksi utang hanya boleh berisi identitas turn, debt, aksi, dan posisi aset yang valid.');
    }
    const membership = this.socketMembership.get(socketId);
    if (!membership) return failure('NOT_IN_ROOM', 'Pemain tidak sedang terhubung sebagai anggota room.');
    const room = this.rooms.get(membership.roomCode);
    if (!room || room.status !== 'started' || !room.gameState) {
      return failure('ROOM_NOT_STARTED', 'Permainan room belum dimulai.');
    }
    const member = room.players.find(player => player.playerId === membership.playerId);
    if (!member || member.socketId !== socketId || member.isConnected !== true) {
      return failure('NOT_IN_ROOM', 'Identitas koneksi pemain tidak lagi aktif.');
    }
    return room.gameState.resolveDebtAction({playerId: membership.playerId, ...payload});
  }

  leaveRoom(socketId) {
    const membership = this.socketMembership.get(socketId);
    if (!membership) return failure('NOT_IN_ROOM', 'Pemain tidak sedang berada di room.');
    const room = this.rooms.get(membership.roomCode);
    if (room?.status === 'started' && room.gameState?.state?.gameStatus === 'IN_GAME') {
      const player = this._disconnectMember(socketId, membership, room);
      if (!player) return failure('NOT_IN_ROOM', 'Identitas koneksi pemain tidak lagi aktif.');
      this.onRoomUpdated(this.getPublicRoom(room.roomCode), room.roomCode);
      this.scheduleDisconnectedAutomation(room.roomCode);
      return success({room: this.getPublicRoom(room.roomCode), deleted: false, retained: true});
    }
    this.socketMembership.delete(socketId);
    if (!room) return success({room: null, deleted: true});

    const leavingPlayer = room.players.find(player => player.playerId === membership.playerId);
    this._revokeSession(room.roomCode, membership.playerId);
    room.players = room.players.filter(player => player.playerId !== membership.playerId);
    if (leavingPlayer?.playerId === room.hostPlayerId && room.players.length > 0) {
      room.hostPlayerId = room.players[0].playerId;
    }
    if (room.players.length === 0) {
      room.gameState = null;
      this.rooms.delete(room.roomCode);
      return success({room: null, deleted: true, roomCode: room.roomCode});
    }
    return success({room: this.getPublicRoom(room.roomCode), deleted: false});
  }

  handleDisconnect(socketId) {
    const membership = this.socketMembership.get(socketId);
    if (!membership) return failure('NOT_IN_ROOM', 'Pemain tidak sedang berada di room.');
    const room = this.rooms.get(membership.roomCode);
    if (!room) { this.socketMembership.delete(socketId); return failure('ROOM_NOT_FOUND', 'Room tidak ditemukan.'); }
    const player = this._disconnectMember(socketId, membership, room);
    if (!player) return success({room: this.getPublicRoom(room.roomCode), retained: true});
    this.onRoomUpdated(this.getPublicRoom(room.roomCode), room.roomCode);
    this.scheduleDisconnectedAutomation(room.roomCode);
    return success({room: this.getPublicRoom(room.roomCode), retained: true,
      expiresAt: this.sessionsByPlayer.get(this._sessionKey(room.roomCode, player.playerId))?.expiresAt || null});
  }

  getConnectedMembers(roomCode) {
    const room = this.rooms.get(String(roomCode || '').toUpperCase());
    if (!room) return [];
    return room.players.filter(player => player.isConnected && player.socketId)
      .map(player => ({socketId: player.socketId, playerId: player.playerId}));
  }

  getMembership(socketId) {
    const membership = this.socketMembership.get(socketId);
    return membership ? {...membership} : null;
  }

  getGameState(roomCode) {
    return this.rooms.get(String(roomCode || '').toUpperCase())?.gameState || null;
  }

  getPublicRoom(roomCode) {
    const room = this.rooms.get(String(roomCode || '').toUpperCase());
    if (!room) return null;
    return {
      roomCode: room.roomCode,
      hostPlayerId: room.hostPlayerId,
      status: room.status,
      createdAt: room.createdAt,
      minPlayers: ROOM_MIN_PLAYERS,
      maxPlayers: ROOM_MAX_PLAYERS,
      players: room.players.map(({playerId, playerName, isReady, isConnected, joinedAt}) => ({
        playerId, playerName, isReady, isConnected, joinedAt
      }))
    };
  }
}
