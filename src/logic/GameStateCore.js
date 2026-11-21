import {CFG} from '../config.js';

export const PlayerStatus = {
  ACTIVE: 'ACTIVE',
  IN_JAIL: 'IN_JAIL',
  BANKRUPT: 'BANKRUPT'
};

export const GameStatus = {
  WAITING: 'WAITING',
  IN_GAME: 'IN_GAME',
  FINISHED: 'FINISHED'
};

const cloneJson = value => JSON.parse(JSON.stringify(value));

/** Pure game data model shared by browser and Node; no singleton, DOM, or Phaser imports. */
export class GameState {
  constructor(snapshot = null) {
    const initialPlayers = [
      { id: 1, name: 'Pemain 1', cn: 'Merah', color: '#ef4444', dark: '#b91c1c' },
      { id: 2, name: 'Pemain 2', cn: 'Biru', color: '#3b82f6', dark: '#1d4ed8' },
      { id: 3, name: 'Pemain 3', cn: 'Hijau', color: '#22c55e', dark: '#15803d' },
      { id: 4, name: 'Pemain 4', cn: 'Kuning', color: '#facc15', dark: '#ca8a04' }
    ].map((player, seat) => ({
      ...player,
      playerId: `player-${player.id}`,
      seat,
      money: CFG.START_MONEY || 1500,
      pos: 0,
      status: PlayerStatus.ACTIVE,
      properties: [],
      jailTurns: 0,
      inJail: false,
      hasGetOutOfJailCard: 0,
      consecutiveDoubles: 0
    }));

    this.gameStatus = GameStatus.IN_GAME;
    this.round = 1;
    this.currentTurn = 0;
    this.turnId = 1;
    this.activePlayerId = initialPlayers[0]?.playerId ?? null;
    this.consecutiveDoubles = 0;
    this.lastRoll = null;
    this.phase = 'WAITING_ROLL';
    this.bankHouses = 32;
    this.bankHotels = 12;
    this.players = initialPlayers;
    this.properties = new Map();
    this.transactions = [];

    if (snapshot) this.restoreSnapshot(snapshot);
  }

  static create(options) { return new GameState(options); }

  static fromSnapshot(snapshot) { return new GameState(snapshot); }

  toSnapshot() {
    return JSON.parse(JSON.stringify({
      version: 1,
      gameStatus: this.gameStatus,
      round: this.round,
      currentTurn: this.currentTurn,
      turnId: this.turnId,
      activePlayerId: this.activePlayerId,
      consecutiveDoubles: this.consecutiveDoubles,
      lastRoll: this.lastRoll,
      phase: this.phase,
      bankHouses: this.bankHouses,
      bankHotels: this.bankHotels,
      players: this.players,
      properties: Array.from(this.properties.entries()),
      transactions: this.transactions
    }));
  }

  restoreSnapshot(snapshot) {
    this.gameStatus = snapshot.gameStatus ?? GameStatus.IN_GAME;
    this.round = snapshot.round ?? 1;
    this.currentTurn = snapshot.currentTurn ?? 0;
    this.turnId = Number.isInteger(snapshot.turnId) && snapshot.turnId > 0 ? snapshot.turnId : 1;
    this.consecutiveDoubles = snapshot.consecutiveDoubles ?? 0;
    this.lastRoll = snapshot.lastRoll ? cloneJson(snapshot.lastRoll) : null;
    this.phase = snapshot.phase ?? 'WAITING_ROLL';
    this.bankHouses = snapshot.bankHouses ?? 32;
    this.bankHotels = snapshot.bankHotels ?? 12;
    const restoredPlayers = cloneJson(snapshot.players || this.players).map((player, seat) => ({
      ...player,
      playerId: player.playerId || `player-${player.id}`,
      seat: Number.isInteger(player.seat) ? player.seat : seat
    }));
    this.players.splice(0, this.players.length, ...restoredPlayers);
    this.activePlayerId = snapshot.activePlayerId || this.players[this.currentTurn]?.playerId || null;
    this.properties.clear();
    cloneJson(snapshot.properties || []).forEach(([key, value]) => this.properties.set(key, value));
    this.transactions.splice(0, this.transactions.length, ...cloneJson(snapshot.transactions || []));
    return this;
  }

  getActivePlayer() { return this.players[this.currentTurn]; }

  getPlayerById(id) {
    return this.players.find(player => player.playerId === id || player.id === id || player.id === Number(id));
  }

  getPlayerBySeat(seat) { return this.players.find(player => player.seat === seat); }

  getSeatByPlayerId(playerId) { return this.getPlayerById(playerId)?.seat ?? -1; }

  getPlayerIndexById(playerId) {
    return this.players.findIndex(player => player.playerId === playerId || player.id === playerId || player.id === Number(playerId));
  }

  get turn() { return this.currentTurn; }
  set turn(value) { this.currentTurn = value; }
}

export function createGameState(options) { return GameState.create(options); }
