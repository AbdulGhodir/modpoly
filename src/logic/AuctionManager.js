import {gameState, PlayerStatus} from './GameState.js';
import {economyManager, TransactionType} from './EconomyManager.js';
import {propertyManager} from './PropertyManager.js';

export class AuctionManager {
  constructor() {
    this.isActive = false;
    this.property = null;
    this.highestBid = 0;
    this.highestBidder = null;
    this.activeBidderIds = [];
    this.currentPointer = 0;
    this.onFinishCallback = null;
  }

  startAuction(property, onFinish) {
    this.property = property;
    this.onFinishCallback = onFinish;
    this.isActive = true;

    // Lelang dimulai dari $0 (tawaran pertama minimal $1)
    this.highestBid = 0;
    this.highestBidder = null;

    // Semua pemain yang tidak bangkrut berhak mengikuti lelang (termasuk IN_JAIL)
    this.activeBidderIds = gameState.players
      .filter(p => p.status !== PlayerStatus.BANKRUPT)
      .map(p => p.id);

    this.currentPointer = 0;

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('auction:started', {
        detail: this.getAuctionState()
      }));
    }

    return this.getAuctionState();
  }

  getAuctionState() {
    const totalEligible = gameState.players.filter(p => p.status !== PlayerStatus.BANKRUPT).length;
    return {
      isActive: this.isActive,
      property: this.property,
      highestBid: this.highestBid,
      highestBidder: this.highestBidder,
      currentBidder: this.getCurrentBidder(),
      activeBidders: this.activeBidderIds.map(id => gameState.getPlayerById(id)).filter(Boolean),
      totalActiveBidders: this.activeBidderIds.length,
      passedCount: totalEligible - this.activeBidderIds.length
    };
  }

  getCurrentBidder() {
    if (!this.isActive || this.activeBidderIds.length === 0) return null;
    const currentId = this.activeBidderIds[this.currentPointer % this.activeBidderIds.length];
    return gameState.getPlayerById(currentId);
  }

  placeBid(amount) {
    if (!this.isActive) return false;
    const currentBidder = this.getCurrentBidder();
    if (!currentBidder) return false;

    const targetBid = Math.floor(Number(amount));
    
    // Validasi nilai penawaran
    if (this.highestBidder === null) {
      if (targetBid < 1) {
        console.warn(`[AuctionManager] Tawaran awal minimal $1`);
        return false;
      }
    } else {
      if (targetBid <= this.highestBid) {
        console.warn(`[AuctionManager] Tawaran ($${targetBid}) harus lebih tinggi dari tawaran saat ini ($${this.highestBid})`);
        return false;
      }
    }

    // Validasi saldo penawar
    if (currentBidder.money < targetBid) {
      console.warn(`[AuctionManager] Saldo ${currentBidder.name} ($${currentBidder.money}) tidak cukup untuk menawar $${targetBid}`);
      return false;
    }

    this.highestBid = targetBid;
    this.highestBidder = currentBidder;

    // Geser giliran ke penawar aktif berikutnya
    this.currentPointer = (this.currentPointer + 1) % this.activeBidderIds.length;

    // Jika hanya tersisa 1 penawar aktif dan dialah penawar tertinggi, lelang selesai
    if (this.activeBidderIds.length === 1 && this.highestBidder.id === this.activeBidderIds[0]) {
      return this._finishAuction(true);
    }

    this._notifyUpdate();
    return true;
  }

  pass() {
    if (!this.isActive) return false;
    const currentBidder = this.getCurrentBidder();
    if (!currentBidder) return false;

    const currentIndex = this.currentPointer % this.activeBidderIds.length;
    // Hapus penawar ini dari daftar penawar aktif
    this.activeBidderIds = this.activeBidderIds.filter(id => id !== currentBidder.id);

    if (this.activeBidderIds.length === 0) {
      return this._finishAuction(this.highestBidder !== null);
    }
    if (this.activeBidderIds.length === 1 && this.highestBidder !== null) {
      return this._finishAuction(true);
    }

    // After removing player at currentIndex, the next player is now at currentIndex
    this.currentPointer = currentIndex % this.activeBidderIds.length;
    this._notifyUpdate();
    return true;
  }

  removePlayerFromAuction(playerId) {
    if (!this.isActive) return;
    const wasHighestBidder = this.highestBidder && this.highestBidder.id === playerId;
    const currentIndex = this.activeBidderIds.length > 0 ? this.currentPointer % this.activeBidderIds.length : 0;

    this.activeBidderIds = this.activeBidderIds.filter(id => id !== playerId);

    if (wasHighestBidder) {
      this.highestBidder = null;
      this.highestBid = 0;
    }

    if (this.activeBidderIds.length === 0) {
      this._finishAuction(this.highestBidder !== null);
      return;
    }
    if (this.activeBidderIds.length === 1 && this.highestBidder !== null) {
      this._finishAuction(true);
      return;
    }
    this.currentPointer = currentIndex % this.activeBidderIds.length;
    this._notifyUpdate();
  }

  _finishAuction(hasWinner) {
    this.isActive = false;
    let result = null;

    if (hasWinner && this.highestBidder) {
      const winner = this.highestBidder;
      const finalPrice = this.highestBid;

      // Potong saldo pemenang lelang
      const paid = economyManager.deductMoney(
        winner.id,
        finalPrice,
        `Menang lelang ${this.property.name} seharga $${finalPrice}`,
        TransactionType.AUCTION
      );

      if (!paid) {
        result = {
          hasWinner: false,
          winner: null,
          price: 0,
          property: this.property,
          message: `Lelang ${this.property.name}: Pemenang tidak dapat membayar. Properti tetap milik Bank.`
        };
      } else {
        // Ubah kepemilikan properti ke pemenang
        propertyManager.setOwner(this.property.pos, winner.id);

        result = {
          hasWinner: true,
          winner,
          price: finalPrice,
          property: this.property,
          message: `🎉 ${winner.name} memenangkan lelang ${this.property.name} seharga $${finalPrice.toLocaleString('id-ID')}!`
        };
      }
    } else {
      result = {
        hasWinner: false,
        winner: null,
        price: 0,
        property: this.property,
        message: `Lelang ${this.property.name} berakhir tanpa pemenang. Properti tetap milik Bank.`
      };
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('auction:ended', { detail: result }));
    }

    if (this.onFinishCallback) {
      this.onFinishCallback(result);
    }

    return result;
  }

  _notifyUpdate() {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('auction:updated', {
        detail: this.getAuctionState()
      }));
    }
  }
}

export const auctionManager = new AuctionManager();
