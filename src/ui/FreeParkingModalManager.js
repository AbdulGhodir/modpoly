import {gameState} from '../logic/GameState.js';
import {TILES} from '../data/tiles.js';
import {COL} from '../config.js';

export class FreeParkingModalManager {
  constructor() {
    this.overlay = null;
    this.minimized = false;
    this.restoreBtn = null;
    this.pendingTravelResolve = null;
    this.initDOM();
    if (typeof window !== 'undefined') {
      window.addEventListener('game:over', () => {
        this.close();
        this.pendingTravelResolve?.({ action: 'CANCELLED' });
      });
    }
  }

  initDOM() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('freeparking-modal-overlay')) {
      this.overlay = document.getElementById('freeparking-modal-overlay');
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'freeparking-modal-overlay';
    overlay.className = 'tile-modal-overlay hidden';
    document.body.appendChild(overlay);
    this.overlay = overlay;
  }

  isOpen() {
    return this.overlay && !this.overlay.classList.contains('hidden');
  }

  close() {
    if (!this.overlay) return;
    this.minimized = false;
    this.restoreBtn?.remove();
    this.restoreBtn = null;
    this.overlay.classList.remove('minimized');
    this.overlay.classList.remove('visible');
    setTimeout(() => {
      this.overlay.classList.add('hidden');
      this.overlay.innerHTML = '';
    }, 200);
  }

  minimize() {
    if (!this.isOpen() || this.minimized) return;
    this.minimized = true;
    this.overlay.classList.add('minimized');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tile-modal-restore-pill pulse';
    button.innerHTML = '<span class="restore-icon">🚗</span><span class="restore-label">Buka kembali: Parkir Bebas</span><span class="restore-chevron">▲</span>';
    button.onclick = () => {
      this.minimized = false;
      this.overlay.classList.remove('minimized');
      button.remove();
      this.restoreBtn = null;
    };
    document.body.appendChild(button);
    this.restoreBtn = button;
  }

  promptTravel(player) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        this.pendingTravelResolve = null;
        resolve(result);
      };
      this.pendingTravelResolve = finish;
      this.initDOM();
      if (!this.overlay) return finish({ action: 'STAY' });

      const canAfford = player.money >= 50;

      // 39 Petak tujuan (semua petak kecuali petak 20 Parkir Bebas itu sendiri)
      const selectableTiles = TILES.filter(t => t.pos !== 20);

      // Kategori pilihan untuk memudahkan navigasi
      let selectedPos = 0; // default START

      const render = () => {
        const selectedTile = TILES[selectedPos];
        const willPassStart = selectedPos < 20; // Dari petak 20 searah jarum jam (clockwise), 0..19 melewati START

        this.overlay.innerHTML = `
          <div class="tile-modal-card freeparking-card visible">
            <div class="tile-modal-top-bar" style="background: linear-gradient(135deg, #0284c7, #0369a1);">
              <span>🅿️ PARKIR BEBAS — LAYANAN TRAVEL</span>
              <span>Biaya: $50</span>
              <button type="button" class="btn-tile-minimize" title="Perkecil modal" aria-label="Minimize"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="2.5" y1="8" x2="13.5" y2="8"/></svg></button>
            </div>

            <div class="tile-modal-body">
              <h3 class="tile-prop-title">Pilih Petak Tujuan Anda</h3>
              <p class="tile-prop-subtitle">
                Anda memulai giliran di Parkir Bebas. Anda dapat membayar <b>$50</b> untuk langsung berpindah ke petak mana saja searah jarum jam!
              </p>

              <div class="travel-preview-box">
                <div class="travel-target-info">
                  <span class="preview-lbl">Tujuan Terpilih:</span>
                  <b class="preview-name">${selectedTile.nama} (${selectedTile.sub || 'Petak ' + selectedTile.pos})</b>
                </div>
                <div class="travel-bonus-badge ${willPassStart ? 'bonus-yes' : 'bonus-no'}">
                  ${willPassStart ? '✨ Melewati / Sampai di START (+ $200 Bonus Gaji)' : '➡️ Tidak Melewati START'}
                </div>
              </div>

              <div class="tile-picker-container">
                <div class="tile-picker-label">Daftar 39 Petak Papan (Klik untuk Memilih):</div>
                <div class="tile-picker-grid">
                  ${selectableTiles.map(t => {
                    const isSelected = t.pos === selectedPos;
                    const groupColor = COL[t.group] || (t.type === 'rail' ? '#334155' : (t.type === 'util' ? '#0284c7' : '#94a3b8'));
                    return `
                      <button type="button" class="btn-tile-choice ${isSelected ? 'selected' : ''}" data-pos="${t.pos}">
                        <span class="choice-color-bar" style="background:${groupColor}"></span>
                        <div class="choice-info">
                          <span class="choice-num">#${t.pos}</span>
                          <span class="choice-title">${t.nama}</span>
                        </div>
                      </button>
                    `;
                  }).join('')}
                </div>
              </div>

              <div class="player-balance-strip" style="--c:${player.color};margin-top:10px;">
                <span>Saldo ${player.name}:</span>
                <b>💰 $${player.money.toLocaleString('id-ID')}</b>
              </div>

              ${!canAfford ? '<div class="alert-insufficient">⚠️ Saldo tidak cukup ($50) untuk menggunakan layanan Travel.</div>' : ''}

              <div class="tile-modal-actions" style="margin-top:14px;">
                <button id="btn-travel-confirm" class="btn-primary-action" ${!canAfford ? 'disabled' : ''}>
                  🚗 Bayar $50 & Berangkat ke Petak #${selectedPos}
                </button>
                <button id="btn-travel-stay" class="btn-secondary-action">
                  🎲 Tetap di Sini (Lempar Dadu Normal)
                </button>
              </div>
            </div>
          </div>
        `;

        // Event listener klik petak
        this.overlay.querySelectorAll('.btn-tile-choice').forEach(btn => {
          btn.onclick = () => {
            selectedPos = Number(btn.getAttribute('data-pos'));
            render();
          };
        });
        this.overlay.querySelector('.btn-tile-minimize')?.addEventListener('click', () => this.minimize());

        // Event Konfirmasi Travel
        const btnConfirm = document.getElementById('btn-travel-confirm');
        if (btnConfirm && canAfford) {
          btnConfirm.onclick = () => {
            this.close();
            finish({
              action: 'TRAVEL',
              targetPos: selectedPos,
              cost: 50,
              willPassStart
            });
          };
        }

        // Event Tetap di Sini
        const btnStay = document.getElementById('btn-travel-stay');
        if (btnStay) {
          btnStay.onclick = () => {
            this.close();
            finish({ action: 'STAY' });
          };
        }
      };

      render();
      this.overlay.classList.remove('hidden');
      requestAnimationFrame(() => this.overlay.classList.add('visible'));
    });
  }
}

export const freeParkingModalManager = new FreeParkingModalManager();
