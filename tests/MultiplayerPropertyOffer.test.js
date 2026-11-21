import test from 'node:test';
import assert from 'node:assert/strict';
import {GameState} from '../src/logic/GameStateCore.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {initMultiplayerPropertyOffer} from '../src/ui/MultiplayerPropertyOffer.js';

test('does not reopen a purchase prompt after the same offer has entered auction phase', () => {
  const snapshot = new GameState().toSnapshot();
  snapshot.roomCode = 'ROOM01';
  snapshot.players = [{...snapshot.players[0], playerId: 'p1', seat: 0, name: 'One', pos: 3},
    {...snapshot.players[1], playerId: 'p2', seat: 1, name: 'Two'}];
  snapshot.activePlayerId = 'p1';
  snapshot.phase = 'WAITING_PROPERTY_DECISION';
  snapshot.properties = [[3, {id: 'prop_3', pos: 3, name: 'Bali', type: 'prop', owner: null, price: 60}]];
  snapshot.pendingPropertyOffer = {roomCode: 'ROOM01', resolutionId: 'offer', playerId: 'p1', seat: 0,
    turnId: 1, propertyPos: 3, propertyId: 'prop_3', price: 60};
  const store = new ClientGameStore(new GameState());
  store.setSnapshot(snapshot);
  let prompts = 0;
  const modalManager = {isOpen: () => false, promptPurchase: () => { prompts++; return Promise.resolve(); }};
  initMultiplayerPropertyOffer({client: {}, store, modalManager, getActiveRoom: () => ({roomCode: 'ROOM01'}),
    getLocalPlayerId: () => 'p1'});

  store.getState().phase = 'WAITING_AUCTION_ACTION';
  store.activeAuction = {auctionId: 'offer:auction'};
  store.notify({type: 'movement-animation-complete'});
  assert.equal(prompts, 0);
});
