import test from 'node:test';
import assert from 'node:assert/strict';
import {GameState} from '../src/logic/GameStateCore.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {initAuctionResolutionSync} from '../src/network/AuctionResolutionSync.js';
import {getAuctionBidOptions, initMultiplayerAuction, isLocalAuctionBidder, parseCustomAuctionBid} from '../src/ui/MultiplayerAuction.js';

class FakeClient {
  listeners = new Map();
  on(name, listener) {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }
  emit(name, payload) { for (const listener of this.listeners.get(name) || []) listener(payload); }
}

const room = {roomCode: 'AUCT01', status: 'started'};
function baseSnapshot() {
  const snapshot = new GameState().toSnapshot();
  snapshot.roomCode = room.roomCode;
  snapshot.players = [
    {...snapshot.players[0], playerId: 'p1', seat: 0, name: 'Satu', pos: 3, money: 1500, properties: []},
    {...snapshot.players[1], playerId: 'p2', seat: 1, name: 'Dua', pos: 0, money: 1500, properties: []}
  ];
  snapshot.activePlayerId = 'p1';
  snapshot.properties = [[3, {id: 'prop_3', pos: 3, name: 'Bali', type: 'prop', price: 60, owner: null}]];
  snapshot.transactions = [];
  snapshot.phase = 'WAITING_PROPERTY_DECISION';
  snapshot.pendingPropertyOffer = {roomCode: room.roomCode, resolutionId: 'resolution-1', playerId: 'p1', seat: 0,
    turnId: 1, propertyPos: 3, propertyId: 'prop_3', price: 60, propertyName: 'Bali'};
  return snapshot;
}
function makeAuction(revision = 1) {
  return {auctionId: 'resolution-1:auction', roomCode: room.roomCode, resolutionId: 'resolution-1', turnId: 1,
    initiatorId: 'p1', propertyPos: 3, propertyId: 'prop_3', propertyName: 'Bali', propertyPrice: 60,
    participantIds: ['p1', 'p2'], activeBidderIds: ['p1', 'p2'], currentBidderIndex: 0,
    currentBidderId: 'p1', highestBid: 0, highestBidderId: null, highestBidder: null, revision,
    participants: [{playerId: 'p1', name: 'Satu', seat: 0, money: 1500, status: 'ACTIVE'},
      {playerId: 'p2', name: 'Dua', seat: 1, money: 1500, status: 'ACTIVE'}],
    activeBidders: [{playerId: 'p1', name: 'Satu', seat: 0, money: 1500, status: 'ACTIVE'},
      {playerId: 'p2', name: 'Dua', seat: 1, money: 1500, status: 'ACTIVE'}]};
}
function setupStore() {
  const store = new ClientGameStore(new GameState());
  store.setSnapshot(baseSnapshot());
  return store;
}

test('auction quick-bid amounts follow single-player increments and always meet the server minimum', () => {
  assert.deepEqual(getAuctionBidOptions(makeAuction()), {minimumBid: 1, quickBids: [1, 26, 51]});
  const withBid = {...makeAuction(), highestBid: 100, highestBidderId: 'p1'};
  assert.deepEqual(getAuctionBidOptions(withBid), {minimumBid: 101, quickBids: [110, 135, 160]});
  assert.equal(isLocalAuctionBidder(withBid, 'p2'), false);
  assert.equal(isLocalAuctionBidder({...withBid, currentBidderId: 'p2'}, 'p2'), true);
});

test('custom auction bids accept only whole safe integers at or above the minimum', () => {
  assert.equal(parseCustomAuctionBid('101', 101), 101);
  for (const invalid of ['', '   ', '-1', '1.5', '1e3', 'NaN', 'Infinity', '9007199254740992']) {
    assert.equal(parseCustomAuctionBid(invalid, 1), null, `expected ${JSON.stringify(invalid)} to be rejected`);
  }
  assert.equal(parseCustomAuctionBid('100', 101), null);
});

test('both clients apply the same auction start, update, and official settlement; duplicates are ignored', () => {
  const client = new FakeClient();
  const stores = [setupStore(), setupStore()];
  const modals = stores.map(() => ({shown: [], results: [], showAuthoritativeAuction(value) { this.shown.push(value); },
    showAuthoritativeAuctionResult(value) { this.results.push(value); }, closeAuthoritativeAuction() {}}));
  const cleanups = stores.map((store, index) => {
    initAuctionResolutionSync({client, store, getActiveRoom: () => room, logger: {warn() {}}});
    return initMultiplayerAuction({client, store, modalManager: modals[index], getActiveRoom: () => room,
      getLocalPlayerId: () => index ? 'p2' : 'p1'});
  });
  const initial = baseSnapshot();
  const auction1 = makeAuction();
  const started = {roomCode: room.roomCode, type: 'STARTED', auction: auction1,
    snapshot: {...initial, phase: 'WAITING_AUCTION_ACTION', pendingPropertyOffer: null, activeAuction: auction1}};
  client.emit('game:auction-started', started);
  assert.deepEqual(stores.map(store => store.activeAuction), [auction1, auction1]);
  assert.deepEqual(modals.map(modal => modal.shown.length), [1, 1]);
  client.emit('game:auction-started', started);
  assert.deepEqual(modals.map(modal => modal.shown.length), [1, 1]);

  const auction2 = {...auction1, currentBidderIndex: 1, currentBidderId: 'p2', highestBid: 100,
    highestBidderId: 'p1', highestBidder: auction1.participants[0], revision: 2};
  const updated = {...started, type: 'UPDATED', auction: auction2,
    snapshot: {...started.snapshot, activeAuction: auction2}};
  client.emit('game:auction-updated', updated);
  assert.deepEqual(stores.map(store => store.activeAuction), [auction2, auction2]);

  const endSnapshot = {...initial, currentTurn: 0, turnId: 1, activePlayerId: 'p1', phase: 'PLAYER_ACTION',
    pendingPropertyOffer: null, activeAuction: null, players: initial.players.map(player => player.playerId === 'p1'
      ? {...player, money: 1400, properties: ['prop_3']}
      : player), properties: [[3, {...initial.properties[0][1], owner: 'p1'}]],
    transactions: [{id: 'tx_resolution-1:auction', type: 'AUCTION', amount: 100, players: ['Satu', 'Bank']} ]};
  const ended = {roomCode: room.roomCode, type: 'ENDED', auctionId: auction1.auctionId, previousTurnId: 1,
    turnId: 1, currentTurn: 0, round: 1, activePlayerId: 'p1', phase: 'PLAYER_ACTION',
    extraRollAllowed: false, consecutiveDoubles: 0,
    winner: {playerId: 'p1', name: 'Satu', seat: 0}, amount: 100,
    property: {id: 'prop_3', pos: 3, name: 'Bali', owner: 'p1'},
    transaction: endSnapshot.transactions[0], balances: [{playerId: 'p1', money: 1400}, {playerId: 'p2', money: 1500}],
    snapshot: endSnapshot};
  client.emit('game:auction-ended', ended);
  assert.equal(stores[0].getPlayer('p1').money, 1400);
  assert.deepEqual(stores.map(store => store.getProperty(3).owner), ['p1', 'p1']);
  assert.deepEqual(modals.map(modal => modal.results.length), [1, 1]);
  client.emit('game:auction-ended', ended);
  assert.deepEqual(modals.map(modal => modal.results.length), [1, 1]);
  cleanups.forEach(cleanup => cleanup());
});

test('reconnect snapshot restores the active bidder and read-only participant state', () => {
  const snapshot = baseSnapshot();
  snapshot.phase = 'WAITING_AUCTION_ACTION';
  snapshot.pendingPropertyOffer = null;
  snapshot.activeAuction = makeAuction();
  const store = new ClientGameStore(new GameState());
  const modalManager = {shown: [], showAuthoritativeAuction(value) { this.shown.push(value); },
    showAuthoritativeAuctionResult() {}, closeAuthoritativeAuction() {}};
  const cleanup = initMultiplayerAuction({client: new FakeClient(), store, modalManager,
    getActiveRoom: () => room, getLocalPlayerId: () => 'p2'});
  store.setSnapshot(snapshot);
  assert.equal(store.getPhase(), 'WAITING_AUCTION_ACTION');
  assert.equal(store.activeAuction.currentBidderId, 'p1');
  assert.equal(store.activeAuction.auctionId, 'resolution-1:auction');
  assert.equal(modalManager.shown.length, 1);
  cleanup();
});

test('non-current client cannot submit an auction action from the multiplayer controller', async () => {
  const snapshot = baseSnapshot();
  snapshot.phase = 'WAITING_AUCTION_ACTION';
  snapshot.pendingPropertyOffer = null;
  snapshot.activeAuction = makeAuction();
  const store = new ClientGameStore(new GameState());
  store.setSnapshot(snapshot);
  let options;
  const modalManager = {showAuthoritativeAuction(_auction, passedOptions) { options = passedOptions; },
    showAuthoritativeAuctionResult() {}, closeAuthoritativeAuction() {}};
  let requests = 0;
  const cleanup = initMultiplayerAuction({client: {request() { requests++; }}, store, modalManager,
    getActiveRoom: () => room, getLocalPlayerId: () => 'p2'});
  store.notify({type: 'snapshot'});
  const response = await options.onAction('BID', 10, store.activeAuction);
  assert.equal(response.ok, false);
  assert.equal(requests, 0);
  cleanup();
});

test('active bidder controls use current turn and reject stale auction actions before sending', async () => {
  const snapshot = baseSnapshot();
  snapshot.phase = 'WAITING_AUCTION_ACTION';
  snapshot.pendingPropertyOffer = null;
  snapshot.activeAuction = makeAuction();
  const store = new ClientGameStore(new GameState());
  store.setSnapshot(snapshot);
  let options;
  const modalManager = {showAuthoritativeAuction(_auction, passedOptions) { options = passedOptions; },
    showAuthoritativeAuctionResult() {}, closeAuthoritativeAuction() {}};
  const requests = [];
  const cleanup = initMultiplayerAuction({client: {request(...args) { requests.push(args); return {ok: true}; }}, store,
    modalManager, getActiveRoom: () => room, getLocalPlayerId: () => 'p1'});
  store.notify({type: 'snapshot'});
  assert.equal(options.localPlayerId, 'p1');
  assert.deepEqual(options.quickBids, [1, 26, 51]);
  assert.equal((await options.onAction('BID', 0, store.activeAuction)).ok, false);
  assert.equal(requests.length, 0);
  assert.equal((await options.onAction('BID', 1, store.activeAuction)).ok, true);
  assert.equal(requests[0][0], 'game:auction-action');

  store.activeAuction = {...store.activeAuction, turnId: 2};
  assert.equal((await options.onAction('PASS', null, snapshot.activeAuction)).ok, false);
  assert.equal(requests.length, 1);
  cleanup();
});
