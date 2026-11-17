import {gameState, PlayerStatus} from '../logic/GameState.js';
import {propertyManager} from '../logic/PropertyManager.js';
import {tradeManager} from '../logic/TradeManager.js';
import {COL} from '../config.js';
import {toast, buildHud} from './hud.js';

export class TradeModalManager {
  constructor() {
    this.overlay = null;
    this.selectedPartnerId = null;
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

  close() {
    if (!this.overlay) return;
    this.overlay.classList.remove('visible');
    setTimeout(() => {
      this.overlay.classList.add('hidden');
      this.overlay.innerHTML = '';
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('trade:closed'));
      }
    }, 200);
  }

  open(initiatorPlayer = null) {
    this.initDOM();
    const player1 = initiatorPlayer || gameState.getActivePlayer();
    if (!player1 || player1.status === PlayerStatus.BANKRUPT) return;

    // Cari daftar calon partner dagang (pemain yang belum bangkrut)
    const partners = gameState.players.filter(p => p.id !== player1.id && p.status !== PlayerStatus.BANKRUPT);
    if (partners.length === 0) {
      toast('❌ Tidak ada pemain lain yang aktif untuk diajak barter/tukar.');
      return;
    }

    // Default partner: partner pertama
    if (!this.selectedPartnerId || !partners.some(p => p.id === this.selectedPartnerId)) {
      this.selectedPartnerId = partners[0].id;
    }

    let p1Money = 0;
    let p2Money = 0;
    let p1Props = new Set();
    let p2Props = new Set();
    let p1JailCard = 0;
    let p2JailCard = 0;
    let activeTradeTab = 'give';

    const render = () => {
      const player2 = gameState.getPlayerById(this.selectedPartnerId);
      if (!player2) return;

      const p1AllProps = propertyManager.getPlayerProperties(player1.id);
      const p2AllProps = propertyManager.getPlayerProperties(player2.id);

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
                  <button type="button" class="partner-chip ${p.id === this.selectedPartnerId ? 'active' : ''}" data-id="${p.id}" style="--c:${p.color}">
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
                    const groupProps = propertyManager.getColorGroupProperties(p.group);
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
                    const groupProps = propertyManager.getColorGroupProperties(p.group);
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
            <button id="btn-cancel-trade" class="btn-secondary-action">
              Batal
            </button>
          </div>
        </div>
      `;

      // Event listener ganti partner
      this.overlay.querySelectorAll('.partner-chip').forEach(btn => {
        btn.onclick = () => {
          const inP1MCur = document.getElementById('trade-p1-money');
          if (inP1MCur) p1Money = Math.min(player1.money, Math.max(0, Number(inP1MCur.value || 0)));
          this.selectedPartnerId = Number(btn.getAttribute('data-id'));
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
      const btnCancel = document.getElementById('btn-cancel-trade');
      if (btnCancel) btnCancel.onclick = () => this.close();

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
        btnSubmit.onclick = () => {
          if (inP1M) p1Money = Math.min(player1.money, Math.max(0, Number(inP1M.value || 0)));
          if (inP2M) p2Money = Math.min(player2.money, Math.max(0, Number(inP2M.value || 0)));

          // Validasi minimal ada aset yang ditukar
          if (p1Money === 0 && p2Money === 0 && p1Props.size === 0 && p2Props.size === 0 && p1JailCard === 0 && p2JailCard === 0) {
            toast('⚠️ Tentukan setidaknya satu uang, properti, atau kartu yang ditukar.');
            return;
          }

          const offer = {
            fromPlayerId: player1.id,
            toPlayerId: player2.id,
            giveMoney: p1Money,
            receiveMoney: p2Money,
            givePropPositions: Array.from(p1Props),
            receivePropPositions: Array.from(p2Props),
            giveJailCards: p1JailCard,
            receiveJailCards: p2JailCard,
            // Untuk tampilan review:
            player1Id: player1.id,
            player2Id: player2.id,
            player1Money: p1Money,
            player2Money: p2Money,
            player1PropertyPositions: Array.from(p1Props),
            player2PropertyPositions: Array.from(p2Props),
            player1JailCards: p1JailCard,
            player2JailCards: p2JailCard
          };

          const validation = tradeManager.validateTrade(offer);
          if (!validation.valid) {
            toast(`❌ ${validation.reason}`);
            return;
          }

          // Tampilkan Konfirmasi Review untuk Pemain 2
          this.promptTradeReview(player1, player2, offer);
        };
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

    const btnAccept = document.getElementById('btn-accept-trade');
    if (btnAccept) {
      btnAccept.onclick = () => {
        const result = tradeManager.executeTrade(offer);
        if (result.success) {
          toast(`🤝 Pertukaran antara ${player1.name} dan ${player2.name} BERHASIL!`);
          buildHud();
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('property:updated'));
          }
          this.close();
        } else {
          toast(`❌ Gagal: ${result.reason}`);
          this.close();
        }
      };
    }

    const btnReject = document.getElementById('btn-reject-trade');
    if (btnReject) {
      btnReject.onclick = () => {
        toast(`❌ ${player2.name} menolak tawaran pertukaran.`);
        this.close();
      };
    }
  }
}

export const tradeModalManager = new TradeModalManager();
