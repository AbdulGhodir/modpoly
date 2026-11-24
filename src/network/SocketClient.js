import {io} from 'socket.io-client';
import {friendlyResponse} from '../ui/messages.js';

export class SocketClient {
  constructor({url = import.meta.env?.VITE_SOCKET_URL || '', socketFactory = io} = {}) {
    this.url = url.trim();
    this.socketFactory = socketFactory;
    this.socket = null;
    this.status = 'disconnected';
    this.statusListeners = new Set();
    this.eventListeners = new Map();
  }

  getStatus() {
    return this.status;
  }

  isConnected() {
    return this.status === 'connected';
  }

  onStatusChange(listener) {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  on(eventName, listener) {
    if (!this.eventListeners.has(eventName)) this.eventListeners.set(eventName, new Set());
    const listeners = this.eventListeners.get(eventName);
    const isNewListener = !listeners.has(listener);
    listeners.add(listener);
    if (this.socket && isNewListener) this.socket.on(eventName, listener);
    return () => {
      listeners.delete(listener);
      this.socket?.off(eventName, listener);
      if (listeners.size === 0) this.eventListeners.delete(eventName);
    };
  }

  connect() {
    if (!this.url) {
      this._setStatus('disconnected');
      return null;
    }
    if (this.socket) {
      if (!this.socket.connected) {
        this._setStatus('connecting');
        this.socket.connect();
      }
      return this.socket;
    }

    this._setStatus('connecting');
    this.socket = this.socketFactory(this.url, {
      autoConnect: false,
      // WebSocket langsung: polling HTTP butuh sticky session dan sering putus di balik proxy/load balancer.
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      timeout: 20000
    });

    for (const [eventName, listeners] of this.eventListeners) {
      for (const listener of listeners) this.socket.on(eventName, listener);
    }

    this.socket.on('connect', () => this._setStatus('connected'));
    this.socket.on('disconnect', () => this._setStatus('disconnected'));
    this.socket.on('connect_error', () => this._setStatus('connecting'));
    this.socket.io?.on('reconnect_attempt', () => this._setStatus('connecting'));
    this.socket.io?.on('reconnect_failed', () => this._setStatus('disconnected'));
    this.socket.connect();
    return this.socket;
  }

  disconnect() {
    if (!this.socket) {
      this._setStatus('disconnected');
      return;
    }
    this.socket.disconnect();
    this.socket = null;
    this._setStatus('disconnected');
  }

  ping(message) {
    if (!this.isConnected() || typeof message !== 'string' || !message.trim() || message.length > 200) {
      return false;
    }
    this.socket.emit('connection:ping', {message: message.trim()});
    return true;
  }

  request(eventName, payload = {}, timeoutMs = 5000) {
    if (!this.isConnected() || !this.socket) {
      return Promise.resolve({
        ok: false,
        error: {code: 'NOT_CONNECTED', message: 'Belum tersambung. Tunggu sebentar lalu coba lagi.'}
      });
    }
    return new Promise(resolve => {
      this.socket.timeout(timeoutMs).emit(eventName, payload, (error, response) => {
        if (error) {
          resolve({ok: false, error: {code: 'TIMEOUT', message: 'Koneksi sedang lambat. Coba lagi sebentar lagi.'}});
          return;
        }
        resolve(response && typeof response === 'object'
          ? friendlyResponse(response)
          : {ok: false, error: {code: 'INVALID_RESPONSE', message: 'Terjadi kendala. Coba lagi.'}});
      });
    });
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

export const socketClient = new SocketClient();
