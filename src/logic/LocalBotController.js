// Bot untuk mode lokal. Keputusannya memakai botBrain.js (sama dengan server multiplayer).
// Pendekatan: bot "menekan tombol" yang sama dengan pemain manusia, jadi semua aturan game
// tetap lewat jalur kode yang sudah ada (tidak ada logika game ganda yang bisa menyimpang).
import {gameState, GameStatus, PlayerStatus} from './GameState.js';
import {turnManager} from './TurnManager.js';
import {propertyManager} from './PropertyManager.js';
import {bankruptcyManager} from './BankruptcyManager.js';
import {economyManager, TransactionType} from './EconomyManager.js';
import {auctionManager} from './AuctionManager.js';
import {tileModalManager} from '../ui/TileModalManager.js';
import {jailModalManager} from '../ui/JailModalManager.js';
import {freeParkingModalManager} from '../ui/FreeParkingModalManager.js';
import {bankruptcyModalManager} from '../ui/BankruptcyModalManager.js';
import {tradeModalManager} from '../ui/TradeModalManager.js';
import {buildHud, toast} from '../ui/hud.js';
import {TILES} from '../data/tiles.js';
import {chooseJailAction, decideAuctionAction, pickBuildAction, pickDebtStep, pickParkingDestination,
  shouldBuyProperty} from './botBrain.js';

const THINK = {purchase: 1500, chance: 2300, jail: 1600, parking: 1800, auction: 1300, debt: 900, turn: 1100, build: 800};

let installed = false;
let nextActionAt = 0;
let lastTurnKey = null;
let auctionTimer = null;

const isLocalMode = () => typeof document !== 'undefined' && document.body?.classList.contains('mode-local');
const click = id => { const el = document.getElementById(id); if (el && !el.disabled) { el.click(); return true; } return false; };
const activeBot = () => {
  const player = gameState.getActivePlayer();
  return player?.isBot && player.status !== PlayerStatus.BANKRUPT ? player : null;
};

function wrap(manager, method, factory) {
  const original = manager[method].bind(manager);
  manager[method] = factory(original);
}

function installModalDrivers() {
  // Beli / lelang
  wrap(tileModalManager, 'promptPurchase', original => (prop, player, options = {}) => {
    const promise = original(prop, player, options);
    if (player?.isBot && typeof options.onDecision !== 'function') {
      setTimeout(() => {
        const buy = shouldBuyProperty({money: player.money, prop, props: propertyManager.getAllProperties(), meKey: player.id});
        if (!(buy && click('btn-buy-prop'))) click('btn-auction-prop');
      }, THINK.purchase);
    }
    return promise;
  });

  // Kartu Kesempatan: bot menekan "Ambil Kartu" setelah pemain sempat membaca.
  wrap(tileModalManager, 'promptChanceCard', original => player => {
    const promise = original(player);
    if (player?.isBot) setTimeout(() => click('btn-chance-ok'), THINK.chance);
    return promise;
  });

  // Sewa: otomatis lunas kalau uang cukup (tanpa UI). Kalau kurang, bot menyelesaikan utang sendiri.
  wrap(tileModalManager, 'promptRent', original => (prop, tenant, owner, rentAmount) => {
    if (!tenant?.isBot || tenant.money >= rentAmount) return original(prop, tenant, owner, rentAmount);
    return (async () => {
      const debt = await bankruptcyModalManager.promptDebtResolution(tenant, owner, rentAmount, `Sewa ${prop.name}`);
      if (debt.resolved) {
        const paid = economyManager.transferMoney(tenant.id, owner.id, rentAmount, `Bayar sewa ${prop.name}`, TransactionType.RENT);
        buildHud();
        if (paid) return {tenant, owner, rentAmount, bankrupt: false};
      }
      return {tenant, owner, rentAmount: 0, bankrupt: true};
    })();
  });

  // Penjara
  wrap(jailModalManager, 'promptJailAction', original => (player, options = {}) => {
    const promise = original(player, options);
    if (player?.isBot && typeof options.onAction !== 'function') {
      setTimeout(() => {
        const choice = chooseJailAction({money: player.money, hasCard: (player.hasGetOutOfJailCard || 0) > 0});
        const order = choice === 'USE_CARD' ? ['btn-jail-card', 'btn-jail-bail', 'btn-jail-double']
          : choice === 'PAY_BAIL' ? ['btn-jail-bail', 'btn-jail-double'] : ['btn-jail-double'];
        order.some(click);
      }, THINK.jail);
    }
    return promise;
  });

  // Parkir Bebas: bot memilih petak tujuan atau memilih tidak berpindah.
  wrap(freeParkingModalManager, 'promptTravel', original => (player, options = {}) => {
    const promise = original(player, options);
    if (player?.isBot && typeof options.onAction !== 'function') {
      setTimeout(() => {
        if (!freeParkingModalManager.isOpen()) return; // uang kurang -> modal sudah otomatis lanjut
        const target = pickParkingDestination({money: player.money, props: propertyManager.getAllProperties(),
          tiles: TILES, meKey: player.id, fromPos: player.pos});
        if (target === null) freeParkingModalManager.skip();
        else freeParkingModalManager.pick(target);
      }, THINK.parking);
    }
    return promise;
  });

  // Utang: bot jual bangunan -> gadai -> bangkrut, tanpa dialog konfirmasi.
  wrap(bankruptcyModalManager, 'promptDebtResolution', original => async (debtor, creditor, amount, reason = '') => {
    if (!debtor?.isBot) return original(debtor, creditor, amount, reason);
    for (let guard = 0; guard < 60; guard++) {
      const owned = propertyManager.getPlayerProperties(debtor.id);
      const sellActions = owned.filter(p => p.type === 'prop' && (p.houses > 0 || p.hasHotel)).map(p => ({
        action: p.hasHotel ? 'SELL_HOTEL' : 'SELL_HOUSE', propertyPos: p.pos,
        refund: Math.floor((p.hasHotel ? (p.hotelPrice || 50) : (p.housePrice || 50)) * 0.5)}));
      const mortgageActions = owned.filter(p => !p.isMortgaged && propertyManager.canMortgage(p.pos).canMortgage)
        .map(p => ({propertyPos: p.pos, amount: p.mortgageValue}));
      const step = pickDebtStep({money: debtor.money, amount, sellActions, mortgageActions,
        canDeclareBankruptcy: sellActions.length === 0 && mortgageActions.length === 0});
      if (!step || step.action === 'BANKRUPTCY') break;
      if (step.action === 'PAY') return {resolved: true, bankrupt: false};
      if (step.action === 'SELL_HOTEL') propertyManager.sellHotel(step.propertyPos);
      else if (step.action === 'SELL_HOUSE') propertyManager.sellHouse(step.propertyPos);
      else propertyManager.mortgageProperty(step.propertyPos);
      buildHud();
      await new Promise(done => setTimeout(done, THINK.debt));
    }
    bankruptcyManager.declareBankruptcy(debtor.id, creditor ? creditor.id : 'BANK', amount);
    toast(`💥 ${debtor.name} bangkrut!`);
    return {resolved: false, bankrupt: true};
  });
}

function installAuctionDriver() {
  const act = () => {
    clearTimeout(auctionTimer);
    if (!auctionManager.isActive) return;
    const bidder = auctionManager.getCurrentBidder();
    if (!bidder?.isBot) return;
    auctionTimer = setTimeout(() => {
      const current = auctionManager.getCurrentBidder();
      if (!auctionManager.isActive || current?.id !== bidder.id) return;
      const decision = decideAuctionAction({money: bidder.money, prop: auctionManager.property,
        highestBid: auctionManager.highestBid, props: propertyManager.getAllProperties(), meKey: bidder.id});
      const done = decision.action === 'BID'
        ? auctionManager.placeBid(decision.amount, bidder.id)
        : auctionManager.pass(bidder.id);
      if (done === false && decision.action === 'BID') auctionManager.pass(bidder.id);
      if (auctionManager.isActive) tileModalManager._renderAuctionRoom();
    }, THINK.auction);
  };
  window.addEventListener('auction:started', () => setTimeout(act, 400));
  window.addEventListener('auction:updated', act);
}

function botBuild(player) {
  const pick = pickBuildAction({money: player.money, props: propertyManager.getAllProperties(), meKey: player.id,
    bankHouses: gameState.bankHouses, bankHotels: gameState.bankHotels});
  if (!pick) return false;
  const result = pick.action === 'BUILD_HOTEL' ? propertyManager.buildHotel(pick.propertyPos) : propertyManager.buildHouse(pick.propertyPos);
  if (!result?.success) return false;
  buildHud();
  toast(`🔨 ${player.name} membangun di ${propertyManager.getProperty(pick.propertyPos)?.name || 'propertinya'}`);
  return true;
}

function anyModalOpen() {
  return tileModalManager.isOpen() || jailModalManager.isOpen() || freeParkingModalManager.isOpen() ||
    bankruptcyModalManager.isOpen() || tradeModalManager.isOpen();
}

function tick() {
  const bot = isLocalMode() ? activeBot() : null;
  document.body.classList.toggle('bot-turn', Boolean(bot));
  if (!bot || gameState.gameStatus === GameStatus.FINISHED || turnManager.getPhase() === 'GAME_OVER') return;
  const now = Date.now();
  const turnKey = `${gameState.round}:${gameState.currentTurn}:${bot.playerId}`;
  if (turnKey !== lastTurnKey) { lastTurnKey = turnKey; nextActionAt = now + THINK.turn; }
  if (now < nextActionAt || anyModalOpen() || auctionManager.isActive) return;

  const act = delay => { nextActionAt = Date.now() + delay; };
  // 1) Lempar lagi (double) atau lempar pertama.
  if (document.getElementById('btn-roll-again') && turnManager.canRoll()) {
    if (click('btn-roll-again')) act(THINK.turn);
    return;
  }
  // 2) Giliran selesai: bangun dulu kalau mampu, lalu "Selesai Giliran".
  if (document.getElementById('btn-end-turn') && ['PLAYER_ACTION', 'ROLLING'].includes(turnManager.getPhase())) {
    if (turnManager.getPhase() === 'PLAYER_ACTION' && botBuild(bot)) return act(THINK.build);
    if (click('btn-end-turn')) act(THINK.turn);
    return;
  }
  if (turnManager.getPhase() === 'WAITING_ROLL' && turnManager.canRoll()) {
    document.getElementById('dice')?.click();
    act(THINK.turn);
  }
}

/** Pasang driver bot (aman dipanggil berulang). */
export function initLocalBots() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  installModalDrivers();
  installAuctionDriver();
  setInterval(tick, 500);
}
