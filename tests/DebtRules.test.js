import test from 'node:test';
import assert from 'node:assert/strict';
import {getBuildingSaleEligibility} from '../src/logic/mortgage.js';

test('shared single-player and server liquidation rules preserve even sale and hotel downgrade behavior', () => {
  const properties = new Map([
    [1, {pos: 1, id: 'prop_1', type: 'prop', group: 'Brown', owner: 'p1', housePrice: 50, houses: 1, hasHotel: false}],
    [3, {pos: 3, id: 'prop_3', type: 'prop', group: 'Brown', owner: 'p1', housePrice: 50, houses: 2, hasHotel: false}],
    [39, {pos: 39, id: 'prop_39', type: 'prop', group: 'Blue', owner: 'p1', housePrice: 200, hotelPrice: 200, houses: 0, hasHotel: true}]
  ]);
  const one = properties.get(1), three = properties.get(3);
  one.houses = 1; three.houses = 2;
  assert.equal(getBuildingSaleEligibility(one, properties, 32, 'SELL_HOUSE').success, false);
  const houseSale = getBuildingSaleEligibility(three, properties, 32, 'SELL_HOUSE');
  assert.equal(houseSale.refund, 25);
  three.houses = houseSale.resultingHouses;
  assert.equal(three.houses, 1);
  const hotel = properties.get(39);
  const hotelSale = getBuildingSaleEligibility(hotel, properties, 4, 'SELL_HOTEL');
  assert.equal(hotelSale.refund, 100);
  assert.equal(hotel.hasHotel, true, 'eligibility checks do not mutate state');
  hotel.hasHotel = false;
  hotel.houses = hotelSale.resultingHouses;
  assert.equal(hotel.houses, 4);
  assert.equal(hotelSale.bankHouseDelta, -4);
  assert.equal(hotelSale.hotelReturned, 1);
  hotel.hasHotel = true;
  const noStockHotelSale = getBuildingSaleEligibility(hotel, properties, 3, 'SELL_HOTEL');
  assert.equal(noStockHotelSale.resultingHouses, 0);
  assert.equal(noStockHotelSale.bankHouseDelta, 0);
});
