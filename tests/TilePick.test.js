import test from 'node:test';
import assert from 'node:assert/strict';
import {endTilePick, findTileAt, getActiveTilePick, pickTile, pointInPolygon, startTilePick,
  subscribeTilePick} from '../src/board/tilePick.js';

test('pickTile forwards valid taps and ignores disabled or invalid tiles', () => {
  const picked = [];
  const request = startTilePick({disabled: [20], onPick: pos => picked.push(pos)});
  assert.equal(pickTile(20), false, 'the disabled Free Parking tile does nothing');
  assert.equal(pickTile(-1), false);
  assert.equal(pickTile(2.5), false);
  assert.equal(pickTile(7), true);
  assert.deepEqual(picked, [7]);
  endTilePick(request);
  assert.equal(pickTile(7), false, 'no active pick after it ended');
});

test('a stale request cannot end a newer pick, and listeners see the current request immediately', () => {
  const first = startTilePick({onPick() {}});
  const second = startTilePick({onPick() {}});
  assert.equal(endTilePick(first), false);
  assert.equal(getActiveTilePick(), second);
  const seen = [];
  const unsubscribe = subscribeTilePick(request => seen.push(request?.id ?? null));
  assert.deepEqual(seen, [second.id], 'late subscribers (scene created after the prompt) get the active pick');
  endTilePick(second);
  unsubscribe();
  assert.deepEqual(seen, [second.id, null]);
});

test('point-in-polygon hit testing picks the right tile polygon', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const diamond = [[20, 5], [25, 0], [30, 5], [25, 10]];
  assert.equal(pointInPolygon(5, 5, square), true);
  assert.equal(pointInPolygon(15, 5, square), false);
  assert.equal(findTileAt(25, 5, [square, diamond]), 1);
  assert.equal(findTileAt(21, 1, [square, diamond]), -1, 'outside the diamond corner');
});
