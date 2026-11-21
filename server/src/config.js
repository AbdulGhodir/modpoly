import 'dotenv/config';

const parsedPort = Number(process.env.PORT || 3000);
const parsedSessionGracePeriod = Number(process.env.SESSION_GRACE_PERIOD_MS || 15 * 60 * 1000);
const positiveNumber = (name, fallback, min = 1, max = 100000) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
};

export const serverConfig = {
  port: Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 3000,
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean),
  sessionGracePeriodMs: Number.isFinite(parsedSessionGracePeriod) && parsedSessionGracePeriod >= 0
    ? Math.floor(parsedSessionGracePeriod) : 15 * 60 * 1000,
  maxSocketMessageBytes: Math.floor(positiveNumber('MAX_SOCKET_MESSAGE_BYTES', 16 * 1024, 1024, 1024 * 1024)),
  maxRooms: Math.floor(positiveNumber('MAX_ROOMS', 500, 1, 100000)),
  rateLimits: {
    room: {capacity: positiveNumber('ROOM_EVENT_BURST', 12), refillPerSecond: positiveNumber('ROOM_EVENT_RATE_PER_SECOND', 0.25, 0.01)},
    gameplay: {capacity: positiveNumber('GAME_EVENT_BURST', 20), refillPerSecond: positiveNumber('GAME_EVENT_RATE_PER_SECOND', 1.5, 0.01)},
    ping: {capacity: positiveNumber('PING_EVENT_BURST', 6), refillPerSecond: positiveNumber('PING_EVENT_RATE_PER_SECOND', 1, 0.01)},
    roomIp: {capacity: positiveNumber('ROOM_IP_BURST', 10), refillPerSecond: positiveNumber('ROOM_IP_RATE_PER_SECOND', 0.2, 0.01)}
  }
};
