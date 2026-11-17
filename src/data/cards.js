export const CHANCE_CARDS = [
  {
    id: 'ch_1',
    title: 'KARTU KESEMPATAN',
    desc: 'Juara 1 Lomba Desain Batik Nusantara! Dapatkan hadiah dari Bank.',
    amount: 100,
    type: 'MONEY_GAIN',
    icon: '🎨'
  },
  {
    id: 'ch_2',
    title: 'KARTU KESEMPATAN',
    desc: 'Denda Tilang Elektronik & Uji Emisi. Bayar denda ke Bank.',
    amount: 50,
    type: 'MONEY_LOSS',
    icon: '🚗'
  },
  {
    id: 'ch_3',
    title: 'KARTU KESEMPATAN',
    desc: 'Maju langsung ke petak START! Ambil gaji $200.',
    type: 'MOVE_TO',
    targetPos: 0,
    icon: '🏁'
  },
  {
    id: 'ch_4',
    title: 'KARTU KESEMPATAN',
    desc: 'Perjalanan dinas ke Stasiun Gambir (Petak 5)! Jika lewat START, ambil $200.',
    type: 'MOVE_TO',
    targetPos: 5,
    icon: '🚆'
  },
  {
    id: 'ch_5',
    title: 'KARTU KESEMPATAN',
    desc: 'Liburan ke Denpasar Bali (Petak 24)! Nikmati pantai.',
    type: 'MOVE_TO',
    targetPos: 24,
    icon: '🏖️'
  },
  {
    id: 'ch_6',
    title: 'KARTU KESEMPATAN',
    desc: 'Kunjungan kerja ke Utilitas PLN (Petak 12).',
    type: 'MOVE_TO',
    targetPos: 12,
    icon: '⚡'
  },
  {
    id: 'ch_7',
    title: 'KARTU KESEMPATAN',
    desc: 'Kemacetan parah! Mundur 3 petak ke belakang.',
    type: 'MOVE_BACKWARD',
    steps: 3,
    icon: '↩️'
  },
  {
    id: 'ch_8',
    title: 'KARTU KESEMPATAN',
    desc: 'Biaya Perbaikan Rumah & Renovasi. Bayar $25 tiap Rumah dan $100 tiap Hotel.',
    type: 'REPAIR_BUILDINGS',
    houseCost: 25,
    hotelCost: 100,
    icon: '🔨'
  },
  {
    id: 'ch_9',
    title: 'KARTU KESEMPATAN',
    desc: 'Pajak Pemeliharaan Lingkungan Properti. Bayar $40 tiap Rumah dan $115 tiap Hotel.',
    type: 'REPAIR_BUILDINGS',
    houseCost: 40,
    hotelCost: 115,
    icon: '🏡'
  },
  {
    id: 'ch_10',
    title: 'KARTU KESEMPATAN',
    desc: 'Dividen Saham Investasi BUMN cair! Terima keuntungan dari Bank.',
    amount: 150,
    type: 'MONEY_GAIN',
    icon: '📈'
  },
  {
    id: 'ch_11',
    title: 'KARTU KESEMPATAN',
    desc: 'Biaya Tambahan Tiket Pesawat & Bagasi. Bayar ke Bank.',
    amount: 50,
    type: 'MONEY_LOSS',
    icon: '✈️'
  },
  {
    id: 'ch_12',
    title: 'KARTU KESEMPATAN',
    desc: 'Terpilih sebagai Pengusaha Berprestasi Teladan! Dapatkan penghargaan dari Bank.',
    amount: 100,
    type: 'MONEY_GAIN',
    icon: '🏅'
  },
  {
    id: 'ch_13',
    title: 'KARTU KESEMPATAN',
    desc: 'Donasi Bantuan Bencana Alam & Kemanusiaan. Sumbangkan dana ke Bank.',
    amount: 50,
    type: 'MONEY_LOSS',
    icon: '🤝'
  },
  {
    id: 'ch_14',
    title: 'KARTU KESEMPATAN',
    desc: 'Traktir Makan Malam! Bayar $50 kepada setiap pemain lain yang masih aktif.',
    amount: 50,
    type: 'PAY_EACH_PLAYER',
    icon: '🍽️'
  },
  {
    id: 'ch_15',
    title: 'KARTU KESEMPATAN',
    desc: 'Hari Ulang Tahun Anda! Setiap pemain lain memberikan kado uang $50 kepada Anda.',
    amount: 50,
    type: 'COLLECT_FROM_EACH_PLAYER',
    icon: '🎂'
  },
  {
    id: 'ch_16',
    title: 'KARTU KESEMPATAN',
    desc: 'KARTU BEBAS PENJARA! Simpan kartu ini untuk keluar dari penjara secara gratis.',
    type: 'GET_OUT_OF_JAIL',
    icon: '🎟️'
  }
];

// Fisher-Yates Shuffle
function shuffleDeck(cards) {
  const deck = [...cards];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

let activeDeck = shuffleDeck(CHANCE_CARDS);
let discardPile = [];

export function resetChanceDeck() {
  activeDeck = shuffleDeck(CHANCE_CARDS);
  discardPile = [];
}

export function drawChanceCard() {
  if (activeDeck.length === 0) {
    if (discardPile.length === 0) {
      activeDeck = shuffleDeck(CHANCE_CARDS);
    } else {
      activeDeck = shuffleDeck(discardPile);
      discardPile = [];
    }
  }

  const card = activeDeck.shift();

  // Kartu bebas penjara tidak langsung masuk discard pile, melainkan disimpan pemain
  if (card.type !== 'GET_OUT_OF_JAIL') {
    discardPile.push(card);
  }

  return card;
}

export function returnGetOutOfJailCard() {
  const jailCard = CHANCE_CARDS.find(c => c.type === 'GET_OUT_OF_JAIL');
  if (jailCard) {
    discardPile.push(jailCard);
  }
}
