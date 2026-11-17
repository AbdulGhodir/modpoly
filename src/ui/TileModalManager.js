import {gameState, PlayerStatus} from '../logic/GameState.js';
import {economyManager, TransactionType} from '../logic/EconomyManager.js';
import {propertyManager} from '../logic/PropertyManager.js';
import {auctionManager} from '../logic/AuctionManager.js';
import {bankruptcyModalManager} from './BankruptcyModalManager.js';
import {drawChanceCard} from '../data/cards.js';
import {COL} from '../config.js';
import {TILES} from '../data/tiles.js';
import {toast, buildHud} from './hud.js';

export class TileModalManager {
  constructor() {
    this.overlay = null;
    this.minimized = false;
    this.restoreBtn = null;
    this.currentPropName = '';
    this.initDOM();
  }

  initDOM() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('tile-modal-overlay')) {
      this.overlay = document.getElementById('tile-modal-overlay');
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'tile-modal-overlay';
    overlay.className = 'tile-modal-overlay hidden';
    document.body.appendChild(overlay);
    this.overlay = overlay;
  }

  isOpen() {
    return this.overlay && !this.overlay.classList.contains('hidden');
  }

  isMinimized() {
    return !!this.minimized;
  }

  minimize() {
    if (!this.isOpen() || this.minimized) return;
    this.minimized = true;

    // Sembunyikan modal overlay
    this.overlay.classList.add('minimized');

    // Tampilkan tombol compact restore di bagian bawah layar
    this._showRestoreButton();

    toast('Modal properti diminimize. Buka kembali melalui tombol di bawah.');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('tilemodal:minimized'));
    }
  }

  restore() {
    if (!this.minimized) return;
    this.minimized = false;

    // Tampilkan kembali modal overlay
    this.overlay.classList.remove('minimized');

    // Hapus tombol restore dari layar
    this._removeRestoreButton();

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('tilemodal:restored'));
    }
  }

  _showRestoreButton() {
    this._removeRestoreButton();

    const title = this.currentPropName || 'Properti';
    const restoreBtn = document.createElement('button');
    restoreBtn.id = 'tile-modal-restore-btn';
    restoreBtn.className = 'tile-modal-restore-pill pulse';
    restoreBtn.type = 'button';
    restoreBtn.title = 'Buka kembali modal properti';
    restoreBtn.innerHTML = `
      <span class="restore-icon">🏢</span>
      <span class="restore-label">Buka Modal: <b>${title}</b></span>
      <span class="restore-chevron">▲</span>
    `;

    restoreBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.restore();
    };

    document.body.appendChild(restoreBtn);
    this.restoreBtn = restoreBtn;
  }

  _removeRestoreButton() {
    if (this.restoreBtn) {
      this.restoreBtn.remove();
      this.restoreBtn = null;
    }
    const el = document.getElementById('tile-modal-restore-btn');
    if (el) el.remove();
  }

  close() {
    if (!this.overlay) return;
    this.minimized = false;
    this._removeRestoreButton();
    this.overlay.classList.remove('minimized');
    this.overlay.classList.remove('visible');
    setTimeout(() => {
      this.overlay.classList.add('hidden');
      this.overlay.innerHTML = '';
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('tilemodal:closed'));
      }
    }, 220);
  }

  _showContent(html, propName = '') {
    if (propName) {
      this.currentPropName = propName;
    }
    this.overlay.innerHTML = html;
    this.overlay.classList.remove('hidden');

    // Hubungkan tombol minimize jika ada di top bar
    const minBtn = this.overlay.querySelector('.btn-tile-minimize');
    if (minBtn) {
      minBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.minimize();
      };
    }

    requestAnimationFrame(() => {
      if (!this.minimized) {
        this.overlay.classList.add('visible');
      }
      const card = this.overlay.querySelector('.tile-modal-card');
      if (card) card.classList.add('visible');
    });

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('tilemodal:opened'));
    }
  }

  // ========================================================
  // 1. POPUP PEMBELIAN PROPERTI
  // ========================================================
  promptPurchase(prop, player) {
    return new Promise((resolve) => {
      const colorBar = COL[prop.group] || (prop.type === 'rail' ? '#334155' : '#0284c7');
      const typeLabel = prop.type === 'prop' ? 'Kota' : (prop.type === 'rail' ? 'Stasiun Kereta' : 'Utilitas Perusahaan');
      const canAfford = player.money >= prop.price;

      let rentInfo = '';
      if (prop.type === 'prop') {
        rentInfo = `Sewa Dasar: <b>$${prop.rent.base}</b> (Hotel: $${prop.rent.hotel})`;
      } else if (prop.type === 'rail') {
        rentInfo = `Sewa 1 Stasiun: <b>$${prop.rent.count1}</b> (4 Stasiun: $${prop.rent.count4})`;
      } else {
        rentInfo = `Faktor Dadu: <b>${prop.rent.factor1}x</b> (2 Utilitas: ${prop.rent.factor2}x)`;
      }

      const buildInfo = prop.type === 'prop'
        ? `<div class="modal-detail-row"><span>Biaya Rumah / Hotel:</span><b>$${prop.housePrice} / unit</b></div>`
        : '';

      const html = `
        <div class="tile-modal-card">
          <div class="tile-modal-top-bar" style="background:${colorBar}">
            <div class="tile-modal-top-info">
              <span>${typeLabel}</span>
              <span class="top-bar-sub">Tersedia untuk Dibeli</span>
            </div>
            <button type="button" class="btn-tile-minimize" title="Perkecil modal untuk melihat papan" aria-label="Minimize"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="2.5" y1="8" x2="13.5" y2="8"/></svg></button>
          </div>

          <div class="tile-modal-body">
            <h3 class="tile-prop-title">${prop.name}</h3>
            <p class="tile-prop-subtitle">Properti ini belum bertuan. Jadilah pemilik pertamanya!</p>

            <div class="tile-details-box">
              <div class="modal-detail-row">
                <span>Harga Pembelian:</span>
                <b class="price-highlight">$${prop.price.toLocaleString('id-ID')}</b>
              </div>
              <div class="modal-detail-row">
                <span>Tarif Sewa:</span>
                <span>${rentInfo}</span>
              </div>
              ${buildInfo}
              <div class="modal-detail-row">
                <span>Nilai Gadai (Hipotek):</span>
                <b>$${prop.mortgageValue.toLocaleString('id-ID')}</b>
              </div>
            </div>

            <div class="player-balance-strip" style="--c:${player.color}">
              <span>Saldo ${player.name}:</span>
              <b>💰 $${player.money.toLocaleString('id-ID')}</b>
            </div>

            ${!canAfford ? '<div class="alert-insufficient">⚠️ Saldo Anda tidak mencukupi untuk membeli properti ini langsung.</div>' : ''}

            <div class="tile-modal-actions">
              <button id="btn-buy-prop" class="btn-primary-action" ${!canAfford ? 'disabled' : ''}>
                💰 Beli Properti ($${prop.price})
              </button>
              <button id="btn-auction-prop" class="btn-secondary-action">
                ⚖️ Lewati (Masuk Lelang)
              </button>
            </div>
          </div>
        </div>
      `;

      this._showContent(html, prop.name);

      const btnBuy = document.getElementById('btn-buy-prop');
      const btnAuction = document.getElementById('btn-auction-prop');

      if (btnBuy && canAfford) {
        btnBuy.onclick = () => {
          // 1. Potong saldo
          economyManager.deductMoney(
            player.id,
            prop.price,
            `Membeli properti ${prop.name} seharga $${prop.price}`,
            TransactionType.BUY_PROP
          );

          // 2. Set kepemilikan
          propertyManager.setOwner(prop.pos, player.id);

          toast(`🎉 ${player.name} berhasil membeli ${prop.name}!`);
          buildHud();

          this.close();
          resolve({ action: 'BUY', player, prop });
        };
      }

      if (btnAuction) {
        btnAuction.onclick = () => {
          this.close();
          // Lanjut ke sistem lelang
          setTimeout(() => {
            this.promptAuction(prop).then(auctionRes => {
              resolve({ action: 'AUCTION', result: auctionRes });
            });
          }, 240);
        };
      }
    });
  }

  // ========================================================
  // 2. SISTEM LELANG PROPERTI (AUCTION ROOM)
  // ========================================================
  promptAuction(prop) {
    return new Promise((resolve) => {
      auctionManager.startAuction(prop, (result) => {
        // Rendering the result must not prevent the auction promise from settling.
        try {
          this._renderAuctionFinished(result);
        } catch (error) {
          console.error('[TileModalManager] Gagal menampilkan hasil lelang:', error);
        }
        setTimeout(() => {
          try {
            this.close();
          } finally {
            resolve(result);
          }
        }, 2200);
      });

      this._renderAuctionRoom();
    });
  }

  _renderAuctionRoom() {
    const state = auctionManager.getAuctionState();
    if (!state.isActive) return;

    const prop = state.property;
    const colorBar = COL[prop.group] || (prop.type === 'rail' ? '#334155' : '#0284c7');
    const currentBidder = state.currentBidder;
    const highestBid = state.highestBid;
    const highestBidder = state.highestBidder;

    const minNextBid = highestBidder ? highestBid + 10 : highestBid;

    const html = `
      <div class="tile-modal-card auction-card">
        <div class="tile-modal-top-bar" style="background:${colorBar}">
          <div class="tile-modal-top-info">
            <span>⚖️ BALAI LELANG PROPERTI</span>
            <span class="top-bar-sub">Harga Asli: $${prop.price}</span>
          </div>
          <button type="button" class="btn-tile-minimize" title="Perkecil modal untuk melihat papan" aria-label="Minimize"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="2.5" y1="8" x2="13.5" y2="8"/></svg></button>
        </div>

        <div class="tile-modal-body">
          <h3 class="tile-prop-title">${prop.name}</h3>

          <!-- Kotak Tawaran Tertinggi Saat Ini -->
          <div class="auction-highest-box">
            <span class="lbl-small">Tawaran Tertinggi Saat Ini</span>
            <div class="highest-bid-val">$${highestBid.toLocaleString('id-ID')}</div>
            <div class="highest-bidder-name">
              ${highestBidder ? `Dipimpin oleh: <b style="color:${highestBidder.color}">${highestBidder.name}</b>` : '<i>Belum ada tawaran masuk (Tawaran awal)</i>'}
            </div>
          </div>

          <!-- Giliran Penawar Saat Ini -->
          <div class="auction-turn-box" style="border-left: 5px solid ${currentBidder ? currentBidder.color : '#888'}">
            <div class="bidder-header">
              <span>Giliran Menawar:</span>
              <b style="color:${currentBidder ? currentBidder.color : '#000'}">${currentBidder ? currentBidder.name : '-'}</b>
            </div>
            <div class="bidder-balance">
              Saldo: <b>$${currentBidder ? currentBidder.money.toLocaleString('id-ID') : 0}</b>
            </div>
          </div>

          <!-- Opsi Penawaran Tambahan -->
          <div class="auction-bid-buttons">
            <button class="btn-bid-step" data-bid="${minNextBid}" ${(!currentBidder || currentBidder.money < minNextBid) ? 'disabled' : ''}>
              Tawar $${minNextBid.toLocaleString('id-ID')}
            </button>
            <button class="btn-bid-step" data-bid="${minNextBid + 25}" ${(!currentBidder || currentBidder.money < minNextBid + 25) ? 'disabled' : ''}>
              Tawar $${(minNextBid + 25).toLocaleString('id-ID')}
            </button>
            <button class="btn-bid-step" data-bid="${minNextBid + 50}" ${(!currentBidder || currentBidder.money < minNextBid + 50) ? 'disabled' : ''}>
              Tawar $${(minNextBid + 50).toLocaleString('id-ID')}
            </button>
          </div>

          <div class="auction-custom-bid">
            <input type="number" id="auction-custom-input" min="${minNextBid}" placeholder="Nominal kustom (min $${minNextBid})..." />
            <button id="btn-auction-custom" class="btn-secondary-action" ${!currentBidder ? 'disabled' : ''}>
              Tawar Kustom
            </button>
          </div>

          <div class="auction-footer-actions">
            <button id="btn-auction-pass" class="btn-pass-action">
              ❌ PASS (Lewati Lelang)
            </button>
          </div>

          <div class="auction-participants-info">
            Penawar aktif: <b>${state.totalActiveBidders} pemain</b>${state.passedCount > 0 ? ` &nbsp;•&nbsp; <span style="color:#94a3b8;font-size:12px;">${state.passedCount} sudah PASS</span>` : ''}
          </div>
        </div>
      </div>
    `;

    this._showContent(html, `Lelang ${prop.name}`);

    // Bind event tombol tawaran
    this.overlay.querySelectorAll('.btn-bid-step').forEach(btn => {
      btn.onclick = () => {
        const val = Number(btn.dataset.bid);
        auctionManager.placeBid(val);
        this._renderAuctionRoom();
      };
    });

    const btnPass = document.getElementById('btn-auction-pass');
    if (btnPass) {
      btnPass.onclick = () => {
        auctionManager.pass();
        this._renderAuctionRoom();
      };
    }

    const btnCustom = document.getElementById('btn-auction-custom');
    const inputCustom = document.getElementById('auction-custom-input');
    if (btnCustom && inputCustom) {
      btnCustom.onclick = () => {
        const val = Number(inputCustom.value);
        if (!val || val < 1) { toast('⚠️ Masukkan nominal tawaran yang valid.'); return; }
        const res = auctionManager.placeBid(val);
        if (!res) toast('⚠️ Tawaran tidak valid. Harus lebih tinggi dari tawaran saat ini atau saldo tidak cukup.');
        this._renderAuctionRoom();
      };
    }
  }

  _renderAuctionFinished(result) {
    const html = `
      <div class="tile-modal-card auction-card finish">
        <div class="tile-modal-body text-center">
          <div class="finish-icon">${result.hasWinner ? '🏆' : '🏛️'}</div>
          <h3 class="tile-prop-title">${result.hasWinner ? 'Lelang Selesai!' : 'Lelang Berakhir'}</h3>
          <p class="finish-desc">${result.message}</p>
          ${result.hasWinner ? `<div class="finish-price-tag">Harga Final: <b>$${result.price.toLocaleString('id-ID')}</b></div>` : ''}
        </div>
      </div>
    `;
    this._showContent(html, `Lelang ${result.property?.name || 'Properti'}`);
  }

  // ========================================================
  // 3. POPUP PEMBAYARAN SEWA PROPERTI
  // ========================================================
  promptRent(prop, tenant, owner, rentAmount) {
    return new Promise((resolve) => {
      if (tenant.money >= rentAmount) {
        const paid = economyManager.transferMoney(tenant.id, owner.id, rentAmount,
          `Bayar sewa ${prop.name}`, TransactionType.RENT);
        if (paid) {
          toast(`💸 ${tenant.name} membayar sewa $${rentAmount.toLocaleString('id-ID')} ke ${owner.name}`);
          buildHud();
          resolve({ tenant, owner, rentAmount, bankrupt: false });
        } else resolve({ tenant, owner, rentAmount: 0, bankrupt: true });
        return;
      }
      const colorBar = COL[prop.group] || (prop.type === 'rail' ? '#334155' : '#0284c7');
      const canAfford = tenant.money >= rentAmount;

      let breakdown = 'Sewa Tanah Dasar';
      if (prop.type === 'prop') {
        if (prop.hasHotel) breakdown = 'Sewa Hotel Bintang Lima';
        else if (prop.houses > 0) breakdown = `Sewa dengan ${prop.houses} Rumah`;
        else if (propertyManager.isColorGroupMonopoly(owner.id, prop.group)) breakdown = 'Sewa Monopoli Warna (2x Lipat)';
      } else if (prop.type === 'rail') {
        const count = propertyManager.getAllProperties().filter(p => p.type === 'rail' && p.owner === owner.id).length;
        breakdown = `Sewa ${count} Stasiun Kereta Terhubung`;
      } else {
        breakdown = `Sewa Utilitas x Total Dadu`;
      }

      const html = `
        <div class="tile-modal-card">
          <div class="tile-modal-top-bar" style="background:${colorBar}">
            <div class="tile-modal-top-info">
              <span>TAGIHAN SEWA PROPERTI</span>
              <span class="top-bar-sub">Milik ${owner.name}</span>
            </div>
            <button type="button" class="btn-tile-minimize" title="Perkecil modal untuk melihat papan" aria-label="Minimize"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="2.5" y1="8" x2="13.5" y2="8"/></svg></button>
          </div>

          <div class="tile-modal-body">
            <h3 class="tile-prop-title">${prop.name}</h3>
            <p class="tile-prop-subtitle">${tenant.name} mendarat di properti milik ${owner.name}.</p>

            <!-- Box Transfer Penyewa ke Pemilik -->
            <div class="rent-flow-box">
              <div class="party-box">
                <span class="party-role">Penyewa</span>
                <b style="color:${tenant.color}">${tenant.name}</b>
                <small>Saldo: $${tenant.money.toLocaleString('id-ID')}</small>
              </div>
              <div class="rent-arrow">➔ 💸 ➔</div>
              <div class="party-box">
                <span class="party-role">Pemilik</span>
                <b style="color:${owner.color}">${owner.name}</b>
                <small>Saldo: $${owner.money.toLocaleString('id-ID')}</small>
              </div>
            </div>

            <div class="tile-details-box">
              <div class="modal-detail-row">
                <span>Rincian Biaya:</span>
                <span>${breakdown}</span>
              </div>
              <div class="modal-detail-row">
                <span>Total Sewa yang Wajib Dibayar:</span>
                <b class="price-highlight" style="color:#dc2626">$${rentAmount.toLocaleString('id-ID')}</b>
              </div>
            </div>

            ${!canAfford ? '<div class="alert-insufficient">⚠️ Saldo tidak mencukupi! Anda harus melikuidasi aset atau menyatakan bangkrut.</div>' : ''}

            <div class="tile-modal-actions">
              <button id="btn-pay-rent" class="btn-primary-action pay-rent-btn">
                ${canAfford ? `💸 Bayar Sewa ($${rentAmount.toLocaleString('id-ID')})` : '⚠️ Selesaikan Utang / Likuidasi Aset'}
              </button>
            </div>
          </div>
        </div>
      `;

      this._showContent(html, `Sewa: ${prop.name}`);

      const btnPay = document.getElementById('btn-pay-rent');
      if (btnPay) {
        btnPay.onclick = async () => {
          if (tenant.money < rentAmount) {
            this.close();
            setTimeout(async () => {
              const debtRes = await bankruptcyModalManager.promptDebtResolution(
                tenant,
                owner,
                rentAmount,
                `Sewa ${prop.name}`
              );

              if (debtRes.resolved) {
                economyManager.transferMoney(
                  tenant.id,
                  owner.id,
                  rentAmount,
                  `Bayar sewa ${prop.name}`,
                  TransactionType.RENT
                );
                toast(`💸 ${tenant.name} berhasil melunasi sewa $${rentAmount.toLocaleString('id-ID')} ke ${owner.name}`);
                buildHud();
                resolve({ tenant, owner, rentAmount, bankrupt: false });
              } else {
                resolve({ tenant, owner, rentAmount: 0, bankrupt: true });
              }
            }, 220);
            return;
          }

          // Transfer uang normal via EconomyManager
          economyManager.transferMoney(
            tenant.id,
            owner.id,
            rentAmount,
            `Bayar sewa ${prop.name}`,
            TransactionType.RENT
          );

          toast(`💸 ${tenant.name} membayar sewa $${rentAmount.toLocaleString('id-ID')} ke ${owner.name}`);
          buildHud();

          this.close();
          resolve({ tenant, owner, rentAmount, bankrupt: false });
        };
      }
    });
  }

  // ========================================================
  // 4. POPUP KARTU KESEMPATAN (CHANCE CARD)
  // ========================================================
  promptChanceCard(player) {
    return new Promise((resolve) => {
      const card = drawChanceCard();

      let badgeHtml = '';
      if (card.type === 'MONEY_GAIN') {
        badgeHtml = `<div class="chance-effect-badge gain">+ $${card.amount} (Pemasukan)</div>`;
      } else if (card.type === 'MONEY_LOSS') {
        badgeHtml = `<div class="chance-effect-badge loss">- $${card.amount} (Pengeluaran)</div>`;
      } else if (card.type === 'MOVE_TO') {
        const destName = TILES[card.targetPos]?.nama || `Petak #${card.targetPos}`;
        badgeHtml = `<div class="chance-effect-badge gain">🚗 Berpindah ke ${destName}</div>`;
      } else if (card.type === 'MOVE_BACKWARD') {
        badgeHtml = `<div class="chance-effect-badge loss">↩️ Mundur ${card.steps} Petak</div>`;
      } else if (card.type === 'REPAIR_BUILDINGS') {
        badgeHtml = `<div class="chance-effect-badge loss">🔨 Renovasi ($${card.houseCost}/Rumah, $${card.hotelCost}/Hotel)</div>`;
      } else if (card.type === 'PAY_EACH_PLAYER') {
        badgeHtml = `<div class="chance-effect-badge loss">💸 Bayar $${card.amount} ke Tiap Pemain</div>`;
      } else if (card.type === 'COLLECT_FROM_EACH_PLAYER') {
        badgeHtml = `<div class="chance-effect-badge gain">💰 Terima $${card.amount} dari Tiap Pemain</div>`;
      } else if (card.type === 'GET_OUT_OF_JAIL') {
        badgeHtml = `<div class="chance-effect-badge gain">🎟️ Kartu Bebas Penjara Disimpan</div>`;
      }

      const html = `
        <div class="tile-modal-card chance-card">
          <div class="tile-modal-top-bar" style="background:#8b5cf6">
            <div class="tile-modal-top-info">
              <span>🎴 KARTU KESEMPATAN</span>
              <span class="top-bar-sub">Kejutan Acak</span>
            </div>
            <button type="button" class="btn-tile-minimize" title="Perkecil modal untuk melihat papan" aria-label="Minimize"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="2.5" y1="8" x2="13.5" y2="8"/></svg></button>
          </div>

          <div class="tile-modal-body text-center chance-modal-body">
            <div class="chance-card-icon">${card.icon || '🎴'}</div>
            <h3 class="chance-card-title">${card.title}</h3>
            <p class="chance-card-desc">${card.desc}</p>

            ${badgeHtml}

            <div class="tile-modal-actions chance-actions">
              <button id="btn-chance-ok" class="btn-primary-action">
                Ambil Kartu & Jalankan Efek ➔
              </button>
            </div>
          </div>
        </div>
      `;

      this._showContent(html, `Kesempatan: ${card.title}`);

      const btnOk = document.getElementById('btn-chance-ok');
      if (btnOk) {
        btnOk.onclick = async () => {
          this.close();

          // 1. Uang Masuk
          if (card.type === 'MONEY_GAIN') {
            economyManager.addMoney(player.id, card.amount, card.desc, TransactionType.CARD_REWARD || TransactionType.CHANCE);
            toast(`🎉 ${card.desc} (+$${card.amount})`);
            buildHud();
            resolve(card);
          }
          // 2. Uang Keluar
          else if (card.type === 'MONEY_LOSS') {
            if (player.money < card.amount) {
              const debtRes = await bankruptcyModalManager.promptDebtResolution(player, null, card.amount, card.desc);
              if (debtRes.resolved) {
                economyManager.deductMoney(player.id, card.amount, card.desc, TransactionType.CARD_PENALTY || TransactionType.CHANCE);
              }
            } else {
              economyManager.deductMoney(player.id, card.amount, card.desc, TransactionType.CARD_PENALTY || TransactionType.CHANCE);
              toast(`💸 ${card.desc} (-$${card.amount})`);
            }
            buildHud();
            resolve(card);
          }
          // 3. Kartu Bebas Penjara
          else if (card.type === 'GET_OUT_OF_JAIL') {
            player.hasGetOutOfJailCard = (player.hasGetOutOfJailCard || 0) + 1;
            toast('🎟️ Kartu Bebas Penjara berhasil disimpan di inventaris Anda!');
            buildHud();
            resolve(card);
          }
          // 4. Biaya Perbaikan Bangunan
          else if (card.type === 'REPAIR_BUILDINGS') {
            const pProps = propertyManager.getPlayerProperties(player.id);
            let hCount = 0;
            let htCount = 0;
            pProps.forEach(p => {
              if (p.hasHotel) htCount++;
              else hCount += (p.houses || 0);
            });
            const totalCost = (hCount * card.houseCost) + (htCount * card.hotelCost);

            if (totalCost === 0) {
              toast('🏡 Anda belum memiliki rumah/hotel. Biaya perbaikan $0.');
            } else if (player.money < totalCost) {
              const debtRes = await bankruptcyModalManager.promptDebtResolution(player, null, totalCost, `${card.desc} ($${totalCost})`);
              if (debtRes.resolved) {
                economyManager.deductMoney(player.id, totalCost, card.desc, TransactionType.CARD_PENALTY || TransactionType.CHANCE);
              }
            } else {
              economyManager.deductMoney(player.id, totalCost, card.desc, TransactionType.CARD_PENALTY || TransactionType.CHANCE);
              toast(`🔨 Membayar biaya renovasi: -$$${totalCost} (${hCount}x Rumah, ${htCount}x Hotel)`);
            }
            buildHud();
            resolve(card);
          }
          // 5. Bayar ke Setiap Pemain
          else if (card.type === 'PAY_EACH_PLAYER') {
            const opponents = gameState.players.filter(p => p.id !== player.id && p.status === PlayerStatus.ACTIVE);
            const totalCost = opponents.length * card.amount;

            if (player.money < totalCost) {
              const debtRes = await bankruptcyModalManager.promptDebtResolution(player, null, totalCost, card.desc);
              if (debtRes.resolved) {
                opponents.forEach(op => {
                  economyManager.transferMoney(player.id, op.id, card.amount, card.desc, TransactionType.CARD_PENALTY || TransactionType.CHANCE);
                });
              }
            } else {
              opponents.forEach(op => {
                economyManager.transferMoney(player.id, op.id, card.amount, card.desc, TransactionType.CARD_PENALTY || TransactionType.CHANCE);
              });
              toast(`🍽️ Membayar $${card.amount} ke setiap pemain aktif!`);
            }
            buildHud();
            resolve(card);
          }
          // 6. Terima dari Setiap Pemain
          else if (card.type === 'COLLECT_FROM_EACH_PLAYER') {
            const opponents = gameState.players.filter(p => p.id !== player.id && p.status === PlayerStatus.ACTIVE);
            let totalReceived = 0;
            opponents.forEach(op => {
              const pay = Math.min(op.money, card.amount);
              if (pay > 0) {
                economyManager.transferMoney(op.id, player.id, pay, card.desc, TransactionType.CARD_REWARD || TransactionType.CHANCE);
                totalReceived += pay;
              }
            });
            toast(`🎂 Menerima total $${totalReceived.toLocaleString('id-ID')} dari ${opponents.length} pemain aktif!`);
            buildHud();
            resolve(card);
          }
          // 7. Berpindah Posisi (MOVE_TO)
          else if (card.type === 'MOVE_TO') {
            const targetPos = card.targetPos;
            if (typeof window !== 'undefined') {
              await new Promise(done => {
                window.dispatchEvent(new CustomEvent('player:animate_move', {
                  detail: {
                    playerId: player.id,
                    targetPos,
                    clockwise: true,
                    awardStartBonus: true,
                    resolveTile: true,
                    onComplete: done
                  }
                }));
              });
            }
            resolve(card);
          }
          // 8. Mundur Posisi (MOVE_BACKWARD)
          else if (card.type === 'MOVE_BACKWARD') {
            const targetPos = (player.pos - card.steps + 40) % 40;
            if (typeof window !== 'undefined') {
              await new Promise(done => {
                window.dispatchEvent(new CustomEvent('player:animate_move', {
                  detail: {
                    playerId: player.id,
                    targetPos,
                    steps: card.steps,
                    clockwise: false,
                    awardStartBonus: false,
                    resolveTile: true,
                    onComplete: done
                  }
                }));
              });
            }
            resolve(card);
          } else {
            resolve(card);
          }
        };
      }
    });
  }
}

export const tileModalManager = new TileModalManager();
