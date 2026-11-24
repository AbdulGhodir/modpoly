// Dialog ramah pengguna: pengganti confirm() bawaan browser + layar "Cara Bermain".
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));

function mount(html, {onClose} = {}) {
  const host = document.createElement('div');
  host.className = 'mp-dialog-host';
  host.innerHTML = html;
  document.body.appendChild(host);
  requestAnimationFrame(() => host.classList.add('open'));
  const close = result => {
    if (host.dataset.closed) return;
    host.dataset.closed = '1';
    host.classList.remove('open');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => host.remove(), 180);
    onClose?.(result);
  };
  const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); close(false); } };
  document.addEventListener('keydown', onKey, true);
  host.addEventListener('click', event => { if (event.target === host) close(false); });
  return {host, close};
}

/** @returns {Promise<boolean>} true bila pemain menekan tombol konfirmasi. */
export function confirmDialog({title = 'Yakin?', message = '', confirmText = 'Ya', cancelText = 'Batal', tone = 'primary', icon = '❓'} = {}) {
  return new Promise(resolve => {
    const {host, close} = mount(`
      <div class="mp-dialog" role="alertdialog" aria-modal="true" aria-labelledby="mp-dialog-title">
        <div class="mp-dialog-icon">${esc(icon)}</div>
        <h3 id="mp-dialog-title">${esc(title)}</h3>
        <p>${esc(message).replace(/\n/g, '<br>')}</p>
        <div class="mp-dialog-actions">
          <button type="button" class="mp-btn mp-btn-ghost" data-act="cancel">${esc(cancelText)}</button>
          <button type="button" class="mp-btn ${tone === 'danger' ? 'mp-btn-danger' : 'mp-btn-primary'}" data-act="ok">${esc(confirmText)}</button>
        </div>
      </div>`, {onClose: resolve});
    host.querySelector('[data-act="cancel"]').onclick = () => close(false);
    host.querySelector('[data-act="ok"]').onclick = () => close(true);
    host.querySelector('[data-act="cancel"]').focus();
  });
}

const HELP_STEPS = [
  ['🎲', 'Lempar dadu', 'Di gilirannya, setiap pemain melempar dadu lalu pionnya berjalan sesuai angka dadu. Dapat angka kembar? Kamu boleh melempar sekali lagi.'],
  ['🏠', 'Beli properti', 'Mendarat di petak kosong? Kamu bisa membelinya. Kalau tidak jadi beli, properti dilelang ke pemain lain.'],
  ['💰', 'Kumpulkan sewa', 'Pemain lain yang mendarat di propertimu harus membayar sewa. Punya satu warna lengkap? Sewanya jadi lebih mahal dan kamu bisa membangun rumah dan hotel.'],
  ['🚓', 'Penjara', 'Masuk penjara? Bayar denda $50, pakai kartu bebas penjara, atau coba lempar angka kembar untuk keluar.'],
  ['🅿️', 'Parkir Bebas', 'Mendarat di Parkir Bebas, kamu bisa istirahat atau membayar $50 untuk pindah ke petak mana pun yang kamu pilih.'],
  ['🏆', 'Cara menang', 'Kalau uangmu tidak cukup untuk membayar, jual bangunan atau gadai properti. Kalau tetap tidak cukup, kamu bangkrut. Pemain terakhir yang bertahan adalah pemenangnya!']
];

export function showHelp() {
  const {host, close} = mount(`
    <div class="mp-dialog mp-dialog-help" role="dialog" aria-modal="true" aria-labelledby="mp-help-title">
      <h3 id="mp-help-title">📖 Cara Bermain</h3>
      <p class="mp-help-lead">Beli properti, tarik sewa dari lawan, dan jadi satu-satunya pemain yang bertahan.</p>
      <ol class="mp-help-list">
        ${HELP_STEPS.map(([icon, title, text]) => `
          <li><span class="mp-help-icon">${icon}</span><div><b>${esc(title)}</b><span>${esc(text)}</span></div></li>`).join('')}
      </ol>
      <div class="mp-dialog-actions"><button type="button" class="mp-btn mp-btn-primary" data-act="ok">Mengerti, ayo main!</button></div>
    </div>`);
  host.querySelector('[data-act="ok"]').onclick = () => close(true);
  return close;
}
