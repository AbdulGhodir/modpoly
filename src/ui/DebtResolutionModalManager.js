import {clientGameStore} from '../state/ClientGameStore.js';
import {confirmDialog} from './dialog.js';
import {socketClient} from '../network/SocketClient.js';
import {createActionGuard} from '../logic/ActionGuard.js';
import {bankruptcyModalManager} from './BankruptcyModalManager.js';
import {toast} from './hud.js';

const money = value => `$${Number(value || 0).toLocaleString('id-ID')}`;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));

export class DebtResolutionModalManager {
  constructor({store = clientGameStore, client = socketClient} = {}) {
    this.store = store;
    this.client = client;
    this.overlay = null;
    this.localPlayerId = null;
    this.activeRoom = null;
    this.requestPending = false;
    this.initDOM();
    this.unsubscribe = store.subscribe(({change}) => {
      if (['debt-created', 'debt-updated', 'debt-resolved', 'rent-resolved', 'snapshot',
        'movement-animation-complete', 'chance-presentation-complete', 'rent-presentation-complete'].includes(change.type)) {
        this.presentWhenReady();
      }
      if (change.type === 'debt-resolved' && change.detail?.result?.winner) {
        const winner = this.store.getPlayer(change.detail.result.winner.playerId);
        if (winner) bankruptcyModalManager.showVictoryModal(winner);
      }
    });
    globalThis.window?.addEventListener?.('tilemodal:closed', () => this.presentWhenReady());
    globalThis.window?.addEventListener?.('modal:closed', () => this.presentWhenReady());
  }

  setContext({getActiveRoom, getLocalPlayerId}) {
    this.activeRoom = getActiveRoom;
    this.localPlayerId = getLocalPlayerId;
    this.presentWhenReady();
  }

  initDOM() {
    if (typeof document === 'undefined') return;
    this.overlay = document.getElementById('multiplayer-debt-overlay');
    if (this.overlay) return;
    this.overlay = document.createElement('div');
    this.overlay.id = 'multiplayer-debt-overlay';
    this.overlay.className = 'tile-modal-overlay hidden';
    document.body.appendChild(this.overlay);
  }

  isOpen() { return Boolean(this.overlay && !this.overlay.classList.contains('hidden')); }

  presentWhenReady() {
    const debt = this.store.pendingDebt;
    if (!debt || this.activeRoom?.()?.status !== 'started') {
      if (!debt && this.isOpen()) this.close();
      return;
    }
    if (this.localPlayerId?.() !== debt.playerId) {
      if (this.isOpen()) this.close();
      return;
    }
    if (this.store.presentation.movement?.status === 'ANIMATING' || this.store.presentation.chancePending ||
        this.store.presentation.rentPending || globalThis.document?.querySelector('.tile-modal-overlay:not(.hidden):not(#multiplayer-debt-overlay)')) return;
    this.render(debt);
  }

  render(debt) {
    if (!this.overlay) this.initDOM();
    if (!this.overlay) return;
    const canAct = this.localPlayerId?.() === debt.playerId && !this.requestPending;
    const sellButtons = (debt.sellActions || []).map(item => `
      <button class="btn-quick-liquidate debt-action" data-action="${item.action}" data-pos="${item.propertyPos}" ${canAct ? '' : 'disabled'}>
        ${item.action === 'SELL_HOTEL' ? 'Jual hotel' : 'Jual 1 rumah'} (+${money(item.refund)})
      </button>`).join('');
    const mortgageButtons = (debt.mortgageActions || []).map(item => `
      <button class="btn-quick-liquidate debt-action" data-action="MORTGAGE" data-pos="${item.propertyPos}" ${canAct ? '' : 'disabled'}>
        Gadai properti (+${money(item.amount)})
      </button>`).join('');
    const recipients = (debt.paymentRecipients || []).map(item =>
      `<div class="debt-row"><span>${escapeHtml(item.name)}:</span><b>${money(item.amount)}</b></div>`).join('');
    this.overlay.innerHTML = `
      <div class="tile-modal-card debt-card visible">
        <div class="tile-modal-header" style="background:linear-gradient(135deg,#b91c1c,#991b1b)">
          <div class="tile-modal-icon">⚠️</div><div class="tile-modal-title-group"><h3>PENYELESAIAN UTANG</h3>
          <span class="jail-status-tag">${escapeHtml(debt.playerName)}</span></div>
        </div>
        <div class="tile-modal-body">
          <div class="debt-summary-box">
            <div class="debt-row"><span>Kewajiban:</span><b>${money(debt.amount)}</b></div>
            <div class="debt-row"><span>Kreditur:</span><b>${escapeHtml(debt.creditorName)}</b></div>
            <div class="debt-row"><span>Keterangan:</span><b>${escapeHtml(debt.description)}</b></div>
            ${debt.chanceCard ? `<div class="debt-row"><span>Kartu:</span><b>${escapeHtml(debt.chanceCard.id)} · ${escapeHtml(debt.chanceCard.desc)}</b></div>` : ''}
            ${recipients ? `<div class="debt-row"><span>Penerima pembayaran:</span><b></b></div>${recipients}` : ''}
            <div class="debt-row"><span>Saldo saat ini:</span><b>${money(debt.playerBalance)}</b></div>
            <div class="debt-row"><span>Kekurangan:</span><b>${money(Math.max(0, debt.amount - debt.playerBalance))}</b></div>
          </div>
          ${!canAct ? '<p>Menunggu pemain yang berutang menyelesaikan kewajibannya.</p>' : ''}
          ${sellButtons ? `<div class="liquidation-section-title">Jual bangunan (50% biaya bangun)</div><div class="debt-liquidation-list">${sellButtons}</div>` : ''}
          ${mortgageButtons ? `<div class="liquidation-section-title">Gadaikan properti</div><div class="debt-liquidation-list">${mortgageButtons}</div>` : ''}
          <div class="debt-footer-actions">
            <button class="btn-primary-action" data-action="PAY" ${canAct && debt.canPay ? '' : 'disabled'}>Bayar utang (${money(debt.amount)})</button>
            ${debt.canDeclareBankruptcy ? `<button class="btn-bankruptcy-action debt-action" data-action="BANKRUPTCY" ${canAct ? '' : 'disabled'}>Nyatakan bangkrut</button>` : ''}
          </div>
        </div>
      </div>`;
    this.overlay.classList.remove('hidden');
    requestAnimationFrame(() => this.overlay?.classList.add('visible'));
    this.overlay.querySelectorAll('[data-action]').forEach(button => {
      button.onclick = createActionGuard(async () => this.sendAction(button, debt));
    });
  }

  async sendAction(button, debt) {
    if (this.localPlayerId?.() !== debt.playerId || this.requestPending) return false;
    const action = button.getAttribute('data-action');
    const propertyPos = button.hasAttribute('data-pos') ? Number(button.getAttribute('data-pos')) : undefined;
    if (action === 'BANKRUPTCY' && !(await confirmDialog({title: 'Menyerah dan bangkrut?', icon: '💥', tone: 'danger',
      message: `Kamu akan dinyatakan bangkrut kepada ${debt.creditorName} dan keluar dari permainan.`,
      confirmText: 'Ya, bangkrut', cancelText: 'Jangan dulu'}))) return false;
    this.requestPending = true;
    this.render({...debt, playerBalance: this.store.getBalance(debt.playerId)});
    let response;
    try {
      response = await this.client.request('game:debt-action', {
        turnId: debt.turnId, debtId: debt.debtId,
        actionId: globalThis.crypto?.randomUUID?.() || `debt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        action, ...(propertyPos === undefined ? {} : {propertyPos})
      });
    } catch (error) {
      this.requestPending = false;
      this.render(this.store.pendingDebt || debt);
      toast(error?.message || 'Koneksi terputus saat menyelesaikan utang.');
      return false;
    }
    this.requestPending = false;
    if (!response.ok) {
      this.render(this.store.pendingDebt || debt);
      toast(response.error?.message || 'Aksi utang gagal.');
      return false;
    }
    if (action === 'PAY' || action === 'BANKRUPTCY') this.close();
    else if (this.store.pendingDebt) this.render(this.store.pendingDebt);
    return true;
  }

  close() {
    if (!this.overlay) return;
    this.overlay.classList.remove('visible');
    setTimeout(() => this.overlay?.classList.add('hidden'), 200);
  }
}

export const debtResolutionModalManager = new DebtResolutionModalManager();
