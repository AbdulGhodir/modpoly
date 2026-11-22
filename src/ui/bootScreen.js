// Loading screen: (1) menyiapkan papan -> (2) menunggu server gratisan bangun -> lobi.
// Pemain bisa memilih "Main Lokal" kapan saja tanpa menunggu server.

const HINT_AFTER_MS = 6000;
const LONG_WAIT_MS = 90000;
const WAKE_PING_EVERY_MS = 5000;

export function initBootScreen({client, openLocal} = {}) {
  const root = document.getElementById('boot-screen');
  if (!root) return {boardReady() {}, dismiss() {}};

  const caption = root.querySelector('.caption');
  const serverBox = root.querySelector('#boot-server');
  const serverStatus = root.querySelector('#boot-server-status');
  const serverHint = root.querySelector('#boot-server-hint');
  const localButton = root.querySelector('#boot-local');

  let phase = 'board'; // board -> server -> done
  let wantLocal = false;
  let dismissed = false;
  let startedAt = Date.now();
  let ticker = null;
  let pinger = null;
  let removeStatusListener = () => {};

  const url = (client?.url || '').replace(/\/+$/, '');

  function stopTimers() {
    clearInterval(ticker);
    clearInterval(pinger);
    ticker = pinger = null;
  }

  function dismiss({local = false} = {}) {
    if (dismissed) return;
    dismissed = true;
    phase = 'done';
    stopTimers();
    removeStatusListener();
    window.__gameReady = true;
    document.body.classList.remove('app-loading');
    document.body.classList.add('app-ready');
    window.setTimeout(() => root.remove(), 350);
    if (local) {
      try { openLocal?.(); } catch (error) { console.error('[boot] openLocal failed', error); }
    }
  }

  // Server gratisan tidur kalau sepi. Request HTTP biasa ikut membangunkan container,
  // jadi kirim "ping" ringan (no-cors, hasil tidak dibaca) sampai socket benar-benar tersambung.
  function wakeServer() {
    if (!url || typeof fetch !== 'function') return;
    fetch(`${url}/health`, {mode: 'no-cors', cache: 'no-store'}).catch(() => {});
  }

  function renderServerStatus() {
    if (!serverStatus) return;
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    serverStatus.textContent = `Menyambungkan ke server… ${seconds} dtk`;
    const elapsed = Date.now() - startedAt;
    if (serverHint) {
      serverHint.textContent = elapsed >= LONG_WAIT_MS
        ? 'Belum juga tersambung. Periksa koneksi internetmu, atau main lokal dulu sambil menunggu.'
        : elapsed >= HINT_AFTER_MS
          ? 'Server gratis sedang bangun dari tidur, biasanya butuh 30–60 detik. Tunggu sebentar ya.'
          : '';
    }
  }

  function enterServerPhase() {
    phase = 'server';
    startedAt = Date.now();
    if (caption) caption.textContent = 'Papan siap!';
    serverBox?.classList.add('show');
    renderServerStatus();
    ticker = setInterval(renderServerStatus, 1000);
  }

  function boardReady() {
    if (dismissed) return;
    window.__gameReady = true;
    try { window.sessionStorage?.removeItem('modpoly.bootRetry'); } catch { /* abaikan */ }
    if (wantLocal) return dismiss({local: true});
    // Tanpa URL server (mode offline) atau sudah tersambung: tidak perlu menunggu.
    if (!url || client?.isConnected?.()) return dismiss();
    enterServerPhase();
  }

  localButton?.addEventListener('click', () => {
    if (phase === 'board') {
      // Papan belum selesai disiapkan: tandai saja, lanjut otomatis begitu siap.
      wantLocal = true;
      localButton.disabled = true;
      localButton.textContent = 'Menyiapkan papan…';
      return;
    }
    dismiss({local: true});
  });

  if (client?.onStatusChange) {
    removeStatusListener = client.onStatusChange(status => {
      if (status === 'connected' && phase === 'server') dismiss();
    });
  }

  if (url) {
    wakeServer();
    pinger = setInterval(() => {
      if (client?.isConnected?.() || dismissed) return stopTimers();
      wakeServer();
    }, WAKE_PING_EVERY_MS);
  }

  return {boardReady, dismiss};
}
