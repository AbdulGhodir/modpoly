import {gameState, PlayerStatus, GameStatus} from './GameState.js';
import {propertyManager} from './PropertyManager.js';
import {economyManager, TransactionType} from './EconomyManager.js';
import {bankruptcyManager} from './BankruptcyManager.js';
import {tileModalManager} from '../ui/TileModalManager.js';
import {jailModalManager} from '../ui/JailModalManager.js';
import {freeParkingModalManager} from '../ui/FreeParkingModalManager.js';
import {bankruptcyModalManager} from '../ui/BankruptcyModalManager.js';
import {tradeModalManager} from '../ui/TradeModalManager.js';
import {jailManager} from './JailManager.js';
import {toast, buildHud} from '../ui/hud.js';
import {TILES} from '../data/tiles.js';

export const TurnPhase = {
  WAITING_ROLL: 'WAITING_ROLL',
  ROLLING: 'ROLLING',
  MOVING: 'MOVING',
  RESOLVING_TILE: 'RESOLVING_TILE',
  PLAYER_ACTION: 'PLAYER_ACTION',
  END_TURN: 'END_TURN',
  GAME_OVER: 'GAME_OVER'
};

export class TurnManager {
  constructor() {
    this.phase = TurnPhase.WAITING_ROLL;
    this.chanceDepth = 0;
  }

  getPhase() {
    return this.phase;
  }

  setPhase(newPhase) {
    const oldPhase = this.phase;
    this.phase = newPhase;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('phase:changed', {
        detail: { from: oldPhase, to: newPhase, player: gameState.getActivePlayer() }
      }));
    }
  }

  canRoll() {
    if (gameState.gameStatus === GameStatus.FINISHED) return false;

    // Dadu tidak boleh diklik jika ada modal interaksi yang sedang terbuka
    if (tileModalManager && tileModalManager.isOpen()) return false;
    if (jailModalManager && jailModalManager.isOpen()) return false;
    if (freeParkingModalManager && freeParkingModalManager.isOpen()) return false;
    if (bankruptcyModalManager && bankruptcyModalManager.isOpen()) return false;
    if (tradeModalManager && tradeModalManager.isOpen()) return false;

    // Cegah lempar dadu jika pion sedang bergerak atau petak sedang diproses
    if (this.phase === TurnPhase.MOVING || this.phase === TurnPhase.RESOLVING_TILE || this.phase === TurnPhase.ROLLING) return false;

    const player = gameState.getActivePlayer();
    if (!player || player.status === PlayerStatus.BANKRUPT) return false;

    const isDouble = gameState.lastRoll?.isDouble;
    const isFreeParking = player.pos === 20;
    const allowExtraRoll = isDouble && !jailManager.isInJail(player?.id) && (player?.consecutiveDoubles || 0) < 3 && !isFreeParking;

    return this.phase === TurnPhase.WAITING_ROLL || 
          (this.phase === TurnPhase.PLAYER_ACTION && allowExtraRoll);
  }

  startRolling() {
    if (!this.canRoll()) return false;
    this.setPhase(TurnPhase.ROLLING);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('dice:rolling'));
    }
    return true;
  }

  handleRoll(rollData) {
    const player = gameState.getActivePlayer();
    if (!player || player.status === PlayerStatus.BANKRUPT) {
      return { canMove: false, allowExtraRoll: false };
    }
    gameState.lastRoll = rollData;

    // A. JIKA PEMAIN SEDANG DI PENJARA
    if (jailManager.isInJail(player.id)) {
      const jailRes = jailManager.processJailRoll(player.id, rollData);
      if (jailRes.released) {
        // Bebas dari penjara! Bergerak sesuai total dadu tapi TIDAK ada lemparan ulang
        return {
          canMove: true,
          rollData,
          escapedJail: true,
          allowExtraRoll: false
        };
      } else {
        // Gagal keluar penjara -> tetap di posisi 10, tidak boleh bergerak
        return {
          canMove: false,
          rollData,
          stayInJail: true,
          jailRes
        };
      }
    }

    // B. PEMAIN NORMAL AKTIF MELEMPAR DADU
    const isDouble = rollData.isDouble;
    if (isDouble) {
      player.consecutiveDoubles = (player.consecutiveDoubles || 0) + 1;
      gameState.consecutiveDoubles = player.consecutiveDoubles;

      if (player.consecutiveDoubles >= 3) {
        // ATURAN KLASIK: 3x Double berturut-turut -> Langsung masuk penjara!
        jailManager.sendToJail(player.id, '3x Double Berturut-turut');
        return {
          canMove: false,
          rollData,
          jailed3xDouble: true,
          allowExtraRoll: false
        };
      }

      return {
        canMove: true,
        rollData,
        allowExtraRoll: true
      };
    } else {
      player.consecutiveDoubles = 0;
      gameState.consecutiveDoubles = 0;
      return {
        canMove: true,
        rollData,
        allowExtraRoll: false
      };
    }
  }

  startMoving(rollData) {
    gameState.lastRoll = rollData;
    this.setPhase(TurnPhase.MOVING);
  }

  async resolveTile(tileIdx) {
    if (gameState.gameStatus === GameStatus.FINISHED) return;
    this.setPhase(TurnPhase.RESOLVING_TILE);
    const player = gameState.getActivePlayer();
    const tile = TILES[tileIdx];
    const prop = propertyManager.getProperty(tileIdx);

    // 1. Petak Properti (Kota, Stasiun, Utilitas)
    if (prop) {
      // Kasus A: Belum dimiliki -> Munculkan Popup Pembelian
      if (!prop.owner) {
        const buyResult = await tileModalManager.promptPurchase(prop, player);
        this._notifyResolved({ tile, prop, action: 'PURCHASE_OR_AUCTION', result: buyResult });
        return buyResult;
      }

      // Kasus B: Milik pemain itu sendiri
      if (prop.owner === player.id) {
        toast(`🏡 ${player.name} mendarat di properti miliknya sendiri (${prop.name}). Bebas biaya!`);
        this._notifyResolved({ tile, prop, action: 'OWN_PROPERTY' });
        return { action: 'OWN_PROPERTY', prop };
      }

      // Kasus C: Milik pemain lain
      const owner = gameState.getPlayerById(prop.owner);

      // Jika properti sedang digadaikan -> Bebas sewa
      if (prop.isMortgaged) {
        toast(`📄 ${prop.name} sedang digadaikan oleh ${owner.name}. Bebas biaya sewa!`);
        this._notifyResolved({ tile, prop, action: 'MORTGAGED' });
        return { action: 'MORTGAGED', prop };
      }

      // Hitung tarif sewa berdasarkan data CSV & status monopoli / rumah
      const rent = propertyManager.calculateRent(tileIdx, gameState.lastRoll?.total || 7);
      const rentResult = await tileModalManager.promptRent(prop, player, owner, rent);
      this._notifyResolved({ tile, prop, action: 'RENT_PAID', result: rentResult });
      return rentResult;
    }

    // 2. Petak Pajak
    if (tile.type === 'tax') {
      const taxAmount = Number(tile.price || 0);
      if (player.money < taxAmount) {
        const debtRes = await bankruptcyModalManager.promptDebtResolution(
          player,
          null,
          taxAmount,
          `Pajak ${tile.nama}`
        );
        if (debtRes.resolved) {
          economyManager.deductMoney(player.id, taxAmount, `Bayar ${tile.nama}`, TransactionType.TAX);
          toast(`💸 ${player.name} melunasi ${tile.nama}: -$${taxAmount.toLocaleString('id-ID')}`);
          buildHud();
        }
      } else {
        economyManager.deductMoney(player.id, taxAmount, `Bayar ${tile.nama}`, TransactionType.TAX);
        toast(`💸 ${player.name} kena ${tile.nama}! Saldo otomatis dipotong -$${taxAmount.toLocaleString('id-ID')}`);
        buildHud();
      }
      this._notifyResolved({ tile, action: 'TAX', taxAmount });
      return { action: 'TAX', taxAmount };
    }

    // 3. Petak Kartu Kesempatan
    if (tile.type === 'chance') {
      if (this.chanceDepth >= 2) {
        toast(`🎴 ${player.name} mendarat di Kesempatan lagi, tidak menarik kartu tambahan.`);
        this._notifyResolved({ tile, action: 'CHANCE_LIMIT' });
        return { action: 'CHANCE_LIMIT' };
      }
      this.chanceDepth++;
      try {
        const cardResult = await tileModalManager.promptChanceCard(player);
        this._notifyResolved({ tile, action: 'CHANCE', result: cardResult });
        return cardResult;
      } finally {
        this.chanceDepth--;
      }
    }

    // 4. Petak Pojok (Corner)
    if (tile.type === 'corner') {
      if (tile.pos === 0) {
        toast(`🏁 ${player.name} mendarat tepat di petak START!`);
      } else if (tile.pos === 10) {
        toast(`🔒 ${player.name} hanya lewat / berkunjung di Penjara.`);
      } else if (tile.pos === 20) {
        toast(`🅿️ ${player.name} istirahat di Parkir Bebas.`);
      } else if (tile.pos === 30) {
        // ATURAN KLASIK: Masuk Penjara!
        jailManager.sendToJail(player.id, 'Mendarat di petak KE PENJARA');
        this._notifyResolved({ tile, action: 'JAIL', jailed: true });
        return { action: 'JAIL', tile };
      }
      this._notifyResolved({ tile, action: 'CORNER' });
      return { action: 'CORNER', tile };
    }

    toast(`🎯 ${player.name} mendarat di ${tile.nama}`);
    this._notifyResolved({ tile, action: 'LAND' });
    return { action: 'LAND', tile };
  }

  _notifyResolved(detail) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('tile:resolved', { detail }));
    }
  }

  startPlayerAction(options = {}) {
    const player = gameState.getActivePlayer();
    // 1. Guard kebangkrutan: Pemain bangkrut tidak boleh mendapatkan aksi giliran
    if (!player || player.status === PlayerStatus.BANKRUPT) {
      this.endTurn();
      return;
    }

    this.setPhase(TurnPhase.PLAYER_ACTION);

    const isDouble = gameState.lastRoll?.isDouble;
    const isFreeParking = player.pos === 20;

    // Jika mendarat di Parkir Bebas, batalkan kesempatan lempar ulang dan reset double
    if (isFreeParking) {
      player.consecutiveDoubles = 0;
      gameState.consecutiveDoubles = 0;
    }

    // Double hanya memberikan lemparan ulang jika:
    // - Hasil dadu adalah double
    // - Pemain TIDAK sedang dipenjara
    // - Tidak terkena aturan 3x double
    // - Pemain TIDAK berhenti di petak Parkir Bebas (posisi 20)
    // - Tidak dipaksa false oleh opsi aksi
    const allowExtraRoll = options.allowExtraRoll !== undefined
      ? options.allowExtraRoll
      : (isDouble && !jailManager.isInJail(player?.id) && (player?.consecutiveDoubles || 0) < 3 && !isFreeParking);

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('turn:action', {
        detail: {
          player,
          isDouble,
          allowExtraRoll,
          consecutiveDoubles: player?.consecutiveDoubles || 0
        }
      }));
    }
  }

  endTurn() {
    if (gameState.gameStatus === GameStatus.FINISHED || this.phase === TurnPhase.GAME_OVER) return;
    this.setPhase(TurnPhase.END_TURN);

    const activePlayer = gameState.getActivePlayer();
    if (activePlayer) {
      activePlayer.consecutiveDoubles = 0;
    }
    gameState.consecutiveDoubles = 0;
    gameState.lastRoll = null;

    // Cari pemain aktif berikutnya yang belum bangkrut
    const totalPlayers = gameState.players.length;
    let nextTurn = (gameState.currentTurn + 1) % totalPlayers;
    let attempts = 0;

    while (gameState.players[nextTurn].status === PlayerStatus.BANKRUPT && attempts < totalPlayers) {
      nextTurn = (nextTurn + 1) % totalPlayers;
      attempts++;
    }

    // Jika tersisa 1 pemenang aktif
    const winner = bankruptcyManager.checkWinner();
    if (winner || attempts >= totalPlayers) {
      this.setPhase(TurnPhase.GAME_OVER);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('game:over', { detail: { winner } }));
      }
      return;
    }

    if (nextTurn <= gameState.currentTurn) {
      gameState.round++;
    }

    gameState.currentTurn = nextTurn;
    const nextPlayer = gameState.players[nextTurn];
    if (nextPlayer) {
      nextPlayer.consecutiveDoubles = 0;
    }

    this.startTurn();
  }

  async startTurn() {
    if (gameState.gameStatus === GameStatus.FINISHED) {
      this.setPhase(TurnPhase.GAME_OVER);
      return;
    }
    this.setPhase(TurnPhase.WAITING_ROLL);
    const player = gameState.getActivePlayer();

    // Guard: Jika pemain tidak ada atau bangkrut, lewati giliran
    if (!player || player.status === PlayerStatus.BANKRUPT) {
      this.endTurn();
      return;
    }

    // 1. Jika pemain aktif sedang berada di Penjara, tampilkan Jail Modal
    if (jailManager.isInJail(player.id)) {
      const res = await jailModalManager.promptJailAction(player);
      if (res.action === 'PAY_BAIL') {
        jailManager.payBail(player.id);
        buildHud();
      } else if (res.action === 'USE_CARD') {
        jailManager.useGetOutOfJailCard(player.id);
        buildHud();
      }
    }
    // 2. SISTEM KHUSUS PARKIR BEBAS (FREE PARKING TRAVEL):
    // Jika pemain memulai gilirannya di petak 20 (Parkir Bebas) dan tidak di penjara:
    // Pemain diberi pilihan membayar $50 untuk berpindah ke petak mana saja!
    else if (player.pos === 20) {
      const travelChoice = await freeParkingModalManager.promptTravel(player);
      if (gameState.gameStatus === GameStatus.FINISHED) return;
      if (travelChoice && travelChoice.action === 'TRAVEL') {
        // Potong biaya $50
        economyManager.deductMoney(
          player.id,
          50,
          `Layanan Travel Parkir Bebas ke ${TILES[travelChoice.targetPos]?.nama}`,
          TransactionType.PARKING_TRAVEL || TransactionType.OTHER
        );
        toast(`🚗 ${player.name} membayar $50 untuk berpindah ke ${TILES[travelChoice.targetPos]?.nama}!`);
        buildHud();

        // Animate pawn clockwise ke target tile
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('player:animate_move', {
            detail: {
              playerId: player.id,
              targetPos: travelChoice.targetPos,
              clockwise: true,
              awardStartBonus: true,
              resolveTile: true,
              skipRoll: true
            }
          }));
        }
        return; // Pemain tidak melempar dadu pada giliran ini!
      }
    }

    if (gameState.gameStatus === GameStatus.FINISHED) return;

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('turn:ready', {
        detail: { player: gameState.getActivePlayer(), round: gameState.round }
      }));
    }
  }
}

export const turnManager = new TurnManager();
