import test from 'node:test';
import assert from 'node:assert/strict';
import {initMultiplayerChanceResolution} from '../src/ui/MultiplayerChanceResolution.js';

function makeStore() {
  const listeners = new Set();
  return {listeners, presentation: {movement: null, movements: new Map(), chancePending: false},
    pendingChancePresentation: null, state: {phase: 'CHANCE_PRESENTATION', activePlayerId: 'p1', turnId: 1},
    getState() { return this.state; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    notify(change) { for (const listener of listeners) listener({change}); }};
}
const event = (id, playerId='p1') => ({roomCode: 'AB2CD3', resolutionId: id, presentationId: `pres-${id}`,
  playerId, turnId: 1, card: {id: 'ch_1', title: 'KARTU KESEMPATAN', desc: 'Hadiah'}, phase: 'CHANCE_PRESENTATION'});

test('queues Chance presentation until movement and a blocking modal finish; duplicate card never reopens', () => {
  const store = makeStore();
  store.presentation.movement = {status: 'ANIMATING'};
  const target = new EventTarget();
  const opened = [];
  const modalManager = {isOpen: () => false, showAuthoritativeChanceCard: (card, options) => { opened.push({card, options}); return true; }};
  const cleanup = initMultiplayerChanceResolution({store, modalManager, eventTarget: target,
    getActiveRoom: () => ({roomCode: 'AB2CD3', status: 'started'}), getLocalPlayerId: () => 'p1',
    client: {isConnected: () => true, async request() { return {ok: true}; }}});
  store.pendingChancePresentation = {presentationId: 'pres-c1', event: event('c1'), pendingPlayerIds: ['p1']};
  store.notify({type: 'chance-presented', detail: event('c1')});
  store.notify({type: 'chance-presented', detail: event('c1')});
  assert.equal(opened.length, 0);
  store.presentation.movement.status = 'COMPLETE';
  store.notify({type: 'movement-animation-complete'});
  assert.equal(opened.length, 1);
  assert.equal(opened[0].options.canContinue, true);
  target.dispatchEvent(new Event('tilemodal:closed'));
  assert.equal(store.presentation.chancePending, false);
  cleanup();
});

test('recipient Continue sends authoritative action once and waits for server response', async () => {
  const store = makeStore();
  const opened = [];
  const requests = [];
  const modalManager = {isOpen: () => false, showAuthoritativeChanceCard: (card, options) => { opened.push({card, options}); return true; }};
  const cleanup = initMultiplayerChanceResolution({store, modalManager, eventTarget: new EventTarget(),
    getActiveRoom: () => ({roomCode: 'AB2CD3', status: 'started'}), getLocalPlayerId: () => 'p1',
    client: {isConnected: () => true, async request(name, payload) { requests.push([name, payload]); return {ok: true}; }}});
  const card = event('continue-1');
  store.pendingChancePresentation = {presentationId: card.presentationId, event: card, pendingPlayerIds: ['p1']};
  store.notify({type: 'chance-presented', detail: card});
  assert.equal(opened.length, 1);
  assert.equal((await opened[0].options.onContinue()).ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], 'game:chance-continue');
  assert.deepEqual({...requests[0][1], actionId: '...'}, {
    turnId: 1, resolutionId: 'continue-1', presentationId: 'pres-continue-1', actionId: '...'
  });
  cleanup();
});

test('non-recipient sees read-only presentation and closing it never changes or acknowledges game state', () => {
  const store = makeStore();
  const opened = [];
  let requests = 0;
  const target = new EventTarget();
  const modalManager = {isOpen: () => false, showAuthoritativeChanceCard: (card, options) => { opened.push({card, options}); return true; }};
  const cleanup = initMultiplayerChanceResolution({store, modalManager, eventTarget: target,
    getActiveRoom: () => ({roomCode: 'AB2CD3', status: 'started'}), getLocalPlayerId: () => 'p2',
    client: {isConnected: () => true, async request() { requests++; return {ok: true}; }}});
  const card = event('read-only');
  store.pendingChancePresentation = {presentationId: card.presentationId, event: card, pendingPlayerIds: ['p1']};
  store.notify({type: 'chance-presented', detail: card});
  assert.equal(opened[0].options.canContinue, false);
  assert.equal(store.state.phase, 'CHANCE_PRESENTATION');
  target.dispatchEvent(new Event('tilemodal:closed'));
  assert.equal(requests, 0);
  assert.equal(store.state.phase, 'CHANCE_PRESENTATION');
  cleanup();
});

test('reconnect restores the same pending card without replaying effects', () => {
  const store = makeStore();
  const displayed = [];
  const pending = {presentationId: 'pres-reconnect', event: {...event('reconnect'), presentationId: 'pres-reconnect'}, pendingPlayerIds: ['p1']};
  const cleanup = initMultiplayerChanceResolution({store, modalManager: {isOpen: () => false,
    showAuthoritativeChanceCard: value => { displayed.push(value); return true; }}, eventTarget: new EventTarget(),
    getActiveRoom: () => ({roomCode: 'AB2CD3', status: 'started'}), getLocalPlayerId: () => 'p1',
    client: {isConnected: () => true, async request() { return {ok: true}; }}});
  store.pendingChancePresentation = pending;
  store.notify({type: 'snapshot', detail: {pendingChancePresentation: pending}});
  store.notify({type: 'snapshot', detail: {pendingChancePresentation: pending}});
  assert.equal(displayed.length, 1);
  assert.equal(displayed[0].card.id, 'ch_1');
  cleanup();
});