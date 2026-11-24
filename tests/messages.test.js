import test from 'node:test';
import assert from 'node:assert/strict';
import {friendlyMessage, friendlyResponse, softenMessage} from '../src/ui/messages.js';

test('known error codes become plain Indonesian sentences', () => {
  assert.match(friendlyMessage({code: 'ROOM_NOT_FOUND', message: 'Room tidak ditemukan.'}), /Ruangan tidak ditemukan/);
  assert.match(friendlyMessage({code: 'TIMEOUT'}), /lambat/);
});

test('technical payload errors never reach the player', () => {
  assert.equal(friendlyMessage({code: 'INVALID_PAYLOAD', message: 'Aksi harus berisi turnId, actionId.'}), 'Terjadi kendala. Coba lagi.');
  assert.equal(softenMessage('Socket.IO tidak valid'), 'Terjadi kendala. Coba lagi.');
});

test('unknown codes get everyday wording instead of room/host/server jargon', () => {
  assert.equal(softenMessage('Hanya host yang dapat memulai permainan di room ini.'), 'Hanya pembuat ruangan yang dapat memulai permainan di ruangan ini.');
});

test('friendlyResponse keeps successes untouched and keeps the raw message for debugging', () => {
  const ok = {ok: true, room: {}};
  assert.equal(friendlyResponse(ok), ok);
  const failed = friendlyResponse({ok: false, error: {code: 'ROOM_FULL', message: 'Room sudah penuh.'}});
  assert.equal(failed.error.rawMessage, 'Room sudah penuh.');
  assert.match(failed.error.message, /penuh/);
});
