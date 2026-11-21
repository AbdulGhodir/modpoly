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
  constructor(state = gameState, dependencies = {}) {
    this.state = state;
    this.propertyManager = dependencies.propertyManager || propertyManager;
    this.economyManager = dependencies.economyManager || economyManager;
    this.bankruptcyManager = dependencies.bankruptcyManager || bankruptcyManager;
    this.jailManager = dependencies.jailManager || jailManager;
    this.tradeModalManager = dependencies.tradeModalManager || tradeModalManager;
    this.tileModalManager = dependencies.tileModalManager || tileModalManager;
    this.jailModalManager = dependencies.jailModalManager || jailModalManager;
    this.freeParkingModalManager = dependencies.freeParkingModalManager || freeParkingModalManager;
    this.bankruptcyModalManager = dependencies.bankruptcyModalManager || bankruptcyModalManager;
    this.phase = TurnPhase.WAITING_ROLL;
    this.chanceDepth = 0;
    this.lastEndedTurnKey = null;
  }

  getPhase() {
    return this.phase;
  }

  setPhase(newPhase) {
    const oldPhase = this.phase;
    this.phase = newPhase;
    this.state.phase = newPhase;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('phase:changed', {
        detail: { from: oldPhase, to: newPhase, player: this.state.getActivePlayer() }
      }));
    }
  }

  canRoll() {
    if (this.state.gameStatus === GameStatus.FINISHED) return false;

    // Dadu tidak boleh diklik jika ada modal interaksi yang sedang terbuka
    if (tileModalManager && this.tileModalManager.isOpen()) return false;
    if (jailModalManager && this.jailModalManager.isOpen()) return false;
    if (freeParkingModalManager && this.freeParkingModalManager.isOpen()) return false;
    if (bankruptcyModalManager && this.bankruptcyModalManager.isOpen()) return false;
    if (tradeModalManager && this.tradeModalManager.isOpen()) return false;

    // Cegah lempar dadu jika pion sedang bergerak atau petak sedang diproses
    if (this.phase === TurnPhase.MOVING || this.phase === TurnPhase.RESOLVING_TILE || this.phase === TurnPhase.ROLLING) return false;

    const player = this.state.getActivePlayer();
    if (!player || player.status === PlayerStatus.BANKRUPT) return false;

    const isDouble = this.state.lastRoll?.isDouble;
    const isFreeParking = player.pos === 20;
    const allowExtraRoll = isDouble && !this.jailManager.isInJail(player?.id) && (player?.consecutiveDoubles || 0) < 3 && !isFreeParking;

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
    const player = this.state.getActivePlayer();
    if (!player || player.status === PlayerStatus.BANKRUPT) {
      return { canMove: false, allowExtraRoll: false };
    }
    this.state.lastRoll = rollData;

    // A. JIKA PEMAIN SEDANG DI PENJARA
    if (this.jailManager.isInJail(player.id)) {
      const jailRes = this.jailManager.processJailRoll(player.id, rollData);
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
      this.state.consecutiveDoubles = player.consecutiveDoubles;

      if (player.consecutiveDoubles >= 3) {
        // ATURAN KLASIK: 3x Double berturut-turut -> Langsung masuk penjara!
        this.jailManager.sendToJail(player.id, '3x Double Berturut-turut');
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
      this.state.consecutiveDoubles = 0;
      return {
        canMove: true,
        rollData,
        allowExtraRoll: false
      };
    }
  }

  startMoving(rollData) {
    this.state.lastRoll = rollData;
    this.setPhase(TurnPhase.MOVING);
  }

  async resolveTile(tileIdx) {
    if (this.state.gameStatus === GameStatus.FINISHED) return;
    this.setPhase(TurnPhase.RESOLVING_TILE);
    const player = this.state.getActivePlayer();
    const tile = TILES[tileIdx];
    const prop = this.propertyManager.getProperty(tileIdx);

    // 1. Petak Properti (Kota, Stasiun, Utilitas)
    if (prop) {
      // Kasus A: Belum dimiliki -> Munculkan Popup Pembelian
      if (!prop.owner) {
        const buyResult = await this.tileModalManager.promptPurchase(prop, player);
        this._notifyResolved({ tile, prop, action: 'PURCHASE_OR_AUCTION', result: buyResult });
        return buyResult;
      }

      // Kasus B: Milik pemain itu sendiri
      if (prop.owner === player.id) {
        this._notifyResolved({ tile, prop, action: 'OWN_PROPERTY' });
        return { action: 'OWN_PROPERTY', prop };
      }

      // Kasus C: Milik pemain lain
      const owner = this.state.getPlayerById(prop.owner);

      // Jika properti sedang digadaikan -> Bebas sewa
      if (prop.isMortgaged) {
        this._notifyResolved({ tile, prop, action: 'MORTGAGED' });
        return { action: 'MORTGAGED', prop };
      }

      // Hitung tarif sewa berdasarkan data CSV & status monopoli / rumah
      const rent = this.propertyManager.calculateRent(tileIdx, this.state.lastRoll?.total || 7);
      const rentResult = await this.tileModalManager.promptRent(prop, player, owner, rent);
      this._notifyResolved({ tile, prop, action: 'RENT_PAID', result: rentResult });
      return rentResult;
    }

    // 2. Petak Pajak
    if (tile.type === 'tax') {
      const taxAmount = Number(tile.price || 0);
      if (player.money < taxAmount) {
        const debtRes = await this.bankruptcyModalManager.promptDebtResolution(
          player,
          null,
          taxAmount,
          `Pajak ${tile.nama}`
        );
        if (debtRes.resolved) {
          this.economyManager.deductMoney(player.id, taxAmount, `Bayar ${tile.nama}`, TransactionType.TAX);
          buildHud();
        }
      } else {
        this.economyManager.deductMoney(player.id, taxAmount, `Bayar ${tile.nama}`, TransactionType.TAX);
        buildHud();
      }
      this._notifyResolved({ tile, action: 'TAX', taxAmount });
      return { action: 'TAX', taxAmount };
    }

    // 3. Petak Kartu Kesempatan
    if (tile.type === 'chance') {
      if (this.chanceDepth >= 2) {
        this._notifyResolved({ tile, action: 'CHANCE_LIMIT' });
        return { action: 'CHANCE_LIMIT' };
      }
      this.chanceDepth++;
      try {
        const cardResult = await this.tileModalManager.promptChanceCard(player);
        this._notifyResolved({ tile, action: 'CHANCE', result: cardResult });
        return cardResult;
      } finally {
        this.chanceDepth--;
      }
    }

    // 4. Petak Pojok (Corner)
    if (tile.type === 'corner') {
      if (tile.pos === 30) {
        // ATURAN KLASIK: Masuk Penjara!
        this.jailManager.sendToJail(player.id, 'Mendarat di petak KE PENJARA');
        this._notifyResolved({ tile, action: 'JAIL', jailed: true });
        return { action: 'JAIL', tile };
      }
      this._notifyResolved({ tile, action: 'CORNER' });
      return { action: 'CORNER', tile };
    }

    this._notifyResolved({ tile, action: 'LAND' });
    return { action: 'LAND', tile };
  }

  _notifyResolved(detail) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('tile:resolved', { detail }));
    }
  }

  startPlayerAction(options = {}) {
    const player = this.state.getActivePlayer();
    // 1. Guard kebangkrutan: Pemain bangkrut tidak boleh mendapatkan aksi giliran
    if (!player || player.status === PlayerStatus.BANKRUPT) {
      this.endTurn();
      return;
    }

    this.setPhase(TurnPhase.PLAYER_ACTION);

    const isDouble = this.state.lastRoll?.isDouble;
    const isFreeParking = player.pos === 20;

    // Jika mendarat di Parkir Bebas, batalkan kesempatan lempar ulang dan reset double
    if (isFreeParking) {
      player.consecutiveDoubles = 0;
      this.state.consecutiveDoubles = 0;
    }

    // Double hanya memberikan lemparan ulang jika:
    // - Hasil dadu adalah double
    // - Pemain TIDAK sedang dipenjara
    // - Tidak terkena aturan 3x double
    // - Pemain TIDAK berhenti di petak Parkir Bebas (posisi 20)
    // - Tidak dipaksa false oleh opsi aksi
    const allowExtraRoll = options.allowExtraRoll !== undefined
      ? options.allowExtraRoll
      : (isDouble && !this.jailManager.isInJail(player?.id) && (player?.consecutiveDoubles || 0) < 3 && !isFreeParking);

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

  endTurn(expectedTurnKey = null) {
    if (this.state.gameStatus === GameStatus.FINISHED || this.phase === TurnPhase.GAME_OVER) return;
    const currentPlayer = this.state.getActivePlayer();
    const turnKey = `${this.state.round}:${this.state.currentTurn}:${currentPlayer?.playerId || currentPlayer?.id}`;
    if (expectedTurnKey && expectedTurnKey !== turnKey) return;
    if (this.lastEndedTurnKey === turnKey) return;
    this.lastEndedTurnKey = turnKey;
    this.setPhase(TurnPhase.END_TURN);

    const activePlayer = this.state.getActivePlayer();
    if (activePlayer) {
      activePlayer.consecutiveDoubles = 0;
    }
    this.state.consecutiveDoubles = 0;
    this.state.lastRoll = null;

    // Cari pemain aktif berikutnya yang belum bangkrut
    const totalPlayers = this.state.players.length;
    let nextTurn = (this.state.currentTurn + 1) % totalPlayers;
    let attempts = 0;

    while (this.state.players[nextTurn].status === PlayerStatus.BANKRUPT && attempts < totalPlayers) {
      nextTurn = (nextTurn + 1) % totalPlayers;
      attempts++;
    }

    // Jika tersisa 1 pemenang aktif
    const winner = this.bankruptcyManager.checkWinner();
    if (winner || attempts >= totalPlayers) {
      this.setPhase(TurnPhase.GAME_OVER);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('game:over', { detail: { winner } }));
      }
      return;
    }

    if (nextTurn <= this.state.currentTurn) {
      this.state.round++;
    }

    this.state.currentTurn = nextTurn;
    this.state.turnId = (this.state.turnId || 0) + 1;
    const nextPlayer = this.state.players[nextTurn];
    this.state.activePlayerId = nextPlayer?.playerId || null;
    if (nextPlayer) {
      nextPlayer.consecutiveDoubles = 0;
    }

    this.startTurn();
  }

  async startTurn() {
    if (this.state.gameStatus === GameStatus.FINISHED) {
      this.setPhase(TurnPhase.GAME_OVER);
      return;
    }
    this.setPhase(TurnPhase.WAITING_ROLL);
    const player = this.state.getActivePlayer();

    // Guard: Jika pemain tidak ada atau bangkrut, lewati giliran
    if (!player || player.status === PlayerStatus.BANKRUPT) {
      this.endTurn();
      return;
    }

    // 1. Jika pemain aktif sedang berada di Penjara, tampilkan Jail Modal
    if (this.jailManager.isInJail(player.id)) {
      const res = await this.jailModalManager.promptJailAction(player);
      if (res.action === 'PAY_BAIL') {
        this.jailManager.payBail(player.id);
        buildHud();
      } else if (res.action === 'USE_CARD') {
        this.jailManager.useGetOutOfJailCard(player.id);
        buildHud();
      }
    }
    // 2. SISTEM KHUSUS PARKIR BEBAS (FREE PARKING TRAVEL):
    // Jika pemain memulai gilirannya di petak 20 (Parkir Bebas) dan tidak di penjara:
    else if (player.pos === 20) {
      const travelChoice = await this.freeParkingModalManager.promptTravel(player);
      if (this.state.gameStatus === GameStatus.FINISHED) return;
      if (travelChoice && travelChoice.action === 'TRAVEL') {
        // Potong biaya $50
        this.economyManager.deductMoney(
          player.id,
          50,
          `Layanan Travel Parkir Bebas ke ${TILES[travelChoice.targetPos]?.nama}`,
          TransactionType.PARKING_TRAVEL || TransactionType.OTHER
        );
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

    if (this.state.gameStatus === GameStatus.FINISHED) return;

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('turn:ready', {
        detail: { player: this.state.getActivePlayer(), round: this.state.round }
      }));
    }
  }
}

export const turnManager = new TurnManager();
