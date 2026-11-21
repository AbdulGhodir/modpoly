import {gameState, PlayerStatus} from './GameState.js';
import {economyManager, TransactionType} from './EconomyManager.js';
import {returnGetOutOfJailCard} from '../data/cards.js';
import {toast, buildHud} from '../ui/hud.js';
import {BAIL_COST, MAX_JAIL_TURNS} from './jailRules.js';

export {BAIL_COST, MAX_JAIL_TURNS};

export class JailManager {
  constructor(state = gameState, economy = economyManager) {
    this.state = state;
    this.economy = economy;
  }

  isInJail(playerId) {
    const player = this.state.getPlayerById(playerId);
    return player ? (player.status === PlayerStatus.IN_JAIL || player.inJail === true) : false;
  }

  getJailTurns(playerId) {
    const player = this.state.getPlayerById(playerId);
    return player ? (player.jailTurns || 0) : 0;
  }

  hasGetOutOfJailCard(playerId) {
    const player = this.state.getPlayerById(playerId);
    return player ? ((player.hasGetOutOfJailCard || 0) > 0) : false;
  }

  sendToJail(playerId, reason = 'KE PENJARA') {
    const player = this.state.getPlayerById(playerId);
    if (!player) return false;

    // Pindahkan pion langsung ke petak Penjara (posisi 10)
    player.pos = 10;
    player.status = PlayerStatus.IN_JAIL;
    player.inJail = true;
    player.jailTurns = 0;
    player.consecutiveDoubles = 0;
    this.state.consecutiveDoubles = 0;

    toast(`🔒 ${player.name} masuk ke Penjara! (${reason})`);
    buildHud();

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('player:jailed', {
        detail: { playerId, player, reason }
      }));
    }

    return true;
  }

  releaseFromJail(playerId) {
    const player = this.state.getPlayerById(playerId);
    if (!player) return false;

    player.status = PlayerStatus.ACTIVE;
    player.inJail = false;
    player.jailTurns = 0;
    player.consecutiveDoubles = 0;
    this.state.consecutiveDoubles = 0;

    buildHud();

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('player:released', {
        detail: { playerId, player }
      }));
    }

    return true;
  }

  payBail(playerId) {
    const player = this.state.getPlayerById(playerId);
    if (!player) return { success: false, message: 'Pemain tidak ditemukan.' };
    if (!this.isInJail(playerId)) return { success: false, message: 'Pemain tidak sedang dipenjara.' };

    if (!this.economy.hasEnoughMoney(playerId, BAIL_COST)) {
      return {
        success: false,
        message: `Saldo ${player.name} tidak cukup untuk membayar denda $${BAIL_COST}!`
      };
    }

    const paid = this.economy.deductMoney(
      playerId,
      BAIL_COST,
      `Denda keluar dari Penjara: -$${BAIL_COST}`,
      TransactionType.BAIL
    );

    if (!paid) {
      return { success: false, message: 'Pembayaran denda gagal.' };
    }

    this.releaseFromJail(playerId);
    toast(`🔓 ${player.name} membayar denda $${BAIL_COST} dan bebas dari Penjara!`);

    return {
      success: true,
      cost: BAIL_COST,
      message: `${player.name} membayar denda $${BAIL_COST} dan bebas dari Penjara!`
    };
  }

  useGetOutOfJailCard(playerId) {
    const player = this.state.getPlayerById(playerId);
    if (!player) return { success: false, message: 'Pemain tidak ditemukan.' };
    if (!this.isInJail(playerId)) return { success: false, message: 'Pemain tidak sedang dipenjara.' };

    if (!this.hasGetOutOfJailCard(playerId)) {
      return { success: false, message: 'Pemain tidak memiliki Kartu Bebas Penjara.' };
    }

    player.hasGetOutOfJailCard--;
    returnGetOutOfJailCard();
    this.releaseFromJail(playerId);
    toast(`🎟️ ${player.name} menggunakan Kartu Bebas Penjara dan langsung bebas!`);

    return {
      success: true,
      message: `${player.name} menggunakan Kartu Bebas Penjara dan bebas!`
    };
  }

  processJailRoll(playerId, diceRoll) {
    const player = this.state.getPlayerById(playerId);
    if (!player) return { success: false, message: 'Pemain tidak ditemukan.' };
    if (!this.isInJail(playerId)) return { success: false, message: 'Pemain tidak sedang dipenjara.' };

    const {isDouble, total, dice} = diceRoll;

    // Kasus 1: Berhasil mendapatkan Double
    if (isDouble) {
      this.releaseFromJail(playerId);
      toast(`🎲 DOUBLE! (${dice[0]}+${dice[1]}) ${player.name} berhasil keluar dari Penjara!`);
      return {
        success: true,
        released: true,
        isDouble: true,
        total,
        dice,
        extraRollAllowed: false, // Aturan klasik: double saat keluar penjara TIDAK mendapat lemparan ekstra
        message: `Double (${dice[0]}+${dice[1]})! ${player.name} bebas dan bergerak ${total} petak.`
      };
    }

    // Kasus 2: Gagal mendapatkan Double
    player.jailTurns = (player.jailTurns || 0) + 1;

    // Jika sudah percobaan ke-3 gagal -> Wajib bayar denda $50
    if (player.jailTurns >= MAX_JAIL_TURNS) {
      const hasMoney = this.economy.hasEnoughMoney(playerId, BAIL_COST);

      if (hasMoney) {
        this.economy.deductMoney(
          playerId,
          BAIL_COST,
          `Denda wajib giliran ke-3 Penjara: -$${BAIL_COST}`,
          TransactionType.BAIL
        );
        this.releaseFromJail(playerId);
        toast(`⚠️ Percobaan ke-3 gagal! ${player.name} wajib bayar denda $${BAIL_COST} dan keluar bergerak.`);

        return {
          success: true,
          released: true,
          isDouble: false,
          total,
          dice,
          forcedBail: true,
          extraRollAllowed: false,
          message: `Percobaan ke-3 gagal. Denda $${BAIL_COST} dipotong, pemain bebas bergerak ${total} petak.`
        };
      } else {
        // Saldo tidak mencukupi untuk denda wajib
        toast(`🚨 Saldo ${player.name} tidak cukup membayar denda wajib $${BAIL_COST}!`);
        return {
          success: false,
          released: false,
          isDouble: false,
          total,
          dice,
          insolvent: true,
          message: `Saldo tidak mencukupi untuk membayar denda wajib $${BAIL_COST}.`
        };
      }
    }

    // Masih ada kesempatan tersisa (percobaan 1 atau 2)
    const sisa = MAX_JAIL_TURNS - player.jailTurns;
    toast(`🔒 Bukan Double (${dice[0]}+${dice[1]}). ${player.name} tetap di Penjara. Sisa kesempatan: ${sisa}.`);

    return {
      success: false,
      released: false,
      isDouble: false,
      total,
      dice,
      jailTurns: player.jailTurns,
      remainingAttempts: sisa,
      message: `Bukan double. Tetap di Penjara (${player.jailTurns}/${MAX_JAIL_TURNS}).`
    };
  }
}

export const jailManager = new JailManager();
