import {gameState, PlayerStatus, GameStatus} from './GameState.js';
import {economyManager, TransactionType} from './EconomyManager.js';
import {propertyManager} from './PropertyManager.js';
import {toast, buildHud} from '../ui/hud.js';

export class TradeManager {
  constructor(state = gameState, economy = economyManager, properties = propertyManager) {
    this.state = state;
    this.economy = economy;
    this.properties = properties;
    this.executedOffers = new WeakSet();
  }

  validateTrade({
    fromPlayerId,
    toPlayerId,
    giveMoney = 0,
    receiveMoney = 0,
    givePropPositions = [],
    receivePropPositions = [],
    giveJailCards = 0,
    receiveJailCards = 0
  }) {
    const fromPlayer = this.state.getPlayerById(fromPlayerId);
    const toPlayer = this.state.getPlayerById(toPlayerId);

    if (!fromPlayer || !toPlayer) {
      return { valid: false, reason: 'Pemain tidak ditemukan.' };
    }

    if (fromPlayer.id === toPlayer.id) {
      return { valid: false, reason: 'Tidak dapat berdagang dengan diri sendiri.' };
    }

    if (this.state.gameStatus === GameStatus.FINISHED) {
      return { valid: false, reason: 'Permainan telah selesai. Tidak dapat berdagang.' };
    }

    if (fromPlayer.status === PlayerStatus.BANKRUPT || toPlayer.status === PlayerStatus.BANKRUPT) {
      return { valid: false, reason: 'Pemain bangkrut tidak dapat berdagang.' };
    }

    // Validasi saldo uang
    if (fromPlayer.money < giveMoney) {
      return { valid: false, reason: `Saldo ${fromPlayer.name} ($${fromPlayer.money}) tidak cukup untuk menawarkan $${giveMoney}.` };
    }

    if (toPlayer.money < receiveMoney) {
      return { valid: false, reason: `Saldo ${toPlayer.name} ($${toPlayer.money}) tidak cukup untuk memberikan $${receiveMoney}.` };
    }

    // Validasi kartu bebas penjara
    if ((fromPlayer.hasGetOutOfJailCard || 0) < giveJailCards) {
      return { valid: false, reason: `${fromPlayer.name} tidak memiliki cukup Kartu Bebas Penjara.` };
    }

    if ((toPlayer.hasGetOutOfJailCard || 0) < receiveJailCards) {
      return { valid: false, reason: `${toPlayer.name} tidak memiliki cukup Kartu Bebas Penjara.` };
    }

    // Validasi properti yang diberikan oleh fromPlayer
    for (const pos of givePropPositions) {
      const prop = this.properties.getProperty(pos);
      if (!prop || prop.owner !== fromPlayer.id) {
        return { valid: false, reason: `Properti ${prop ? prop.name : pos} bukan milik ${fromPlayer.name}.` };
      }
      if (prop.houses > 0 || prop.hasHotel) {
        return { valid: false, reason: `Properti ${prop.name} masih memiliki bangunan. Jual seluruh bangunan terlebih dahulu.` };
      }
      if (prop.type === 'prop') {
        const groupProps = this.properties.getColorGroupProperties(prop.group);
        if (groupProps.some(p => p.houses > 0 || p.hasHotel)) {
          return { valid: false, reason: `Kelompok warna ${prop.group} masih memiliki bangunan di kota lain. Jual semua bangunan terlebih dahulu.` };
        }
      }
    }

    // Validasi properti yang diminta dari toPlayer
    for (const pos of receivePropPositions) {
      const prop = this.properties.getProperty(pos);
      if (!prop || prop.owner !== toPlayer.id) {
        return { valid: false, reason: `Properti ${prop ? prop.name : pos} bukan milik ${toPlayer.name}.` };
      }
      if (prop.houses > 0 || prop.hasHotel) {
        return { valid: false, reason: `Properti ${prop.name} masih memiliki bangunan. Jual seluruh bangunan terlebih dahulu.` };
      }
      if (prop.type === 'prop') {
        const groupProps = this.properties.getColorGroupProperties(prop.group);
        if (groupProps.some(p => p.houses > 0 || p.hasHotel)) {
          return { valid: false, reason: `Kelompok warna ${prop.group} masih memiliki bangunan di kota lain. Jual semua bangunan terlebih dahulu.` };
        }
      }
    }

    return { valid: true };
  }

  executeTrade(tradeOffer) {
    if (tradeOffer && typeof tradeOffer === 'object' && this.executedOffers.has(tradeOffer)) {
      return { success: false, reason: 'Tawaran ini sudah pernah diproses.' };
    }
    const check = this.validateTrade(tradeOffer);
    if (!check.valid) {
      return { success: false, reason: check.reason };
    }

    const {
      fromPlayerId,
      toPlayerId,
      giveMoney = 0,
      receiveMoney = 0,
      givePropPositions = [],
      receivePropPositions = [],
      giveJailCards = 0,
      receiveJailCards = 0
    } = tradeOffer;

    const fromPlayer = this.state.getPlayerById(fromPlayerId);
    const toPlayer = this.state.getPlayerById(toPlayerId);

    // EKSEKUSI ATOMIK:
    // 1. Transfer Uang
    if (giveMoney > 0) {
      this.economy.transferMoney(
        fromPlayer.id,
        toPlayer.id,
        giveMoney,
        `Perdagangan aset (Trade): ${fromPlayer.name} ➔ ${toPlayer.name}`,
        TransactionType.TRADE
      );
    }

    if (receiveMoney > 0) {
      this.economy.transferMoney(
        toPlayer.id,
        fromPlayer.id,
        receiveMoney,
        `Perdagangan aset (Trade): ${toPlayer.name} ➔ ${fromPlayer.name}`,
        TransactionType.TRADE
      );
    }

    // 2. Transfer Kartu Bebas Penjara
    if (giveJailCards > 0 || receiveJailCards > 0) {
      fromPlayer.hasGetOutOfJailCard = (fromPlayer.hasGetOutOfJailCard || 0) - giveJailCards + receiveJailCards;
      toPlayer.hasGetOutOfJailCard = (toPlayer.hasGetOutOfJailCard || 0) - receiveJailCards + giveJailCards;
    }

    // 3. Transfer Properti
    givePropPositions.forEach(pos => {
      this.properties.setOwner(pos, toPlayer.id);
    });

    receivePropPositions.forEach(pos => {
      this.properties.setOwner(pos, fromPlayer.id);
    });

    toast(`🤝 Kesepakatan perdagangan antara ${fromPlayer.name} dan ${toPlayer.name} berhasil diselesaikan!`);
    buildHud();

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('trade:completed', {
        detail: { tradeOffer, fromPlayer, toPlayer }
      }));
    }

    this.executedOffers.add(tradeOffer);

    return {
      success: true,
      message: `Perdagangan antara ${fromPlayer.name} dan ${toPlayer.name} sukses!`
    };
  }
}

export const tradeManager = new TradeManager();
