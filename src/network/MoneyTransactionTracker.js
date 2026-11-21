/** Observe only accepted, newly recorded transactions; snapshots establish a quiet baseline. */
export class MoneyTransactionTracker {
  constructor({store, isMultiplayer, onBalanceChange}) {
    this.store = store;
    this.isMultiplayer = isMultiplayer;
    this.onBalanceChange = onBalanceChange;
    this.seenTransactionIds = new Set();
    this.balances = new Map();
    this.roomCode = store.roomCode;
    this.seed();
    this.unsubscribe = store.subscribe(({change}) => this.handleChange(change));
  }

  seed({resetTransactionIds = false} = {}) {
    if (resetTransactionIds) this.seenTransactionIds.clear();
    this.balances = new Map(this.store.getPlayers().map(player => [player.playerId, player.money]));
    for (const transaction of this.store.getState().transactions) {
      if (typeof transaction?.id === 'string') this.seenTransactionIds.add(transaction.id);
    }
  }

  handleChange(change = {}) {
    const roomCode = this.store.roomCode;
    if (change.type === 'snapshot' || roomCode !== this.roomCode) {
      this.roomCode = roomCode;
      this.seed({resetTransactionIds: true});
      return;
    }
    if (!this.isMultiplayer?.()) {
      this.seed();
      return;
    }

    const transactions = this.store.getState().transactions;
    const added = [];
    const addedTransactions = [];
    for (const transaction of transactions) {
      const id = transaction?.id;
      if (typeof id !== 'string' || !id || this.seenTransactionIds.has(id)) continue;
      this.seenTransactionIds.add(id);
      added.push(id);
      addedTransactions.push(transaction);
    }
    if (!added.length) return;

    const changes = [];
    for (const player of this.store.getPlayers()) {
      const previous = this.balances.get(player.playerId);
      const delta = Number.isFinite(previous) ? player.money - previous : 0;
      if (delta !== 0) changes.push({playerId: player.playerId, delta});
      this.balances.set(player.playerId, player.money);
    }
    if (changes.length) this.onBalanceChange?.({roomCode, transactionIds: added, transactions: addedTransactions, changes, change});
  }

  destroy() { this.unsubscribe?.(); }
}

export function initMoneyTransactionTracker(options) {
  return new MoneyTransactionTracker(options);
}
