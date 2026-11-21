import test from 'node:test';
import assert from 'node:assert/strict';
import {FreeParkingModalManager} from '../src/ui/FreeParkingModalManager.js';
import {getActiveTilePick, pickTile} from '../src/board/tilePick.js';

const player = money => ({playerId: 'p1', money});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('local: tapping a tile pays travel to it; Free Parking itself does nothing', async () => {
  const manager = new FreeParkingModalManager();
  const result = manager.promptTravel(player(500));
  assert.equal(manager.isOpen(), true);
  assert.deepEqual(getActiveTilePick().disabled, [20], 'tile 20 is dark/disabled');
  assert.equal(pickTile(20), false);
  assert.equal(manager.isOpen(), true, 'still waiting after tapping Free Parking');
  assert.equal(pickTile(5), true);
  assert.deepEqual(await result, {action: 'TRAVEL', targetPos: 5, cost: 50, willPassStart: true});
  assert.equal(manager.isOpen(), false);
  assert.equal(getActiveTilePick(), null, 'board highlight is cleared');
  const later = manager.promptTravel(player(500));
  pickTile(25);
  assert.equal((await later).willPassStart, false, 'tiles after 20 do not pass START');
});

test('local: "Tidak Memilih" stays and returns to a normal roll', async () => {
  const manager = new FreeParkingModalManager();
  const result = manager.promptTravel(player(500));
  manager.skip();
  assert.deepEqual(await result, {action: 'STAY'});
  assert.equal(getActiveTilePick(), null);
});

test('local: not enough money shows a toast and falls through to a normal roll', async () => {
  const manager = new FreeParkingModalManager();
  const messages = [];
  const result = await manager.promptTravel(player(49), {notify: message => messages.push(message)});
  assert.deepEqual(result, {action: 'STAY'});
  assert.deepEqual(messages, ['Uang Anda tidak cukup untuk parkir bebas.']);
  assert.equal(manager.isOpen(), false);
  assert.equal(getActiveTilePick(), null, 'no glowing tiles when travel is impossible');
});

test('multiplayer: tap sends TRAVEL, stays in pick mode if the server rejects, closes once accepted', async () => {
  const manager = new FreeParkingModalManager();
  const calls = [];
  let accept = false;
  const result = manager.promptTravel(player(500), {canAct: true,
    onAction: async (action, targetPos) => { calls.push([action, targetPos]); return accept; }});
  pickTile(7);
  await tick();
  assert.deepEqual(calls, [['TRAVEL', 7]]);
  assert.equal(manager.isOpen(), true, 'rejected: the player can choose again');
  assert.equal(getActiveTilePick() !== null, true);
  accept = true;
  pickTile(8);
  assert.deepEqual(await result, {action: 'TRAVEL', targetPos: 8, cost: 50, willPassStart: true});
  assert.deepEqual(calls, [['TRAVEL', 7], ['TRAVEL', 8]]);
  assert.equal(getActiveTilePick(), null);
});

test('multiplayer: a second tap while the TRAVEL request is in flight is ignored', async () => {
  const manager = new FreeParkingModalManager();
  const calls = [];
  let release;
  const result = manager.promptTravel(player(500), {canAct: true,
    onAction: (action, targetPos) => { calls.push([action, targetPos]); return new Promise(resolve => { release = resolve; }); }});
  pickTile(3);
  pickTile(4);
  manager.skip();
  assert.deepEqual(calls, [['TRAVEL', 3]]);
  release(true);
  assert.equal((await result).targetPos, 3);
});

test('multiplayer: not enough money toasts and tells the server STAY so dice unlock', async () => {
  const manager = new FreeParkingModalManager();
  const calls = [];
  const messages = [];
  const result = await manager.promptTravel(player(10), {canAct: true, notify: message => messages.push(message),
    onAction: async (action, targetPos) => { calls.push([action, targetPos]); return true; }});
  assert.deepEqual(result, {action: 'STAY'});
  assert.deepEqual(calls, [['STAY', undefined]]);
  assert.deepEqual(messages, ['Uang Anda tidak cukup untuk parkir bebas.']);
  assert.equal(getActiveTilePick(), null);
});

test('multiplayer: broke player whose STAY is rejected can retry instead of getting stuck', async () => {
  const manager = new FreeParkingModalManager();
  let attempts = 0;
  const result = manager.promptTravel(player(10), {canAct: true, notify() {},
    onAction: async () => ++attempts > 1});
  await tick();
  assert.equal(manager.isOpen(), true);
  manager.skip();
  assert.deepEqual(await result, {action: 'STAY'});
  assert.equal(attempts, 2);
});

test('cancelTravelPrompt (e.g. server resolved it) ends the pick and resolves CANCELLED', async () => {
  const manager = new FreeParkingModalManager();
  const result = manager.promptTravel(player(500));
  manager.cancelTravelPrompt();
  assert.deepEqual(await result, {action: 'CANCELLED'});
  assert.equal(manager.isOpen(), false);
  assert.equal(getActiveTilePick(), null);
});

test('a spectator (canAct false) never gets a pick mode', async () => {
  const manager = new FreeParkingModalManager();
  const result = await manager.promptTravel(player(500), {canAct: false, onAction() { return true; }});
  assert.deepEqual(result, {action: 'CANCELLED'});
  assert.equal(getActiveTilePick(), null);
});
