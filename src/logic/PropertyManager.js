import {TILES} from '../data/tiles.js';
import {gameState} from './GameState.js';
import {economyManager, TransactionType} from './EconomyManager.js';
import {purchaseUnownedProperty} from './purchaseUnownedProperty.js';
import {initializePropertyState} from './propertyState.js';
import {calculatePropertyRent} from './rent.js';
import {getMortgageEligibility, getUnmortgageEligibility, getBuildingSaleEligibility} from './mortgage.js';

export class PropertyManager {
  constructor(state = gameState, economy = economyManager) {
    this.state = state;
    this.economy = economy;
    this.initProperties();
  }

  // Menghubungkan dan memetakan data properti dari TILES (sumber CSV) ke dalam GameState
  initProperties() {
    initializePropertyState(this.state, TILES);
  }

  _buildRentTable(tile) {
    if (tile.type === 'prop') {
      return {
        base: Number(tile.sewa_tanah || 0),
        house1: Number(tile.sewa_rumah_1 || 0),
        house2: Number(tile.sewa_rumah_2 || 0),
        house3: Number(tile.sewa_rumah_3 || 0),
        house4: Number(tile.sewa_rumah_4 || 0),
        hotel: Number(tile.sewa_hotel || 0)
      };
    } else if (tile.type === 'rail') {
      return {
        count1: Number(tile.sewa_1 || 25),
        count2: Number(tile.sewa_2 || 50),
        count3: Number(tile.sewa_3 || 100),
        count4: Number(tile.sewa_4 || 200)
      };
    } else if (tile.type === 'util') {
      return {
        factor1: Number(tile.faktor_1 || 4),
        factor2: Number(tile.faktor_2 || 10)
      };
    }
    return {};
  }

  getProperty(pos) {
    return this.state.properties.get(pos) || null;
  }

  getAllProperties() {
    return Array.from(this.state.properties.values());
  }

  getPlayerProperties(playerId) {
    return this.getAllProperties().filter(p => p.owner === playerId);
  }

  setOwner(pos, playerId) {
    const prop = this.getProperty(pos);
    if (!prop) return false;

    // Hapus dari pemilik lama jika ada
    if (prop.owner !== null) {
      const prevPlayer = this.state.getPlayerById(prop.owner);
      if (prevPlayer) {
        prevPlayer.properties = prevPlayer.properties.filter(id => id !== prop.id);
      }
    }

    // Set pemilik baru
    prop.owner = playerId;
    if (playerId !== null) {
      const newPlayer = this.state.getPlayerById(playerId);
      if (newPlayer && !newPlayer.properties.includes(prop.id)) {
        newPlayer.properties.push(prop.id);
      }
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('property:updated', {
        detail: { pos, playerId, property: prop }
      }));
    }
    return true;
  }

  purchaseProperty(pos, playerId) {
    return purchaseUnownedProperty({
      state: this.state,
      economy: this.economy,
      properties: this,
      pos,
      playerId
    });
  }

  getColorGroupProperties(group) {
    return this.getAllProperties().filter(p => p.type === 'prop' && p.group === group);
  }

  isColorGroupMonopoly(playerId, group) {
    if (!playerId || !group) return false;
    const groupProps = this.getColorGroupProperties(group);
    if (groupProps.length === 0) return false;
    return groupProps.every(p => p.owner === playerId);
  }

  calculateRent(pos, diceRoll = 7) {
    const prop = this.getProperty(pos);
    return calculatePropertyRent(prop, this.state.properties, diceRoll);
  }

  // ─── SISTEM PEMBANGUNAN RUMAH & HOTEL ──────────────────────────────────────

  canBuildHouse(pos) {
    const prop = this.getProperty(pos);
    if (!prop) return { success: false, canBuild: false, reason: 'Properti tidak ditemukan.' };
    if (prop.type !== 'prop') return { success: false, canBuild: false, reason: 'Hanya kota/tanah yang dapat dibangun rumah.' };
    if (!prop.owner) return { success: false, canBuild: false, reason: 'Properti belum dimiliki.' };
    if (prop.isMortgaged) return { success: false, canBuild: false, reason: 'Properti sedang digadaikan.' };
    if (prop.hasHotel) return { success: false, canBuild: false, reason: 'Properti sudah memiliki Hotel maksimal.' };
    if (prop.houses >= 4) return { success: false, canBuild: false, reason: 'Sudah 4 rumah. Silakan tingkatkan ke Hotel.' };

    // Syarat Monopoli kelompok warna
    if (!this.isColorGroupMonopoly(prop.owner, prop.group)) {
      return { success: false, canBuild: false, reason: 'Wajib memiliki seluruh kota dalam kelompok warna yang sama.' };
    }

    const groupProps = this.getColorGroupProperties(prop.group);

    // Larangan pembangunan jika ada properti sekelompok yang sedang digadaikan
    if (groupProps.some(p => p.isMortgaged)) {
      return { success: false, canBuild: false, reason: 'Ada properti dalam kelompok warna ini yang sedang digadaikan.' };
    }

    // Aturan pembangunan merata: jumlah rumah tidak boleh mendahului properti lain dalam kelompok
    const minHouses = Math.min(...groupProps.map(p => p.hasHotel ? 5 : p.houses));
    if (prop.houses > minHouses) {
      return { success: false, canBuild: false, reason: 'Pembangunan harus merata. Bangun properti lain yang lebih sedikit rumahnya terlebih dahulu.' };
    }

    // Stok rumah Bank
    if ((this.state.bankHouses ?? 32) <= 0) {
      return { success: false, canBuild: false, reason: 'Persediaan rumah di Bank telah habis.' };
    }

    // Ketersediaan saldo pemain
    const cost = prop.housePrice || 50;
    if (!this.economy.hasEnoughMoney(prop.owner, cost)) {
      return { success: false, canBuild: false, reason: `Saldo tidak cukup untuk membangun rumah ($${cost}).` };
    }

    return { success: true, canBuild: true, cost, prop };
  }

  buildHouse(pos) {
    const check = this.canBuildHouse(pos);
    if (!check.success) return check;

    const prop = check.prop;
    const cost = check.cost;

    const paid = this.economy.deductMoney(
      prop.owner,
      cost,
      `Membangun 1 rumah di ${prop.name}: -$${cost}`,
      TransactionType.BUILD
    );

    if (!paid) {
      return { success: false, message: 'Transaksi pembayaran pembangunan gagal.' };
    }

    prop.houses++;
    if (typeof this.state.bankHouses === 'number') {
      this.state.bankHouses--;
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('property:updated', { detail: { pos, property: prop } }));
      window.dispatchEvent(new CustomEvent('building:updated', { detail: { pos, property: prop, type: 'HOUSE' } }));
    }

    return { success: true, message: `Berhasil membangun 1 rumah di ${prop.name}! Total: ${prop.houses} rumah.` };
  }

  canBuildHotel(pos) {
    const prop = this.getProperty(pos);
    if (!prop) return { success: false, canBuild: false, reason: 'Properti tidak ditemukan.' };
    if (prop.type !== 'prop') return { success: false, canBuild: false, reason: 'Hanya kota/tanah yang dapat dibangun hotel.' };
    if (!prop.owner) return { success: false, canBuild: false, reason: 'Properti belum dimiliki.' };
    if (prop.isMortgaged) return { success: false, canBuild: false, reason: 'Properti sedang digadaikan.' };
    if (prop.hasHotel) return { success: false, canBuild: false, reason: 'Properti sudah memiliki Hotel.' };
    if (prop.houses < 4) return { success: false, canBuild: false, reason: 'Wajib memiliki 4 rumah terlebih dahulu sebelum upgrade ke Hotel.' };

    if (!this.isColorGroupMonopoly(prop.owner, prop.group)) {
      return { success: false, canBuild: false, reason: 'Wajib memiliki seluruh kota dalam kelompok warna yang sama.' };
    }

    const groupProps = this.getColorGroupProperties(prop.group);
    if (groupProps.some(p => p.isMortgaged)) {
      return { success: false, canBuild: false, reason: 'Ada properti dalam kelompok warna ini yang sedang digadaikan.' };
    }

    // Aturan merata untuk hotel: semua properti dalam kelompok warna wajib punya minimal 4 rumah (atau hotel)
    const allHave4 = groupProps.every(p => p.houses === 4 || p.hasHotel);
    if (!allHave4) {
      return { success: false, canBuild: false, reason: 'Pembangunan merata: seluruh properti dalam kelompok warna wajib memiliki 4 rumah.' };
    }

    // Stok hotel Bank
    if ((this.state.bankHotels ?? 12) <= 0) {
      return { success: false, canBuild: false, reason: 'Persediaan hotel di Bank telah habis.' };
    }

    const cost = prop.hotelPrice || prop.housePrice || 50;
    if (!this.economy.hasEnoughMoney(prop.owner, cost)) {
      return { success: false, canBuild: false, reason: `Saldo tidak cukup untuk membangun hotel ($${cost}).` };
    }

    return { success: true, canBuild: true, cost, prop };
  }

  buildHotel(pos) {
    const check = this.canBuildHotel(pos);
    if (!check.success) return check;

    const prop = check.prop;
    const cost = check.cost;

    const paid = this.economy.deductMoney(
      prop.owner,
      cost,
      `Membangun Hotel di ${prop.name}: -$${cost}`,
      TransactionType.BUILD
    );

    if (!paid) {
      return { success: false, message: 'Transaksi pembayaran pembangunan hotel gagal.' };
    }

    // 4 rumah dikembalikan ke stok Bank, 1 hotel diambil
    prop.houses = 0;
    prop.hasHotel = true;
    if (typeof this.state.bankHouses === 'number') this.state.bankHouses += 4;
    if (typeof this.state.bankHotels === 'number') this.state.bankHotels--;

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('property:updated', { detail: { pos, property: prop } }));
      window.dispatchEvent(new CustomEvent('building:updated', { detail: { pos, property: prop, type: 'HOTEL' } }));
    }

    return { success: true, message: `Selamat! Hotel mewah berhasil dibangun di ${prop.name}!` };
  }

  canSellHouse(pos) {
    const prop = this.getProperty(pos);
    const eligibility = getBuildingSaleEligibility(prop, this.state.properties, this.state.bankHouses, 'SELL_HOUSE');
    return eligibility.success ? {success: true, canSell: true, refund: eligibility.refund, prop}
      : {success: false, canSell: false, reason: eligibility.reason};
  }

  sellHouse(pos) {
    const check = this.canSellHouse(pos);
    if (!check.success) return check;

    const prop = check.prop;
    const refund = check.refund;

    prop.houses--;
    if (typeof this.state.bankHouses === 'number') this.state.bankHouses++;

    this.economy.addMoney(
      prop.owner,
      refund,
      `Jual 1 rumah di ${prop.name}: +$${refund}`,
      TransactionType.SELL_BUILD
    );

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('property:updated', { detail: { pos, property: prop } }));
      window.dispatchEvent(new CustomEvent('building:updated', { detail: { pos, property: prop, type: 'SELL_HOUSE' } }));
    }

    return { success: true, message: `Berhasil menjual 1 rumah di ${prop.name}. Menerima +$${refund}.` };
  }

  canSellHotel(pos) {
    const prop = this.getProperty(pos);
    const eligibility = getBuildingSaleEligibility(prop, this.state.properties, this.state.bankHouses, 'SELL_HOTEL');
    return eligibility.success ? {success: true, canSell: true, refund: eligibility.refund, prop}
      : {success: false, canSell: false, reason: eligibility.reason};
  }

  sellHotel(pos) {
    const check = this.canSellHotel(pos);
    if (!check.success) return check;

    const prop = check.prop;
    const refund = check.refund;

    prop.hasHotel = false;
    if (typeof this.state.bankHotels === 'number') this.state.bankHotels++;

    // Jika bank memiliki cukup rumah (>= 4), hotel diturunkan menjadi 4 rumah
    if (typeof this.state.bankHouses === 'number' && this.state.bankHouses >= 4) {
      prop.houses = 4;
      this.state.bankHouses -= 4;
    } else {
      prop.houses = 0;
    }

    this.economy.addMoney(
      prop.owner,
      refund,
      `Jual Hotel di ${prop.name}: +$${refund}`,
      TransactionType.SELL_BUILD
    );

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('property:updated', { detail: { pos, property: prop } }));
      window.dispatchEvent(new CustomEvent('building:updated', { detail: { pos, property: prop, type: 'SELL_HOTEL' } }));
    }

    return { success: true, message: `Berhasil menjual Hotel di ${prop.name}. Menerima +$${refund}.` };
  }

  getBuildableProperties(playerId) {
    return this.getPlayerProperties(playerId).filter(p => {
      if (p.type !== 'prop' || p.isMortgaged) return false;
      const chkHouse = this.canBuildHouse(p.pos);
      const chkHotel = this.canBuildHotel(p.pos);
      return chkHouse.success || chkHotel.success;
    });
  }

  getSellableProperties(playerId) {
    return this.getPlayerProperties(playerId).filter(p => {
      if (p.type !== 'prop') return false;
      return (p.houses > 0 && !p.hasHotel) || p.hasHotel;
    });
  }

  // ─── SISTEM HIPOTEK / GADAI PROPERTI ────────────────────────────────────────

  canMortgage(pos) {
    const prop = this.getProperty(pos);
    const eligibility = getMortgageEligibility(prop, this.state.properties);
    return eligibility.success
      ? {success: true, canMortgage: true, value: eligibility.value, prop}
      : {success: false, canMortgage: false, reason: eligibility.reason};
  }

  mortgageProperty(pos) {
    const check = this.canMortgage(pos);
    if (!check.success) return check;

    const prop = check.prop;
    const value = check.value;

    prop.isMortgaged = true;

    this.economy.addMoney(
      prop.owner,
      value,
      `Gadai ${prop.name}: +$${value}`,
      TransactionType.MORTGAGE
    );

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('property:updated', { detail: { pos, property: prop } }));
      window.dispatchEvent(new CustomEvent('property:mortgaged', { detail: { pos, property: prop, value } }));
    }

    return { success: true, message: `Properti ${prop.name} berhasil digadaikan. Menerima +$${value}.` };
  }

  canUnmortgage(pos) {
    const prop = this.getProperty(pos);
    const eligibility = getUnmortgageEligibility(prop, this.state.properties, this.economy.getBalance?.(prop?.owner) ??
      this.state.getPlayerById(prop?.owner)?.money);
    return eligibility.success
      ? {success: true, canUnmortgage: true, mortgageValue: eligibility.principal, interest: eligibility.interest, totalCost: eligibility.totalCost, prop}
      : {success: false, canUnmortgage: false, ...(Number.isFinite(eligibility.principal) ? {mortgageValue: eligibility.principal} : {}),
        ...(Number.isFinite(eligibility.interest) ? {interest: eligibility.interest} : {}),
        ...(Number.isFinite(eligibility.totalCost) ? {totalCost: eligibility.totalCost} : {}), reason: eligibility.reason};
  }

  unmortgageProperty(pos) {
    const check = this.canUnmortgage(pos);
    if (!check.success) return check;

    const prop = check.prop;
    const totalCost = check.totalCost;

    const paid = this.economy.deductMoney(
      prop.owner,
      totalCost,
      `Tebus gadai ${prop.name}: -$${totalCost}`,
      TransactionType.UNMORTGAGE
    );

    if (!paid) {
      return { success: false, message: 'Pembayaran tebus gadai gagal.' };
    }

    prop.isMortgaged = false;

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('property:updated', { detail: { pos, property: prop } }));
      window.dispatchEvent(new CustomEvent('property:unmortgaged', { detail: { pos, property: prop, cost: totalCost } }));
    }

    return { success: true, message: `Gadai ${prop.name} berhasil ditebus sebesar $${totalCost}!` };
  }

  getMortgagedProperties(playerId) {
    return this.getPlayerProperties(playerId).filter(p => p.isMortgaged);
  }

  getUnmortgagedProperties(playerId) {
    return this.getPlayerProperties(playerId).filter(p => !p.isMortgaged);
  }
}

export const propertyManager = new PropertyManager();
