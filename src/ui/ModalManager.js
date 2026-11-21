import {clientGameStore} from '../state/ClientGameStore.js';
import {propertyManager} from '../logic/PropertyManager.js';
import {tradeModalManager} from './TradeModalManager.js';
import {COL} from '../config.js';
import {toast, buildHud} from './hud.js';
import {createActionGuard} from '../logic/ActionGuard.js';
import {socketClient} from '../network/SocketClient.js';
import {canShowPlayerActionMenu} from './multiplayerTurnControls.js';

const newBuildingActionId = () => globalThis.crypto?.randomUUID?.() || `building-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export class ModalManager {
  constructor() {
    this.overlay = null;
    this.modal = null;
    this.activeTab = 'properties';
    this.multiplayerContext = null;
    this.multiplayerSessionObserved = false;
    this.initDOM();
    clientGameStore.subscribe(({change}) => {
      if (!['property-finance-resolved', 'building-resolved'].includes(change.type)) return;
      buildHud();
      if (this.isOpen()) this.renderCurrentTab();
    });
  }

  setMultiplayerContext(context) { this.multiplayerContext = context; }

  getPropertyOwnerId(player) {
    const room = this.multiplayerContext?.getActiveRoom?.();
    return room?.status === 'started' ? player.playerId : player.id;
  }

  getMortgageActionStatus(player) {
    const room = this.multiplayerContext?.getActiveRoom?.();
    if (room?.status === 'started') this.multiplayerSessionObserved = true;
    if (room?.status !== 'started') return this.multiplayerSessionObserved
      ? {online: true, allowed: false}
      : {online: false, allowed: true};
    if (!player) return {online: true, allowed: false};
    const localPlayerId = this.multiplayerContext?.getLocalPlayerId?.();
    const state = clientGameStore.getState();
    return {online: true, allowed: localPlayerId === player.playerId &&
      state.activePlayerId === player.playerId && ['WAITING_ROLL', 'PLAYER_ACTION'].includes(state.phase)};
  }

  getBuildingActionStatus(player) {
    const room = this.multiplayerContext?.getActiveRoom?.();
    if (room?.status !== 'started') return {online: false, allowed: true};
    const state = clientGameStore.getState();
    const allowed = player?.playerId === this.multiplayerContext?.getLocalPlayerId?.() &&
      state.activePlayerId === player.playerId && state.gameStatus === 'IN_GAME' &&
      ['WAITING_ROLL', 'PLAYER_ACTION'].includes(state.phase);
    return {online: true, allowed};
  }

  async sendBuildingAction(action, propertyPos) {
    const state = clientGameStore.getState();
    const response = await socketClient.request('game:building-action', {
      turnId: state.turnId, actionId: newBuildingActionId(), action, propertyPos
    });
    if (!response?.ok) {
      toast(`⚠️ ${response?.error?.message || 'Aksi bangunan gagal.'}`);
      return false;
    }
    toast(`🏗️ ${response.result.message}`);
    return true;
  }

  createPropertyActionResolutionId() {
    return globalThis.crypto?.randomUUID?.() || `property-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  initDOM() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('action-modal-overlay')) {
      this.overlay = document.getElementById('action-modal-overlay');
      this.modal = this.overlay.querySelector('#action-modal');
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'action-modal-overlay';
    overlay.className = 'modal-overlay hidden';

    overlay.innerHTML = `
      <div id="action-modal" class="modal-card">
        <div class="modal-header">
          <div class="modal-player-info">
            <span class="player-color-dot" id="modal-player-dot"></span>
            <div>
              <h3 id="modal-player-name">Pemain 1</h3>
              <p id="modal-player-meta">Saldo: <b id="modal-player-money">$1.500</b> • <span id="modal-player-props">0 Properti</span></p>
            </div>
          </div>
          <button id="modal-close-btn" class="modal-btn-close" title="Tutup">✕</button>
        </div>

        <div class="modal-body">
          <!-- Sidebar Navigasi Menu Tindakan -->
          <div class="modal-nav">
            <button class="nav-btn active" data-tab="properties">
              <span class="nav-icon">🏠</span> Properti Saya
            </button>
            <button class="nav-btn" data-tab="build">
              <span class="nav-icon">🏗️</span> Bangun Rumah / Hotel
            </button>
            <button class="nav-btn" data-tab="sell_build">
              <span class="nav-icon">🔨</span> Jual Bangunan
            </button>
            <button class="nav-btn" data-tab="mortgage">
              <span class="nav-icon">📄</span> Gadai Properti
            </button>
            <button class="nav-btn" data-tab="unmortgage">
              <span class="nav-icon">💵</span> Tebus Gadai
            </button>
            <button class="nav-btn" data-tab="trade">
              <span class="nav-icon">🤝</span> Tukar / Barter
            </button>
            <div class="nav-spacer"></div>
            <button id="modal-nav-close" class="nav-btn nav-close-btn">
              <span class="nav-icon">🚪</span> Tutup
            </button>
          </div>

          <!-- Konten Tab -->
          <div class="modal-content" id="modal-tab-content">
            <!-- Konten dinamis di-render via JavaScript -->
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.modal = overlay.querySelector('#action-modal');

    // Event listener penutup modal
    overlay.querySelector('#modal-close-btn').onclick = () => this.close();
    overlay.querySelector('#modal-nav-close').onclick = () => this.close();
    overlay.onclick = (e) => {
      if (e.target === overlay) this.close();
    };

    // Navigasi Tab
    const navButtons = overlay.querySelectorAll('.nav-btn[data-tab]');
    navButtons.forEach(btn => {
      btn.onclick = () => {
        if (btn.classList.contains('disabled')) return;
        const tab = btn.getAttribute('data-tab');
        if (tab === 'trade') {
          this.close();
          setTimeout(() => tradeModalManager.open(), 220);
          return;
        }
        this.switchTab(tab);
      };
    });

    // ESC key untuk tutup modal
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) {
        this.close();
      }
    });
  }

  isOpen() {
    return this.overlay && !this.overlay.classList.contains('hidden');
  }

  switchTab(tabName) {
    this.activeTab = tabName;
    if (!this.overlay) return;

    const navButtons = this.overlay.querySelectorAll('.nav-btn[data-tab]');
    navButtons.forEach(btn => {
      if (btn.getAttribute('data-tab') === tabName) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    this.renderCurrentTab();
  }

  open() {
    this.initDOM();
    const player = clientGameStore.getActivePlayer();
    if (!player || player.status === 'BANKRUPT') return;
    const room = this.multiplayerContext?.getActiveRoom?.();
    if (room?.status === 'started' && !canShowPlayerActionMenu({
      state: clientGameStore.getState(), store: clientGameStore, room,
      localPlayerId: this.multiplayerContext?.getLocalPlayerId?.(),
      connected: socketClient.isConnected()
    })) return;

    this.renderCurrentTab();

    // Tampilkan overlay dengan animasi halus
    this.overlay.classList.remove('hidden');
    requestAnimationFrame(() => {
      this.overlay.classList.add('visible');
      this.modal.classList.add('visible');
    });

    window.dispatchEvent(new CustomEvent('modal:opened', { detail: { player } }));
  }

  close() {
    if (!this.isOpen()) return;

    this.overlay.classList.remove('visible');
    this.modal.classList.remove('visible');

    setTimeout(() => {
      this.overlay.classList.add('hidden');
      window.dispatchEvent(new CustomEvent('modal:closed'));
    }, 200);
  }

  renderCurrentTab() {
    const player = clientGameStore.getActivePlayer();
    if (!player) return;

    // Update header info pemain aktif
    const dot = document.getElementById('modal-player-dot');
    const nameEl = document.getElementById('modal-player-name');
    const moneyEl = document.getElementById('modal-player-money');
    const propsEl = document.getElementById('modal-player-props');

    if (dot) dot.style.backgroundColor = player.color;
    if (nameEl) nameEl.textContent = `${player.name} (${player.cn})`;
    if (moneyEl) moneyEl.textContent = `$${player.money.toLocaleString('id-ID')}`;

    const playerProps = propertyManager.getPlayerProperties(this.getPropertyOwnerId(player));
    if (propsEl) propsEl.textContent = `${playerProps.length} Properti`;

    if (this.activeTab === 'properties') {
      this.renderProperties(player, playerProps);
    } else if (this.activeTab === 'build') {
      this.renderBuildTab(player);
    } else if (this.activeTab === 'sell_build') {
      this.renderSellBuildTab(player);
    } else if (this.activeTab === 'mortgage') {
      this.renderMortgageTab(player);
    } else if (this.activeTab === 'unmortgage') {
      this.renderUnmortgageTab(player);
    }
  }

  // ─── TAB 1: DAFTAR PROPERTI SAYA ───────────────────────────────────────────
  renderProperties(player, properties) {
    const content = document.getElementById('modal-tab-content');
    if (!content) return;

    if (properties.length === 0) {
      content.innerHTML = `
        <div class="empty-props-state">
          <div class="empty-props-icon">🏙️</div>
          <h4>Belum Memiliki Properti</h4>
          <p>${player.name} belum membeli kota, stasiun, atau utilitas apapun.</p>
          <small>Tips: Mendaratlah di petak yang belum bertuan untuk membelinya dari Bank!</small>
        </div>
      `;
      return;
    }

    content.innerHTML = `
      <div class="props-list-header">
        <h4>Daftar Kepemilikan (${properties.length})</h4>
        <span class="props-summary">Total Investasi Aset</span>
      </div>
      <div class="props-grid">
        ${properties.map(p => {
          const colorBar = COL[p.group] || (p.type === 'rail' ? '#334155' : '#0284c7');
          const typeLabel = p.type === 'prop' ? 'Kota' : (p.type === 'rail' ? 'Stasiun' : 'Utilitas');
          const statusGadai = p.isMortgaged ? '<span class="prop-badge mortgaged">Tergadai</span>' : '<span class="prop-badge normal">Aktif</span>';

          let rentInfo = '';
          if (p.type === 'prop') {
            rentInfo = p.hasHotel ? 'Sewa Hotel: $' + p.rent.hotel : (p.houses > 0 ? `Sewa (${p.houses} Rumah): $` + p.rent[`house${p.houses}`] : `Sewa Dasar: $${p.rent.base}`);
          } else if (p.type === 'rail') {
            rentInfo = `Sewa Dasar: $${p.rent.count1}`;
          } else {
            rentInfo = `Faktor: ${p.rent.factor1}x Dadu`;
          }

          let buildingBadge = '';
          if (p.hasHotel) buildingBadge = '<span class="buildings-pill">🏨 Hotel</span>';
          else if (p.houses > 0) buildingBadge = `<span class="buildings-pill">${p.houses}x 🏠</span>`;

          return `
            <div class="prop-card">
              <div class="prop-card-header" style="background:${colorBar}">
                <span>${typeLabel}</span>
                ${statusGadai}
              </div>
              <div class="prop-card-body">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <div class="prop-card-name">${p.name}</div>
                  ${buildingBadge}
                </div>
                <div class="prop-card-rent">${rentInfo}</div>
                <div class="prop-card-footer">
                  <small>Harga Beli: $${p.price}</small>
                  <small>Nilai Gadai: $${p.mortgageValue}</small>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // ─── TAB 2: BANGUN RUMAH / HOTEL ───────────────────────────────────────────
  renderBuildTab(player) {
    const content = document.getElementById('modal-tab-content');
    if (!content) return;

    const ownerId = this.getPropertyOwnerId(player);
    const actionStatus = this.getBuildingActionStatus(player);
    const cities = propertyManager.getPlayerProperties(ownerId).filter(p => p.type === 'prop');

    if (cities.length === 0) {
      content.innerHTML = `
        <div class="empty-props-state">
          <div class="empty-props-icon">🏗️</div>
          <h4>Belum Ada Kota yang Dapat Dibangun</h4>
          <p>${player.name} belum memiliki kota/tanah. Hanya petak kota yang dapat dibangun rumah dan hotel.</p>
        </div>
      `;
      return;
    }

    content.innerHTML = `
      <div class="props-list-header">
        <h4>Bangun Rumah & Hotel</h4>
        <span class="props-summary">Stok Bank: ${clientGameStore.getState().bankHouses ?? 32} Rumah • ${clientGameStore.getState().bankHotels ?? 12} Hotel</span>
      </div>
      ${!actionStatus.allowed ? '<small class="prop-status-note error">Aksi bangunan hanya tersedia bagi pemain aktif pada fase sebelum melempar dadu.</small>' : ''}
      <div class="props-grid">
        ${cities.map(p => {
          const colorBar = COL[p.group] || '#888';
          const chkHouse = propertyManager.canBuildHouse(p.pos);
          const chkHotel = propertyManager.canBuildHotel(p.pos);

          let bldgLabel = 'Tanah Kosong';
          if (p.hasHotel) bldgLabel = '🏨 Hotel Maksimal';
          else if (p.houses > 0) bldgLabel = `${p.houses}x 🏠 Rumah`;

          let statusReason = '';
          if (p.hasHotel) {
            statusReason = '<small class="prop-status-note">Sudah mencapai level bangunan tertinggi.</small>';
          } else if (p.houses === 4) {
            statusReason = chkHotel.canBuild ?
              '<small class="prop-status-note" style="color:#15803d">Siap upgrade ke Hotel!</small>' :
              `<small class="prop-status-note error">${chkHotel.reason}</small>`;
          } else {
            statusReason = chkHouse.canBuild ?
              '<small class="prop-status-note" style="color:#15803d">Siap bangun rumah!</small>' :
              `<small class="prop-status-note error">${chkHouse.reason}</small>`;
          }

          return `
            <div class="prop-card">
              <div class="prop-card-header" style="background:${colorBar}">
                <span>${p.group.toUpperCase()}</span>
                <span class="prop-badge normal">${bldgLabel}</span>
              </div>
              <div class="prop-card-body">
                <div class="prop-card-name">${p.name}</div>
                <div style="font-size:11.5px;color:#475569;margin-top:2px;">
                  Biaya Rumah: <b>$${p.housePrice}</b> • Hotel: <b>$${p.hotelPrice}</b>
                </div>
                ${statusReason}
                <div class="prop-action-row">
                  ${p.houses < 4 && !p.hasHotel ? `
                    <button class="btn-prop-action build-house" ${chkHouse.canBuild && actionStatus.allowed ? '' : 'disabled'} data-pos="${p.pos}">
                      🏠 Bangun Rumah ($${p.housePrice})
                    </button>
                  ` : ''}
                  ${p.houses === 4 && !p.hasHotel ? `
                    <button class="btn-prop-action build-hotel" ${chkHotel.canBuild && actionStatus.allowed ? '' : 'disabled'} data-pos="${p.pos}">
                      🏨 Bangun Hotel ($${p.hotelPrice})
                    </button>
                  ` : ''}
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Pasang handler tombol bangun
    content.querySelectorAll('.btn-prop-action.build-house').forEach(btn => {
      btn.onclick = createActionGuard(async () => {
        const pos = Number(btn.getAttribute('data-pos'));
        const status = this.getBuildingActionStatus(clientGameStore.getActivePlayer());
        if (!status.allowed) { toast('Hanya pemain aktif sebelum melempar dadu yang dapat mengelola bangunan.'); return false; }
        if (status.online) return this.sendBuildingAction('BUILD_HOUSE', pos);
        const res = propertyManager.buildHouse(pos);
        if (res.success) {
          toast(`🔨 ${res.message}`);
          buildHud();
          this.renderCurrentTab();
        } else {
          toast(`⚠️ ${res.reason || res.message}`);
        }
      });
    });

    content.querySelectorAll('.btn-prop-action.build-hotel').forEach(btn => {
      btn.onclick = createActionGuard(async () => {
        const pos = Number(btn.getAttribute('data-pos'));
        const status = this.getBuildingActionStatus(clientGameStore.getActivePlayer());
        if (!status.allowed) { toast('Hanya pemain aktif sebelum melempar dadu yang dapat mengelola bangunan.'); return false; }
        if (status.online) return this.sendBuildingAction('BUILD_HOTEL', pos);
        const res = propertyManager.buildHotel(pos);
        if (res.success) {
          toast(`🌟 ${res.message}`);
          buildHud();
          this.renderCurrentTab();
        } else {
          toast(`⚠️ ${res.reason || res.message}`);
        }
      });
    });
  }

  // ─── TAB 3: JUAL BANGUNAN ──────────────────────────────────────────────────
  renderSellBuildTab(player) {
    const content = document.getElementById('modal-tab-content');
    if (!content) return;

    const ownerId = this.getPropertyOwnerId(player);
    const actionStatus = this.getBuildingActionStatus(player);
    const sellable = propertyManager.getPlayerProperties(ownerId).filter(p => p.type === 'prop' && (p.houses > 0 || p.hasHotel));

    if (sellable.length === 0) {
      content.innerHTML = `
        <div class="empty-props-state">
          <div class="empty-props-icon">🔨</div>
          <h4>Belum Ada Bangunan untuk Dijual</h4>
          <p>${player.name} belum memiliki rumah atau hotel pada kota-kota yang dimiliki.</p>
        </div>
      `;
      return;
    }

    content.innerHTML = `
      <div class="props-list-header">
        <h4>Jual Bangunan Kembali ke Bank</h4>
        <span class="props-summary">Nilai Pengembalian: 50% Biaya Bangun</span>
      </div>
      ${!actionStatus.allowed ? '<small class="prop-status-note error">Aksi bangunan hanya tersedia bagi pemain aktif pada fase sebelum melempar dadu.</small>' : ''}
      <div class="props-grid">
        ${sellable.map(p => {
          const colorBar = COL[p.group] || '#888';
          let bldgLabel = p.hasHotel ? '🏨 1 Hotel' : `${p.houses}x 🏠 Rumah`;

          let sellBtn = '';
          if (p.hasHotel) {
            const chk = propertyManager.canSellHotel(p.pos);
            sellBtn = `
              <button class="btn-prop-action sell-action" ${chk.canSell && actionStatus.allowed ? '' : 'disabled'} data-pos="${p.pos}" data-type="hotel">
                Jual Hotel (+$${chk.refund})
              </button>
            `;
          } else {
            const chk = propertyManager.canSellHouse(p.pos);
            sellBtn = `
              <button class="btn-prop-action sell-action" ${chk.canSell && actionStatus.allowed ? '' : 'disabled'} data-pos="${p.pos}" data-type="house">
                Jual 1 Rumah (+$${chk.refund})
              </button>
            `;
          }

          return `
            <div class="prop-card">
              <div class="prop-card-header" style="background:${colorBar}">
                <span>${p.name}</span>
                <span class="prop-badge normal">${bldgLabel}</span>
              </div>
              <div class="prop-card-body">
                <div style="font-size:12px;color:#475569;">
                  Status Bangunan: <b>${bldgLabel}</b>
                </div>
                <div class="prop-action-row">
                  ${sellBtn}
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    content.querySelectorAll('.btn-prop-action.sell-action').forEach(btn => {
      btn.onclick = createActionGuard(async () => {
        const pos = Number(btn.getAttribute('data-pos'));
        const type = btn.getAttribute('data-type');
        const status = this.getBuildingActionStatus(clientGameStore.getActivePlayer());
        if (!status.allowed) { toast('Hanya pemain aktif sebelum melempar dadu yang dapat mengelola bangunan.'); return false; }
        if (status.online) return this.sendBuildingAction(type === 'hotel' ? 'SELL_HOTEL' : 'SELL_HOUSE', pos);
        const res = type === 'hotel' ? propertyManager.sellHotel(pos) : propertyManager.sellHouse(pos);
        if (res.success) {
          toast(`💰 ${res.message}`);
          buildHud();
          this.renderCurrentTab();
        } else {
          toast(`⚠️ ${res.reason || res.message}`);
        }
      });
    });
  }

  // ─── TAB 4: GADAI PROPERTI ─────────────────────────────────────────────────
  renderMortgageTab(player) {
    const content = document.getElementById('modal-tab-content');
    if (!content) return;

    const props = propertyManager.getPlayerProperties(this.getPropertyOwnerId(player));
    const actionStatus = this.getMortgageActionStatus(player);

    if (props.length === 0) {
      content.innerHTML = `
        <div class="empty-props-state">
          <div class="empty-props-icon">📄</div>
          <h4>Tidak Ada Properti</h4>
          <p>${player.name} belum memiliki aset yang dapat digadaikan.</p>
        </div>
      `;
      return;
    }

    content.innerHTML = `
      <div class="props-list-header">
        <h4>Gadaikan Properti ke Bank</h4>
        <span class="props-summary">Dapatkan uang tunai instan dari Bank</span>
      </div>
      <div class="props-grid">
        ${props.map(p => {
          const colorBar = COL[p.group] || (p.type === 'rail' ? '#334155' : '#0284c7');
          const chk = propertyManager.canMortgage(p.pos);

          return `
            <div class="prop-card">
              <div class="prop-card-header" style="background:${colorBar}">
                <span>${p.name}</span>
                ${p.isMortgaged ? '<span class="prop-badge mortgaged">Tergadai</span>' : '<span class="prop-badge normal">Siap Gadai</span>'}
              </div>
              <div class="prop-card-body">
                <div class="prop-card-name">${p.name}</div>
                <div style="font-size:12px;color:#15803d;font-weight:600;">
                  Pinjaman: +$${p.mortgageValue}
                </div>
                ${!actionStatus.allowed ? '<small class="prop-status-note error">Hanya pemain aktif sebelum melempar dadu yang dapat mengelola gadai.</small>' : ''}
                ${!chk.canMortgage && !p.isMortgaged ? `<small class="prop-status-note error">${chk.reason}</small>` : ''}
                <div class="prop-action-row">
                  <button class="btn-prop-action mortgage-action" ${chk.canMortgage && actionStatus.allowed ? '' : 'disabled'} data-pos="${p.pos}">
                    ${p.isMortgaged ? 'Sudah Digadaikan' : `Gadaikan (+$${p.mortgageValue})`}
                  </button>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    content.querySelectorAll('.btn-prop-action.mortgage-action').forEach(btn => {
      btn.onclick = createActionGuard(async () => {
        const pos = Number(btn.getAttribute('data-pos'));
        const actionStatus = this.getMortgageActionStatus(clientGameStore.getActivePlayer());
        if (!actionStatus.allowed) {
          toast('Hanya pemain aktif sebelum melempar dadu yang dapat mengelola gadai.');
          return false;
        }
        if (actionStatus.online) {
          const response = await socketClient.request('game:property-mortgage', {
            turnId: clientGameStore.getState().turnId, resolutionId: this.createPropertyActionResolutionId(), propertyPos: pos
          });
          if (!response.ok) {
            toast(`⚠️ ${response.error?.message || 'Gadai properti gagal.'}`);
            return false;
          }
          toast(`💵 ${response.result.message}`);
          return true;
        }
        const res = propertyManager.mortgageProperty(pos);
        if (res.success) {
          toast(`💵 ${res.message}`);
          buildHud();
          this.renderCurrentTab();
        } else {
          toast(`⚠️ ${res.reason || res.message}`);
        }
      });
    });
  }

  // ─── TAB 5: TEBUS GADAI ───────────────────────────────────────────────────
  renderUnmortgageTab(player) {
    const content = document.getElementById('modal-tab-content');
    if (!content) return;

    const mortgaged = propertyManager.getMortgagedProperties(this.getPropertyOwnerId(player));
    const actionStatus = this.getMortgageActionStatus(player);

    if (mortgaged.length === 0) {
      content.innerHTML = `
        <div class="empty-props-state">
          <div class="empty-props-icon">💵</div>
          <h4>Tidak Ada Properti yang Digadaikan</h4>
          <p>Seluruh properti ${player.name} saat ini berstatus aktif dan menghasilkan uang sewa.</p>
        </div>
      `;
      return;
    }

    content.innerHTML = `
      <div class="props-list-header">
        <h4>Tebus Hipotek Properti</h4>
        <span class="props-summary">Biaya: Pokok Gadai + Bunga 10%</span>
      </div>
      <div class="props-grid">
        ${mortgaged.map(p => {
          const colorBar = COL[p.group] || (p.type === 'rail' ? '#334155' : '#0284c7');
          const chk = propertyManager.canUnmortgage(p.pos);

          return `
            <div class="prop-card">
              <div class="prop-card-header" style="background:${colorBar}">
                <span>${p.name}</span>
                <span class="prop-badge mortgaged">Tergadai</span>
              </div>
              <div class="prop-card-body">
                <div class="prop-card-name">${p.name}</div>
                <div style="font-size:11.5px;color:#334155;margin:2px 0;">
                  Pokok: $${chk.mortgageValue} • Bunga 10%: $${chk.interest}
                </div>
                <div style="font-size:12.5px;font-weight:700;color:#0369a1;">
                  Total Tebus: $${chk.totalCost}
                </div>
                ${!actionStatus.allowed ? '<small class="prop-status-note error">Hanya pemain aktif sebelum melempar dadu yang dapat mengelola gadai.</small>' : ''}
                ${!chk.canUnmortgage ? `<small class="prop-status-note error">${chk.reason}</small>` : ''}
                <div class="prop-action-row">
                  <button class="btn-prop-action unmortgage-action" ${chk.canUnmortgage && actionStatus.allowed ? '' : 'disabled'} data-pos="${p.pos}">
                    Tebus Gadai (-$${chk.totalCost})
                  </button>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    content.querySelectorAll('.btn-prop-action.unmortgage-action').forEach(btn => {
      btn.onclick = createActionGuard(async () => {
        const pos = Number(btn.getAttribute('data-pos'));
        const actionStatus = this.getMortgageActionStatus(clientGameStore.getActivePlayer());
        if (!actionStatus.allowed) {
          toast('Hanya pemain aktif sebelum melempar dadu yang dapat mengelola gadai.');
          return false;
        }
        if (actionStatus.online) {
          const response = await socketClient.request('game:property-unmortgage', {
            turnId: clientGameStore.getState().turnId, resolutionId: this.createPropertyActionResolutionId(), propertyPos: pos
          });
          if (!response.ok) {
            toast(`⚠️ ${response.error?.message || 'Penebusan gadai gagal.'}`);
            return false;
          }
          toast(`🔓 ${response.result.message}`);
          return true;
        }
        const res = propertyManager.unmortgageProperty(pos);
        if (res.success) {
          toast(`🔓 ${res.message}`);
          buildHud();
          this.renderCurrentTab();
        } else {
          toast(`⚠️ ${res.reason || res.message}`);
        }
      });
    });
  }
}

export const modalManager = new ModalManager();
