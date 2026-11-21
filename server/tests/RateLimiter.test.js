import test from 'node:test';
import assert from 'node:assert/strict';
import {RateLimiter} from '../src/RateLimiter.js';

test('token bucket allows configured bursts, refills, expires idle keys, and stays bounded', () => {
  let now = 0;
  const limiter = new RateLimiter({now: () => now, idleTtlMs: 100, maxKeys: 2});
  const policy = {capacity: 2, refillPerSecond: 1};
  assert.equal(limiter.consume('socket-a', policy).allowed, true);
  assert.equal(limiter.consume('socket-a', policy).allowed, true);
  const blocked = limiter.consume('socket-a', policy);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 1000);
  now += 1000;
  assert.equal(limiter.consume('socket-a', policy).allowed, true);
  limiter.consume('socket-b', policy);
  now += 200;
  limiter.consume('socket-c', policy);
  assert.ok(limiter.buckets.size <= 2);
  assert.equal(limiter.buckets.has('socket-a'), false);
});
