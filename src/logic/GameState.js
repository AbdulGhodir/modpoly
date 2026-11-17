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

export class GameState {
  constructor() {
    this.gameStatus = GameStatus.IN_GAME;
    this.round = 1;
    this.currentTurn = 0;
    this.consecutiveDoubles = 0;
    this.lastRoll = null;

    // Inisialisasi 4 pemain dengan field lengkap
    this.players = [
      { id: 1, name: 'Pemain 1', cn: 'Merah', color: '#ef4444', dark: '#b91c1c' },
      { id: 2, name: 'Pemain 2', cn: 'Biru', color: '#3b82f6', dark: '#1d4ed8' },
      { id: 3, name: 'Pemain 3', cn: 'Hijau', color: '#22c55e', dark: '#15803d' },
      { id: 4, name: 'Pemain 4', cn: 'Kuning', color: '#facc15', dark: '#ca8a04' }
    ].map(p => ({
      ...p,
      money: CFG.START_MONEY || 1500,
      pos: 0,
      status: PlayerStatus.ACTIVE,
      properties: [], // Array of property id / pos yang dimiliki
      jailTurns: 0,
      inJail: false,
      hasGetOutOfJailCard: 0,
      consecutiveDoubles: 0
    }));

    // Stok persediaan bangunan Bank (Aturan Klasik: 32 rumah & 12 hotel)
    this.bankHouses = 32;
    this.bankHotels = 12;

    // Registry properti terpusat (key: pos, value: PropertyObject)
    this.properties = new Map();

    // Log riwayat transaksi keuangan
    this.transactions = [];
  }

  getActivePlayer() {
    return this.players[this.currentTurn];
  }

  getPlayerById(id) {
    return this.players.find(p => p.id === id || p.id === Number(id));
  }

  // Getter dan Setter untuk kompatibilitas kode lama (GAME.turn & GAME.round)
  get turn() {
    return this.currentTurn;
  }

  set turn(val) {
    this.currentTurn = val;
  }
}

// Singleton GameState terpusat
export const gameState = new GameState();
