// "Otak" bot ModPoly. Fungsi murni (tanpa DOM/Socket) yang dipakai bersama oleh
// mode lokal (browser) dan multiplayer (server), jadi perilaku bot selalu sama.
//
// Filosofi: bot sederhana tapi masuk akal.
//  - Punya uang -> beli. Cadangan kas kecil dijaga supaya tidak langsung bangkrut kena sewa.
//  - Beli lebih agresif kalau melengkapi satu warna (monopoli) atau menghalangi lawan.
//  - Di penjara: pakai kartu bebas, kalau tidak ada bayar denda selama uang cukup, kalau tidak lempar dadu.
//  - Parkir Bebas: pilih petak tujuan dengan skor terbaik (beli properti, lewat START, hindari sewa/penjara/pajak).
//  - Lelang: tawar bertahap sampai batas nilai wajar, lalu PASS.
//  - Punya monopoli + uang lebih -> bangun rumah/hotel secara merata.
//  - Terlilit utang: jual bangunan -> gadai -> baru menyatakan bangkrut.
import {calculatePropertyRent} from './rent.js';
import {BAIL_COST} from './jailRules.js';

export const BOT_RULES = Object.freeze({
  cashReserve: 100,       // sisa uang minimal setelah membeli (biasa)
  buildReserve: 200,      // sisa uang minimal setelah membangun
  parkingFee: 50,         // biaya travel Parkir Bebas
  parkingMinGain: 40,     // skor minimal agar travel lebih baik daripada diam
  passStartBonus: 200
});

const asList = props => props instanceof Map ? [...props.values()] : Array.isArray(props) ? props : [];
const roundTo10 = value => Math.max(10, Math.round(value / 10) * 10);

/** Info kelompok warna/stasiun/utilitas dari sudut pandang bot. */
export function groupInfo(prop, props, meKey) {
  const group = asList(props).filter(item => item.type === prop.type && item.group === prop.group);
  const total = group.length;
  const mine = group.filter(item => item.owner === meKey).length;
  const ownedByOthers = new Map();
  for (const item of group) {
    if (item.owner && item.owner !== meKey) ownedByOthers.set(item.owner, (ownedByOthers.get(item.owner) || 0) + 1);
  }
  const unowned = group.filter(item => !item.owner).length;
  const isLastMissing = prop.owner === null || prop.owner === undefined ? unowned === 1 : false;
  const completes = total > 1 && isLastMissing && mine === total - 1;
  const blocks = total > 1 && isLastMissing && [...ownedByOthers.values()].some(count => count === total - 1);
  return {total, mine, completes, blocks};
}

export function shouldBuyProperty({money, prop, props, meKey}) {
  if (!prop || money < prop.price) return false;
  const info = groupInfo(prop, props, meKey);
  let reserve = BOT_RULES.cashReserve;
  if (info.completes || info.blocks) reserve = 0;
  else if (info.mine > 0 || prop.type !== 'prop') reserve = Math.floor(BOT_RULES.cashReserve / 2);
  return money - prop.price >= reserve;
}

/** @returns {'USE_CARD'|'PAY_BAIL'|'ROLL'} */
export function chooseJailAction({money, hasCard}) {
  if (hasCard) return 'USE_CARD';
  if (money >= BAIL_COST + BOT_RULES.cashReserve) return 'PAY_BAIL';
  return 'ROLL';
}

/** @returns {number|null} posisi tujuan, atau null untuk tetap diam (lempar dadu biasa). */
export function pickParkingDestination({money, props, tiles, meKey, fromPos = 20}) {
  if (money < BOT_RULES.parkingFee + BOT_RULES.cashReserve) return null;
  const propList = asList(props);
  const spendable = money - BOT_RULES.parkingFee;
  let best = null;
  for (const tile of tiles || []) {
    if (tile.pos === fromPos || tile.pos === 30) continue; // 30 = masuk penjara
    let score = tile.pos < fromPos ? BOT_RULES.passStartBonus : 0; // melewati START dapat gaji
    const prop = propList.find(item => item.pos === tile.pos);
    if (prop) {
      if (!prop.owner) {
        if (shouldBuyProperty({money: spendable, prop, props: propList, meKey})) {
          const info = groupInfo(prop, propList, meKey);
          score += 150 + info.mine * 80 + (info.completes ? 400 : 0) + (info.blocks ? 150 : 0);
        }
      } else if (prop.owner !== meKey && !prop.isMortgaged) {
        const rent = calculatePropertyRent(prop, propList, 7);
        score -= rent >= spendable ? 2000 : Math.round(rent * 1.3);
      }
    } else if (tile.type === 'tax') {
      score -= Number(tile.price || 0);
    } else if (tile.type === 'chance') {
      score += 5;
    }
    if (!best || score > best.score) best = {pos: tile.pos, score};
  }
  return best && best.score - BOT_RULES.parkingFee >= BOT_RULES.parkingMinGain ? best.pos : null;
}

/** @returns {{action:'BID', amount:number}|{action:'PASS'}} */
export function decideAuctionAction({money, prop, highestBid, props, meKey}) {
  const info = groupInfo(prop, props, meKey);
  const factor = info.completes ? 1.6 : info.blocks ? 1.2 : info.mine > 0 ? 1.0 : 0.85;
  const maxBid = Math.min(Math.floor(prop.price * factor), money - 30);
  const step = roundTo10(prop.price * 0.1);
  const nextBid = highestBid > 0 ? highestBid + step : roundTo10(prop.price * 0.3);
  if (nextBid > maxBid || nextBid > money) return {action: 'PASS'};
  return {action: 'BID', amount: nextBid};
}

/** Pilih satu aksi bangun (rumah/hotel) yang aman secara aturan & kas, atau null. */
export function pickBuildAction({money, props, meKey, bankHouses = 32, bankHotels = 12}) {
  const all = asList(props);
  const candidates = [];
  for (const prop of all) {
    if (prop.type !== 'prop' || prop.owner !== meKey || prop.isMortgaged || prop.hasHotel) continue;
    const group = all.filter(item => item.type === 'prop' && item.group === prop.group);
    if (group.length === 0 || group.some(item => item.owner !== meKey || item.isMortgaged)) continue;
    const levels = group.map(item => item.hasHotel ? 5 : item.houses);
    if (prop.houses < 4) {
      const cost = prop.housePrice || 50;
      if (bankHouses > 0 && prop.houses <= Math.min(...levels) && money - cost >= BOT_RULES.buildReserve) {
        candidates.push({action: 'BUILD_HOUSE', propertyPos: prop.pos, cost, houses: prop.houses});
      }
    } else if (prop.houses === 4 && group.every(item => item.hasHotel || item.houses === 4)) {
      const cost = prop.hotelPrice || prop.housePrice || 50;
      if (bankHotels > 0 && money - cost >= BOT_RULES.buildReserve) {
        candidates.push({action: 'BUILD_HOTEL', propertyPos: prop.pos, cost, houses: 4});
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.houses - b.houses || b.cost - a.cost);
  const {action, propertyPos} = candidates[0];
  return {action, propertyPos};
}

/**
 * Satu langkah penyelesaian utang.
 * sellActions: [{action:'SELL_HOUSE'|'SELL_HOTEL', propertyPos, refund}], mortgageActions: [{propertyPos, amount}]
 * @returns {{action:string, propertyPos?:number}|null}
 */
export function pickDebtStep({money, amount, sellActions = [], mortgageActions = [], canDeclareBankruptcy = false}) {
  if (money >= amount) return {action: 'PAY'};
  if (sellActions.length) {
    const best = [...sellActions].sort((a, b) => (b.refund || 0) - (a.refund || 0))[0];
    return {action: best.action, propertyPos: best.propertyPos};
  }
  if (mortgageActions.length) {
    const best = [...mortgageActions].sort((a, b) => (b.amount || 0) - (a.amount || 0))[0];
    return {action: 'MORTGAGE', propertyPos: best.propertyPos};
  }
  return canDeclareBankruptcy ? {action: 'BANKRUPTCY'} : null;
}
