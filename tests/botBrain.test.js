import test from 'node:test';
import assert from 'node:assert/strict';
import {createPropertyRecord} from '../src/logic/propertyState.js';
import {chooseJailAction, decideAuctionAction, pickBuildAction, pickDebtStep, pickParkingDestination,
  shouldBuyProperty} from '../src/logic/botBrain.js';

const brown = (pos, owner = null, extra = {}) => ({...createPropertyRecord({pos, type: 'prop', nama: `B${pos}`, group: 'brown',
  harga_beli: 60, sewa_tanah: 2, sewa_rumah_1: 10, sewa_rumah_2: 30, sewa_rumah_3: 90, sewa_rumah_4: 160, sewa_hotel: 250,
  biaya_rumah: 50, biaya_hotel: 50, hipotek: 30}), owner, ...extra});

test('buys when it has money, declines when it would be left with almost nothing', () => {
  const prop = brown(1);
  assert.equal(shouldBuyProperty({money: 1500, prop, props: [prop, brown(3)], meKey: 'me'}), true);
  assert.equal(shouldBuyProperty({money: 59, prop, props: [prop, brown(3)], meKey: 'me'}), false);
  assert.equal(shouldBuyProperty({money: 70, prop, props: [prop, brown(3)], meKey: 'me'}), false);
});

test('buys even with low cash when it completes a color set', () => {
  const prop = brown(3);
  const props = [brown(1, 'me'), prop];
  assert.equal(shouldBuyProperty({money: 70, prop, props, meKey: 'me'}), true);
});

test('jail: card first, then bail when affordable, otherwise roll', () => {
  assert.equal(chooseJailAction({money: 20, hasCard: true}), 'USE_CARD');
  assert.equal(chooseJailAction({money: 500, hasCard: false}), 'PAY_BAIL');
  assert.equal(chooseJailAction({money: 120, hasCard: false}), 'ROLL');
});

test('free parking: travels to a buyable tile that passes START, stays when poor', () => {
  const tiles = [{pos: 0, type: 'corner'}, {pos: 1, type: 'prop'}, {pos: 25, type: 'prop'}, {pos: 30, type: 'corner'}];
  const props = [brown(1), brown(25, 'enemy', {rent: {base: 500, house1: 0}})];
  assert.equal(pickParkingDestination({money: 1000, props, tiles, meKey: 'me'}), 1);
  assert.equal(pickParkingDestination({money: 120, props, tiles, meKey: 'me'}), null);
});

test('auction: bids in steps up to a fair value, then passes', () => {
  const prop = brown(1);
  const first = decideAuctionAction({money: 1000, prop, highestBid: 0, props: [prop], meKey: 'me'});
  assert.equal(first.action, 'BID');
  assert.ok(first.amount >= 10 && first.amount <= prop.price);
  assert.equal(decideAuctionAction({money: 1000, prop, highestBid: 200, props: [prop], meKey: 'me'}).action, 'PASS');
  assert.equal(decideAuctionAction({money: 20, prop, highestBid: 0, props: [prop], meKey: 'me'}).action, 'PASS');
});

test('builds evenly only on a complete color set and keeps a cash reserve', () => {
  const props = [brown(1, 'me', {houses: 1}), brown(3, 'me', {houses: 0})];
  assert.deepEqual(pickBuildAction({money: 1000, props, meKey: 'me'}), {action: 'BUILD_HOUSE', propertyPos: 3});
  assert.equal(pickBuildAction({money: 220, props, meKey: 'me'}), null);
  assert.equal(pickBuildAction({money: 1000, props: [brown(1, 'me'), brown(3)], meKey: 'me'}), null);
});

test('debt: pay, then sell buildings, then mortgage, then bankruptcy', () => {
  assert.deepEqual(pickDebtStep({money: 300, amount: 200}), {action: 'PAY'});
  assert.equal(pickDebtStep({money: 0, amount: 200, sellActions: [{action: 'SELL_HOUSE', propertyPos: 1, refund: 25}],
    mortgageActions: [{propertyPos: 3, amount: 30}]}).action, 'SELL_HOUSE');
  assert.equal(pickDebtStep({money: 0, amount: 200, mortgageActions: [{propertyPos: 3, amount: 30}]}).action, 'MORTGAGE');
  assert.equal(pickDebtStep({money: 0, amount: 200, canDeclareBankruptcy: true}).action, 'BANKRUPTCY');
});
