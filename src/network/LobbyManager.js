import {socketClient} from './SocketClient.js';
import {startLocalGame} from '../logic/localGame.js';
import {requestGameDisplayMode} from '../ui/fullscreen.js';
import {confirmDialog, showHelp} from '../ui/dialog.js';
import {diceSvg, heroBoardSvg, pawnSvg} from '../ui/heroArt.js';

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
      this.errorMessage = 'Ruangan ditutup karena terlalu lama tidak aktif.';
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

    const btnHelp = document.getElementById('btn-help');
    if (btnHelp) btnHelp.onclick = () => showHelp();

    const btnHome = document.getElementById('btn-lobby-home');
    if (btnHome) {
      btnHome.onclick = async () => {
        const activeGame = this.room?.status === 'started';
        const confirmExit = await confirmDialog(activeGame
          ? {title: 'Keluar sementara?', icon: '🚪', message: 'Permainanmu tetap tersimpan. Kamu bisa kembali kapan saja lewat tombol "Lanjutkan Permainan".',
            confirmText: 'Keluar Sementara', cancelText: 'Tetap di sini'}
          : {title: 'Kembali ke menu utama?', icon: '🏠', message: 'Permainan yang sedang berjalan akan dihentikan.',
            confirmText: 'Ya, ke menu utama', cancelText: 'Lanjut main', tone: 'danger'});
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
    if (status === 'disconnected' && this.room) this.errorMessage = 'Koneksi terputus. Mencoba menyambungkan kembali…';
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
      ? 'Menyambungkan kembali ke ruangan…'
      : 'Koneksi terputus. Permainanmu tersimpan sementara.';
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
        this.errorMessage = response.error?.message || 'Belum bisa kembali ke ruangan. Coba lagi.';
        this.open('main');
        return false;
      }
      this.room = response.room;
      this.playerId = response.playerId;
      this._saveSession(response.sessionToken, response.room.roomCode);
      this.errorMessage = '';
      const snapshotApplied = this.onSessionRestored?.({roomCode: response.room.roomCode, snapshot: response.snapshot || null});
      if (response.room.status === 'started' && (!response.snapshot || snapshotApplied !== true)) {
        this.errorMessage = 'Sudah tersambung, tetapi permainan belum termuat sempurna. Coba muat ulang.';
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
      this.errorMessage = error?.message || 'Belum bisa kembali ke ruangan. Coba lagi.';
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
    if (status === 'connected') return 'Siap bermain online';
    if (status === 'connecting') return 'Menyiapkan mode online…';
    return this.client.url
      ? 'Belum tersambung'
      : 'Mode online belum tersedia';
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

  // Status koneksi online dalam bahasa awam (tanpa istilah teknis).
  _statusInfo() {
    if (!this.client.url) return {state: 'off', label: 'Belum tersedia', long: 'Mode online belum tersedia saat ini.'};
    const status = this.client.getStatus();
    if (status === 'connected') return {state: 'ready', label: 'Siap', long: 'Siap bermain online'};
    if (status === 'connecting') return {state: 'wait', label: 'Menyiapkan…', long: 'Menyiapkan mode online… biasanya hanya beberapa detik.'};
    return {state: 'off', label: 'Belum tersambung', long: 'Belum tersambung ke mode online.'};
  }

  _renderMainView() {
    const info = this._statusInfo();
    this.overlay.innerHTML = `
      <div class="home">
        <div class="home-deco" aria-hidden="true">
          <span class="deco deco-1">${diceSvg(3, 58)}</span>
          <span class="deco deco-2">${diceSvg(6, 42)}</span>
          <span class="deco deco-3">${pawnSvg('#3b82f6', '#1d4ed8', 38)}</span>
          <span class="deco deco-4">${pawnSvg('#22c55e', '#15803d', 34)}</span>
        </div>
        <div class="home-inner">
          <section class="home-hero">
            <h1 class="home-logo"><span class="logo-mod">Mod</span><span class="logo-poly">Poly</span></h1>
            <p class="home-tagline">Beli properti, tarik sewa, dan jadi juragan kota!</p>
            <div class="home-art">${heroBoardSvg()}</div>
          </section>
          <section class="home-actions" aria-label="Pilih cara bermain">
            <button type="button" id="btn-select-local" class="home-btn home-btn-offline">
              <span class="hb-icon" aria-hidden="true">🎲</span>
              <span class="hb-text"><b>Main Offline</b><small>Satu layar untuk 1–4 pemain. Bisa lawan bot!</small></span>
              <span class="hb-go" aria-hidden="true">▶</span>
            </button>
            <button type="button" id="btn-select-multiplayer" class="home-btn home-btn-online">
              <span class="hb-icon" aria-hidden="true">🌐</span>
              <span class="hb-text">
                <span class="hb-title"><b>Main Online</b><span class="hb-chip ${info.state}"><i></i>${escapeHtml(info.label)}</span></span>
                <small>Ajak teman lewat kode ruangan.</small>
              </span>
            </button>
            <button type="button" id="btn-home-help" class="home-link">📖 Cara Bermain</button>
          </section>
        </div>
      </div>
    `;
    this.overlay.querySelector('#btn-select-local')?.addEventListener('click', () => this.setView('local'));
    this.overlay.querySelector('#btn-select-multiplayer')?.addEventListener('click', () => this.setView('multiplayer-menu'));
    this.overlay.querySelector('#btn-home-help')?.addEventListener('click', () => showHelp());
  }

  _renderLocalSetupView() {
    const MAX_TOTAL = 4;
    this.localBotCount = Math.max(0, Math.min(this.localBotCount, MAX_TOTAL - this.localPlayerCount));
    const humans = this.localPlayerCount;
    const bots = this.localBotCount;
    const total = humans + bots;
    const canAddBot = total < MAX_TOTAL;
    const canStart = total >= 2;

    let rows = '';
    for (let i = 0; i < humans; i++) {
      const val = this.localPlayerNames[i] || `Pemain ${i + 1}`;
      rows += `
        <div class="pn-player">
          <span class="pn-dot pn-num" aria-hidden="true">${i + 1}</span>
          <label class="pn-player-main">
            <span class="pn-player-role">Pemain ${i + 1}</span>
            <input type="text" class="pn-input local-player-input" data-index="${i}" maxlength="18" value="${escapeHtml(val)}" placeholder="Nama pemain ${i + 1}" />
          </label>
        </div>`;
    }
    for (let b = 0; b < bots; b++) {
      rows += `
        <div class="pn-player pn-player-bot">
          <span class="pn-dot pn-num pn-num-bot" aria-hidden="true">🤖</span>
          <div class="pn-player-main">
            <span class="pn-player-role">Lawan komputer</span>
            <span class="pn-bot-name">🤖 Bot ${b + 1}</span>
          </div>
          <button type="button" class="btn-remove-bot" data-bot="${b}" aria-label="Hapus Bot ${b + 1}">✕</button>
        </div>`;
    }

    this.overlay.innerHTML = `
      <div class="pn pn-narrow">
        <header class="pn-head">
          <button type="button" class="pn-back" id="btn-back-to-main" aria-label="Kembali ke menu utama">← Kembali</button>
          <div class="pn-title"><h2>Main Offline</h2><p>Bergantian di satu layar, tanpa internet.</p></div>
        </header>
        <div class="pn-body">
          <div class="pn-section">
            <div class="pn-label">Berapa orang yang main?</div>
            <div class="pn-chip-row">
              ${[1, 2, 3, 4].map(num => `
                <button type="button" class="pn-chip btn-count-chip ${this.localPlayerCount === num ? 'active' : ''}" data-count="${num}">${num} orang</button>`).join('')}
            </div>
          </div>
          <div class="pn-section">
            <div class="pn-label">Daftar pemain <span class="pn-count">${total}/${MAX_TOTAL}</span></div>
            <div class="pn-roster">${rows}</div>
            <button type="button" id="btn-add-bot" class="pn-add-bot btn-add-bot" ${canAddBot ? '' : 'disabled'}>➕ Tambah Bot</button>
            <p class="pn-hint">${canAddBot
              ? 'Bot adalah lawan komputer. Ia membeli properti, membayar denda penjara, dan membangun rumah sendiri.'
              : 'Sudah 4 pemain. Kurangi jumlah orang untuk menambah bot.'}</p>
          </div>
          <div class="pn-note">🎲 Urutan giliran diacak otomatis saat permainan dimulai.</div>
          ${canStart ? '' : '<div class="pn-note pn-note-warn">🤖 Main sendirian? Tambahkan minimal 1 bot sebagai lawan.</div>'}
          <button type="button" id="btn-start-local" class="mp-btn mp-btn-green mp-btn-block" ${canStart ? '' : 'disabled'}>Mulai Main ▶</button>
        </div>
      </div>
    `;

    this.overlay.querySelector('#btn-back-to-main')?.addEventListener('click', () => this.setView('main'));
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
        this.localPlayerNames[Number(e.target.dataset.index)] = e.target.value;
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
        startLocalGame({playerCount: names.length, playerNames: names, botFlags});
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
    const info = this._statusInfo();
    const isOnline = this.client.getStatus() === 'connected';
    const canAct = isOnline && !this.pending;
    const create = this.multiplayerTab === 'create';
    this.overlay.innerHTML = `
      <div class="pn pn-narrow">
        <header class="pn-head">
          <button type="button" class="pn-back" id="btn-back-to-main" aria-label="Kembali ke menu utama">← Kembali</button>
          <div class="pn-title"><h2>Main Online</h2><p>Main bareng teman, di perangkat masing-masing.</p></div>
        </header>
        <div class="pn-body">
          <div class="pn-status ${info.state}">
            <i></i><span>${escapeHtml(info.long)}</span>
            ${!isOnline && this.client.url ? '<button id="room-reconnect" class="pn-mini-btn" type="button">Coba lagi</button>' : ''}
          </div>
          ${this.errorMessage ? `<div class="pn-error" role="alert">${escapeHtml(this.errorMessage)}</div>` : ''}
          <div class="pn-tabs" role="tablist">
            <button type="button" role="tab" class="pn-tab ${create ? 'active' : ''}" id="tab-create" aria-selected="${create}">✨ Buat Ruangan</button>
            <button type="button" role="tab" class="pn-tab ${create ? '' : 'active'}" id="tab-join" aria-selected="${!create}">🔗 Masuk Ruangan</button>
          </div>
          <label class="pn-field"><span>Nama kamu</span>
            <input class="pn-input" id="room-player-name" maxlength="24" autocomplete="nickname" value="${escapeHtml(this.playerName)}" placeholder="Tulis namamu di sini" />
          </label>
          ${create ? `
            <p class="pn-hint">Kamu akan mendapat kode 6 karakter. Bagikan kode itu ke teman agar mereka bisa ikut main.</p>
            <button id="room-create" class="mp-btn mp-btn-blue mp-btn-block" type="button" ${canAct ? '' : 'disabled'}>Buat Ruangan</button>
          ` : `
            <label class="pn-field"><span>Kode ruangan dari temanmu</span>
              <input class="pn-input pn-code-input" id="room-code-input" maxlength="6" autocomplete="off" autocapitalize="characters" value="${escapeHtml(this.joinRoomCode)}" placeholder="Contoh: 7KDMQW" />
            </label>
            <button id="room-join" class="mp-btn mp-btn-blue mp-btn-block" type="button" ${canAct ? '' : 'disabled'}>Masuk Ruangan</button>
          `}
          <div class="pn-note">👥 Satu ruangan untuk 2–4 pemain. Giliran diacak otomatis saat permainan dimulai.</div>
        </div>
      </div>
    `;
    this.overlay.querySelector('#btn-back-to-main')?.addEventListener('click', () => this.setView('main'));
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
    this.overlay.querySelector('#room-reconnect')?.addEventListener('click', () => this.client.connect());
    this.overlay.querySelector('#room-player-name')?.addEventListener('input', e => {
      this.playerName = e.target.value;
      writeStored('monopoly.lastPlayerName', this.playerName);
    });
    this.overlay.querySelector('#room-code-input')?.addEventListener('input', e => {
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
    const isOnline = this.client.getStatus() === 'connected';
    const canAct = isOnline && !this.pending;
    const isHost = room.hostPlayerId === this.playerId;
    const self = room.players.find(player => player.playerId === this.playerId);
    const allReady = room.players.every(player => player.isReady);
    const enoughPlayers = room.players.length >= room.minPlayers;
    const canStart = isHost && room.status === 'waiting' && enoughPlayers && allReady;
    const playersHtml = room.players.map((player, idx) => {
      const isSelf = player.playerId === this.playerId;
      const isRoomHost = player.playerId === room.hostPlayerId;
      const isBot = player.isBot === true;
      const pill = isBot ? ['ready', 'Bot'] : player.isConnected === false ? ['offline', 'Terputus']
        : player.isReady ? ['ready', 'Siap'] : ['not-ready', 'Belum siap'];
      return `
        <li class="pn-player ${isSelf ? 'is-self' : ''}">
          <span class="pn-dot pn-num${isBot ? ' pn-num-bot' : ''}" aria-hidden="true">${isBot ? '🤖' : idx + 1}</span>
          <div class="pn-player-main">
            <span class="pn-player-name">${escapeHtml(isBot ? player.playerName.replace(/^🤖\s*/, '') : player.playerName)}</span>
            <span class="pn-badges">
              ${isRoomHost ? '<span class="pn-badge host">👑 Pembuat</span>' : ''}
              ${isSelf ? '<span class="pn-badge self">Kamu</span>' : ''}
            </span>
          </div>
          <span class="pn-pill ${pill[0]}">${pill[1]}</span>
          ${isBot && isHost && room.status === 'waiting' ? `<button type="button" class="btn-remove-bot" data-bot-id="${escapeHtml(player.playerId)}" aria-label="Hapus bot" ${canAct ? '' : 'disabled'}>✕</button>` : ''}
        </li>`;
    }).join('');

    const started = room.status === 'started';
    const tip = started
      ? ['🎮', 'Permainan sedang berjalan. Tekan <b>Lanjutkan Permainan</b> untuk kembali ke papan.', 'good']
      : !enoughPlayers
        ? ['⏳', 'Butuh minimal <b>2 pemain</b>. Tunggu temanmu bergabung' + (isHost ? ', atau tekan <b>Tambah Bot</b>.' : '.'), '']
        : !allReady
          ? ['⚡', 'Menunggu semua pemain menekan <b>Siap</b>.', '']
          : isHost
            ? ['🎲', 'Semua pemain sudah siap! Tekan <b>Mulai Permainan</b>.', 'good']
            : ['🎲', 'Semua pemain sudah siap! Menunggu pembuat ruangan memulai permainan.', 'good'];
    const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

    this.overlay.innerHTML = `
      <div class="pn">
        <header class="pn-head pn-head-room">
          <div class="pn-room-state ${started ? 'started' : 'waiting'}">${started ? '🎮 Sedang bermain' : '🟢 Menunggu pemain'}</div>
          <div class="pn-room-count">Pemain <b>${room.players.length}/${room.maxPlayers}</b></div>
        </header>
        <div class="pn-body">
          <div class="pn-code">
            <span class="pn-code-label">Kode ruangan</span>
            <div class="pn-code-tiles" aria-label="Kode ruangan ${escapeHtml(room.roomCode)}">
              ${[...room.roomCode].map(ch => `<span class="code-tile">${escapeHtml(ch)}</span>`).join('')}
            </div>
            <div class="pn-code-actions">
              <button type="button" id="room-copy-code" class="mp-btn mp-btn-ghost mp-btn-sm">📋 Salin</button>
              ${canShare ? '<button type="button" id="room-share-code" class="mp-btn mp-btn-ghost mp-btn-sm">📤 Bagikan</button>' : ''}
            </div>
          </div>
          ${this.noticeMessage ? `<div class="pn-notice" role="status">${escapeHtml(this.noticeMessage)}</div>` : ''}
          ${this.errorMessage ? `<div class="pn-error" role="alert">${escapeHtml(this.errorMessage)}</div>` : ''}
          <div class="pn-section">
            <div class="pn-label">Pemain di ruangan</div>
            <ul class="pn-roster">${playersHtml}</ul>
          </div>
          <div class="pn-note ${tip[2] === 'good' ? 'pn-note-good' : ''}">${tip[0]} ${tip[1]}</div>
          <div class="pn-actions">
            ${room.status === 'waiting' ? `
              <button id="room-toggle-ready" class="mp-btn ${self?.isReady ? 'mp-btn-ghost' : 'mp-btn-green'} mp-btn-block" type="button" ${canAct ? '' : 'disabled'}>
                ${self?.isReady ? '↩ Batal Siap' : '✅ Saya Siap'}
              </button>` : ''}
            ${isHost && room.status === 'waiting' ? `
              <button id="room-add-bot" class="pn-add-bot btn-add-bot" type="button" ${canAct && room.players.length < room.maxPlayers ? '' : 'disabled'}>➕ Tambah Bot</button>
              <button id="room-start" class="mp-btn mp-btn-primary mp-btn-block" type="button" ${canAct && canStart ? '' : 'disabled'}>🚀 Mulai Permainan</button>` : ''}
            ${started ? `
              <button id="room-rejoin-game" class="mp-btn mp-btn-green mp-btn-block" type="button">
                🎮 Lanjutkan Permainan
              </button>` : ''}
            ${started && !this.rejoinAvailable && this.errorMessage ? `
              <button id="room-retry-snapshot" class="mp-btn mp-btn-ghost mp-btn-block" type="button" ${canAct ? '' : 'disabled'}>Coba muat ulang permainan</button>` : ''}
            <button id="room-leave" class="mp-btn mp-btn-danger-ghost mp-btn-block" type="button" ${this.pending ? 'disabled' : ''}>
              ${started ? 'Keluar Sementara' : '🚪 Keluar Ruangan'}
            </button>
          </div>
        </div>
      </div>
    `;
    this.overlay.querySelector('#room-copy-code')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(room.roomCode);
        this.noticeMessage = '✓ Kode ruangan disalin. Tinggal kirim ke temanmu!';
        this.errorMessage = '';
      } catch {
        this.noticeMessage = `Kode ruangan: ${room.roomCode}`;
      }
      this._render();
    });
    this.overlay.querySelector('#room-share-code')?.addEventListener('click', async () => {
      try {
        await navigator.share({
          title: 'ModPoly',
          text: `Ayo main ModPoly! Masukkan kode ruangan: ${room.roomCode}`,
          url: `${location.origin}${location.pathname}`
        });
      } catch { /* pemain menutup menu bagikan */ }
    });
    this.overlay.querySelector('#room-toggle-ready')?.addEventListener('click', () => {
      if (!self?.isReady) requestGameDisplayMode();
      this._request(self?.isReady ? 'room:not-ready' : 'room:ready');
    });
    this.overlay.querySelector('#room-add-bot')?.addEventListener('click', () => this._request('room:add-bot'));
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
    this.overlay.querySelector('#room-leave')?.addEventListener('click', () => this._leaveRoom());
  }

  async _request(eventName, payload = {}) {
    if (this.pending) return;
    this.pending = true;
    this.errorMessage = '';
    this.noticeMessage = '';
    this._render();
    try {
      const response = await this.client.request(eventName, payload);
      if (!response.ok) {
        this.errorMessage = response.error?.message || 'Terjadi kendala. Coba lagi.';
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
      this.errorMessage = error.message || 'Terjadi kendala. Coba lagi.';
    } finally {
      this.pending = false;
      if (this.isOpen) this._render();
    }
  }

  async _createRoom() {
    const input = this.overlay.querySelector('#room-player-name');
    const playerName = (input?.value || this.playerName || '').trim();
    if (!playerName) {
      this.errorMessage = 'Tulis namamu dulu ya.';
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
      this.errorMessage = 'Tulis namamu dulu ya.';
      this._render();
      return;
    }
    if (!roomCode) {
      this.errorMessage = 'Masukkan kode ruangan yang terdiri dari 6 huruf/angka.';
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
        this.errorMessage = response.error?.message || 'Belum bisa keluar dari ruangan. Coba lagi.';
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
