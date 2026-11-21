import {gameState, PlayerStatus, GameStatus} from './GameState.js';
import {economyManager, TransactionType} from './EconomyManager.js';
import {propertyManager} from './PropertyManager.js';
import {auctionManager} from './AuctionManager.js';
import {toast, buildHud} from '../ui/hud.js';

export class BankruptcyManager {
  constructor(state = gameState, economy = economyManager, properties = propertyManager, auction = auctionManager) {
    this.state = state;
    this.economy = economy;
    this.properties = properties;
    this.auction = auction;
  }

  checkSolvency(playerId, amountToPay) {
    const player = this.state.getPlayerById(playerId);
    if (!player) return { canPayNow: false, canLiquidateToPay: false, totalLiquidationValue: 0 };

    if (player.money >= amountToPay) {
      return {
        canPayNow: true,
        canLiquidateToPay: true,
        deficit: 0,
        totalLiquidationValue: player.money
      };
    }

    const deficit = amountToPay - player.money;
    let liquidationValue = player.money;

    const props = this.properties.getPlayerProperties(playerId);
    props.forEach(p => {
      // Nilai penjualan bangunan (50% dari harga bangun)
      if (p.hasHotel) {
        liquidationValue += Math.floor((p.hotelPrice || 50) * 0.5);
      }
      if (p.houses > 0) {
        liquidationValue += Math.floor((p.housePrice || 50) * 0.5) * p.houses;
      }
      // Nilai hipotek jika belum digadaikan
      if (!p.isMortgaged) {
        liquidationValue += (p.mortgageValue || Math.floor((p.price || 0) / 2));
      }
    });

    return {
      canPayNow: false,
      canLiquidateToPay: liquidationValue >= amountToPay,
      deficit,
      totalLiquidationValue: liquidationValue
    };
  }

  declareBankruptcy(debtorId, creditorId, debtAmount = 0) {
    const debtor = this.state.getPlayerById(debtorId);
    if (!debtor) return false;

    debtor.status = PlayerStatus.BANKRUPT;
    debtor.consecutiveDoubles = 0;
    if (this.state.getActivePlayer()?.id === debtor.id) {
      this.state.consecutiveDoubles = 0;
      this.state.lastRoll = null;
    }

    // Hapus debitor dari lelang aktif jika lelang sedang berlangsung
    if (this.auction && this.auction.isActive) {
      this.auction.removePlayerFromAuction(debtor.id);
    }

    const creditor = (creditorId && creditorId !== 'BANK')
      ? this.state.getPlayerById(creditorId)
      : null;

    // 1. Likuidasi seluruh bangunan (rumah / hotel) milik debitor kembali ke Bank
    const debtorProps = this.properties.getPlayerProperties(debtor.id);
    let buildingLiquidationCash = 0;

    debtorProps.forEach(p => {
      if (p.hasHotel) {
        const refund = Math.floor((p.hotelPrice || 50) * 0.5);
        buildingLiquidationCash += refund;
        p.hasHotel = false;
        if (typeof this.state.bankHotels === 'number') this.state.bankHotels++;
      }
      if (p.houses > 0) {
        const refund = Math.floor((p.housePrice || 50) * 0.5) * p.houses;
        buildingLiquidationCash += refund;
        if (typeof this.state.bankHouses === 'number') this.state.bankHouses += p.houses;
        p.houses = 0;
      }
    });

    const totalCash = debtor.money + buildingLiquidationCash;
    debtor.money = 0;

    // 2. Kasus A: Bangkrut kepada pemain lain
    if (creditor) {
      // Transfer seluruh sisa uang + hasil likuidasi bangunan ke kreditur
      if (totalCash > 0) {
        creditor.money += totalCash;
        this.economy.logTransaction({
          players: [debtor.name, creditor.name],
          amount: totalCash,
          type: TransactionType.BANKRUPTCY,
          description: `${debtor.name} bangkrut! Menyerahkan uang kas $${totalCash.toLocaleString('id-ID')} kepada ${creditor.name}`
        });
      }

      // Serahkan kartu bebas penjara jika ada
      if (debtor.hasGetOutOfJailCard > 0) {
        creditor.hasGetOutOfJailCard = (creditor.hasGetOutOfJailCard || 0) + debtor.hasGetOutOfJailCard;
        debtor.hasGetOutOfJailCard = 0;
      }

      // Serahkan seluruh properti kepada kreditur (status hipotek tetap melekat)
      debtorProps.forEach(p => {
        const wasMortgaged = p.isMortgaged;
        this.properties.setOwner(p.pos, creditor.id);
        if (wasMortgaged) {
          p.isMortgaged = true; // Status hipotek tetap melekat
          const interest = Math.round((p.mortgageValue || 0) * 0.1);
          if (interest > 0 && creditor.money >= interest) {
            this.economy.deductMoney(
              creditor.id,
              interest,
              `Bunga 10% atas penerimaan properti tergadai: ${p.name}`,
              TransactionType.MORTGAGE
            );
          }
        }
      });

      toast(`💥 ${debtor.name} BANGKRUT! Seluruh aset & properti diserahkan kepada ${creditor.name}.`);
    }
    // 3. Kasus B: Bangkrut kepada Bank
    else {
      if (totalCash > 0) {
        this.economy.logTransaction({
          players: [debtor.name, 'Bank'],
          amount: totalCash,
          type: TransactionType.BANKRUPTCY,
          description: `${debtor.name} bangkrut kepada Bank! Menyerahkan sisa dana $${totalCash.toLocaleString('id-ID')}`
        });
      }

      debtor.hasGetOutOfJailCard = 0;

      // Kembalikan seluruh properti ke Bank (status kepemilikan dilepas)
      debtorProps.forEach(p => {
        p.isMortgaged = false;
        this.properties.setOwner(p.pos, null);
      });

      toast(`💥 ${debtor.name} BANGKRUT kepada Bank! Semua properti dikembalikan ke Bank.`);
    }

    buildHud();

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('player:bankrupt', {
        detail: { debtor, creditor, debtAmount }
      }));
    }

    // 4. Periksa apakah tersisa 1 pemenang
    this.checkWinner();

    return true;
  }

  getActivePlayers() {
    return this.state.players.filter(p => p.status !== PlayerStatus.BANKRUPT);
  }

  checkWinner() {
    const activePlayers = this.getActivePlayers();
    if (activePlayers.length === 1 && this.state.gameStatus !== GameStatus.FINISHED) {
      const winner = activePlayers[0];
      this.state.gameStatus = GameStatus.FINISHED;

      toast(`🏆 PERMAINAN SELESAI! ${winner.name} (${winner.cn}) MENANG MUTLAK!`);

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('game:over', {
          detail: { winner, totalPlayers: this.state.players.length }
        }));
      }

      return winner;
    }
    return null;
  }
}

export const bankruptcyManager = new BankruptcyManager();
