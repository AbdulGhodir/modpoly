// Mengubah kode/pesan error teknis dari server menjadi kalimat yang mudah dimengerti pemain.
const BY_CODE = {
  NOT_CONNECTED: 'Belum tersambung. Tunggu sebentar lalu coba lagi.',
  TIMEOUT: 'Koneksi sedang lambat. Coba lagi sebentar lagi.',
  INVALID_RESPONSE: 'Terjadi kendala. Coba lagi.',
  RATE_LIMITED: 'Terlalu cepat! Tunggu sebentar lalu coba lagi.',
  ROOM_NOT_FOUND: 'Ruangan tidak ditemukan atau sudah ditutup. Periksa lagi kodenya.',
  ROOM_FULL: 'Ruangan sudah penuh (maksimal 4 pemain).',
  ROOM_STARTED: 'Permainan di ruangan ini sudah dimulai.',
  ROOM_CAPACITY: 'Sedang ramai. Coba buat ruangan lagi sebentar lagi.',
  ROOM_CODE_UNAVAILABLE: 'Kode ruangan belum bisa dibuat. Coba lagi.',
  INVALID_ROOM_CODE: 'Kode ruangan terdiri dari 6 huruf/angka. Periksa lagi kodenya.',
  ALREADY_IN_ROOM: 'Kamu masih berada di ruangan lain. Keluar dulu sebelum bergabung ke ruangan baru.',
  HOST_ONLY: 'Hanya pembuat ruangan yang bisa melakukan ini.',
  PLAYERS_NOT_READY: 'Semua pemain harus menekan "Siap" dulu.',
  NOT_ENOUGH_PLAYERS: 'Butuh minimal 2 pemain untuk mulai. Tambahkan teman atau bot.',
  NOT_IN_ROOM: 'Kamu sudah tidak berada di ruangan ini.',
  INVALID_SESSION: 'Sesi bermainmu sudah berakhir. Silakan bergabung ke ruangan lagi.',
  SESSION_EXPIRED: 'Sesi bermainmu sudah berakhir. Silakan bergabung ke ruangan lagi.',
  SESSION_ALREADY_MOVED: 'Permainan ini sedang dibuka di perangkat lain.',
  SESSION_ROOM_MISMATCH: 'Sesi bermainmu sudah berakhir. Silakan bergabung ke ruangan lagi.',
  BOT_NOT_FOUND: 'Bot tidak ditemukan.',
  BOT_TRADE_UNAVAILABLE: 'Bot tidak menerima tukar aset.',
  GAME_STATE_CREATION_FAILED: 'Permainan belum bisa dimulai. Coba lagi.'
};
const GENERIC = 'Terjadi kendala. Coba lagi.';
const TECHNICAL = /\b(turnId|actionId|resolutionId|presentationId|auctionId|tradeId|payload|snapshot|socket|socket\.io|GameState|token sesi)\b/i;

/** Merapikan pesan yang kodenya tidak ada di daftar (istilah teknis diganti kata sehari-hari). */
export function softenMessage(message) {
  if (typeof message !== 'string' || !message.trim()) return GENERIC;
  if (TECHNICAL.test(message)) return GENERIC;
  return message
    .replace(/\bRoom\b/g, 'Ruangan').replace(/\broom\b/g, 'ruangan')
    .replace(/\bHost\b/g, 'Pembuat ruangan').replace(/\bhost\b/g, 'pembuat ruangan')
    .replace(/\bServer\b/g, 'Game').replace(/\bserver\b/g, 'game')
    .replace(/\bReady\b/g, 'Siap').replace(/\bready\b/g, 'siap');
}

/** @returns {string} pesan ramah untuk ditampilkan ke pemain. */
export function friendlyMessage(error) {
  if (!error) return GENERIC;
  if (error.code && BY_CODE[error.code]) return BY_CODE[error.code];
  if (/^INVALID_/.test(error.code || '')) return GENERIC;
  return softenMessage(error.message);
}

/** Salin respons gagal dengan pesan yang sudah dirapikan (pesan asli tetap ada di rawMessage). */
export function friendlyResponse(response) {
  if (!response || response.ok !== false || !response.error) return response;
  return {...response, error: {...response.error, rawMessage: response.error.message, message: friendlyMessage(response.error)}};
}
