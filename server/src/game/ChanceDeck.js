import {CHANCE_CARDS} from '../../../src/data/cards.js';

/** A private Chance deck for one server game/room. */
export class ChanceDeck {
  constructor({cards = CHANCE_CARDS, random = Math.random} = {}) {
    this.cards = cards.map(card => ({...card}));
    this.random = random;
    this.discardPile = [];
    this.activeDeck = this._shuffle(this.cards);
  }

  _shuffle(cards) {
    const deck = [...cards];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  draw() {
    if (!this.activeDeck.length) {
      this.activeDeck = this._shuffle(this.discardPile.length ? this.discardPile : this.cards);
      this.discardPile = [];
    }
    const card = this.activeDeck.shift();
    if (card.type !== 'GET_OUT_OF_JAIL') this.discardPile.push(card);
    return card ? {...card} : null;
  }

  returnGetOutOfJailCard() {
    const card = this.cards.find(candidate => candidate.type === 'GET_OUT_OF_JAIL');
    if (card) this.discardPile.push(card);
  }

  toSnapshot() {
    return {activeDeck: this.activeDeck.map(card => card.id), discardPile: this.discardPile.map(card => card.id)};
  }

  static fromSnapshot(snapshot, {cards = CHANCE_CARDS, random = Math.random} = {}) {
    if (!snapshot || !Array.isArray(snapshot.activeDeck) || !Array.isArray(snapshot.discardPile)) {
      throw new Error('Snapshot deck Kesempatan tidak valid.');
    }
    const cardMap = new Map(cards.map(card => [card.id, {...card}]));
    const ids = [...snapshot.activeDeck, ...snapshot.discardPile];
    if (ids.some(id => typeof id !== 'string' || !cardMap.has(id)) || new Set(ids).size !== ids.length) {
      throw new Error('Snapshot deck Kesempatan berisi kartu tidak valid atau duplikat.');
    }
    const deck = Object.create(ChanceDeck.prototype);
    deck.cards = cards.map(card => ({...card}));
    deck.random = random;
    deck.activeDeck = snapshot.activeDeck.map(id => ({...cardMap.get(id)}));
    deck.discardPile = snapshot.discardPile.map(id => ({...cardMap.get(id)}));
    return deck;
  }
}
