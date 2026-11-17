import {TILES} from '../data/tiles.js';
import {gameState} from './GameState.js';
import {economyManager, TransactionType} from './EconomyManager.js';

export class PropertyManager {
  constructor() {
    this.initProperties();
  }

  // Menghubungkan dan memetakan data properti dari TILES (sumber CSV) ke dalam GameState
  initProperties() {
    TILES.forEach(tile => {
      if (['prop', 'rail', 'util'].includes(tile.type)) {
        const prop = {
          id: `prop_${tile.pos}`,
          pos: tile.pos,
          name: tile.nama,
          type: tile.type,
          group: tile.group || (tile.type === 'rail' ? 'rail' : 'util'),
          price: Number(tile.harga_beli || tile.price || 0),
          owner: null, // default: bank (belum dimiliki)
          isMortgaged: false,
          mortgageValue: Number(tile.hipotek || Math.floor((tile.harga_beli || tile.price || 0) / 2)),
          houses: 0,
          hasHotel: false,
          housePrice: Number(tile.biaya_rumah || 0),
          hotelPrice: Number(tile.biaya_hotel || 0),
          icon: tile.icon || '',
          rent: this._buildRentTable(tile)
        };
        gameState.properties.set(tile.pos, prop);
      }
    });
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
    return gameState.properties.get(pos) || null;
  }

  getAllProperties() {
    return Array.from(gameState.properties.values());
  }

  getPlayerProperties(playerId) {
    return this.getAllProperties().filter(p => p.owner === playerId);
  }

  setOwner(pos, playerId) {
    const prop = this.getProperty(pos);
    if (!prop) return false;

    // Hapus dari pemilik lama jika ada
    if (prop.owner !== null) {
      const prevPlayer = gameState.getPlayerById(prop.owner);
      if (prevPlayer) {
        prevPlayer.properties = prevPlayer.properties.filter(id => id !== prop.id);
      }
    }

    // Set pemilik baru
    prop.owner = playerId;
    if (playerId !== null) {
      const newPlayer = gameState.getPlayerById(playerId);
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
    if (!prop || !prop.owner || prop.isMortgaged) return 0;

    if (prop.type === 'prop') {
      if (prop.hasHotel) return prop.rent.hotel;
      if (prop.houses === 4) return prop.rent.house4;
      if (prop.houses === 3) return prop.rent.house3;
      if (prop.houses === 2) return prop.rent.house2;
      if (prop.houses === 1) return prop.rent.house1;

      // Jika satu set warna dimiliki penuh (Monopoly), sewa tanah dasar dikali 2
      const isMonopoly = this.isColorGroupMonopoly(prop.owner, prop.group);
      return isMonopoly ? prop.rent.base * 2 : prop.rent.base;
    }

    if (prop.type === 'rail') {
      const ownerRails = this.getAllProperties().filter(p => p.type === 'rail' && p.owner === prop.owner);
      const count = Math.min(4, Math.max(1, ownerRails.length));
      return prop.rent[`count${count}`] || 25;
    }

    if (prop.type === 'util') {
      const ownerUtils = this.getAllProperties().filter(p => p.type === 'util' && p.owner === prop.owner);
      const factor = ownerUtils.length >= 2 ? prop.rent.factor2 : prop.rent.factor1;
      return diceRoll * factor;
    }

    return 0;
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
    if ((gameState.bankHouses ?? 32) <= 0) {
      return { success: false, canBuild: false, reason: 'Persediaan rumah di Bank telah habis.' };
    }

    // Ketersediaan saldo pemain
    const cost = prop.housePrice || 50;
    if (!economyManager.hasEnoughMoney(prop.owner, cost)) {
      return { success: false, canBuild: false, reason: `Saldo tidak cukup untuk membangun rumah ($${cost}).` };
    }

    return { success: true, canBuild: true, cost, prop };
  }

  buildHouse(pos) {
    const check = this.canBuildHouse(pos);
    if (!check.success) return check;

    const prop = check.prop;
    const cost = check.cost;

    const paid = economyManager.deductMoney(
      prop.owner,
      cost,
      `Membangun 1 rumah di ${prop.name}: -$${cost}`,
      TransactionType.BUILD
    );

    if (!paid) {
      return { success: false, message: 'Transaksi pembayaran pembangunan gagal.' };
    }

    prop.houses++;
    if (typeof gameState.bankHouses === 'number') {
      gameState.bankHouses--;
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
    if ((gameState.bankHotels ?? 12) <= 0) {
      return { success: false, canBuild: false, reason: 'Persediaan hotel di Bank telah habis.' };
    }

    const cost = prop.hotelPrice || prop.housePrice || 50;
    if (!economyManager.hasEnoughMoney(prop.owner, cost)) {
      return { success: false, canBuild: false, reason: `Saldo tidak cukup untuk membangun hotel ($${cost}).` };
    }

    return { success: true, canBuild: true, cost, prop };
  }

  buildHotel(pos) {
    const check = this.canBuildHotel(pos);
    if (!check.success) return check;

    const prop = check.prop;
    const cost = check.cost;

    const paid = economyManager.deductMoney(
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
    if (typeof gameState.bankHouses === 'number') gameState.bankHouses += 4;
    if (typeof gameState.bankHotels === 'number') gameState.bankHotels--;

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('property:updated', { detail: { pos, property: prop } }));
      window.dispatchEvent(new CustomEvent('building:updated', { detail: { pos, property: prop, type: 'HOTEL' } }));
    }

    return { success: true, message: `Selamat! Hotel mewah berhasil dibangun di ${prop.name}!` };
  }

  canSellHouse(pos) {
    const prop = this.getProperty(pos);
    if (!prop) return { success: false, canSell: false, reason: 'Properti tidak ditemukan.' };
    if (prop.houses <= 0) return { success: false, canSell: false, reason: 'Tidak ada rumah pada properti ini.' };
    if (prop.hasHotel) return { success: false, canSell: false, reason: 'Properti memiliki Hotel, bukan rumah biasa. Silakan jual Hotel.' };

    const groupProps = this.getColorGroupProperties(prop.group);
    // Aturan penjualan merata: tidak boleh menjual rumah jika ada properti sekelompok yang punya rumah lebih banyak
    const maxHouses = Math.max(...groupProps.map(p => p.hasHotel ? 5 : p.houses));
    if (prop.houses < maxHouses) {
      return { success: false, canSell: false, reason: 'Penjualan harus merata. Jual rumah dari properti yang lebih banyak terlebih dahulu.' };
    }

    const refund = Math.floor((prop.housePrice || 50) * 0.5);
    return { success: true, canSell: true, refund, prop };
  }

  sellHouse(pos) {
    const check = this.canSellHouse(pos);
    if (!check.success) return check;

    const prop = check.prop;
    const refund = check.refund;

    prop.houses--;
    if (typeof gameState.bankHouses === 'number') gameState.bankHouses++;

    economyManager.addMoney(
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
    if (!prop) return { success: false, canSell: false, reason: 'Properti tidak ditemukan.' };
    if (!prop.hasHotel) return { success: false, canSell: false, reason: 'Properti tidak memiliki Hotel.' };

    const refund = Math.floor((prop.hotelPrice || prop.housePrice || 50) * 0.5);
    return { success: true, canSell: true, refund, prop };
  }

  sellHotel(pos) {
    const check = this.canSellHotel(pos);
    if (!check.success) return check;

    const prop = check.prop;
    const refund = check.refund;

    prop.hasHotel = false;
    if (typeof gameState.bankHotels === 'number') gameState.bankHotels++;

    // Jika bank memiliki cukup rumah (>= 4), hotel diturunkan menjadi 4 rumah
    if (typeof gameState.bankHouses === 'number' && gameState.bankHouses >= 4) {
      prop.houses = 4;
      gameState.bankHouses -= 4;
    } else {
      prop.houses = 0;
    }

    economyManager.addMoney(
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
    if (!prop) return { success: false, canMortgage: false, reason: 'Properti tidak ditemukan.' };
    if (!prop.owner) return { success: false, canMortgage: false, reason: 'Properti belum dimiliki.' };
    if (prop.isMortgaged) return { success: false, canMortgage: false, reason: 'Properti sudah dalam status digadaikan.' };

    // Tidak boleh ada bangunan pada properti ini
    if (prop.houses > 0 || prop.hasHotel) {
      return { success: false, canMortgage: false, reason: 'Seluruh bangunan pada properti ini harus dijual terlebih dahulu.' };
    }

    // Jika kota, tidak boleh ada bangunan pada SEMUA properti dalam satu kelompok warna
    if (prop.type === 'prop') {
      const groupProps = this.getColorGroupProperties(prop.group);
      const hasAnyBuilding = groupProps.some(p => p.houses > 0 || p.hasHotel);
      if (hasAnyBuilding) {
        return { success: false, canMortgage: false, reason: 'Semua bangunan pada kelompok warna ini harus dijual terlebih dahulu sebelum menggadaikan.' };
      }
    }

    const value = prop.mortgageValue || Math.floor((prop.price || 0) / 2);
    return { success: true, canMortgage: true, value, prop };
  }

  mortgageProperty(pos) {
    const check = this.canMortgage(pos);
    if (!check.success) return check;

    const prop = check.prop;
    const value = check.value;

    prop.isMortgaged = true;

    economyManager.addMoney(
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
    if (!prop) return { success: false, canUnmortgage: false, reason: 'Properti tidak ditemukan.' };
    if (!prop.owner) return { success: false, canUnmortgage: false, reason: 'Properti belum dimiliki.' };
    if (!prop.isMortgaged) return { success: false, canUnmortgage: false, reason: 'Properti tidak sedang digadaikan.' };

    const mortgageValue = prop.mortgageValue || Math.floor((prop.price || 0) / 2);
    const interest = Math.round(mortgageValue * 0.10);
    const totalCost = mortgageValue + interest;

    if (!economyManager.hasEnoughMoney(prop.owner, totalCost)) {
      return {
        success: false,
        canUnmortgage: false,
        reason: `Saldo tidak mencukupi untuk menebus gadai ($${totalCost} = Pokok $${mortgageValue} + Bunga $${interest}).`
      };
    }

    return { success: true, canUnmortgage: true, mortgageValue, interest, totalCost, prop };
  }

  unmortgageProperty(pos) {
    const check = this.canUnmortgage(pos);
    if (!check.success) return check;

    const prop = check.prop;
    const totalCost = check.totalCost;

    const paid = economyManager.deductMoney(
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
