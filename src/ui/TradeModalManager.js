import {PlayerStatus} from '../logic/GameState.js';
import {clientGameStore} from '../state/ClientGameStore.js';
import {propertyManager} from '../logic/PropertyManager.js';
import {tradeManager} from '../logic/TradeManager.js';
import {COL} from '../config.js';
import {toast, buildHud} from './hud.js';
import {createActionGuard} from '../logic/ActionGuard.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const newActionId = () => globalThis.crypto?.randomUUID?.() || `trade-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export class TradeModalManager {
  constructor() {
    this.overlay = null;
    this.selectedPartnerId = null;
    this.multiplayerContext = null;
    this.authoritativeTradeId = null;
    this.closeTimer = null;
    this.initDOM();
  }

  initDOM() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('trade-modal-overlay')) {
      this.overlay = document.getElementById('trade-modal-overlay');
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'trade-modal-overlay';
    overlay.className = 'tile-modal-overlay hidden';

    // Klik backdrop untuk menutup modal
    overlay.onclick = (e) => {
      if (e.target === overlay) this.close();
    };

    // ESC key untuk menutup modal
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) {
        this.close();
      }
    });

    document.body.appendChild(overlay);
    this.overlay = overlay;
  }

  isOpen() {
    return this.overlay && !this.overlay.classList.contains('hidden');
  }

  setMultiplayerContext(context) { this.multiplayerContext = context; }

  _isMultiplayer() { return this.multiplayerContext?.getActiveRoom?.()?.status === 'started'; }

  _tradePlayerId(player) { return this._isMultiplayer() ? player?.playerId : player?.id; }

  _getPlayerProperties(player) {
    const ownerId = this._tradePlayerId(player);
    return this._isMultiplayer()
      ? clientGameStore.getProperties().filter(property => property.owner === ownerId)
      : propertyManager.getPlayerProperties(ownerId);
  }

  _getColorGroupProperties(group) {
    return this._isMultiplayer()
      ? clientGameStore.getProperties().filter(property => property.type === 'prop' && property.group === group)
      : propertyManager.getColorGroupProperties(group);
  }

  close() {
    if (!this.overlay) return;
    clearTimeout(this.closeTimer);
    this.overlay.classList.remove('visible');
    this.closeTimer = setTimeout(() => {
      this.overlay.classList.add('hidden');
      this.overlay.innerHTML = '';
      this.closeTimer = null;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('trade:closed'));
      }
    }, 200);
  }

  open(initiatorPlayer = null) {
    this.initDOM();
    clearTimeout(this.closeTimer);
    const online = this._isMultiplayer();
    const player1 = online
      ? clientGameStore.getPlayer(this.multiplayerContext.getLocalPlayerId?.())
      : (initiatorPlayer || clientGameStore.getActivePlayer());
    if (online && (player1?.playerId !== clientGameStore.getState().activePlayerId ||
        clientGameStore.getState().gameStatus === 'FINISHED')) return;
    if (!player1 || player1.status === PlayerStatus.BANKRUPT) return;

    // Cari daftar calon partner dagang (pemain yang belum bangkrut)
    const player1Identity = this._tradePlayerId(player1);
    const partners = clientGameStore.getPlayers().filter(p => this._tradePlayerId(p) !== player1Identity && p.status !== PlayerStatus.BANKRUPT && !p.isBot);
    if (partners.length === 0) {
      toast('❌ Tidak ada pemain manusia lain untuk diajak barter/tukar (bot tidak menerima tukar aset).');
      return;
    }

    // Default partner: partner pertama
    if (!this.selectedPartnerId || !partners.some(p => this._tradePlayerId(p) === this.selectedPartnerId)) {
      this.selectedPartnerId = this._tradePlayerId(partners[0]);
    }

    let p1Money = 0;
    let p2Money = 0;
    let p1Props = new Set();
    let p2Props = new Set();
    let p1JailCard = 0;
    let p2JailCard = 0;
    let activeTradeTab = 'give';

    const render = () => {
      const player2 = online
        ? clientGameStore.getPlayer(this.selectedPartnerId)
        : clientGameStore.getPlayer(this.selectedPartnerId);
      if (!player2) return;

      const p1AllProps = this._getPlayerProperties(player1);
      const p2AllProps = this._getPlayerProperties(player2);

      this.overlay.innerHTML = `
        <div class="tile-modal-card trade-modal-card visible">
          <div class="tile-modal-top-bar" style="background: linear-gradient(135deg, #0d9488, #0f766e);">
            <span>🤝 PERDAGANGAN & BARTER PROPERTI</span>
            <button id="btn-trade-close-x" class="btn-x-top" title="Tutup">✕</button>
          </div>

          <div class="tile-modal-body trade-modal-scroll">
            <!-- Pilihan Partner Dagang -->
            <div class="trade-partner-selector">
              <span>Pilih Mitra Dagang:</span>
              <div class="partner-chips">
                ${partners.map(p => `
                  <button type="button" class="partner-chip ${this._tradePlayerId(p) === this.selectedPartnerId ? 'active' : ''}" data-id="${this._tradePlayerId(p)}" style="--c:${p.color}">
                    <span class="chip-dot" style="background:${p.color}"></span>
                    ${p.name} ($${p.money.toLocaleString('id-ID')})
                  </button>
                `).join('')}
              </div>
            </div>

            <!-- Segmented Tab Khusus Mobile (HP Portrait) -->
            <div class="trade-mobile-tabs" id="trade-mobile-tabs">
              <button type="button" class="trade-tab-btn ${activeTradeTab === 'give' ? 'active' : ''}" data-tab="give" id="btn-tab-give">
                📤 Anda Berikan
              </button>
              <button type="button" class="trade-tab-btn ${activeTradeTab === 'receive' ? 'active' : ''}" data-tab="receive" id="btn-tab-receive">
                📥 Anda Minta
              </button>
            </div>

            <!-- Area Kolom Barter: Pemain 1 VS Pemain 2 -->
            <div class="trade-columns ${activeTradeTab === 'give' ? 'show-give' : 'show-receive'}" id="trade-columns-wrap">
              <!-- Kolom Pemain 1 (Yang Anda Berikan) -->
              <div class="trade-col trade-col-give" style="border-top: 4px solid ${player1.color};">
                <div class="trade-col-header">
                  <b style="color:${player1.color}">${player1.name} (Anda Berikan)</b>
                  <small>Saldo: $${player1.money.toLocaleString('id-ID')}</small>
                </div>

                <div class="trade-field">
                  <label>Uang Tunai Ditawarkan ($):</label>
                  <input type="number" id="trade-p1-money" min="0" max="${player1.money}" value="${p1Money}" class="trade-num-input" />
                </div>

                ${player1.hasGetOutOfJailCard > 0 ? `
                  <div class="trade-field jail-field">
                    <label>
                      <input type="checkbox" id="trade-p1-jail" ${p1JailCard > 0 ? 'checked' : ''} />
                      Sertakan Kartu Bebas Penjara (Miliki: ${player1.hasGetOutOfJailCard})
                    </label>
                  </div>
                ` : ''}

                <div class="trade-props-list-title">Properti Ditawarkan:</div>
                <div class="trade-props-scroll">
                  ${p1AllProps.length === 0 ? '<div class="empty-list-note">Tidak memiliki properti</div>' : ''}
                  ${p1AllProps.map(p => {
                    const groupProps = this._getColorGroupProperties(p.group);
                    const hasGroupBuilding = groupProps.some(gp => gp.houses > 0 || gp.hasHotel);
                    const isChecked = p1Props.has(p.pos);
                    const colorBar = COL[p.group] || (p.type === 'rail' ? '#334155' : '#0284c7');

                    return `
                      <label class="trade-prop-item ${hasGroupBuilding ? 'disabled' : ''}">
                        <input type="checkbox" class="chk-p1-prop" data-pos="${p.pos}" ${isChecked ? 'checked' : ''} ${hasGroupBuilding ? 'disabled' : ''} />
                        <span class="prop-swatch" style="background:${colorBar}"></span>
                        <div class="prop-trade-meta">
                          <span class="prop-name">${p.name}</span>
                          <span class="prop-sub">${p.isMortgaged ? '⚠️ Tergadai' : `$${p.price}`} ${hasGroupBuilding ? '(Ada bangunan)' : ''}</span>
                        </div>
                      </label>
                    `;
                  }).join('')}
                </div>
              </div>

              <!-- Kolom Pemain 2 (Yang Anda Minta) -->
              <div class="trade-col trade-col-receive" style="border-top: 4px solid ${player2.color};">
                <div class="trade-col-header">
                  <b style="color:${player2.color}">${player2.name} (Anda Minta)</b>
                  <small>Saldo: $${player2.money.toLocaleString('id-ID')}</small>
                </div>

                <div class="trade-field">
                  <label>Uang Tunai Diminta ($):</label>
                  <input type="number" id="trade-p2-money" min="0" max="${player2.money}" value="${p2Money}" class="trade-num-input" />
                </div>

                ${player2.hasGetOutOfJailCard > 0 ? `
                  <div class="trade-field jail-field">
                    <label>
                      <input type="checkbox" id="trade-p2-jail" ${p2JailCard > 0 ? 'checked' : ''} />
                      Minta Kartu Bebas Penjara (Miliki: ${player2.hasGetOutOfJailCard})
                    </label>
                  </div>
                ` : ''}

                <div class="trade-props-list-title">Properti Diminta:</div>
                <div class="trade-props-scroll">
                  ${p2AllProps.length === 0 ? '<div class="empty-list-note">Tidak memiliki properti</div>' : ''}
                  ${p2AllProps.map(p => {
                    const groupProps = this._getColorGroupProperties(p.group);
                    const hasGroupBuilding = groupProps.some(gp => gp.houses > 0 || gp.hasHotel);
                    const isChecked = p2Props.has(p.pos);
                    const colorBar = COL[p.group] || (p.type === 'rail' ? '#334155' : '#0284c7');

                    return `
                      <label class="trade-prop-item ${hasGroupBuilding ? 'disabled' : ''}">
                        <input type="checkbox" class="chk-p2-prop" data-pos="${p.pos}" ${isChecked ? 'checked' : ''} ${hasGroupBuilding ? 'disabled' : ''} />
                        <span class="prop-swatch" style="background:${colorBar}"></span>
                        <div class="prop-trade-meta">
                          <span class="prop-name">${p.name}</span>
                          <span class="prop-sub">${p.isMortgaged ? '⚠️ Tergadai' : `$${p.price}`} ${hasGroupBuilding ? '(Ada bangunan)' : ''}</span>
                        </div>
                      </label>
                    `;
                  }).join('')}
                </div>
              </div>
            </div>
          </div>

          <!-- Tombol Aksi Bawah (Sticky Footer) -->
          <div class="tile-modal-actions trade-modal-footer">
            <button id="btn-submit-trade" class="btn-primary-action">
              📤 Ajukan Tawaran ke ${player2.name}
            </button>
          </div>
        </div>
      `;

      // Event listener ganti partner
      this.overlay.querySelectorAll('.partner-chip').forEach(btn => {
        btn.onclick = () => {
          const inP1MCur = document.getElementById('trade-p1-money');
          if (inP1MCur) p1Money = Math.min(player1.money, Math.max(0, Number(inP1MCur.value || 0)));
          const selectedId = btn.getAttribute('data-id');
          this.selectedPartnerId = online ? selectedId : Number(selectedId);
          p2Money = 0;
          p2Props.clear();
          p2JailCard = 0;
          render();
        };
      });

      // Mobile Tabs switcher (tanpa merender ulang DOM, nilai input & checkbox 100% aman)
      const tabGive = document.getElementById('btn-tab-give');
      const tabReceive = document.getElementById('btn-tab-receive');
      const colsWrap = document.getElementById('trade-columns-wrap');
      if (tabGive && tabReceive && colsWrap) {
        tabGive.onclick = () => {
          activeTradeTab = 'give';
          colsWrap.classList.add('show-give');
          colsWrap.classList.remove('show-receive');
          tabGive.classList.add('active');
          tabReceive.classList.remove('active');
        };
        tabReceive.onclick = () => {
          activeTradeTab = 'receive';
          colsWrap.classList.add('show-receive');
          colsWrap.classList.remove('show-give');
          tabReceive.classList.add('active');
          tabGive.classList.remove('active');
        };
      }

      // Close buttons
      const btnX = document.getElementById('btn-trade-close-x');
      if (btnX) btnX.onclick = () => this.close();
      // Input money changes
      const inP1M = document.getElementById('trade-p1-money');
      if (inP1M) {
        inP1M.onchange = () => {
          p1Money = Math.min(player1.money, Math.max(0, Number(inP1M.value || 0)));
        };
      }
      const inP2M = document.getElementById('trade-p2-money');
      if (inP2M) {
        inP2M.onchange = () => {
          p2Money = Math.min(player2.money, Math.max(0, Number(inP2M.value || 0)));
        };
      }

      // Jail checkboxes
      const chkJail1 = document.getElementById('trade-p1-jail');
      if (chkJail1) {
        chkJail1.onchange = () => {
          p1JailCard = chkJail1.checked ? 1 : 0;
        };
      }
      const chkJail2 = document.getElementById('trade-p2-jail');
      if (chkJail2) {
        chkJail2.onchange = () => {
          p2JailCard = chkJail2.checked ? 1 : 0;
        };
      }

      // Property checkboxes
      this.overlay.querySelectorAll('.chk-p1-prop').forEach(chk => {
        chk.onchange = () => {
          const pos = Number(chk.getAttribute('data-pos'));
          if (chk.checked) p1Props.add(pos);
          else p1Props.delete(pos);
        };
      });

      this.overlay.querySelectorAll('.chk-p2-prop').forEach(chk => {
        chk.onchange = () => {
          const pos = Number(chk.getAttribute('data-pos'));
          if (chk.checked) p2Props.add(pos);
          else p2Props.delete(pos);
        };
      });

      // Submit Trade Proposal
      const btnSubmit = document.getElementById('btn-submit-trade');
      if (btnSubmit) {
        btnSubmit.onclick = createActionGuard(async () => {
          if (inP1M) p1Money = Math.min(player1.money, Math.max(0, Number(inP1M.value || 0)));
          if (inP2M) p2Money = Math.min(player2.money, Math.max(0, Number(inP2M.value || 0)));

          // Validasi minimal ada aset yang ditukar
          if (p1Money === 0 && p2Money === 0 && p1Props.size === 0 && p2Props.size === 0 && p1JailCard === 0 && p2JailCard === 0) {
            toast('⚠️ Tentukan setidaknya satu uang, properti, atau kartu yang ditukar.');
            return false;
          }

          const offer = {
            fromPlayerId: this._tradePlayerId(player1),
            toPlayerId: this._tradePlayerId(player2),
            giveMoney: p1Money,
            receiveMoney: p2Money,
            givePropPositions: Array.from(p1Props),
            receivePropPositions: Array.from(p2Props),
            giveJailCards: p1JailCard,
            receiveJailCards: p2JailCard,
            // Untuk tampilan review:
            player1Id: this._tradePlayerId(player1),
            player2Id: this._tradePlayerId(player2),
            player1Money: p1Money,
            player2Money: p2Money,
            player1PropertyPositions: Array.from(p1Props),
            player2PropertyPositions: Array.from(p2Props),
            player1JailCards: p1JailCard,
            player2JailCards: p2JailCard
          };

          if (online) {
            const response = await this.multiplayerContext.client?.request?.('game:trade-create', {
              turnId: clientGameStore.getState().turnId,
              actionId: newActionId(),
              toPlayerId: this._tradePlayerId(player2),
              offer: {giveMoney: p1Money, receiveMoney: p2Money,
                givePropPositions: [...p1Props], receivePropPositions: [...p2Props],
                giveJailCards: p1JailCard, receiveJailCards: p2JailCard}
            });
            if (!response?.ok) {
              toast(`Gagal: ${response?.error?.message || 'Penawaran tukar gagal dikirim.'}`);
              return false;
            }
            if (!clientGameStore.trades.has(response.result?.trade?.tradeId)) {
              clientGameStore.applyTradeEvent(response.result);
            }
            return true;
          }

          const validation = tradeManager.validateTrade(offer);
          if (!validation.valid) {
            toast(`❌ ${validation.reason}`);
            return false;
          }

          // Tampilkan Konfirmasi Review untuk Pemain 2
          this.promptTradeReview(player1, player2, offer);
        });
      }
    };

    render();
    this.overlay.classList.remove('hidden');
    requestAnimationFrame(() => {
      this.overlay.classList.add('visible');
      const card = this.overlay.querySelector('.tile-modal-card');
      if (card) card.classList.add('visible');
    });
  }

  showAuthoritativeTrade(trade, {localPlayerId, onAction} = {}) {
    if (!trade?.tradeId || ![trade.fromPlayerId, trade.toPlayerId].includes(localPlayerId)) return false;
    this.initDOM();
    clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.authoritativeTradeId = trade.tradeId;
    const sender = clientGameStore.getPlayer(trade.fromPlayerId);
    const receiver = clientGameStore.getPlayer(trade.toPlayerId);
    if (!sender || !receiver) return false;
    const offer = trade.offer;
    const properties = positions => positions.map(position => {
      const property = clientGameStore.getProperty(position);
      if (!property) return null;
      const mortgage = property.isMortgaged ? ' — Tergadai; status gadai tetap berlaku' : '';
      return `<li>${escapeHtml(property.name)}${mortgage}</li>`;
    }).filter(Boolean);
    const giveProperties = properties(offer.givePropPositions);
    const receiveProperties = properties(offer.receivePropPositions);
    const format = amount => `$${Number(amount || 0).toLocaleString('id-ID')}`;
    const statusText = {
      PENDING: 'Menunggu keputusan penerima.',
      COMPLETED: 'Pertukaran berhasil!',
      REJECTED: `${receiver.name} menolak penawaran.`,
      CANCELLED: `${sender.name} membatalkan penawaran.`,
      INVALIDATED: 'Penawaran tidak berlaku lagi karena aset berubah.'
    }[trade.status] || 'Status penawaran tidak diketahui.';
    const controls = trade.status === 'PENDING'
      ? localPlayerId === trade.toPlayerId
        ? '<button id="btn-trade-server-accept" class="btn-primary-action" style="background:#16a34a">Terima</button><button id="btn-trade-server-reject" class="btn-secondary-action">Tolak</button>'
        : '<button id="btn-trade-server-cancel" class="btn-secondary-action">Batalkan Penawaran</button>'
      : '';
    const html = `<div class="tile-modal-card trade-modal-card review visible">
      <div class="tile-modal-top-bar" style="background:linear-gradient(135deg,#0284c7,#0369a1)">
        <span>🤝 PENAWARAN TRADE</span>
      </div>
      <div class="tile-modal-body trade-modal-scroll">
        <h3 class="tile-prop-title">${escapeHtml(sender.name)} ↔ ${escapeHtml(receiver.name)}</h3>
        <p class="tile-prop-subtitle">${escapeHtml(statusText)}</p>
        <div class="trade-review-box">
          <div class="review-item-group receive"><span class="group-title">${escapeHtml(receiver.name)} menerima</span><ul>
            ${offer.giveMoney ? `<li>Uang: +${format(offer.giveMoney)}</li>` : ''}
            ${offer.giveJailCards ? `<li>Kartu Bebas Penjara: ${offer.giveJailCards}</li>` : ''}
            ${giveProperties.map(item => item.replace('<li>', '<li>Properti: ')).join('')}
            ${!offer.giveMoney && !offer.giveJailCards && !giveProperties.length ? '<li>Tidak ada aset</li>' : ''}
          </ul></div>
          <div class="review-item-group give"><span class="group-title">${escapeHtml(receiver.name)} memberikan</span><ul>
            ${offer.receiveMoney ? `<li>Uang: -${format(offer.receiveMoney)}</li>` : ''}
            ${offer.receiveJailCards ? `<li>Kartu Bebas Penjara: ${offer.receiveJailCards}</li>` : ''}
            ${receiveProperties.map(item => item.replace('<li>', '<li>Properti: ')).join('')}
            ${!offer.receiveMoney && !offer.receiveJailCards && !receiveProperties.length ? '<li>Tidak ada aset</li>' : ''}
          </ul></div>
        </div>
      </div>
      <div class="tile-modal-actions trade-modal-footer">${controls}</div>
    </div>`;
    this.overlay.innerHTML = html;
    this.overlay.classList.remove('hidden');
    requestAnimationFrame(() => this.overlay?.classList.add('visible'));
    if (['COMPLETED', 'REJECTED', 'CANCELLED', 'INVALIDATED'].includes(trade.status)) {
      const terminalTradeId = trade.tradeId;
      this.closeTimer = setTimeout(() => this.closeAuthoritativeTrade(terminalTradeId), 2000);
    }
    for (const [buttonId, action] of [['btn-trade-server-accept', 'ACCEPT'], ['btn-trade-server-reject', 'REJECT'], ['btn-trade-server-cancel', 'CANCEL']]) {
      const button = document.getElementById(buttonId);
      if (!button) continue;
      button.onclick = createActionGuard(async () => {
        button.disabled = true;
        const response = await onAction?.(action, trade);
        if (!response?.ok) {
          toast(response?.error?.message || 'Aksi trade gagal diproses.');
          button.disabled = false;
          return false;
        }
        return true;
      });
    }
    return true;
  }

  closeAuthoritativeTrade(tradeId) {
    if (this.authoritativeTradeId !== tradeId) return false;
    this.authoritativeTradeId = null;
    this.close();
    return true;
  }

  promptTradeReview(player1, player2, offer) {
    const p1PropsList = offer.player1PropertyPositions.map(pos => {
      const prop = propertyManager.getProperty(pos);
      if (!prop) return null;
      if (prop.isMortgaged) {
        return `<b>${prop.name}</b> <span style="color:#d97706;font-size:11px;">(⚠️ Tergadai — Pokok $${prop.mortgageValue}, Bunga 10% $${Math.round(prop.mortgageValue * 0.1)})</span>`;
      }
      return `<b>${prop.name}</b>`;
    }).filter(Boolean);

    const p2PropsList = offer.player2PropertyPositions.map(pos => {
      const prop = propertyManager.getProperty(pos);
      if (!prop) return null;
      if (prop.isMortgaged) {
        return `<b>${prop.name}</b> <span style="color:#d97706;font-size:11px;">(⚠️ Tergadai — Pokok $${prop.mortgageValue}, Bunga 10% $${Math.round(prop.mortgageValue * 0.1)})</span>`;
      }
      return `<b>${prop.name}</b>`;
    }).filter(Boolean);

    this.overlay.innerHTML = `
      <div class="tile-modal-card trade-modal-card review visible">
        <div class="tile-modal-top-bar" style="background: linear-gradient(135deg, #0284c7, #0369a1);">
          <span>🤝 KONFIRMASI PENAWARAN PERTUKARAN</span>
        </div>

        <div class="tile-modal-body trade-modal-scroll">
          <h3 class="tile-prop-title" style="color:${player2.color}">${player2.name}, Terima Tawaran Ini?</h3>
          <p class="tile-prop-subtitle">${player1.name} mengajukan barter pertukaran berikut kepada Anda:</p>

          <div class="trade-review-box">
            <div class="review-item-group receive">
              <span class="group-title">📥 Yang Akan Anda Terima:</span>
              <ul>
                ${offer.player1Money > 0 ? `<li>💰 Uang Tunai: <b>+$${offer.player1Money.toLocaleString('id-ID')}</b></li>` : ''}
                ${offer.player1JailCards > 0 ? `<li>🎟️ ${offer.player1JailCards}x Kartu Bebas Penjara</li>` : ''}
                ${p1PropsList.map(item => `<li>🏠 Properti: ${item}</li>`).join('')}
                ${offer.player1Money === 0 && offer.player1JailCards === 0 && p1PropsList.length === 0 ? '<li><i>Tidak ada yang diterima</i></li>' : ''}
              </ul>
            </div>

            <div class="review-item-group give">
              <span class="group-title">📤 Yang Akan Anda Berikan:</span>
              <ul>
                ${offer.player2Money > 0 ? `<li>💰 Uang Tunai: <b>-$${offer.player2Money.toLocaleString('id-ID')}</b></li>` : ''}
                ${offer.player2JailCards > 0 ? `<li>🎟️ ${offer.player2JailCards}x Kartu Bebas Penjara</li>` : ''}
                ${p2PropsList.map(item => `<li>🏠 Properti: ${item}</li>`).join('')}
                ${offer.player2Money === 0 && offer.player2JailCards === 0 && p2PropsList.length === 0 ? '<li><i>Tidak ada yang diberikan</i></li>' : ''}
              </ul>
            </div>
          </div>
        </div>

        <div class="tile-modal-actions trade-modal-footer">
          <button id="btn-accept-trade" class="btn-primary-action" style="background:#16a34a;">
            ✅ Terima Pertukaran
          </button>
          <button id="btn-reject-trade" class="btn-secondary-action" style="color:#dc2626;">
            ❌ Tolak Tawaran
          </button>
        </div>
      </div>
    `;

    const finishDecision = message => {
      const title = this.overlay?.querySelector('.tile-prop-title');
      const subtitle = this.overlay?.querySelector('.tile-prop-subtitle');
      if (title) title.textContent = message;
      if (subtitle) subtitle.textContent = 'Modal akan menutup otomatis.';
      this.overlay?.querySelector('.trade-modal-footer')?.remove();
      clearTimeout(this.closeTimer);
      this.closeTimer = setTimeout(() => this.close(), 2000);
    };
    const btnAccept = document.getElementById('btn-accept-trade');
    if (btnAccept) {
      btnAccept.onclick = createActionGuard(() => {
        const result = tradeManager.executeTrade(offer);
        if (result.success) {
          toast(`🤝 Pertukaran antara ${player1.name} dan ${player2.name} BERHASIL!`);
          buildHud();
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('property:updated'));
          }
          finishDecision('Pertukaran berhasil');
        } else {
          toast(`❌ Gagal: ${result.reason}`);
          this.close();
        }
      });
    }

    const btnReject = document.getElementById('btn-reject-trade');
    if (btnReject) {
      btnReject.onclick = createActionGuard(() => {
        toast(`❌ ${player2.name} menolak tawaran pertukaran.`);
        finishDecision('Tawaran ditolak');
      });
    }
  }
}

export const tradeModalManager = new TradeModalManager();
