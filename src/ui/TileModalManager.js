import {PlayerStatus} from '../logic/GameState.js';
import {clientGameStore} from '../state/ClientGameStore.js';
import {economyManager, TransactionType} from '../logic/EconomyManager.js';
import {propertyManager} from '../logic/PropertyManager.js';
import {auctionManager} from '../logic/AuctionManager.js';
import {bankruptcyModalManager} from './BankruptcyModalManager.js';
import {drawChanceCard} from '../data/cards.js';
import {COL} from '../config.js';
import {TILES} from '../data/tiles.js';
import {toast, buildHud} from './hud.js';
import {createActionGuard} from '../logic/ActionGuard.js';
import {isLocalAuctionBidder, parseCustomAuctionBid} from './MultiplayerAuction.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const formatAuctionMoney = value => `$${Number(value || 0).toLocaleString('id-ID')}`;

export class TileModalManager {
  constructor() {
    this.overlay = null;
    this.minimized = false;
    this.restoreBtn = null;
    this.currentPropName = '';
    this.closeTimer = null;
    this.displayedChanceResolutionIds = new Set();
    this.displayedRentResolutionIds = new Set();
    this.authoritativeAuctionId = null;
    this.authoritativeChanceAutoCloseTimer = null;
    this.currentChancePresentationId = null;
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
    clearTimeout(this.authoritativeChanceAutoCloseTimer);
    this.authoritativeChanceAutoCloseTimer = null;
    if (!this.overlay) return;
    clearTimeout(this.closeTimer);
    this.minimized = false;
    this.currentChancePresentationId = null;
    this._removeRestoreButton();
    this.overlay.classList.remove('minimized');
    this.overlay.classList.remove('visible');
    this.closeTimer = setTimeout(() => {
      this.overlay.classList.add('hidden');
      this.overlay.innerHTML = '';
      this.closeTimer = null;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('tilemodal:closed'));
      }
    }, 220);
  }

  _showContent(html, propName = '') {
    // A new modal arriving during the previous close animation must not be
    // cleared by that previous close timer.
    clearTimeout(this.closeTimer);
    this.closeTimer = null;
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
  showAuthoritativeChanceCard(event, {canContinue = true, onContinue = null, autoCloseMs = 3200} = {}) {
    const card = event?.card;
    const presentationId = event?.presentationId || event?.resolutionId;
    if (!card || typeof presentationId !== 'string' || this.displayedChanceResolutionIds.has(presentationId)) return false;
    this.displayedChanceResolutionIds.add(presentationId);
    this.currentChancePresentationId = presentationId;
    const money = value => `$${Number(value || 0).toLocaleString('id-ID')}`;
    const amountLabels = {
      MONEY_GAIN: `+${money(card.amount)} (Pemasukan)`,
      MONEY_LOSS: `-${money(card.amount)} (Pengeluaran)`,
      PAY_EACH_PLAYER: `Bayar ${money(card.amount)} ke tiap pemain`,
      COLLECT_FROM_EACH_PLAYER: `Terima ${money(card.amount)} dari tiap pemain`,
      REPAIR_BUILDINGS: `Biaya renovasi ${money(card.houseCost)} per rumah, ${money(card.hotelCost)} per hotel`
    };
    const resultLabel = amountLabels[card.type] || (canContinue
      ? 'Lanjutkan untuk menerapkan efek kartu' : 'Pemain aktif sedang membaca kartu');
    const resultClass = ['MONEY_LOSS', 'PAY_EACH_PLAYER', 'REPAIR_BUILDINGS'].includes(card.type) ? 'loss' : 'gain';
    const html = `
      <div class="tile-modal-card chance-card">
        <div class="tile-modal-top-bar" style="background:#8b5cf6">
          <div class="tile-modal-top-info"><span>🎴 KARTU KESEMPATAN</span><span class="top-bar-sub">Presentasi kartu online</span></div>
          <button type="button" class="btn-tile-minimize" title="Perkecil modal" aria-label="Minimize"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="2.5" y1="8" x2="13.5" y2="8"/></svg></button>
        </div>
        <div class="tile-modal-body text-center chance-modal-body">
          <div class="chance-card-icon">${card.icon || '🎴'}</div>
          <h3 class="chance-card-title">${card.title}</h3>
          <p class="chance-card-desc">${card.desc}</p>
          <div class="chance-effect-badge ${resultClass}">${resultLabel}</div>
        <div class="tile-modal-actions chance-actions">${canContinue
            ? '<button id="btn-chance-authoritative-ok" class="btn-primary-action">Lanjutkan</button>'
            : '<span class="chance-viewing-hint">Pemain aktif sedang membaca kartu…</span>'}</div>
        </div>
      </div>`;
    this._showContent(html, `Kesempatan: ${card.title}`);
    const button = document.getElementById('btn-chance-authoritative-ok');
    if (button) button.onclick = async () => {
      if (button.disabled || typeof onContinue !== 'function') return;
      button.disabled = true;
      button.textContent = 'Memproses…';
      const result = await onContinue();
      if (result?.ok) this.close();
      else if (button.isConnected) {
        button.disabled = false;
        button.textContent = 'Lanjutkan';
        if (result?.message) {
          const status = this.overlay.querySelector('.chance-effect-badge');
          if (status) status.textContent = result.message;
        }
      }
    };
    if (!canContinue) {
      clearTimeout(this.authoritativeChanceAutoCloseTimer);
      this.authoritativeChanceAutoCloseTimer = setTimeout(() => {
        if (this.currentChancePresentationId === presentationId && this.displayedChanceResolutionIds.has(presentationId)) this.close();
      }, autoCloseMs);
    }
    return true;
  }

  showAuthoritativeRentResult(event) {
    const rent = event?.rent;
    const resolutionId = event?.resolutionId;
    if (!rent || typeof resolutionId !== 'string' || this.displayedRentResolutionIds.has(resolutionId)) return false;
    this.displayedRentResolutionIds.add(resolutionId);
    const format = value => `$${Number(value || 0).toLocaleString('id-ID')}`;
    const paid = rent.outcome === 'PAID';
    const insufficient = rent.outcome === 'INSUFFICIENT_FUNDS';
    const title = paid ? 'SEWA TELAH DIBAYAR' : insufficient ? 'SALDO SEWA TIDAK CUKUP' : 'PROPERTI DIGADAIKAN';
    const status = paid
      ? `${rent.tenantName} membayar ${format(rent.amount)} kepada ${rent.ownerName}.`
      : insufficient
        ? `${rent.tenantName} kekurangan saldo. Giliran ditahan sampai penyelesaian utang tersedia.`
        : `Tidak ada sewa yang dibayar kepada ${rent.ownerName}.`;
    const nextPlayer = clientGameStore.getActivePlayer()?.name || '—';
    const turnStatus = event.phase === 'DEBT_RESOLUTION'
      ? 'Menunggu penyelesaian utang'
      : `Giliran berikutnya: ${nextPlayer}`;
    const html = `
      <div class="tile-modal-card chance-card">
        <div class="tile-modal-top-bar" style="background:#0f766e">
          <div class="tile-modal-top-info"><span>HASIL PEMBAYARAN SEWA</span><span class="top-bar-sub">Pembayaran selesai</span></div>
          <button type="button" class="btn-tile-minimize" title="Perkecil modal" aria-label="Minimize"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="2.5" y1="8" x2="13.5" y2="8"/></svg></button>
        </div>
        <div class="tile-modal-body text-center chance-modal-body">
          <h3 class="chance-card-title">${title}</h3>
          <div class="tile-details-box">
            <div class="modal-detail-row"><span>Penyewa:</span><b>${rent.tenantName}</b></div>
            <div class="modal-detail-row"><span>Pemilik:</span><b>${rent.ownerName}</b></div>
            <div class="modal-detail-row"><span>Properti:</span><b>${rent.propertyName}</b></div>
            <div class="modal-detail-row"><span>Jumlah sewa:</span><b class="price-highlight">${format(rent.amount)}</b></div>
            <div class="modal-detail-row"><span>Saldo ${rent.tenantName}:</span><b>${format(rent.tenantBalance)}</b></div>
            <div class="modal-detail-row"><span>Saldo ${rent.ownerName}:</span><b>${format(rent.ownerBalance)}</b></div>
          </div>
          <p>${status}</p><div class="chance-effect-badge ${paid ? 'gain' : 'loss'}">${turnStatus}</div>
          <div class="tile-modal-actions chance-actions"><button id="btn-rent-authoritative-ok" class="btn-primary-action">Lanjutkan</button></div>
        </div>
      </div>`;
    this._showContent(html, `Sewa: ${rent.propertyName}`);
    const button = document.getElementById('btn-rent-authoritative-ok');
    if (button) button.onclick = () => this.close();
    return true;
  }

  promptPurchase(prop, player, {onDecision = null} = {}) {
    return new Promise((resolve) => {
      const authoritative = typeof onDecision === 'function';
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
              <button id="${authoritative ? 'btn-decline-prop' : 'btn-auction-prop'}" class="btn-secondary-action">
                ⚖️ Lewati (Masuk Lelang)
              </button>
            </div>
          </div>
        </div>
      `;

      this._showContent(html, prop.name);

      const btnBuy = document.getElementById('btn-buy-prop');
      const btnAuction = document.getElementById('btn-auction-prop');

      if (authoritative) {
        const btnDecline = document.getElementById('btn-decline-prop');
        if (btnDecline) btnDecline.textContent = 'Masuk Lelang';
        const submitDecision = createActionGuard(async decision => {
          if (btnBuy) btnBuy.disabled = true;
          if (btnDecline) btnDecline.disabled = true;
          const response = await onDecision(decision);
          if (!response?.ok) {
            toast(response?.error?.message || 'Keputusan belum dapat diproses.');
            if (response?.expired) {
              this.close();
              resolve({action: 'EXPIRED'});
              return true;
            }
            if (btnBuy) btnBuy.disabled = !canAfford;
            if (btnDecline) btnDecline.disabled = false;
            return false;
          }
          if (response.auctionStarted) {
            resolve({action: 'AUCTION_STARTED'});
            return true;
          }
          this.close();
          resolve({action: decision});
          return true;
        });
        if (btnBuy && canAfford) btnBuy.onclick = () => submitDecision('BUY');
        if (btnDecline) btnDecline.onclick = () => submitDecision('DECLINE');
        return;
      }

      if (btnBuy && canAfford) {
        btnBuy.onclick = createActionGuard(() => {
          // 1. Potong saldo
          const purchase = propertyManager.purchaseProperty(prop.pos, player.id);
          if (!purchase.success) {
            toast(`⚠️ ${purchase.reason}`);
            return;
          }

          // 2. Set kepemilikan
          buildHud();

          this.close();
          resolve({ action: 'BUY', player, prop });
        });
      }

      if (btnAuction) {
        btnAuction.onclick = createActionGuard(() => {
          this.close();
          // Lanjut ke sistem lelang
          setTimeout(() => {
            this.promptAuction(prop).then(auctionRes => {
              resolve({ action: 'AUCTION', result: auctionRes });
            });
          }, 240);
        });
      }
    });
  }

  showAuthoritativeAuction(auction, {localPlayerId, onAction, minimumBid, quickBids} = {}) {
    if (!auction?.auctionId || !Array.isArray(auction.activeBidders)) return false;
    this.authoritativeAuctionId = auction.auctionId;
    const activeId = auction.currentBidderId;
    const isMyTurn = isLocalAuctionBidder(auction, localPlayerId);
    const property = clientGameStore.getProperty(auction.propertyPos);
    const format = value => `$${Number(value || 0).toLocaleString('id-ID')}`;
    const minBid = Number.isSafeInteger(minimumBid) ? minimumBid : (auction.highestBidderId ? auction.highestBid + 1 : 1);
    const suggestions = Array.isArray(quickBids) ? quickBids : [minBid];
    const activeIds = new Set(auction.activeBidders.map(player => player.playerId));
    const participants = Array.isArray(auction.participants) ? auction.participants : auction.activeBidders;
    const participantNames = participants.map(player => {
      const active = activeIds.has(player.playerId);
      const leader = player.playerId === auction.highestBidderId;
      const label = active ? (leader ? 'Penawar tertinggi' : 'Aktif') : 'PASS';
      return `<span class="auction-player-chip ${active ? 'active' : 'passed'}" title="${label}">${escapeHtml(player.name)}${leader ? ' ★' : ''}${active ? '' : ' · PASS'}</span>`;
    }).join('');
    const currentBidder = auction.activeBidders.find(player => player.playerId === activeId);
    const passedCount = Math.max(0, participants.length - auction.activeBidders.length);
    const actions = isMyTurn
      ? `<div class="auction-controls">
          <div class="auction-bid-buttons">${suggestions.map((amount, index) => `<button type="button" class="btn-bid-step" data-bid="${amount}" ${currentBidder?.money < amount ? 'disabled' : ''}>Tawar ${format(amount)}${index === 0 && auction.highestBidderId ? ' (+10)' : ''}</button>`).join('')}</div>
          <div class="auction-custom-bid"><label for="authoritative-auction-bid">Nominal khusus (min. ${format(minBid)})</label>
            <input id="authoritative-auction-bid" type="number" inputmode="numeric" min="${minBid}" step="1" placeholder="Masukkan tawaran">
            <button id="authoritative-auction-submit" class="btn-primary-action">Tawar nominal</button></div>
          <button id="authoritative-auction-pass" class="btn-pass-action">PASS (Lewati lelang)</button>
        </div>`
      : `<div class="chance-effect-badge auction-waiting-turn">Menunggu ${escapeHtml(auction.activeBidders.find(player => player.playerId === activeId)?.name || 'pemain')} menawar</div>`;
    const html = `<div class="tile-modal-card auction-card">
      <div class="tile-modal-top-bar" style="background:${COL[property?.group] || '#334155'}">
        <div class="tile-modal-top-info"><span>⚖️ LELANG PROPERTI</span><span class="top-bar-sub">Harga asli: ${format(auction.propertyPrice)} · ${auction.activeBidders.length} penawar aktif · ${passedCount} PASS</span></div>
        <button type="button" class="btn-tile-minimize" title="Perkecil modal" aria-label="Minimize"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="2.5" y1="8" x2="13.5" y2="8"/></svg></button>
      </div><div class="tile-modal-body">
        <h3 class="tile-prop-title">${escapeHtml(auction.propertyName)}</h3>
        <div class="tile-details-box"><div class="modal-detail-row"><span>Tawaran tertinggi</span><b>${format(auction.highestBid)}</b></div>
          <div class="modal-detail-row"><span>Penawar tertinggi</span><b>${escapeHtml(auction.highestBidder?.name || 'Belum ada')}</b></div>
          <div class="modal-detail-row"><span>Giliran lelang</span><b>${escapeHtml(currentBidder?.name || '—')}</b></div>
          <div class="modal-detail-row"><span>Tawaran minimum berikutnya</span><b>${format(minBid)}</b></div></div>
        <div class="auction-participants-info">Peserta: ${participantNames}</div>
        ${currentBidder && isMyTurn ? `<div class="bidder-balance">Saldo Anda: <b>${format(currentBidder.money)}</b></div>` : ''}${actions}
      </div></div>`;
    this._showContent(html, `Lelang: ${auction.propertyName}`);
    const submit = document.getElementById('authoritative-auction-submit');
    const pass = document.getElementById('authoritative-auction-pass');
    const input = document.getElementById('authoritative-auction-bid');
    let actionPending = false;
    const setControlsDisabled = disabled => {
      this.overlay?.querySelectorAll('.auction-controls button, .auction-controls input').forEach(control => { control.disabled = disabled; });
    };
    const sendAuctionAction = async (action, amount = null) => {
      if (actionPending) return false;
      actionPending = true;
      setControlsDisabled(true);
      let response;
      try {
        response = await onAction?.(action, amount, auction);
      } catch (error) {
        response = {ok: false, error: {message: error?.message || 'Koneksi lelang terputus.'}};
      }
      if (!response?.ok) {
        toast(response?.error?.message || 'Tawaran tidak dapat diproses.');
        if (this.authoritativeAuctionId === auction.auctionId) {
          this.showAuthoritativeAuction(clientGameStore.activeAuction?.auctionId === auction.auctionId ? clientGameStore.activeAuction : auction,
            {localPlayerId, onAction, minimumBid, quickBids});
        }
        return false;
      }
      return true;
    };
    this.overlay?.querySelectorAll('.btn-bid-step').forEach(button => {
      button.onclick = createActionGuard(() => sendAuctionAction('BID', Number(button.dataset.bid)));
    });
    if (submit) submit.onclick = createActionGuard(async () => {
      const amount = parseCustomAuctionBid(input?.value, minBid);
      if (amount === null) { toast(`Masukkan nominal bulat minimal ${format(minBid)}.`); return false; }
      return sendAuctionAction('BID', amount);
    });
    if (input) input.onkeydown = event => {
      if (event.key === 'Enter' && submit && !submit.disabled) submit.click();
    };
    if (pass) pass.onclick = createActionGuard(() => sendAuctionAction('PASS'));
    return true;
  }

  showAuthoritativeAuctionResult(result) {
    if (!result?.auctionId || this.authoritativeAuctionId !== result.auctionId) return false;
    const winner = result.winner;
    const status = winner ? `${escapeHtml(winner.name)} memenangkan ${escapeHtml(result.property?.name)}.` : 'Tidak ada pemain yang menawar. Properti tetap milik Bank.';
    const html = `<div class="tile-modal-card auction-card finish"><div class="tile-modal-top-bar" style="background:#334155"><div class="tile-modal-top-info"><span>LELANG SELESAI</span><span class="top-bar-sub">Hasil lelang</span></div></div><div class="tile-modal-body text-center"><div class="finish-icon">${winner ? '🏆' : '🏛️'}</div><h3 class="tile-prop-title">${winner ? 'Lelang dimenangkan' : 'Properti tidak terjual'}</h3><p class="finish-desc">${status}</p>${winner ? `<div class="finish-price-tag">Harga akhir: <b>${formatAuctionMoney(result.amount)}</b></div>` : ''}<div class="tile-details-box">${(result.balances || []).map(item => {
      const player = clientGameStore.getPlayer(item.playerId);
      return `<div class="modal-detail-row"><span>Saldo ${escapeHtml(player?.name || '')}</span><b>${formatAuctionMoney(item.money)}</b></div>`;
    }).join('')}</div></div></div>`;
    this._showContent(html, `Hasil lelang: ${result.property?.name || 'Properti'}`);
    const auctionId = result.auctionId;
    setTimeout(() => {
      if (this.authoritativeAuctionId !== auctionId) return;
      this.authoritativeAuctionId = null;
      this.close();
    }, 2400);
    return true;
  }

  closeAuthoritativeAuction(auctionId) {
    if (this.authoritativeAuctionId !== auctionId) return false;
    this.authoritativeAuctionId = null;
    this.close();
    return true;
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
      <div class="tile-modal-card auction-card${currentBidder?.isBot ? ' bot-turn' : ''}">
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
            ${currentBidder?.isBot ? '<div class="bot-thinking">🤖 Bot sedang menimbang tawaran…</div>' : ''}
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
      btn.onclick = createActionGuard(() => {
        const val = Number(btn.dataset.bid);
        auctionManager.placeBid(val, currentBidder?.id ?? null);
        this._renderAuctionRoom();
      });
    });

    const btnPass = document.getElementById('btn-auction-pass');
    if (btnPass) {
      btnPass.onclick = createActionGuard(() => {
        auctionManager.pass(currentBidder?.id ?? null);
        this._renderAuctionRoom();
      });
    }

    const btnCustom = document.getElementById('btn-auction-custom');
    const inputCustom = document.getElementById('auction-custom-input');
    if (btnCustom && inputCustom) {
      btnCustom.onclick = createActionGuard(() => {
        const val = Number(inputCustom.value);
        if (!val || val < 1) { toast('⚠️ Masukkan nominal tawaran yang valid.'); return; }
        const res = auctionManager.placeBid(val, currentBidder?.id ?? null);
        if (!res) toast('⚠️ Tawaran tidak valid. Harus lebih tinggi dari tawaran saat ini atau saldo tidak cukup.');
        this._renderAuctionRoom();
      });
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
        btnPay.onclick = createActionGuard(async () => {
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
                const paid = economyManager.transferMoney(
                  tenant.id,
                  owner.id,
                  rentAmount,
                  `Bayar sewa ${prop.name}`,
                  TransactionType.RENT
                );
                if (!paid) {
                  toast(`⚠️ Saldo masih belum cukup untuk membayar sewa ${prop.name}.`);
                  resolve({ tenant, owner, rentAmount: 0, bankrupt: true });
                  return;
                }
                buildHud();
                resolve({ tenant, owner, rentAmount, bankrupt: false });
              } else {
                resolve({ tenant, owner, rentAmount: 0, bankrupt: true });
              }
            }, 220);
            return;
          }

          // Transfer uang normal via EconomyManager
          const paid = economyManager.transferMoney(
            tenant.id,
            owner.id,
            rentAmount,
            `Bayar sewa ${prop.name}`,
            TransactionType.RENT
          );
          if (!paid) {
            toast(`⚠️ Pembayaran sewa ${prop.name} gagal.`);
            return false;
          }

          buildHud();

          this.close();
          resolve({ tenant, owner, rentAmount, bankrupt: false });
        });
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
        btnOk.onclick = createActionGuard(async () => {
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
              toast(`🔨 Membayar biaya renovasi: -$${totalCost} (${hCount}x Rumah, ${htCount}x Hotel)`);
            }
            buildHud();
            resolve(card);
          }
          // 5. Bayar ke Setiap Pemain
          else if (card.type === 'PAY_EACH_PLAYER') {
            const opponents = clientGameStore.getPlayers().filter(p => p.id !== player.id && p.status === PlayerStatus.ACTIVE);
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
            const opponents = clientGameStore.getPlayers().filter(p => p.id !== player.id && p.status === PlayerStatus.ACTIVE);
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
        });
      }
    });
  }
}

export const tileModalManager = new TileModalManager();
