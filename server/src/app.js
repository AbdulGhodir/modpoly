import express from 'express';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {Server as SocketIOServer} from 'socket.io';
import {serverConfig} from './config.js';
import {RoomManager} from './RoomManager.js';
import {RateLimiter} from './RateLimiter.js';

const MAX_PING_LENGTH = 200;
const MAX_PLAYER_NAME_LENGTH = 24;
const ROOM_EVENTS = new Set(['room:create', 'room:join', 'room:resume', 'room:ready', 'room:not-ready', 'room:get', 'room:leave', 'room:start', 'room:add-bot', 'room:remove-bot']);
const ROOM_CREATE_OR_JOIN_EVENTS = new Set(['room:create', 'room:join']);

const INSTANCE_ID = randomUUID().slice(0, 8);
const STARTED_AT = new Date().toISOString();

// Di belakang reverse proxy (Enzonic/Cloudflare), socket.handshake.address adalah IP proxy, bukan IP pemain.
// Tanpa ini, SEMUA pemain berbagi satu bucket rate-limit room:create/join.
function clientAddress(socket) {
  const headers = socket.handshake.headers || {};
  const forwarded = String(headers['cf-connecting-ip'] || headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || socket.handshake.address || 'unknown';
}

const invalidPayload = message => ({ok: false, error: {code: 'INVALID_PAYLOAD', message}});
const eventFailure = (code, message) => ({ok: false, error: {code, message}});

function readPlayerName(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.playerName !== 'string') {
    return {error: invalidPayload('Nama pemain harus berupa teks.')};
  }
  const playerName = payload.playerName.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!playerName || playerName.length > MAX_PLAYER_NAME_LENGTH) {
    return {error: invalidPayload(`Nama pemain harus berisi 1–${MAX_PLAYER_NAME_LENGTH} karakter.`)};
  }
  return {playerName};
}

export function createBackendServer({port = serverConfig.port, allowedOrigins = serverConfig.allowedOrigins,
  roomManager = new RoomManager({sessionGracePeriodMs: serverConfig.sessionGracePeriodMs, maxRooms: serverConfig.maxRooms}),
  rateLimits = serverConfig.rateLimits, maxSocketMessageBytes = serverConfig.maxSocketMessageBytes} = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Beberapa platform hosting mengecek kesehatan lewat GET / ; balas 200 supaya dianggap sehat.
  app.get('/', (_request, response) => {
    response.type('text/plain').send('ModPoly backend OK');
  });

  app.get('/health', (_request, response) => {
    // instanceId berubah tiap proses start. Kalau dipanggil berkali-kali hasilnya berganti-ganti,
    // berarti ada lebih dari 1 instance di belakang load balancer (rooms tersimpan di memori tiap instance).
    response.json({status: 'ok', service: 'monopoly-socket-server', instanceId: INSTANCE_ID,
      startedAt: STARTED_AT, rooms: roomManager.rooms?.size ?? null, timestamp: new Date().toISOString()});
  });

  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    maxHttpBufferSize: maxSocketMessageBytes,
    // Default 25s/20s terlalu ketat di belakang proxy & tab browser/HP yang di-throttle -> "ping timeout".
    pingInterval: 20000,
    pingTimeout: 60000,
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, !origin || allowedOrigins.includes(origin));
    },
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: false
    }
  });
  const roomIpLimiter = new RateLimiter();
  roomManager.setRoomUpdateListener?.((room, roomCode) => {
    if (room) io.to(roomCode).emit('room:updated', room);
    else io.to(roomCode).emit('room:closed', {roomCode});
  });
  const publishChancePresentation = (roomCode, event) => {
    if (event) io.to(roomCode).emit('game:chance-presented', event);
  };
  const publishChanceResolution = (roomCode, resolution) => {
    if (!resolution?.event) return;
    const game = roomManager.getGameState(roomCode);
    const event = resolution.event;
    io.to(roomCode).emit('game:chance-resolved', event);
    if (event.debt) io.to(roomCode).emit('game:debt-created', game?.debtStateEvent('CREATED', event));
    if (event.destinationOffer) io.to(roomCode).emit('game:property-offer', {...event.destinationOffer});
    const destination = event.destinationEvent;
    if (!destination) return;
    if (event.destinationResolution === 'RENT_RESOLVED') io.to(roomCode).emit('game:rent-resolved', {...destination});
    else if (event.destinationResolution === 'DEBT_CREATED' && !event.debt) {
      io.to(roomCode).emit('game:debt-created', game?.debtStateEvent('CREATED'));
    } else if (event.destinationResolution === 'UNSUPPORTED') {
      io.to(roomCode).emit('game:tile-resolution-unsupported', {...destination});
    } else if (event.destinationResolution === 'TILE_RESOLVED') {
      io.to(roomCode).emit('game:tile-resolution-complete', {...destination});
    }
  };
  const publishTileResolution = (roomCode, resolution) => {
    if (!resolution) return;
    if (resolution.kind === 'PROPERTY_OFFER') io.to(roomCode).emit('game:property-offer', {...resolution.offer});
    else if (resolution.kind === 'CHANCE_PRESENTATION') publishChancePresentation(roomCode, resolution.event);
    else if (resolution.kind === 'CHANCE') publishChanceResolution(roomCode, resolution);
    else if (resolution.kind === 'RENT_RESOLVED') io.to(roomCode).emit('game:rent-resolved', {...resolution.event});
    else if (resolution.kind === 'DEBT_CREATED') {
      io.to(roomCode).emit('game:debt-created', roomManager.getGameState(roomCode)?.debtStateEvent('CREATED', resolution.event));
    } else if (resolution.kind === 'UNSUPPORTED') io.to(roomCode).emit('game:tile-resolution-unsupported', {...resolution.event});
    else if (resolution.kind === 'TILE_RESOLVED') io.to(roomCode).emit('game:tile-resolution-complete', {...resolution.event});
  };
  const publishDebtResult = result => {
    const type = result.type === 'UPDATED' ? 'UPDATED' : 'RESOLVED';
    for (const trade of result.invalidatedTrades || []) {
      publishTradeState(result.roomCode, {roomCode: result.roomCode, type: 'INVALIDATED', trade, snapshot: result.snapshot});
    }
    io.to(result.roomCode).emit('game:debt-state', roomManager.getGameState(result.roomCode).debtStateEvent(type, result));
    if (result.chanceContinuation?.nextPresentation?.event) {
      publishChancePresentation(result.roomCode, result.chanceContinuation.nextPresentation.event);
    }
  };
  roomManager.setAutoActionListener?.((roomCode, action) => {
    const game = roomManager.getGameState(roomCode);
    if (!game || !action) return;
    if (action.type === 'roll') {
      const {jailResolution, ...dice} = action.dice;
      io.to(roomCode).emit('game:dice-rolled', dice);
      if (jailResolution) io.to(roomCode).emit('game:jail-action-resolved', {...jailResolution});
      io.to(roomCode).emit('game:player-moved', {...action.movement});
      publishTileResolution(roomCode, action.tileResolution);
    } else if (action.type === 'jail-roll') {
      const {jailResolution, ...dice} = action.result;
      io.to(roomCode).emit('game:dice-rolled', dice);
      if (jailResolution) io.to(roomCode).emit('game:jail-action-resolved', {...jailResolution});
    } else if (action.type === 'triple-double') {
      io.to(roomCode).emit('game:dice-rolled', {...action.dice});
      io.to(roomCode).emit('game:jail-penalty', {...action.penalty});
    } else if (action.type === 'free-parking') {
      // TRAVEL membungkus event di `event` dan membawa movement + tileResolution; STAY mengirim event langsung.
      const {movement, tileResolution} = action.result;
      io.to(roomCode).emit('game:free-parking-action-resolved', {...(action.result.event || action.result)});
      if (movement) {
        io.to(roomCode).emit('game:player-moved', {...movement});
        publishTileResolution(roomCode, tileResolution);
      }
    } else if (action.type === 'jail-action') {
      io.to(roomCode).emit('game:jail-action-resolved', {...action.result});
    } else if (action.type === 'building') {
      io.to(roomCode).emit('game:building-state', {...action.result});
    } else if (action.type === 'debt') {
      publishDebtResult(action.result);
    } else if (action.type === 'property') {
      if (action.result.type === 'STARTED') io.to(roomCode).emit('game:auction-started', {...action.result});
      else io.to(roomCode).emit('game:property-resolution-complete', {...action.result});
    } else if (action.type === 'auction') {
      io.to(roomCode).emit(action.result.type === 'ENDED' ? 'game:auction-ended' : 'game:auction-updated', {...action.result});
    } else if (action.type === 'chance-continue') {
      publishChanceResolution(roomCode, action.result.resolution);
      if (action.result.nextPresentation?.event) publishChancePresentation(roomCode, action.result.nextPresentation.event);
    } else if (action.type === 'turn-ended') {
      io.to(roomCode).emit('game:turn-ended', {...action.result});
    }
  });
  const publishTradeState = (roomCode, payload) => {
    const trade = payload?.trade;
    const game = roomManager.getGameState(roomCode);
    if (!trade || !game) return;
    for (const member of roomManager.getConnectedMembers(roomCode)) {
      if (member.playerId !== trade.fromPlayerId && member.playerId !== trade.toPlayerId) continue;
      const recipient = io.sockets.sockets.get(member.socketId);
      const membership = roomManager.getMembership(member.socketId);
      if (membership?.roomCode !== roomCode || membership.playerId !== member.playerId ||
          recipient?.data?.roomCode !== roomCode || recipient?.data?.playerId !== member.playerId) continue;
      recipient.emit('game:trade-state', {...payload,
        snapshot: game.toPublicSnapshot({viewerPlayerId: member.playerId})});
    }
  };

  io.on('connection', socket => {
    console.info(`[socket] connected ${socket.id} instance=${INSTANCE_ID} transport=${socket.conn.transport.name}`);
    const socketLimiter = new RateLimiter({maxKeys: 8});
    const remoteAddress = clientAddress(socket);

    const checkRateLimit = eventName => {
      const category = ROOM_EVENTS.has(eventName) ? 'room' : 'gameplay';
      const policy = rateLimits[category];
      const socketResult = socketLimiter.consume(category, policy);
      if (!socketResult.allowed) return socketResult;
      if (ROOM_CREATE_OR_JOIN_EVENTS.has(eventName)) {
        const ipResult = roomIpLimiter.consume(remoteAddress, rateLimits.roomIp);
        if (!ipResult.allowed) return ipResult;
      }
      return {allowed: true, retryAfterMs: 0};
    };

    const registerAckEvent = (eventName, handler) => {
      socket.on(eventName, (payload, acknowledge) => {
        const ack = typeof acknowledge === 'function' ? acknowledge : () => {};
        const limit = checkRateLimit(eventName);
        if (!limit.allowed) {
          const response = eventFailure('RATE_LIMITED', 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.');
          response.error.retryAfterMs = limit.retryAfterMs;
          ack(response);
          return;
        }
        Promise.resolve()
        .then(() => handler(payload))
          .then(response => {
            if (eventName.startsWith('game:') && response?.ok && socket.data.roomCode) {
              roomManager.scheduleDisconnectedAutomation?.(socket.data.roomCode);
            }
            ack(response);
          })
          .catch(error => {
            console.error(`[socket] ${eventName} failed for ${socket.id} (${error?.name || 'Error'}).`);
            ack(eventFailure('INTERNAL_ERROR', 'Terjadi kesalahan server. Silakan coba lagi.'));
          });
      });
    };

    registerAckEvent('room:create', async payload => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          Object.keys(payload).some(key => key !== 'playerName')) return invalidPayload('Pembuatan room hanya menerima nama pemain.');
      const {playerName, error} = readPlayerName(payload);
      if (error) return error;
      const result = roomManager.createRoom({socketId: socket.id, playerName});
      if (!result.ok) return result;
      try {
        await socket.join(result.room.roomCode);
        socket.data.roomCode = result.room.roomCode;
        socket.data.playerId = result.playerId;
        io.to(result.room.roomCode).emit('room:updated', result.room);
        return result;
      } catch (error) {
        roomManager.leaveRoom(socket.id);
        throw error;
      }
    });

    registerAckEvent('room:join', async payload => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          Object.keys(payload).some(key => !['playerName', 'roomCode'].includes(key))) {
        return invalidPayload('Bergabung hanya menerima nama pemain dan kode room.');
      }
      const {playerName, error} = readPlayerName(payload);
      if (error) return error;
      if (!payload || typeof payload.roomCode !== 'string' || payload.roomCode.length > 12) {
        return invalidPayload('Kode room harus berupa teks dengan panjang yang valid.');
      }
      const result = roomManager.joinRoom({socketId: socket.id, roomCode: payload.roomCode, playerName});
      if (!result.ok) return result;
      try {
        await socket.join(result.room.roomCode);
        socket.data.roomCode = result.room.roomCode;
        socket.data.playerId = result.playerId;
        io.to(result.room.roomCode).emit('room:updated', result.room);
        return result;
      } catch (error) {
        roomManager.leaveRoom(socket.id);
        throw error;
      }
    });

    registerAckEvent('room:resume', async payload => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          Object.keys(payload).some(key => !['sessionToken', 'roomCode'].includes(key)) ||
          typeof payload.sessionToken !== 'string' ||
          (payload.roomCode !== undefined && typeof payload.roomCode !== 'string')) {
        return invalidPayload('Pemulihan hanya menerima token sesi dan kode room opsional.');
      }
      const result = roomManager.resumeSession({socketId: socket.id, sessionToken: payload.sessionToken,
        ...(payload.roomCode === undefined ? {} : {roomCode: payload.roomCode})});
      if (!result.ok) return result;
      try {
        await socket.join(result.room.roomCode);
        socket.data.roomCode = result.room.roomCode;
        socket.data.playerId = result.playerId;
        if (result.replacedSocketId && result.replacedSocketId !== socket.id) {
          const previousSocket = io.sockets.sockets.get(result.replacedSocketId);
          previousSocket?.disconnect(true);
        }
        io.to(result.room.roomCode).emit('room:updated', result.room);
        const resumedGame = roomManager.getGameState(result.room.roomCode);
        const response = {ok: true, room: result.room, playerId: result.playerId,
          sessionToken: result.sessionToken,
          snapshot: result.room.status === 'started' && resumedGame
            ? JSON.parse(JSON.stringify(resumedGame.toPublicSnapshot({viewerPlayerId: result.playerId}))) : null};
        return response;
      } catch (error) {
        roomManager.handleDisconnect(socket.id);
        throw error;
      }
    });

    const setReady = (isReady) => {
      const result = roomManager.setReady(socket.id, isReady);
      if (result.ok) io.to(result.room.roomCode).emit('room:updated', result.room);
      return result;
    };
    registerAckEvent('room:ready', () => setReady(true));
    registerAckEvent('room:not-ready', () => setReady(false));

    registerAckEvent('room:start', () => {
      const result = roomManager.startRoom(socket.id);
      if (result.ok) {
        const roomCode = result.room.roomCode;
        const membership = roomManager.getMembership(socket.id);
        const gameState = roomManager.getGameState(roomCode);
        if (!membership || membership.roomCode !== roomCode || !gameState) {
          return eventFailure('SNAPSHOT_UNAVAILABLE', 'GameState room belum tersedia.');
        }
        io.to(roomCode).emit('room:updated', result.room);
        io.to(roomCode).emit('room:started', result.room);
        for (const member of roomManager.getConnectedMembers(roomCode)) {
          try {
            const currentMembership = roomManager.getMembership(member.socketId);
            const recipient = io.sockets.sockets.get(member.socketId);
            if (currentMembership?.roomCode !== roomCode || currentMembership.playerId !== member.playerId ||
                recipient?.data?.roomCode !== roomCode || recipient?.data?.playerId !== member.playerId) continue;
            const snapshot = JSON.parse(JSON.stringify(gameState.toPublicSnapshot({viewerPlayerId: member.playerId})));
            recipient.emit('game:initial-snapshot', {roomCode, snapshot});
          } catch (error) {
            console.error(`[room] initial snapshot failed for ${roomCode}/${member.playerId}:`, error.message);
          }
        }
        // Kalau giliran pertama jatuh ke bot, mulai otomatisasinya.
        roomManager.scheduleDisconnectedAutomation?.(roomCode);
      }
      return result;
    });

    registerAckEvent('room:add-bot', () => {
      const result = roomManager.addBot(socket.id);
      if (result.ok) io.to(result.room.roomCode).emit('room:updated', result.room);
      return result;
    });

    registerAckEvent('room:remove-bot', payload => {
      const result = roomManager.removeBot(socket.id, payload);
      if (result.ok) io.to(result.room.roomCode).emit('room:updated', result.room);
      return result;
    });

    registerAckEvent('game:roll-dice', payload => {
      const membership = roomManager.getMembership(socket.id);
      if (!membership || socket.data.roomCode !== membership.roomCode || socket.data.playerId !== membership.playerId) {
        return eventFailure('NOT_IN_ROOM', 'Identitas socket tidak cocok dengan pemain room.');
      }
      const result = roomManager.requestRoll(socket.id, payload);
      if (!result.ok) return result;
      const roomCode = result.result.roomCode;
      const {movement, tileResolution, jailPenalty, jailResolution, ...diceResult} = result.result;
      io.to(roomCode).emit('game:dice-rolled', {...diceResult});
      if (jailResolution) io.to(roomCode).emit('game:jail-action-resolved', {...jailResolution});
      if (diceResult.jailAttempt && !diceResult.jailReleased) return {ok: true, result: {...result.result}};
      if (movement) io.to(roomCode).emit('game:player-moved', {...movement});
      if (jailPenalty) {
        io.to(roomCode).emit('game:jail-penalty', {...jailPenalty});
      } else {
        const resolution = tileResolution;
        if (resolution.kind === 'PROPERTY_OFFER') {
          io.to(roomCode).emit('game:property-offer', {...resolution.offer});
        } else if (resolution.kind === 'CHANCE_PRESENTATION') {
          publishChancePresentation(roomCode, resolution.event);
        } else if (resolution.kind === 'CHANCE') {
          publishChanceResolution(roomCode, resolution);
        } else if (resolution.kind === 'RENT_RESOLVED') {
          io.to(roomCode).emit('game:rent-resolved', {...resolution.event});
        } else if (resolution.kind === 'DEBT_CREATED') {
          io.to(roomCode).emit('game:debt-created', roomManager.getGameState(roomCode).debtStateEvent('CREATED', resolution.event));
        } else if (resolution.kind === 'UNSUPPORTED') {
          io.to(roomCode).emit('game:tile-resolution-unsupported', {...resolution.event});
        } else if (resolution.kind === 'TILE_RESOLVED') {
          io.to(roomCode).emit('game:tile-resolution-complete', {...resolution.event});
        }
      }
      return {ok: true, result: {...result.result}};
    });

    registerAckEvent('game:end-turn', payload => {
      const membership = roomManager.getMembership(socket.id);
      if (!membership || socket.data.roomCode !== membership.roomCode || socket.data.playerId !== membership.playerId) {
        return eventFailure('NOT_IN_ROOM', 'Identitas socket tidak cocok dengan pemain room.');
      }
      const result = roomManager.endTurn(socket.id, payload);
      if (result.ok && result.result.duplicate !== true) {
        io.to(result.result.roomCode).emit('game:turn-ended', {...result.result});
      }
      return result;
    });

    registerAckEvent('game:jail-action', payload => {
      const membership = roomManager.getMembership(socket.id);
      if (!membership || socket.data.roomCode !== membership.roomCode || socket.data.playerId !== membership.playerId) {
        return eventFailure('NOT_IN_ROOM', 'Identitas socket tidak cocok dengan pemain room.');
      }
      const result = roomManager.resolveJailAction(socket.id, payload);
      if (result.ok) io.to(result.result.roomCode).emit('game:jail-action-resolved', {...result.result});
      return result;
    });

    registerAckEvent('game:free-parking-action', payload => {
      const membership = roomManager.getMembership(socket.id);
      if (!membership || socket.data.roomCode !== membership.roomCode || socket.data.playerId !== membership.playerId) {
        return eventFailure('NOT_IN_ROOM', 'Identitas socket tidak cocok dengan pemain room.');
      }
      const result = roomManager.resolveFreeParkingAction(socket.id, payload);
      if (!result.ok) return result;
      const {roomCode, movement, tileResolution} = result.result;
      // TRAVEL wraps its event in `event`; STAY returns the event itself (broadcasting `{...undefined}` sent an empty
      // object, so clients never cleared the pending decision and the dice stayed locked).
      const event = result.result.event || result.result;
      io.to(roomCode).emit('game:free-parking-action-resolved', {...event});
      if (!movement) return result;
      io.to(roomCode).emit('game:player-moved', {...movement});
      if (tileResolution.kind === 'PROPERTY_OFFER') {
        io.to(roomCode).emit('game:property-offer', {...tileResolution.offer});
      } else if (tileResolution.kind === 'CHANCE_PRESENTATION') {
        publishChancePresentation(roomCode, tileResolution.event);
      } else if (tileResolution.kind === 'CHANCE') {
        publishChanceResolution(roomCode, tileResolution);
      } else if (tileResolution.kind === 'RENT_RESOLVED') {
        io.to(roomCode).emit('game:rent-resolved', {...tileResolution.event});
      } else if (tileResolution.kind === 'DEBT_CREATED') {
        io.to(roomCode).emit('game:debt-created', roomManager.getGameState(roomCode).debtStateEvent('CREATED', tileResolution.event));
      } else if (tileResolution.kind === 'UNSUPPORTED') {
        io.to(roomCode).emit('game:tile-resolution-unsupported', {...tileResolution.event});
      } else if (tileResolution.kind === 'TILE_RESOLVED') {
        io.to(roomCode).emit('game:tile-resolution-complete', {...tileResolution.event});
      }
      return result;
    });

    registerAckEvent('game:property-decision', payload => {
      const membership = roomManager.getMembership(socket.id);
      if (!membership || socket.data.roomCode !== membership.roomCode || socket.data.playerId !== membership.playerId) {
        return eventFailure('NOT_IN_ROOM', 'Identitas socket tidak cocok dengan pemain room.');
      }
      const result = roomManager.resolvePropertyDecision(socket.id, payload);
      if (!result.ok) return result;
      if (result.result.type === 'STARTED') {
        io.to(result.result.roomCode).emit('game:auction-started', {...result.result});
      } else {
        io.to(result.result.roomCode).emit('game:property-resolution-complete', {...result.result});
      }
      return result;
    });

    registerAckEvent('game:auction-action', payload => {
      const membership = roomManager.getMembership(socket.id);
      if (!membership || socket.data.roomCode !== membership.roomCode || socket.data.playerId !== membership.playerId) {
        return eventFailure('NOT_IN_ROOM', 'Identitas socket tidak cocok dengan pemain room.');
      }
      const result = roomManager.resolveAuctionAction(socket.id, payload);
      if (!result.ok) return result;
      const type = result.result.type === 'ENDED' ? 'game:auction-ended' : 'game:auction-updated';
      io.to(result.result.roomCode).emit(type, {...result.result});
      return result;
    });

    registerAckEvent('game:trade-create', payload => {
      const membership = roomManager.getMembership(socket.id);
      if (!membership || socket.data.roomCode !== membership.roomCode || socket.data.playerId !== membership.playerId) {
        return eventFailure('NOT_IN_ROOM', 'Identitas socket tidak cocok dengan pemain room.');
      }
      const result = roomManager.createTradeOffer(socket.id, payload);
      if (!result.ok) return result;
      publishTradeState(result.result.roomCode, result.result);
      return result;
    });

    registerAckEvent('game:trade-action', payload => {
      const membership = roomManager.getMembership(socket.id);
      if (!membership || socket.data.roomCode !== membership.roomCode || socket.data.playerId !== membership.playerId) {
        return eventFailure('NOT_IN_ROOM', 'Identitas socket tidak cocok dengan pemain room.');
      }
      const result = roomManager.resolveTradeAction(socket.id, payload);
      if (!result.ok) return result;
      publishTradeState(result.result.roomCode, result.result);
      return result;
    });

    registerAckEvent('game:building-action', payload => {
      const membership = roomManager.getMembership(socket.id);
      if (!membership || socket.data.roomCode !== membership.roomCode || socket.data.playerId !== membership.playerId) {
        return eventFailure('NOT_IN_ROOM', 'Identitas socket tidak cocok dengan pemain room.');
      }
      const result = roomManager.resolveBuildingAction(socket.id, payload);
      if (!result.ok) return result;
      io.to(result.result.roomCode).emit('game:building-state', {...result.result});
      return result;
    });

    for (const [eventName, action] of [['game:property-mortgage', 'MORTGAGE'], ['game:property-unmortgage', 'UNMORTGAGE']]) {
      registerAckEvent(eventName, payload => {
        const membership = roomManager.getMembership(socket.id);
        if (!membership || socket.data.roomCode !== membership.roomCode || socket.data.playerId !== membership.playerId) {
          return eventFailure('NOT_IN_ROOM', 'Identitas socket tidak cocok dengan pemain room.');
        }
        const result = roomManager.resolveMortgageAction(socket.id, payload, action);
        if (!result.ok) return result;
        io.to(result.result.roomCode).emit('game:property-finance-resolved', {...result.result});
        return result;
      });
    }

    registerAckEvent('game:debt-action', payload => {
      const membership = roomManager.getMembership(socket.id);
      if (!membership || socket.data.roomCode !== membership.roomCode || socket.data.playerId !== membership.playerId) {
        return eventFailure('NOT_IN_ROOM', 'Identitas socket tidak cocok dengan pemain room.');
      }
      const result = roomManager.resolveDebtAction(socket.id, payload);
      if (!result.ok) return result;
      publishDebtResult(result.result);
      return result;
    });

    registerAckEvent('game:chance-continue', payload => {
      const membership = roomManager.getMembership(socket.id);
      if (!membership || socket.data.roomCode !== membership.roomCode || socket.data.playerId !== membership.playerId) {
        return eventFailure('NOT_IN_ROOM', 'Identitas socket tidak cocok dengan pemain room.');
      }
      const result = roomManager.continueChancePresentation(socket.id, payload);
      if (!result.ok) return result;
      const roomCode = result.result.roomCode;
      publishChanceResolution(roomCode, result.result.resolution);
      if (result.result.nextPresentation?.event) publishChancePresentation(roomCode, result.result.nextPresentation.event);
      return result;
    });

    registerAckEvent('room:get', () => {
      const membership = roomManager.getMembership(socket.id);
      if (!membership) return eventFailure('NOT_IN_ROOM', 'Pemain tidak sedang berada di room.');
      const room = roomManager.getPublicRoom(membership.roomCode);
      return room ? {ok: true, room} : eventFailure('ROOM_NOT_FOUND', 'Room tidak ditemukan.');
    });

    registerAckEvent('room:leave', async () => {
      const result = roomManager.leaveRoom(socket.id);
      if (!result.ok) return result;
      const roomCode = socket.data.roomCode;
      if (roomCode) await socket.leave(roomCode);
      delete socket.data.roomCode;
      delete socket.data.playerId;
      if (result.room && !result.retained) io.to(result.room.roomCode).emit('room:updated', result.room);
      return {ok: true, room: result.retained ? result.room : null, deleted: result.deleted, retained: result.retained === true};
    });

    socket.on('connection:ping', payload => {
      const limit = socketLimiter.consume('ping', rateLimits.ping);
      if (!limit.allowed) {
        socket.emit('connection:error', {event: 'connection:ping', error: {code: 'RATE_LIMITED',
          message: 'Terlalu banyak ping. Tunggu sebentar lalu coba lagi.', retryAfterMs: limit.retryAfterMs}});
        return;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          Object.keys(payload).some(key => key !== 'message') ||
          typeof payload.message !== 'string' || payload.message.trim().length === 0 ||
          payload.message.length > MAX_PING_LENGTH) {
        socket.emit('connection:error', {event: 'connection:ping', message: 'Payload ping tidak valid.'});
        return;
      }

      socket.emit('connection:pong', {
        message: payload.message.trim(),
        receivedAt: new Date().toISOString()
      });
    });

    socket.on('error', error => {
      console.error(`[socket] error ${socket.id}:`, error.message);
    });

    socket.on('disconnect', reason => {
      console.info(`[socket] disconnected ${socket.id} instance=${INSTANCE_ID}: ${reason}`);
      socketLimiter.buckets.clear();
      const result = roomManager.handleDisconnect(socket.id);
      if (result.ok && result.room) io.to(result.room.roomCode).emit('room:updated', result.room);
    });
  });

  httpServer.on('error', error => {
    console.error('[http] server error:', error.message);
  });

  return {app, httpServer, io, port, roomManager};
}
