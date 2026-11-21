import {jailManager, BAIL_COST, MAX_JAIL_TURNS} from '../logic/JailManager.js';
import {economyManager} from '../logic/EconomyManager.js';
import {toast, buildHud} from './hud.js';
import {createActionGuard} from '../logic/ActionGuard.js';

export class JailModalManager {
  constructor() {
    this.overlay = null;
    this.initDOM();
  }

  initDOM() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('jail-modal-overlay')) {
      this.overlay = document.getElementById('jail-modal-overlay');
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'jail-modal-overlay';
    overlay.className = 'tile-modal-overlay hidden';
    document.body.appendChild(overlay);
    this.overlay = overlay;
  }

  isOpen() {
    return this.overlay && !this.overlay.classList.contains('hidden');
  }

  promptJailAction(player, options = {}) {
    return new Promise((resolve) => {
      this.initDOM();
      if (!this.overlay) return resolve({ action: 'TRY_DOUBLE' });

      const attemptsUsed = player.jailTurns || 0;
      const attemptsLeft = Math.max(0, MAX_JAIL_TURNS - attemptsUsed);
      const multiplayer = typeof options.onAction === 'function';
      const canAct = !multiplayer || options.canAct === true;
      const hasMoney = multiplayer ? player.money >= BAIL_COST : economyManager.hasEnoughMoney(player.id, BAIL_COST);
      const hasCard = multiplayer ? (player.hasGetOutOfJailCard || 0) > 0 : jailManager.hasGetOutOfJailCard(player.id);

      this.overlay.innerHTML = `
        <div class="tile-modal-card jail-card">
          <!-- Header Modal Penjara -->
          <div class="jail-modal-header">
            <div class="jail-modal-header-icon">⛓️</div>
            <div class="jail-modal-header-title">
              <div class="jail-title-top">RUANG TAHANAN</div>
              <h3 class="jail-title-main">SEDANG DI PENJARA</h3>
            </div>
            <div class="jail-player-chip" style="--c:${player.color};--d:${player.dark}">
              <span class="jail-chip-dot"></span>
              <span class="jail-chip-name">${player.name}</span>
            </div>
            ${multiplayer && !canAct ? '<button class="jail-readonly-close" type="button" aria-label="Tutup">×</button>' : ''}
          </div>

          <div class="tile-modal-body jail-modal-body">
            <p class="jail-prop-subtitle">
              <b>${player.name}</b> harus keluar dari penjara sebelum dapat kembali berkeliling papan.
            </p>

            <!-- Kotak Status Tahanan -->
            <div class="jail-status-grid">
              <div class="jail-stat-item">
                <span class="stat-lbl">Percobaan Double:</span>
                <b class="stat-val">${attemptsUsed} <small>/ ${MAX_JAIL_TURNS}x</small></b>
              </div>
              <div class="jail-stat-item">
                <span class="stat-lbl">Sisa Kesempatan:</span>
                <b class="stat-val">${attemptsLeft} <small>giliran</small></b>
              </div>
              <div class="jail-stat-item full-row">
                <span class="stat-lbl">Saldo Kamu:</span>
                <b class="stat-val ${hasMoney ? 'val-good' : 'val-bad'}">💰 $${player.money.toLocaleString('id-ID')}</b>
              </div>
            </div>

            ${attemptsUsed >= 2 ? `
              <div class="jail-warning-alert">
                <span class="warn-icon">⚠️</span>
                <div class="warn-text">
                  <b>Peringatan Percobaan Terakhir!</b>
                  <span>Jika lemparan double ke-3 ini gagal, denda $50 wajib dibayar otomatis.</span>
                </div>
              </div>
            ` : ''}

            <!-- Daftar Tindakan -->
            <div class="jail-actions-list">
              <!-- Opsi 1: Bayar Denda $50 -->
              <button id="btn-jail-bail" class="btn-jail-action bail ${hasMoney && canAct ? '' : 'disabled'}" ${hasMoney && canAct ? '' : 'disabled'} type="button">
                <div class="jail-btn-icon-wrap">💵</div>
                <div class="jail-btn-content">
                  <div class="jail-btn-title">Bayar Denda $${BAIL_COST}</div>
                  <div class="jail-btn-desc">${hasMoney ? 'Bebas seketika & langsung melempar dadu' : 'Saldo tidak mencukupi ($' + player.money.toLocaleString('id-ID') + ')'}</div>
                </div>
                <span class="jail-btn-chevron">➔</span>
              </button>

              <!-- Opsi 2: Coba Lempar Double -->
              <button id="btn-jail-double" class="btn-jail-action double ${canAct ? '' : 'disabled'}" ${canAct ? '' : 'disabled'} type="button">
                <div class="jail-btn-icon-wrap">🎲</div>
                <div class="jail-btn-content">
                  <div class="jail-btn-title">Coba Lempar Double</div>
                  <div class="jail-btn-desc">Bebas tanpa bayar jika angka kedua dadu kembar (Sisa: ${attemptsLeft}x)</div>
                </div>
                <span class="jail-btn-chevron">➔</span>
              </button>

              <!-- Opsi 3: Kartu Bebas Penjara -->
              ${hasCard ? `
                <button id="btn-jail-card" class="btn-jail-action card ${canAct ? '' : 'disabled'}" ${canAct ? '' : 'disabled'} type="button">
                  <div class="jail-btn-icon-wrap">🎟️</div>
                  <div class="jail-btn-content">
                    <div class="jail-btn-title">Gunakan Kartu Bebas Penjara</div>
                    <div class="jail-btn-desc">Miliki ${player.hasGetOutOfJailCard} kartu. Langsung bebas tanpa biaya!</div>
                  </div>
                  <span class="jail-btn-chevron">➔</span>
                </button>
              ` : ''}
            </div>
          </div>
        </div>
      `;

      this.overlay.classList.remove('hidden');
      requestAnimationFrame(() => this.overlay.classList.add('visible'));

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('jailmodal:opened', { detail: { player } }));
      }

      // Handler Tombol Bayar Denda
      const btnBail = document.getElementById('btn-jail-bail');
      if (btnBail) {
        btnBail.onclick = createActionGuard(() => {
          if (multiplayer) return options.onAction('PAY_BAIL');
          this.close();
          resolve({ action: 'PAY_BAIL' });
        });
      }

      // Handler Tombol Coba Double
      const btnDouble = document.getElementById('btn-jail-double');
      if (btnDouble) {
        btnDouble.onclick = createActionGuard(() => {
          if (multiplayer) return options.onAction('TRY_DOUBLE');
          this.close();
          resolve({ action: 'TRY_DOUBLE' });
        });
      }

      // Handler Tombol Kartu Bebas Penjara
      const btnCard = document.getElementById('btn-jail-card');
      if (btnCard) {
        btnCard.onclick = createActionGuard(() => {
          if (multiplayer) return options.onAction('USE_CARD');
          this.close();
          resolve({ action: 'USE_CARD' });
        });
      }
      this.overlay.querySelector('.jail-readonly-close')?.addEventListener('click', () => this.close());
    });
  }

  close() {
    if (!this.overlay) return;
    this.overlay.classList.remove('visible');
    setTimeout(() => {
      if (this.overlay) this.overlay.classList.add('hidden');
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('jailmodal:closed'));
      }
    }, 200);
  }
}

export const jailModalManager = new JailModalManager();
