import test from 'node:test';
import assert from 'node:assert/strict';
import {initMultiplayerTrade} from '../src/ui/MultiplayerTrade.js';

function setup(localPlayerId) {
  const updates = new Set();
  const trade = {tradeId: 'trade-1', roomCode: 'ROOM01', fromPlayerId: 'sender', toPlayerId: 'receiver',
    status: 'PENDING', updatedAt: '2026-11-18T00:00:00.000Z',
    offer: {giveMoney: 20, receiveMoney: 0, givePropPositions: [], receivePropPositions: []}};
  const store = {trades: new Map([[trade.tradeId, trade]]), subscribe(listener) {updates.add(listener); return () => updates.delete(listener);}};
  const shown = [], requests = [];
  const modalManager = {showAuthoritativeTrade(current, controls) {shown.push({current, controls});},
    closeAuthoritativeTrade(id) {shown.push({closed: id});}};
  const client = {async request(event, payload) {requests.push({event, payload}); return {ok: true};}};
  const getActiveRoom = () => ({roomCode: 'ROOM01', status: 'started'});
  const stop = initMultiplayerTrade({client, store, modalManager, getActiveRoom, getLocalPlayerId: () => localPlayerId});
  return {trade, store, shown, requests, updates, stop};
}

test('trade UI restores pending offers for participants only and limits actions to each party role', async () => {
  const sender = setup('sender');
  for (const listener of sender.updates) listener({change: {type: 'snapshot'}});
  assert.equal(sender.shown.length, 1);
  assert.equal((await sender.shown[0].controls.onAction('ACCEPT', sender.trade)).ok, false);
  assert.equal(sender.requests.length, 0);
  assert.equal((await sender.shown[0].controls.onAction('CANCEL', sender.trade)).ok, true);
  assert.equal(sender.requests[0].payload.action, 'CANCEL');
  sender.stop();

  const receiver = setup('receiver');
  for (const listener of receiver.updates) listener({change: {type: 'snapshot'}});
  assert.equal(receiver.shown.length, 1);
  assert.equal((await receiver.shown[0].controls.onAction('ACCEPT', receiver.trade)).ok, true);
  assert.equal(receiver.requests[0].payload.action, 'ACCEPT');
  assert.equal((await receiver.shown[0].controls.onAction('CANCEL', receiver.trade)).ok, false);
  assert.equal(receiver.requests.length, 1);
  receiver.stop();

  const observer = setup('observer');
  for (const listener of observer.updates) listener({change: {type: 'trade-updated', detail: {trade: observer.trade}}});
  assert.equal(observer.shown.length, 0);
  observer.stop();
});

