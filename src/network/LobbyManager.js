import {socketClient} from './SocketClient.js';
import {startLocalGame} from '../logic/localGame.js';
import {requestGameDisplayMode} from '../ui/fullscreen.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const SESSION_TOKEN_KEY = 'monopoly.sessionToken';
const SESSION_ROOM_KEY = 'monopoly.sessionRoomCode';

function readStored(key) {
  try { return globalThis.localStorage?.getItem(key) || ''; } catch { return ''; }
}
function writeStored(key, value) {
  try {
    if (value) globalThis.localStorage?.setItem(key, value);
    else globalThis.localStorage?.removeItem(key);
  } catch { /* Storage can be disabled; the active socket session still works. */ }
}

export class LobbyManager {
  constructor(client = socketClient) {
    this.client = client;
    this.overlay = null;
    this.room = null;
    this.playerId = null;
    this.playerName = readStored('monopoly.lastPlayerName') || '';
    this.joinRoomCode = '';
    this.sessionToken = readStored(SESSION_TOKEN_KEY);
    this.sessionRoomCode = readStored(SESSION_ROOM_KEY);
    this.resumePending = false;
    this.rejoinAvailable = false;
    this.rejoinAfterResume = false;
    this.onSessionRestored = null;
    this.errorMessage = '';
    this.pending = false;
    this.isOpen = false;
    this.currentView = 'main'; // 'main' | 'local' | 'multiplayer-menu' | 'multiplayer-room' | 'closed'
    this.multiplayerTab = 'create'; // 'create' | 'join'
    this.localPlayerCount = 4; // jumlah pemain MANUSIA (1-4)
    this.localBotCount = 0;    // jumlah bot (total manusia + bot maksimal 4)
    this.localPlayerNames = ['Pemain 1', 'Pemain 2', 'Pemain 3', 'Pemain 4'];
    this.closeTimer = null;
    this.previousStatus = client.getStatus();

    this._buildDom();

    this.removeStatusListener = client.onStatusChange(status => this._onStatus(status));
    this.removeRoomListener = client.on('room:updated', room => this._setRoom(room));
    this.removeStartedListener = client.on('room:started', room => {
      this._setRoom(room);
      if (room?.status === 'started') {
        this.close();
      }
    });
    this.removeClosedListener = client.on('room:closed', payload => {
      if (payload?.roomCode !== this.room?.roomCode) return;
      this.room = null;
      this.playerId = null;
      this.rejoinAvailable = false;
      this._clearStoredSession();
      this.errorMessage = 'Room sudah ditutup karena masa pemulihan berakhir.';
      this.setView('multiplayer-menu');
    });

    this._renderConnectionNotice();

    // Default buka menu utama saat baru masuk aplikasi
    if (typeof document !== 'undefined') {
      if (this.sessionToken) {
        if (client.isConnected()) {
          queueMicrotask(() => this._resumeSession());
        }
      } else {
        this.open('main');
      }
    }
  }

  _buildDom() {
    if (typeof document === 'undefined') return;

    let el = document.getElementById('lobby-screen');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lobby-screen';
      el.className = 'lobby-screen hidden';
      document.body.appendChild(el);
    }
    this.overlay = el;

    // Top action buttons di in-game
    const btnMultiplayer = document.getElementById('btn-multiplayer');
    if (btnMultiplayer) {
      btnMultiplayer.onclick = () => {
        if (this.room) {
          this.open('multiplayer-room');
        } else {
          this.open('multiplayer-menu');
        }
      };
    }

    const btnHome = document.getElementById('btn-lobby-home');
    if (btnHome) {
      btnHome.onclick = async () => {
        const activeGame = this.room?.status === 'started';
        const confirmExit = confirm(activeGame
          ? 'Putus sementara dari game? Sesi tetap tersimpan dan bisa dilanjutkan lewat Rejoin Game.'
          : 'Kembali ke Menu Utama? Permainan saat ini akan dihentikan.');
        if (!confirmExit) return;
        if (this.room) await this._leaveRoom();
        if (typeof document !== 'undefined') {
          document.body.classList.remove('mode-local');
          document.body.classList.remove('mode-multiplayer');
        }
        this.open(activeGame ? 'multiplayer-room' : 'main');
      };
    }
  }

  open(view = 'main') {
    clearTimeout(this.closeTimer);
    this.isOpen = true;
    this.currentView = view;
    if (typeof document !== 'undefined') {
      document.body.classList.add('in-lobby');
    }
    if (view === 'multiplayer-menu' || view === 'multiplayer-room') {
      this.client.connect();
    }
    this._render();
    this.overlay?.classList.remove('hidden');
    globalThis.requestAnimationFrame?.(() => this.overlay?.classList.add('visible'));
  }

  close() {
    this.isOpen = false;
    this.currentView = 'closed';
    if (typeof document !== 'undefined') {
      document.body.classList.remove('in-lobby');
      // Jika room multiplayer aktif, tandai mode
      if (this.room?.status === 'started') {
        document.body.classList.add('mode-multiplayer');
        document.body.classList.remove('mode-local');
      }
    }
    this.overlay?.classList.remove('visible');
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.overlay?.classList.add('hidden'), 180);
  }

  setView(view) {
    this.currentView = view;
    this.errorMessage = '';
    this._render();
  }

  _onStatus(status) {
    if (status === 'disconnected' && this.room) this.errorMessage = 'Koneksi terputus. Mencoba memulihkan sesi room…';
    if (status === 'connected' && this.sessionToken && this.previousStatus !== 'connected') this._resumeSession();
    this.previousStatus = status;
    this._renderConnectionNotice();
    if (this.isOpen) this._render();
  }

  setSessionRestoredHandler(handler) { this.onSessionRestored = typeof handler === 'function' ? handler : null; }

  _clearStoredSession() {
    this.sessionToken = '';
    this.sessionRoomCode = '';
    this.rejoinAvailable = false;
    writeStored(SESSION_TOKEN_KEY, '');
    writeStored(SESSION_ROOM_KEY, '');
  }

  _saveSession(token, roomCode) {
    this.sessionToken = token;
    this.sessionRoomCode = roomCode || '';
    writeStored(SESSION_TOKEN_KEY, token);
    writeStored(SESSION_ROOM_KEY, this.sessionRoomCode);
  }

  _renderConnectionNotice() {
    if (typeof document === 'undefined') return;
    let notice = document.getElementById('room-session-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'room-session-notice';
      notice.className = 'room-session-notice hidden';
      notice.setAttribute('role', 'status');
      document.body.appendChild(notice);
    }
    const show = Boolean(!this.isOpen && (this.room || this.sessionToken) && (this.client.getStatus() !== 'connected' || this.resumePending ||
      (this.errorMessage && this.sessionToken)));
    notice.textContent = this.errorMessage && this.sessionToken
      ? this.errorMessage
      : this.resumePending || this.client.getStatus() === 'connecting'
      ? 'Menyambungkan kembali ke room…'
      : 'Koneksi terputus. Sesi room disimpan sementara.';
    notice.classList.toggle('hidden', !show);
  }

  async _resumeSession() {
    if (this.resumePending || !this.sessionToken || !this.client.isConnected()) return false;
    this.resumePending = true;
    this._renderConnectionNotice();
    try {
      const response = await this.client.request('room:resume', {
        sessionToken: this.sessionToken,
        ...(this.sessionRoomCode ? {roomCode: this.sessionRoomCode} : {})
      });
      if (!response.ok) {
        if (['INVALID_SESSION', 'SESSION_EXPIRED', 'SESSION_ROOM_MISMATCH', 'ROOM_NOT_FOUND'].includes(response.error?.code)) {
          this._clearStoredSession();
          this.room = null;
          this.playerId = null;
          this.rejoinAvailable = false;
        }
        this.errorMessage = response.error?.message || 'Sesi room belum dapat dipulihkan.';
        this.open('main');
        return false;
      }
      this.room = response.room;
      this.playerId = response.playerId;
      this._saveSession(response.sessionToken, response.room.roomCode);
      this.errorMessage = '';
      const snapshotApplied = this.onSessionRestored?.({roomCode: response.room.roomCode, snapshot: response.snapshot || null});
      if (response.room.status === 'started' && (!response.snapshot || snapshotApplied !== true)) {
        this.errorMessage = 'Sesi terhubung, tetapi snapshot terbaru tidak dapat diterapkan.';
        this.rejoinAvailable = false;
        this.open('multiplayer-room');
        return true;
      }
      if (response.room.status === 'started') {
        this.rejoinAvailable = true;
        if (this.rejoinAfterResume) {
          this.rejoinAfterResume = false;
          requestGameDisplayMode();
          this.close();
        } else this.open('multiplayer-room');
      } else {
        this.rejoinAvailable = false;
        this.open('multiplayer-room');
      }
      return true;
    } catch (error) {
      this.errorMessage = error?.message || 'Sesi room belum dapat dipulihkan.';
      this.open('main');
      return false;
    } finally {
      this.resumePending = false;
      if (!this.rejoinAvailable) this.rejoinAfterResume = false;
      this._renderConnectionNotice();
      if (this.isOpen) {
        this._render();
      }
    }
  }

  _setRoom(room) {
    if (!room) return;
    this.room = room;
    this.errorMessage = '';
    this._renderConnectionNotice();
    if (this.isOpen) {
      this.currentView = 'multiplayer-room';
      this._render();
    }
  }

  getRoomState() {
    return this.room;
  }

  _statusText() {
    const status = this.client.getStatus();
    if (status === 'connected') return 'Terhubung ke server';
    if (status === 'connecting') return 'Menghubungkan ke server…';
    return this.client.url
      ? 'Terputus dari server'
      : 'Server belum diatur';
  }

  _render() {
    if (!this.overlay) return;

    if (this.currentView === 'main') {
      this._renderMainView();
    } else if (this.currentView === 'local') {
      this._renderLocalSetupView();
    } else if (this.currentView === 'multiplayer-menu') {
      this._renderMultiplayerMenuView();
    } else if (this.currentView === 'multiplayer-room') {
      this._renderMultiplayerRoomView();
    }
  }

  _renderMainView() {
    const status = this.client.getStatus();
    const isOnline = status === 'connected';

    this.overlay.innerHTML = `
      <div class="lobby-card lobby-card-main">
        <header class="lobby-header">
          <div class="lobby-badge">MONOPOLY DIGITAL</div>
          <h1 class="lobby-logo">ModPoly</h1>
          <p class="lobby-subtitle">Game Papan Klasik & Multiplayer Modern</p>
        </header>

        <div class="lobby-body">
          <div class="lobby-mode-options">
            <button type="button" class="lobby-mode-card mode-local" id="btn-select-local">
              <div class="mode-icon-wrap">🏠</div>
              <div class="mode-info">
                <div class="mode-title-row">
                  <span class="mode-title">Main Lokal</span>
                  <span class="mode-tag tag-offline">1 PERANGKAT</span>
                </div>
                <p class="mode-desc">Bermain bersama di satu layar HP/Laptop secara bergantian (2–4 pemain).</p>
              </div>
              <div class="mode-arrow">➔</div>
            </button>

            <button type="button" class="lobby-mode-card mode-multiplayer" id="btn-select-multiplayer">
              <div class="mode-icon-wrap">🌐</div>
              <div class="mode-info">
                <div class="mode-title-row">
                  <span class="mode-title">Multiplayer Online</span>
                  <span class="mode-tag tag-online">ROOM</span>
                </div>
                <p class="mode-desc">Bermain online bersama teman dengan kode room privat.</p>
              </div>
              <div class="mode-arrow">➔</div>
            </button>
          </div>

          <div class="lobby-server-status ${isOnline ? 'online' : 'offline'}">
            <i class="status-dot"></i>
            <span>Status Server: <b>${escapeHtml(this._statusText())}</b></span>
          </div>
        </div>
      </div>
    `;

    this.overlay.querySelector('#btn-select-local')?.addEventListener('click', () => {
      this.setView('local');
    });

    this.overlay.querySelector('#btn-select-multiplayer')?.addEventListener('click', () => {
      this.client.connect();
      if (this.room) {
        this.setView('multiplayer-room');
      } else {
        this.setView('multiplayer-menu');
      }
    });
  }

  _renderLocalSetupView() {
    const defaultColors = [
      { name: 'Merah', hex: '#ef4444' },
      { name: 'Biru', hex: '#3b82f6' },
      { name: 'Hijau', hex: '#22c55e' },
      { name: 'Kuning', hex: '#facc15' }
    ];
    const MAX_TOTAL = 4;
    this.localBotCount = Math.max(0, Math.min(this.localBotCount, MAX_TOTAL - this.localPlayerCount));
    const humans = this.localPlayerCount;
    const bots = this.localBotCount;
    const total = humans + bots;
    const canAddBot = total < MAX_TOTAL;
    const canStart = total >= 2;

    let playerInputsHtml = '';
    for (let i = 0; i < humans; i++) {
      const color = defaultColors[i];
      const val = this.localPlayerNames[i] || `Pemain ${i + 1}`;
      playerInputsHtml += `
        <div class="local-player-row">
          <span class="local-color-swatch" style="background:${color.hex};" title="Warna ${color.name}"></span>
          <label class="local-player-label">
            <span class="local-player-role">Pemain ${i + 1} (${color.name})</span>
            <input type="text" class="local-player-input" data-index="${i}" maxlength="18" value="${escapeHtml(val)}" placeholder="Masukkan nama pemain ${i + 1}" />
          </label>
        </div>
      `;
    }
    for (let b = 0; b < bots; b++) {
      const color = defaultColors[humans + b];
      playerInputsHtml += `
        <div class="local-player-row local-bot-row">
          <span class="local-color-swatch" style="background:${color.hex};" title="Warna ${color.name}"></span>
          <div class="local-player-label">
            <span class="local-player-role">Bot ${b + 1}</span>
            <span class="local-bot-name">🤖 Bot ${b + 1}</span>
          </div>
          <button type="button" class="btn-remove-bot" data-bot="${b}" aria-label="Hapus Bot ${b + 1}">✕</button>
        </div>
      `;
    }

    this.overlay.innerHTML = `
      <div class="lobby-card lobby-card-local">
        <header class="lobby-header-sub">
          <button type="button" class="btn-lobby-back" id="btn-back-to-main" aria-label="Kembali ke menu utama">← Kembali</button>
          <div class="header-sub-text">
            <h2>Mode Lokal</h2>
            <p>Atur jumlah & nama pemain di perangkat ini</p>
          </div>
        </header>

        <div class="lobby-body">
          <div class="local-count-section">
            <label class="section-title">Jumlah Pemain (manusia)</label>
            <div class="local-count-chips">
              ${[1, 2, 3, 4].map(num => `
                <button type="button" class="btn-count-chip ${this.localPlayerCount === num ? 'active' : ''}" data-count="${num}">
                  ${num} Pemain
                </button>
              `).join('')}
            </div>
          </div>

          <div class="local-roster-section">
            <label class="section-title">Daftar Pemain (${total}/${MAX_TOTAL})</label>
            <div class="local-roster-list">
              ${playerInputsHtml}
            </div>
            <button type="button" id="btn-add-bot" class="btn-add-bot" ${canAddBot ? '' : 'disabled'}>
              ➕ Tambah Bot
            </button>
            <div class="local-bot-hint">
              ${canAddBot ? 'Bot bermain otomatis: beli properti jika uangnya cukup, bayar denda penjara, dan memilih tempat parkir bebas.'
                : 'Sudah 4 pemain. Kurangi jumlah pemain manusia untuk menambah bot.'}
            </div>
          </div>

          <div class="lobby-info-tip">
            <span class="tip-icon">🎲</span>
            <span>Urutan giliran pemain akan <b>diacak otomatis</b> saat permainan dimulai!</span>
          </div>

          ${canStart ? '' : '<div class="lobby-info-tip"><span class="tip-icon">🤖</span><span>Main sendiri? Tambahkan minimal <b>1 bot</b> sebagai lawan.</span></div>'}

          <div class="lobby-actions-row">
            <button type="button" id="btn-start-local" class="btn-primary-action btn-lobby-big" ${canStart ? '' : 'disabled'}>
              Mulai Permainan ➔
            </button>
          </div>
        </div>
      </div>
    `;

    this.overlay.querySelector('#btn-back-to-main')?.addEventListener('click', () => {
      this.setView('main');
    });

    this.overlay.querySelectorAll('.btn-count-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        this.localPlayerCount = Number(btn.dataset.count);
        this._render();
      });
    });

    this.overlay.querySelector('#btn-add-bot')?.addEventListener('click', () => {
      if (this.localPlayerCount + this.localBotCount < MAX_TOTAL) this.localBotCount++;
      this._render();
    });

    this.overlay.querySelectorAll('.btn-remove-bot').forEach(btn => {
      btn.addEventListener('click', () => {
        this.localBotCount = Math.max(0, this.localBotCount - 1);
        this._render();
      });
    });

    this.overlay.querySelectorAll('.local-player-input').forEach(input => {
      input.addEventListener('input', e => {
        const idx = Number(e.target.dataset.index);
        this.localPlayerNames[idx] = e.target.value;
      });
    });

    this.overlay.querySelector('#btn-start-local')?.addEventListener('click', () => {
      if (this.localPlayerCount + this.localBotCount < 2) return;
      requestGameDisplayMode();
      const names = [];
      const botFlags = [];
      for (let i = 0; i < this.localPlayerCount; i++) {
        names.push(this.localPlayerNames[i] || `Pemain ${i + 1}`);
        botFlags.push(false);
      }
      for (let b = 0; b < this.localBotCount; b++) {
        names.push(`🤖 Bot ${b + 1}`);
        botFlags.push(true);
      }
      try {
        startLocalGame({ playerCount: names.length, playerNames: names, botFlags });
      } catch (err) {
        console.error('[LobbyManager] startLocalGame gagal:', err);
      }
      this.close();
      if (typeof document !== 'undefined') {
        document.body.classList.add('mode-local');
        document.body.classList.remove('mode-multiplayer');
      }
    });
  }

  _renderMultiplayerMenuView() {
    const status = this.client.getStatus();
    const isOnline = status === 'connected';
    const canAct = isOnline && !this.pending;

    this.overlay.innerHTML = `
      <div class="lobby-card lobby-card-mp">
        <header class="lobby-header-sub">
          <button type="button" class="btn-lobby-back" id="btn-back-to-main" aria-label="Kembali ke menu utama">← Kembali</button>
          <div class="header-sub-text">
            <h2>Multiplayer Online</h2>
            <p>Main bersama teman via private room</p>
          </div>
        </header>

        <div class="lobby-body">
          <div class="room-connection ${isOnline ? 'online' : 'offline'}">
            <i class="status-dot"></i>
            <span>${escapeHtml(this._statusText())}</span>
            ${!isOnline && this.client.url ? '<button id="room-reconnect" class="btn-secondary-action" type="button">Sambungkan</button>' : ''}
          </div>

          ${this.errorMessage ? `<div class="room-error">${escapeHtml(this.errorMessage)}</div>` : ''}

          <div class="mp-mode-tabs">
            <button type="button" class="btn-mp-tab ${this.multiplayerTab === 'create' ? 'active' : ''}" id="tab-create">
              ✨ Buat Room
            </button>
            <button type="button" class="btn-mp-tab ${this.multiplayerTab === 'join' ? 'active' : ''}" id="tab-join">
              🔗 Gabung Room
            </button>
          </div>

          <div class="mp-tab-content">
            <label class="room-field">Nama Pemain
              <input id="room-player-name" maxlength="24" autocomplete="nickname" value="${escapeHtml(this.playerName)}" placeholder="Masukkan nama Anda..." />
            </label>

            ${this.multiplayerTab === 'create' ? `
              <p class="mp-tab-desc">Sebagai Host, Anda akan mendapatkan kode room untuk dibagikan ke teman-teman.</p>
              <button id="room-create" class="btn-primary-action btn-lobby-big" type="button" ${canAct ? '' : 'disabled'}>
                Buat Room Sekarang
              </button>
            ` : `
              <label class="room-field">Kode Room
                <input id="room-code-input" maxlength="6" autocomplete="off" autocapitalize="characters" value="${escapeHtml(this.joinRoomCode)}" placeholder="CONTOH: 7KDMQW" />
              </label>
              <button id="room-join" class="btn-primary-action btn-lobby-big" type="button" ${canAct ? '' : 'disabled'}>
                Gabung ke Room
              </button>
            `}
          </div>

          <div class="lobby-info-tip">
            <span class="tip-icon">ℹ️</span>
            <span>Room mendukung 2–4 pemain. Giliran pemain akan diacak otomatis saat Host memulai game.</span>
          </div>
        </div>
      </div>
    `;

    this.overlay.querySelector('#btn-back-to-main')?.addEventListener('click', () => {
      this.setView('main');
    });

    this.overlay.querySelector('#tab-create')?.addEventListener('click', () => {
      this.multiplayerTab = 'create';
      this.errorMessage = '';
      this._render();
    });

    this.overlay.querySelector('#tab-join')?.addEventListener('click', () => {
      this.multiplayerTab = 'join';
      this.errorMessage = '';
      this._render();
    });

    this.overlay.querySelector('#room-reconnect')?.addEventListener('click', () => {
      this.client.connect();
    });

    const inputName = this.overlay.querySelector('#room-player-name');
    inputName?.addEventListener('input', e => {
      this.playerName = e.target.value;
      writeStored('monopoly.lastPlayerName', this.playerName);
    });

    const inputCode = this.overlay.querySelector('#room-code-input');
    inputCode?.addEventListener('input', e => {
      this.joinRoomCode = e.target.value.toUpperCase();
    });

    this.overlay.querySelector('#room-create')?.addEventListener('click', () => this._createRoom());
    this.overlay.querySelector('#room-join')?.addEventListener('click', () => this._joinRoom());
  }

  _renderMultiplayerRoomView() {
    const room = this.room;
    if (!room) {
      this.setView('multiplayer-menu');
      return;
    }

    const status = this.client.getStatus();
    const isOnline = status === 'connected';
    const canAct = isOnline && !this.pending;

    const isHost = room.hostPlayerId === this.playerId;
    const self = room.players.find(player => player.playerId === this.playerId);
    const allReady = room.players.every(player => player.isReady);
    const enoughPlayers = room.players.length >= room.minPlayers;
    const canStart = isHost && room.status === 'waiting' && enoughPlayers && allReady;

    const playerColors = ['#ef4444', '#3b82f6', '#22c55e', '#facc15'];

    const playersHtml = room.players.map((player, idx) => {
      const color = playerColors[idx % playerColors.length];
      const isSelf = player.playerId === this.playerId;
      const isRoomHost = player.playerId === room.hostPlayerId;
      const isBot = player.isBot === true;
      const readyClass = isBot ? 'ready' : player.isConnected === false ? 'offline' : player.isReady ? 'ready' : 'not-ready';
      const readyLabel = isBot ? 'Bot' : player.isConnected === false ? 'Terputus' : player.isReady ? 'Ready' : 'Belum Ready';

      return `
        <li class="room-roster-item ${isSelf ? 'is-self' : ''}">
          <div class="roster-left">
            <span class="roster-avatar-dot" style="background:${color};"></span>
            <div class="roster-name-wrap">
              <span class="roster-player-name">${escapeHtml(player.playerName)}</span>
              <div class="roster-badge-group">
                ${isRoomHost ? '<span class="badge-host">👑 HOST</span>' : ''}
                ${isSelf ? '<span class="badge-self">👤 ANDA</span>' : ''}
                ${isBot ? '<span class="badge-bot">🤖 BOT</span>' : ''}
              </div>
            </div>
          </div>
          <span class="roster-ready-pill ${readyClass}">
            ${readyLabel}
          </span>
          ${isBot && isHost && room.status === 'waiting' ? `<button type="button" class="btn-remove-bot" data-bot-id="${escapeHtml(player.playerId)}" aria-label="Hapus bot" ${canAct ? '' : 'disabled'}>✕</button>` : ''}
        </li>
      `;
    }).join('');

    this.overlay.innerHTML = `
      <div class="lobby-card lobby-card-room-full">
        <header class="room-full-header">
          <div class="room-status-badge ${room.status === 'started' ? 'started' : 'waiting'}">
            ${room.status === 'started' ? '🎮 PERMAINAN DIMULAI' : '🟢 MENUNGGU PEMAIN'}
          </div>
          <div class="room-player-count">
            Pemain: <b>${room.players.length} / ${room.maxPlayers}</b>
          </div>
        </header>

        <div class="lobby-body">
          <div class="room-code-panel">
            <span class="code-panel-label">KODE ROOM PRIVATE</span>
            <div class="code-panel-number">${escapeHtml(room.roomCode)}</div>
            <button type="button" id="room-copy-code" class="btn-copy-code">
              📋 Salin Kode
            </button>
          </div>

          ${this.errorMessage ? `<div class="room-error">${escapeHtml(this.errorMessage)}</div>` : ''}

          <div class="room-roster-box">
            <div class="roster-heading">Daftar Pemain (${room.players.length}/${room.maxPlayers})</div>
            <ul class="room-roster-list">
              ${playersHtml}
            </ul>
          </div>

          ${room.status === 'started' ? `
            <div class="lobby-info-tip ready-tip">
              <span class="tip-icon">🎮</span>
              <span>Permainan masih berlangsung. Pilih <b>Rejoin Game</b> untuk kembali ke papan dan melanjutkan sesi Anda.</span>
            </div>
          ` : room.status === 'waiting' && !enoughPlayers ? `
            <div class="lobby-info-tip">
              <span class="tip-icon">⏳</span>
              <span>Menunggu minimal <b>2 pemain</b> untuk dapat memulai game. Main sendiri? Host bisa menekan <b>Tambah Bot</b>.</span>
            </div>
          ` : room.status === 'waiting' && !allReady ? `
            <div class="lobby-info-tip">
              <span class="tip-icon">⚡</span>
              <span>Menunggu semua pemain menekan tombol <b>Ready</b>.</span>
            </div>
          ` : `
            <div class="lobby-info-tip ready-tip">
              <span class="tip-icon">🎲</span>
              <span>Semua pemain siap! Giliran pertama akan diacak saat Host menekan Mulai.</span>
            </div>
          `}

          <div class="room-actions-bar">
            ${room.status === 'waiting' ? `
              <button id="room-toggle-ready" class="btn-primary-action btn-ready ${self?.isReady ? 'is-ready' : ''}" type="button" ${canAct ? '' : 'disabled'}>
                ${self?.isReady ? '⏳ Batal Ready' : '✅ Saya Ready'}
              </button>
            ` : ''}

            ${isHost && room.status === 'waiting' ? `
              <button id="room-add-bot" class="btn-add-bot" type="button" ${canAct && room.players.length < room.maxPlayers ? '' : 'disabled'}>
                ➕ Tambah Bot
              </button>
            ` : ''}

            ${isHost && room.status === 'waiting' ? `
              <button id="room-start" class="btn-primary-action btn-start-game" type="button" ${canAct && canStart ? '' : 'disabled'}>
                🚀 Mulai Game
              </button>
            ` : ''}

            ${room.status === 'started' ? `
              <button id="room-rejoin-game" class="btn-primary-action btn-start-game" type="button">
                🎮 ${this.rejoinAvailable ? 'Rejoin Game' : 'Sambungkan & Rejoin Game'}
              </button>
            ` : ''}
            ${room.status === 'started' && !this.rejoinAvailable && this.errorMessage ? `
              <button id="room-retry-snapshot" class="btn-primary-action" type="button" ${canAct ? '' : 'disabled'}>
                Coba Sinkronkan Ulang
              </button>
            ` : ''}

            <button id="room-leave" class="btn-secondary-action btn-leave" type="button" ${this.pending ? 'disabled' : ''}>
              ${room.status === 'started' ? 'Putus Sementara' : '🚪 Keluar Room'}
            </button>
          </div>
        </div>
      </div>
    `;

    this.overlay.querySelector('#room-copy-code')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(room.roomCode);
        this.errorMessage = '✓ Kode room berhasil disalin!';
      } catch {
        this.errorMessage = `Kode room: ${room.roomCode}`;
      }
      this._render();
    });

    this.overlay.querySelector('#room-toggle-ready')?.addEventListener('click', () => {
      if (!self?.isReady) requestGameDisplayMode();
      this._request(self?.isReady ? 'room:not-ready' : 'room:ready');
    });

    this.overlay.querySelector('#room-add-bot')?.addEventListener('click', () => {
      this._request('room:add-bot');
    });
    this.overlay.querySelectorAll('.btn-remove-bot').forEach(btn => {
      btn.addEventListener('click', () => this._request('room:remove-bot', {playerId: btn.dataset.botId}));
    });

    this.overlay.querySelector('#room-start')?.addEventListener('click', () => {
      requestGameDisplayMode();
      this._request('room:start');
    });

    this.overlay.querySelector('#room-rejoin-game')?.addEventListener('click', () => {
      requestGameDisplayMode();
      if (!this.rejoinAvailable && this.sessionToken) this.rejoinAfterResume = true;
      if (!this.client.isConnected()) {
        this.client.connect();
        return;
      }
      if (!this.rejoinAvailable && this.sessionToken) {
        this._resumeSession();
        return;
      }
      this.close();
    });
    this.overlay.querySelector('#room-retry-snapshot')?.addEventListener('click', () => this._resumeSession());

    this.overlay.querySelector('#room-leave')?.addEventListener('click', () => {
      this._leaveRoom();
    });
  }

  async _request(eventName, payload = {}) {
    if (this.pending) return;
    this.pending = true;
    this.errorMessage = '';
    this._render();
    try {
      const response = await this.client.request(eventName, payload);
      if (!response.ok) {
        this.errorMessage = response.error?.message || 'Permintaan gagal.';
        return;
      }
      if (response.room) {
        this.room = response.room;
        if (response.playerId) this.playerId = response.playerId;
        if (response.sessionToken) this._saveSession(response.sessionToken, response.room.roomCode);
        if (response.room.status === 'started') {
          this.close();
        } else {
          this.currentView = 'multiplayer-room';
        }
      }
    } catch (error) {
      this.errorMessage = error.message || 'Permintaan gagal.';
    } finally {
      this.pending = false;
      if (this.isOpen) this._render();
    }
  }

  async _createRoom() {
    const input = this.overlay.querySelector('#room-player-name');
    const playerName = (input?.value || this.playerName || '').trim();
    if (!playerName) {
      this.errorMessage = 'Silakan masukkan nama pemain terlebih dahulu.';
      this._render();
      return;
    }
    this.playerName = playerName;
    writeStored('monopoly.lastPlayerName', playerName);
    await this._request('room:create', {playerName});
  }

  async _joinRoom() {
    const inputName = this.overlay.querySelector('#room-player-name');
    const inputCode = this.overlay.querySelector('#room-code-input');
    const playerName = (inputName?.value || this.playerName || '').trim();
    const roomCode = (inputCode?.value || this.joinRoomCode || '').trim().toUpperCase();

    if (!playerName) {
      this.errorMessage = 'Silakan masukkan nama pemain terlebih dahulu.';
      this._render();
      return;
    }
    if (!roomCode) {
      this.errorMessage = 'Silakan masukkan 6 digit kode room.';
      this._render();
      return;
    }

    this.playerName = playerName;
    this.joinRoomCode = roomCode;
    writeStored('monopoly.lastPlayerName', playerName);
    await this._request('room:join', {playerName, roomCode});
  }

  async _leaveRoom() {
    if (this.pending) return;
    this.pending = true;
    try {
      const response = await this.client.request('room:leave');
      if (!response.ok) {
        this.errorMessage = response.error?.message || 'Gagal keluar dari room.';
        return;
      }
      if (response.retained) {
        this.room = response.room;
        this.rejoinAvailable = false;
        this.errorMessage = '';
        this.currentView = 'multiplayer-room';
        return;
      }
      this.room = null;
      this.playerId = null;
      this.rejoinAvailable = false;
      this._clearStoredSession();
      this.errorMessage = '';
      this.setView('multiplayer-menu');
    } finally {
      this.pending = false;
      if (this.isOpen) this._render();
    }
  }
}

let lobbyManager;
export function initLobby() {
  if (lobbyManager) return lobbyManager;
  lobbyManager = new LobbyManager();
  return lobbyManager;
}
