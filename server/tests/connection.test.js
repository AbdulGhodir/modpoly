import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {SocketClient} from '../../src/network/SocketClient.js';
import {createBackendServer} from '../src/app.js';

async function startBackend(t) {
  const backend = createBackendServer({port: 0, allowedOrigins: ['http://localhost:5173']});
  backend.httpServer.listen(0, '127.0.0.1');
  await once(backend.httpServer, 'listening');
  const address = backend.httpServer.address();
  t.after(async () => {
    await new Promise(resolve => backend.io.close(resolve));
  });
  return {backend, url: `http://127.0.0.1:${address.port}`};
}

function waitForStatus(client, expectedStatus) {
  if (client.getStatus() === expectedStatus) return Promise.resolve(expectedStatus);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timeout waiting for status ${expectedStatus}`));
    }, 5000);
    const unsubscribe = client.onStatusChange(status => {
      if (status !== expectedStatus) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(status);
    });
  });
}

test('health endpoint reports backend status', async t => {
  const {url} = await startBackend(t);
  const response = await fetch(`${url}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'monopoly-socket-server');
  assert.ok(body.timestamp);
});

test('Socket.IO CORS allows configured frontend origins only', async t => {
  const {url} = await startBackend(t);
  const endpoint = `${url}/socket.io/?EIO=4&transport=polling`;
  const allowed = await fetch(endpoint, {headers: {Origin: 'http://localhost:5173'}});
  const denied = await fetch(endpoint, {headers: {Origin: 'https://untrusted.example'}});

  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('SocketClient sends ping, receives pong, reports disconnect and reconnects', async t => {
  const {backend, url} = await startBackend(t);
  let serverConnections = 0;
  backend.io.on('connection', () => { serverConnections++; });

  const client = new SocketClient({url});
  t.after(() => client.disconnect());
  const statusChanges = [];
  client.onStatusChange(status => statusChanges.push(status));
  let pongCount = 0;
  const recordPong = () => { pongCount++; };
  client.on('connection:pong', recordPong);
  client.on('connection:pong', recordPong);
  const pong = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for pong')), 5000);
    client.on('connection:pong', payload => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });

  const socket = client.connect();
  assert.equal(client.connect(), socket, 'calling connect twice reuses the same socket');
  await waitForStatus(client, 'connected');
  const invalidPayload = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for invalid payload response')), 5000);
    client.on('connection:error', payload => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
  socket.emit('connection:ping', {message: '  '});
  assert.match((await invalidPayload).message, /tidak valid/);
  assert.equal(client.ping('stage-2-check'), true);
  assert.deepEqual(await pong.then(({message}) => message), 'stage-2-check');
  assert.equal(pongCount, 1, 're-registering the same listener must not duplicate delivery');

  const reconnected = once(socket.io, 'reconnect');
  socket.io.engine.close();
  await waitForStatus(client, 'disconnected');
  await reconnected;
  await waitForStatus(client, 'connected');

  assert.ok(serverConnections >= 2);
  assert.ok(statusChanges.includes('disconnected'));
  assert.ok(statusChanges.filter(status => status === 'connected').length >= 2);
});

test('SocketClient remains offline when no backend URL is configured', () => {
  let factoryCalls = 0;
  const client = new SocketClient({url: '', socketFactory: () => { factoryCalls++; }});
  assert.equal(client.connect(), null);
  assert.equal(client.getStatus(), 'disconnected');
  assert.equal(client.isConnected(), false);
  assert.equal(client.ping('offline'), false);
  assert.equal(factoryCalls, 0);
});
