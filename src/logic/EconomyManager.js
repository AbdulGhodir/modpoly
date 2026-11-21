import {gameState} from './GameState.js';

export const TransactionType = {
  SALARY: 'SALARY',                 // Gaji lewat Start
  BUY_PROP: 'BUY_PROP',             // Beli properti
  RENT: 'RENT',                     // Bayar sewa
  TAX: 'TAX',                       // Bayar pajak
  BUILD: 'BUILD',                   // Bangun rumah / hotel
  SELL_BUILD: 'SELL_BUILD',         // Jual rumah / hotel
  MORTGAGE: 'MORTGAGE',             // Gadai properti
  UNMORTGAGE: 'UNMORTGAGE',         // Tebus gadai
  TRANSFER: 'TRANSFER',             // Transfer antar pemain
  CHANCE: 'CHANCE',                 // Hadiah / denda kesempatan
  BAIL: 'BAIL',                     // Tebusan penjara
  BANKRUPTCY: 'BANKRUPTCY',         // Penyelesaian kebangkrutan
  TRADE: 'TRADE',                   // Perdagangan antar pemain
  AUCTION: 'AUCTION',               // Pembayaran lelang
  PARKING_TRAVEL: 'PARKING_TRAVEL', // Biaya pindah Parkir Bebas
  CARD_REWARD: 'CARD_REWARD',       // Hadiah kartu
  CARD_PENALTY: 'CARD_PENALTY'      // Denda kartu
};

let txCounter = 1;

export class EconomyManager {
  constructor(state = gameState) { this.state = state; }

  hasEnoughMoney(playerId, amount) {
    const player = this.state.getPlayerById(playerId);
    if (!player) return false;
    return player.money >= amount;
  }

  addMoney(playerId, amount, reason = '', type = TransactionType.SALARY) {
    if (amount <= 0) return false;
    const player = this.state.getPlayerById(playerId);
    if (!player) return false;

    player.money += amount;

    this.logTransaction({
      players: [player.name],
      amount,
      type,
      description: reason || `Pemasukan untuk ${player.name}: +$${amount.toLocaleString('id-ID')}`
    });

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('economy:transaction', {
        detail: { playerId, amount: +amount, newBalance: player.money, type, reason }
      }));
    }

    return true;
  }

  deductMoney(playerId, amount, reason = '', type = TransactionType.TRANSFER) {
    if (amount <= 0) return false;
    const player = this.state.getPlayerById(playerId);
    if (!player) return false;

    // Larang saldo menjadi negatif tanpa mekanisme kebangkrutan khusus
    if (player.money < amount) {
      console.warn(`[EconomyManager] Saldo ${player.name} ($${player.money}) tidak mencukupi untuk pembayaran $${amount}`);
      return false;
    }

    player.money -= amount;

    this.logTransaction({
      players: [player.name],
      amount,
      type,
      description: reason || `Pengeluaran oleh ${player.name}: -$${amount.toLocaleString('id-ID')}`
    });

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('economy:transaction', {
        detail: { playerId, amount: -amount, newBalance: player.money, type, reason }
      }));
    }

    return true;
  }

  transferMoney(fromPlayerId, toPlayerId, amount, reason = '', type = TransactionType.RENT) {
    if (amount <= 0) return false;
    const sender = this.state.getPlayerById(fromPlayerId);
    const receiver = this.state.getPlayerById(toPlayerId);
    if (!sender || !receiver) return false;

    // Pastikan saldo pengirim cukup
    if (sender.money < amount) {
      console.warn(`[EconomyManager] ${sender.name} tidak cukup dana untuk transfer ke ${receiver.name}`);
      return false;
    }

    sender.money -= amount;
    receiver.money += amount;

    this.logTransaction({
      players: [sender.name, receiver.name],
      amount,
      type,
      description: reason || `${sender.name} membayar $${amount.toLocaleString('id-ID')} kepada ${receiver.name}`
    });

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('economy:transaction', {
        detail: { fromPlayerId, toPlayerId, amount, type, reason }
      }));
    }

    return true;
  }

  logTransaction({ players, amount, type, description }) {
    const tx = {
      id: `tx_${Date.now()}_${txCounter++}`,
      time: new Date().toISOString(),
      players: Array.isArray(players) ? players : [String(players)],
      amount: Math.abs(amount),
      type,
      description
    };
    this.state.transactions.push(tx);
    return tx;
  }

  getTransactions(limit = 20) {
    return this.state.transactions.slice(-limit).reverse();
  }
}

export const economyManager = new EconomyManager();
