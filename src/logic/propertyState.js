export function createPropertyRecord(tile) {
  const rent = tile.type === 'prop'
    ? {
        base: Number(tile.sewa_tanah || 0),
        house1: Number(tile.sewa_rumah_1 || 0),
        house2: Number(tile.sewa_rumah_2 || 0),
        house3: Number(tile.sewa_rumah_3 || 0),
        house4: Number(tile.sewa_rumah_4 || 0),
        hotel: Number(tile.sewa_hotel || 0)
      }
    : tile.type === 'rail'
      ? {
          count1: Number(tile.sewa_1 || 25),
          count2: Number(tile.sewa_2 || 50),
          count3: Number(tile.sewa_3 || 100),
          count4: Number(tile.sewa_4 || 200)
        }
      : tile.type === 'util'
        ? {factor1: Number(tile.faktor_1 || 4), factor2: Number(tile.faktor_2 || 10)}
        : {};

  return {
    id: `prop_${tile.pos}`,
    pos: tile.pos,
    name: tile.nama,
    type: tile.type,
    group: tile.group || (tile.type === 'rail' ? 'rail' : 'util'),
    price: Number(tile.harga_beli || tile.price || 0),
    owner: null,
    isMortgaged: false,
    mortgageValue: Number(tile.hipotek || Math.floor((tile.harga_beli || tile.price || 0) / 2)),
    houses: 0,
    hasHotel: false,
    housePrice: Number(tile.biaya_rumah || 0),
    hotelPrice: Number(tile.biaya_hotel || 0),
    icon: tile.icon || '',
    rent
  };
}

export function initializePropertyState(state, tiles) {
  for (const tile of tiles) {
    if (['prop', 'rail', 'util'].includes(tile.type)) {
      state.properties.set(tile.pos, createPropertyRecord(tile));
    }
  }
  return state.properties;
}
