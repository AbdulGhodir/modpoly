import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionGuard } from '../src/logic/ActionGuard.js';
import { createGameState } from '../src/logic/GameState.js';
import { EconomyManager } from '../src/logic/EconomyManager.js';
import { purchaseUnownedProperty } from '../src/logic/purchaseUnownedProperty.js';

test('rapid confirmation clicks apply a card reward only once', () => {
  const state = createGameState();
  const economy = new EconomyManager(state);
  const takeCard = createActionGuard(() => economy.addMoney(1, 100, 'Kartu +100'));

  takeCard();
  takeCard();
  takeCard();

  assert.equal(state.players[0].money, 1600);
  assert.equal(state.transactions.length, 1);
});

test('rapid confirmation clicks apply a card penalty only once', () => {
  const state = createGameState();
  const economy = new EconomyManager(state);
  const takeCard = createActionGuard(() => economy.deductMoney(1, 50, 'Kartu -50'));

  takeCard();
  takeCard();
  takeCard();

  assert.equal(state.players[0].money, 1450);
  assert.equal(state.transactions.length, 1);
});

test('purchase manager rejects a second purchase of the same property', () => {
  const state = createGameState();
  const economy = new EconomyManager(state);
  const prop = { pos: 1, name: 'Test', price: 200, owner: null };
  const properties = {
    getProperty: pos => pos === prop.pos ? prop : null,
    setOwner: (pos, playerId) => { prop.owner = playerId; }
  };

  const purchase = () => purchaseUnownedProperty({ state, economy, properties, pos: 1, playerId: 1 });
  const first = purchase();
  const second = purchase();

  assert.equal(first.success, true);
  assert.equal(second.success, false);
  assert.equal(prop.owner, 1);
  assert.equal(state.players[0].money, 1500 - prop.price);
  assert.equal(state.transactions.length, 1);
});

test('rent transfer callback cannot transfer twice from rapid confirmation clicks', () => {
  const state = createGameState();
  const economy = new EconomyManager(state);
  const payRent = createActionGuard(() => economy.transferMoney(1, 2, 75, 'Sewa'));

  payRent();
  payRent();

  assert.equal(state.players[0].money, 1425);
  assert.equal(state.players[1].money, 1575);
  assert.equal(state.transactions.length, 1);
});

test('failed asynchronous action unlocks for retry', async () => {
  let attempts = 0;
  const action = createActionGuard(async () => {
    attempts++;
    if (attempts === 1) throw new Error('temporary failure');
    return 'ok';
  });

  await assert.rejects(action(), /temporary failure/);
  assert.equal(await action(), 'ok');
  assert.equal(attempts, 2);
});

test('in-flight asynchronous confirmation rejects repeated clicks before completion', async () => {
  let finish;
  let calls = 0;
  const action = createActionGuard(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  });

  const pending = action();
  assert.equal(action(), undefined);
  assert.equal(calls, 1);
  finish();
  await pending;
  assert.equal(await action(), undefined);
  assert.equal(calls, 1);
});

test('completed guard is scoped to one opportunity and separate actions do not block each other', () => {
  let count = 0;
  const firstAction = createActionGuard(() => ++count);
  const otherAction = createActionGuard(() => ++count);

  firstAction();
  otherAction();
  firstAction();

  assert.equal(count, 2);
});
