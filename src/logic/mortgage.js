function propertyList(properties) {
  return properties instanceof Map ? [...properties.values()] : Array.isArray(properties) ? properties : [];
}

export function mortgageValue(property) {
  return property?.mortgageValue || Math.floor((property?.price || 0) / 2);
}

export function getMortgageEligibility(property, properties) {
  if (!property) return {success: false, reason: 'Properti tidak ditemukan.'};
  if (!property.owner) return {success: false, reason: 'Properti belum dimiliki.'};
  if (property.isMortgaged) return {success: false, reason: 'Properti sudah dalam status digadaikan.'};
  if (property.houses > 0 || property.hasHotel) {
    return {success: false, reason: 'Seluruh bangunan pada properti ini harus dijual terlebih dahulu.'};
  }
  if (property.type === 'prop') {
    const groupProperties = propertyList(properties).filter(item => item.type === 'prop' && item.group === property.group);
    if (groupProperties.some(item => item.houses > 0 || item.hasHotel)) {
      return {success: false, reason: 'Semua bangunan pada kelompok warna ini harus dijual terlebih dahulu sebelum menggadaikan.'};
    }
  }
  return {success: true, value: mortgageValue(property)};
}

export function getUnmortgageEligibility(property, properties, balance) {
  if (!property) return {success: false, reason: 'Properti tidak ditemukan.'};
  if (!property.owner) return {success: false, reason: 'Properti belum dimiliki.'};
  if (!property.isMortgaged) return {success: false, reason: 'Properti tidak sedang digadaikan.'};
  const principal = mortgageValue(property);
  const interest = Math.round(principal * 0.10);
  const totalCost = principal + interest;
  if (!Number.isFinite(balance) || balance < totalCost) {
    return {success: false, principal, interest, totalCost,
      reason: `Saldo tidak mencukupi untuk menebus gadai ($${totalCost} = Pokok $${principal} + Bunga $${interest}).`};
  }
  return {success: true, principal, interest, totalCost};
}

/** Mirrors PropertyManager's even-sale and hotel downgrade rules. */
export function getBuildingSaleEligibility(property, properties, bankHouses = 32, action = 'SELL_HOUSE') {
  if (!property) return {success: false, reason: 'Properti tidak ditemukan.'};
  const all = propertyList(properties);
  if (action === 'SELL_HOTEL') {
    if (!property.hasHotel) return {success: false, reason: 'Properti tidak memiliki Hotel.'};
    const refund = Math.floor((property.hotelPrice || property.housePrice || 50) * 0.5);
    const resultingHouses = bankHouses >= 4 ? 4 : 0;
    return {success: true, refund, resultingHouses, bankHouseDelta: resultingHouses ? -4 : 0, hotelReturned: 1};
  }
  if (property.houses <= 0) return {success: false, reason: 'Tidak ada rumah pada properti ini.'};
  if (property.hasHotel) return {success: false, reason: 'Properti memiliki Hotel, bukan rumah biasa. Silakan jual Hotel.'};
  const group = all.filter(item => item.type === 'prop' && item.group === property.group);
  const maxHouses = Math.max(...group.map(item => item.hasHotel ? 5 : item.houses));
  if (property.houses < maxHouses) {
    return {success: false, reason: 'Penjualan harus merata. Jual rumah dari properti yang lebih banyak terlebih dahulu.'};
  }
  const refund = Math.floor((property.housePrice || 50) * 0.5);
  return {success: true, refund, resultingHouses: property.houses - 1, bankHouseDelta: 1, hotelReturned: 0};
}
