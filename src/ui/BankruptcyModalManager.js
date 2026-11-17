import {gameState} from '../logic/GameState.js';
import {bankruptcyManager} from '../logic/BankruptcyManager.js';
import {propertyManager} from '../logic/PropertyManager.js';
import {toast, buildHud} from './hud.js';

export class BankruptcyModalManager {
  constructor() {
    this.overlay = null;
    this.initDOM();
  }

  initDOM() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('bankruptcy-modal-overlay')) {
      this.overlay = document.getElementById('bankruptcy-modal-overlay');
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'bankruptcy-modal-overlay';
    overlay.className = 'tile-modal-overlay hidden';
    document.body.appendChild(overlay);
    this.overlay = overlay;

    // Listen to game:over to show victory modal
    window.addEventListener('game:over', (e) => {
      this.showVictoryModal(e.detail?.winner);
    });
  }

  isOpen() {
    return this.overlay && !this.overlay.classList.contains('hidden');
  }

  promptDebtResolution(debtor, creditor, debtAmount, reason = '') {
    return new Promise((resolve) => {
      this.initDOM();
      if (!this.overlay) return resolve(false);

      const creditorName = creditor ? creditor.name : 'Bank';
      const creditorColor = creditor ? creditor.color : '#475569';

      const render = () => {
        const deficit = Math.max(0, debtAmount - debtor.money);
        const canPay = debtor.money >= debtAmount;

        // Cari aset yang bisa dijual / digadaikan
        const sellableBldgs = propertyManager.getPlayerProperties(debtor.id)
          .filter(p => p.type === 'prop' && (p.houses > 0 || p.hasHotel));
        const mortgageableProps = propertyManager.getPlayerProperties(debtor.id)
          .filter(p => !p.isMortgaged);

        this.overlay.innerHTML = `
          <div class="tile-modal-card debt-card visible">
            <div class="tile-modal-header" style="background: linear-gradient(135deg, #b91c1c, #991b1b);">
              <div class="tile-modal-icon">⚠️</div>
              <div class="tile-modal-title-group">
                <h3>PENYELESAIAN UTANG</h3>
                <span class="jail-status-tag" style="background:rgba(0,0,0,0.3);">${debtor.name}</span>
              </div>
            </div>

            <div class="tile-modal-body">
              <div class="debt-summary-box">
                <div class="debt-row">
                  <span>Kewajiban Pembayaran:</span>
                  <b style="color:#b91c1c;font-size:16px;">$${debtAmount.toLocaleString('id-ID')}</b>
                </div>
                <div class="debt-row">
                  <span>Pihak Penerima (Kreditur):</span>
                  <b style="color:${creditorColor}">${creditorName}</b>
                </div>
                <div class="debt-row">
                  <span>Keterangan:</span>
                  <small style="color:#64748b">${reason || 'Pembayaran sewa/biaya'}</small>
                </div>
                <div class="debt-divider"></div>
                <div class="debt-row">
                  <span>Saldo ${debtor.name} Saat Ini:</span>
                  <b>$${debtor.money.toLocaleString('id-ID')}</b>
                </div>
                <div class="debt-row">
                  <span>Kekurangan Dana:</span>
                  <b style="color:${deficit > 0 ? '#dc2626' : '#16a34a'}">
                    ${deficit > 0 ? `-$${deficit.toLocaleString('id-ID')}` : 'LUNAS (Saldo Cukup)'}
                  </b>
                </div>
              </div>

              ${deficit > 0 ? `
                <div class="debt-actions-guide">
                  <p>💡 <b>Cara mendapatkan dana darurat:</b> Jual rumah/hotel atau gadaikan properti di bawah ini agar saldo Anda mencukupi.</p>
                </div>
              ` : ''}

              <!-- DAFTAR TINDAKAN PENYELAMATAN ASET -->
              <div class="debt-liquidation-list">
                ${sellableBldgs.length > 0 ? `
                  <div class="liquidation-section-title">🔨 Jual Bangunan (50% Refund):</div>
                  ${sellableBldgs.map(p => {
                    const isHotel = p.hasHotel;
                    const refund = Math.floor((isHotel ? (p.hotelPrice || 50) : (p.housePrice || 50)) * 0.5);
                    return `
                      <div class="liquidation-item">
                        <span>${p.name} (${isHotel ? '🏨 Hotel' : `${p.houses}x 🏠`})</span>
                        <button class="btn-quick-liquidate btn-sell-bldg" data-pos="${p.pos}" data-type="${isHotel ? 'hotel' : 'house'}">
                          Jual (+ $${refund})
                        </button>
                      </div>
                    `;
                  }).join('')}
                ` : ''}

                ${mortgageableProps.length > 0 ? `
                  <div class="liquidation-section-title" style="margin-top:8px;">📄 Gadaikan Properti:</div>
                  ${mortgageableProps.map(p => {
                    const chk = propertyManager.canMortgage(p.pos);
                    return `
                      <div class="liquidation-item">
                        <span>${p.name}</span>
                        <button class="btn-quick-liquidate btn-mortgage-prop" ${chk.canMortgage ? '' : 'disabled'} data-pos="${p.pos}">
                          Gadai (+ $${p.mortgageValue})
                        </button>
                      </div>
                    `;
                  }).join('')}
                ` : ''}

                ${sellableBldgs.length === 0 && mortgageableProps.length === 0 && deficit > 0 ? `
                  <div class="empty-liquidation-note">
                    ❌ Tidak ada aset tersisa yang dapat dijual atau digadaikan.
                  </div>
                ` : ''}
              </div>

              <!-- TOMBOL EKSEKUSI -->
              <div class="debt-footer-actions">
                <button id="btn-pay-debt" class="btn-primary-action ${canPay ? '' : 'disabled'}" ${canPay ? '' : 'disabled'}>
                  ✅ Bayar Utang ($${debtAmount.toLocaleString('id-ID')})
                </button>
                <button id="btn-declare-bankruptcy" class="btn-bankruptcy-action">
                  💥 Nyatakan Bangkrut
                </button>
              </div>
            </div>
          </div>
        `;

        // Pasang event listener tombol likuidasi
        this.overlay.querySelectorAll('.btn-sell-bldg').forEach(btn => {
          btn.onclick = () => {
            const pos = Number(btn.getAttribute('data-pos'));
            const type = btn.getAttribute('data-type');
            if (type === 'hotel') propertyManager.sellHotel(pos);
            else propertyManager.sellHouse(pos);
            buildHud();
            render();
          };
        });

        this.overlay.querySelectorAll('.btn-mortgage-prop').forEach(btn => {
          btn.onclick = () => {
            const pos = Number(btn.getAttribute('data-pos'));
            propertyManager.mortgageProperty(pos);
            buildHud();
            render();
          };
        });

        // Handler Bayar Utang
        const btnPay = document.getElementById('btn-pay-debt');
        if (btnPay) {
          btnPay.onclick = () => {
            this.close();
            resolve({ resolved: true, bankrupt: false });
          };
        }

        // Handler Nyatakan Bangkrut
        const btnBankrupt = document.getElementById('btn-declare-bankruptcy');
        if (btnBankrupt) {
          btnBankrupt.onclick = () => {
            const confirmMsg = `Yakin ingin menyatakan BANGKRUT?\nSemua aset Anda akan diserahkan kepada ${creditorName} dan Anda keluar dari permainan.`;
            if (typeof window !== 'undefined' && !window.confirm(confirmMsg)) return;

            bankruptcyManager.declareBankruptcy(debtor.id, creditor ? creditor.id : 'BANK', debtAmount);
            this.close();
            resolve({ resolved: false, bankrupt: true });
          };
        }
      };

      render();
      this.overlay.classList.remove('hidden');
      requestAnimationFrame(() => this.overlay.classList.add('visible'));
    });
  }

  showVictoryModal(winner) {
    this.initDOM();
    if (!this.overlay || !winner) return;

    const winnerProps = propertyManager.getPlayerProperties(winner.id);
    let totalHouses = 0;
    let totalHotels = 0;
    let totalPropValue = 0;
    let totalBuildingValue = 0;
    winnerProps.forEach(p => {
      totalPropValue += (p.price || 0);
      if (p.hasHotel) {
        totalHotels++;
        totalBuildingValue += (p.hotelPrice || 50);
      }
      if (p.houses > 0) {
        totalHouses += p.houses;
        totalBuildingValue += (p.housePrice || 50) * p.houses;
      }
    });
    const totalAssets = winner.money + totalPropValue + totalBuildingValue;

    this.overlay.innerHTML = `
      <div class="tile-modal-card victory-card visible">
        <div class="victory-header" style="background:${winner.color}">
          <div class="victory-trophy">🏆</div>
          <h2>PEMENANG MONOPOLY!</h2>
          <p>${winner.name} (${winner.cn}) Telah Menaklukkan Papan ModPoly</p>
        </div>

        <div class="tile-modal-body text-center">
          <div class="victory-stats-grid">
            <div class="victory-stat-box">
              <span>Saldo Akhir</span>
              <b>$${winner.money.toLocaleString('id-ID')}</b>
            </div>
            <div class="victory-stat-box">
              <span>Total Properti</span>
              <b>${winnerProps.length} Petak</b>
            </div>
            <div class="victory-stat-box">
              <span>Total Bangunan</span>
              <b>${totalHouses} 🏠 • ${totalHotels} 🏨</b>
            </div>
            <div class="victory-stat-box" style="grid-column: 1 / -1;">
              <span>Total Nilai Kekayaan Bersih (Net Worth)</span>
              <b style="color:#15803d;font-size:16px;">💰 $${totalAssets.toLocaleString('id-ID')}</b>
            </div>
          </div>

          <p class="victory-quote">"Seluruh lawan telah bangkrut! Anda adalah penguasa tunggal kerajaan properti ini!"</p>

          <button id="btn-restart-game" class="btn-primary-action victory-restart-btn">
            🔄 Mainkan Permainan Baru
          </button>
        </div>
      </div>
    `;

    this.overlay.classList.remove('hidden');
    requestAnimationFrame(() => this.overlay.classList.add('visible'));

    const btnRestart = document.getElementById('btn-restart-game');
    if (btnRestart) {
      btnRestart.onclick = () => {
        window.location.reload();
      };
    }
  }

  close() {
    if (!this.overlay) return;
    this.overlay.classList.remove('visible');
    setTimeout(() => {
      if (this.overlay) this.overlay.classList.add('hidden');
    }, 200);
  }
}

export const bankruptcyModalManager = new BankruptcyModalManager();
