import test from 'node:test';
import assert from 'node:assert/strict';
import {MovementMoneyPresentation} from '../src/network/MovementMoneyPresentation.js';

test('a snapshot (e.g. reconnect) clears held payments instead of throwing', () => {
  const presented = [];
  const presentation = new MovementMoneyPresentation({store: {}, present: payload => presented.push(payload)});
  presentation.pendingPayments.set('move-1', {changes: []});
  assert.doesNotThrow(() => presentation.handleStoreChange({type: 'snapshot'}));
  assert.equal(presentation.pendingPayments.size, 0);
  presentation.handleStoreChange({type: 'movement-animation-complete', detail: {movementId: 'move-1'}});
  assert.deepEqual(presented, [], 'stale payments are not replayed after a snapshot');
});
