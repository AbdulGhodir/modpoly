import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameState} from '../src/logic/GameState.js';
import {ClientGameStore} from '../src/state/ClientGameStore.js';
import {initBuildingResolutionSync} from '../src/network/BuildingResolutionSync.js';

function makeClient() {
  const state = createGameState();
  const city = {id: 'prop_1', pos: 1, name: 'Medan', type: 'prop', group: 'brown', owner: 'player-1',
    price: 60, housePrice: 50, hotelPrice: 50, houses: 0, hasHotel: false, isMortgaged: false,
    rent: {base: 2, house1: 10, house2: 30, house3: 90, house4: 160, hotel: 250}};
  state.properties.set(1, city);
  state.players[0].properties.push(city.id);
  const store = new ClientGameStore(state);
  const snapshot = store.getSnapshot();
  snapshot.roomCode = 'BUILD01';
  store.setSnapshot(snapshot);
  const handlers = new Map();
  const client = {on(event, handler) {handlers.set(event, handler); return () => handlers.delete(event);}};
  const remove = initBuildingResolutionSync({client, store, getActiveRoom: () => ({roomCode: 'BUILD01', status: 'started'}), logger: {warn() {}}});
  return {store, handlers, remove};
}

test('clients apply the same authoritative house build snapshot once and expose fresh stock/rent data', () => {
  const a = makeClient(), b = makeClient();
  const snapshot = a.store.getSnapshot();
  snapshot.roomCode = 'BUILD01';
  snapshot.bankHouses = 31;
  snapshot.players[0].money = 1450;
  snapshot.properties.find(([position]) => position === 1)[1].houses = 1;
  snapshot.transactions.push({id: 'tx_building_build-1', players: ['Pemain 1', 'Bank'], amount: 50, type: 'BUILD'});
  const event = {roomCode: 'BUILD01', action: 'BUILD_HOUSE', actionId: 'build-1', playerId: 'player-1',
    playerName: 'Pemain 1', seat: 0, turnId: 1, currentTurn: 0, activePlayerId: 'player-1', phase: 'WAITING_ROLL',
    propertyPos: 1, propertyId: 'prop_1', propertyName: 'Medan', amount: 50, balance: 1450,
    bankHousesBefore: 32, bankHotelsBefore: 12, bankHouses: 31, bankHotels: 12,
    property: {...snapshot.properties.find(([position]) => position === 1)[1]},
    transaction: snapshot.transactions[0], snapshot};
  assert.equal(a.handlers.get('game:building-state')(event), true);
  assert.equal(b.handlers.get('game:building-state')(event), true);
  assert.equal(a.store.getProperty(1).houses, 1);
  assert.equal(b.store.getProperty(1).rent.house1, 10);
  assert.equal(a.store.getState().bankHouses, 31);
  assert.equal(a.store.getBalance('player-1'), 1450);
  assert.equal(a.handlers.get('game:building-state')(event), false);
  a.remove(); b.remove();
});

test('building sync rejects a different room and malformed stock/snapshot data without mutation', () => {
  const {store, handlers, remove} = makeClient();
  const base = store.getSnapshot(); base.roomCode = 'BUILD01';
  const event = {roomCode: 'OTHER1', action: 'BUILD_HOUSE', actionId: 'wrong-room', playerId: 'player-1',
    playerName: 'Pemain 1', seat: 0, turnId: 1, currentTurn: 0, activePlayerId: 'player-1', phase: 'WAITING_ROLL',
    propertyPos: 1, propertyId: 'prop_1', propertyName: 'Medan', amount: 50, balance: 1450,
    bankHousesBefore: 32, bankHotelsBefore: 12, bankHouses: 31, bankHotels: 12,
    property: {id: 'prop_1', owner: 'player-1', houses: 1, hasHotel: false, isMortgaged: false}, snapshot: base};
  assert.equal(handlers.get('game:building-state')(event), false);
  assert.equal(store.getBalance('player-1'), 1500);
  assert.equal(store.getProperty(1).houses, 0);
  remove();
});

