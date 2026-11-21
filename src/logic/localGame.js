import {PlayerStatus, GameStatus} from './GameStateCore.js';
import {clientGameStore} from '../state/ClientGameStore.js';
import {createPropertyRecord} from './propertyState.js';
import {CFG} from '../config.js';

export const DEFAULT_PLAYER_COLORS = [
  { cn: 'Merah', color: '#ef4444', dark: '#b91c1c' },
  { cn: 'Biru', color: '#3b82f6', dark: '#1d4ed8' },
  { cn: 'Hijau', color: '#22c55e', dark: '#15803d' },
  { cn: 'Kuning', color: '#facc15', dark: '#ca8a04' }
];

let turnManagerInstance = null;
let buildHudHandler = null;
let toastHandler = null;
let injectedTiles = null;

export function configureLocalGame({ turnManager = null, buildHud = null, toast = null, tiles = null } = {}) {
  if (turnManager) turnManagerInstance = turnManager;
  if (buildHud) buildHudHandler = buildHud;
  if (toast) toastHandler = toast;
  if (tiles) injectedTiles = tiles;
}

/**
 * Memulai sesi permainan lokal (single device) dengan jumlah dan nama pemain kustom.
 * Urutan giliran pemain diacak secara adil sebelum permainan dimulai.
 */
export function startLocalGame({ playerCount = 4, playerNames = [], tiles = null } = {}) {
  const count = Math.max(2, Math.min(4, Number(playerCount) || 4));
  const activeTiles = tiles || injectedTiles || clientGameStore.getState()?.tiles || [];

  // 1. Siapkan daftar nama pemain
  const roster = [];
  for (let i = 0; i < count; i++) {
    const raw = playerNames[i];
    const name = (typeof raw === 'string' && raw.trim()) ? raw.trim() : `Pemain ${i + 1}`;
    roster.push({ name });
  }

  // 2. Acak urutan giliran pemain (Fisher-Yates shuffle)
  for (let i = roster.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roster[i], roster[j]] = [roster[j], roster[i]];
  }

  // 3. Petakan ke objek pemain GameState dengan warna dan seat berurutan
  const players = roster.map((member, seat) => ({
    id: seat + 1,
    playerId: `player-${seat + 1}`,
    seat,
    name: member.name,
    cn: DEFAULT_PLAYER_COLORS[seat].cn,
    color: DEFAULT_PLAYER_COLORS[seat].color,
    dark: DEFAULT_PLAYER_COLORS[seat].dark,
    money: CFG.START_MONEY || 1500,
    pos: 0,
    status: PlayerStatus.ACTIVE,
    properties: [],
    jailTurns: 0,
    inJail: false,
    hasGetOutOfJailCard: 0,
    consecutiveDoubles: 0
  }));

  // 4. Inisialisasi properti kosong (belum dimiliki siapapun)
  const properties = [];
  for (const tile of activeTiles) {
    if (['prop', 'rail', 'util'].includes(tile.type)) {
      properties.push([tile.pos, createPropertyRecord(tile)]);
    }
  }

  // 5. Susun snapshot state awal yang bersih
  const snapshot = {
    version: 1,
    gameStatus: GameStatus.IN_GAME,
    round: 1,
    currentTurn: 0,
    turnId: 1,
    activePlayerId: players[0].playerId,
    consecutiveDoubles: 0,
    lastRoll: null,
    phase: 'WAITING_ROLL',
    bankHouses: 32,
    bankHotels: 12,
    players,
    properties,
    transactions: []
  };

  // 6. Terapkan ke store (memicu pembaruan pion di GameScene dan HUD)
  clientGameStore.setSnapshot(snapshot);

  // 7. Reset state TurnManager jika ada
  if (turnManagerInstance) {
    turnManagerInstance.lastEndedTurnKey = null;
    turnManagerInstance.phase = 'WAITING_ROLL';
  }

  // 8. Bangun ulang tampilan HUD jika ada
  if (buildHudHandler) {
    buildHudHandler();
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('turn:ready', { detail: { player: players[0] } }));
  }

  if (toastHandler) {
    toastHandler(`🎲 Urutan giliran diacak! Giliran pertama: ${players[0].name} (${players[0].cn})`);
  }

  return players;
}
