export function getAnimatedBalanceChanges(changes, transactions = [], players = []) {
  const salaryByPlayerName = new Map();
  for (const transaction of transactions) if (transaction.type === 'SALARY') {
    const recipient = transaction.players?.[0];
    if (recipient) salaryByPlayerName.set(recipient,
      (salaryByPlayerName.get(recipient) || 0) + transaction.amount);
  }
  return changes.map(change => {
    const player = players.find(item => item.playerId === change.playerId);
    return {...change, delta: change.delta - (salaryByPlayerName.get(player?.name) || 0)};
  }).filter(change => change.delta !== 0);
}

/** Holds rent presentation until the associated authoritative pawn animation settles. */
export class MovementMoneyPresentation {
  constructor({store, present}) {
    this.store = store;
    this.present = present;
    this.pendingPayments = new Map();
  }

  handleBalanceChange(payload) {
    const movementPayment = payload.transactions.some(transaction => ['RENT', 'TAX'].includes(transaction.type));
    const movementId = movementPayment && (payload.change?.detail?.movementId || this.store.lastMovementId);
    const movement = movementId && this.store.presentation.movements.get(movementId);
    if (movementPayment && movement?.status === 'ANIMATING') {
      this.pendingPayments.set(movementId, payload);
      return;
    }
    this.present(payload);
  }

  handleStoreChange(change) {
    if (change.type === 'snapshot') {
      this.pendingPayments.clear();
      return;
    }
    if (change.type !== 'movement-animation-complete') return;
    const movementId = change.detail?.movementId;
    const pending = this.pendingPayments.get(movementId);
    if (!pending) return;
    this.pendingPayments.delete(movementId);
    this.present(pending);
  }

  clear() { this.pendingPayments.clear(); }
}
