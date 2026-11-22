// Build frontend (vite). Dilewati otomatis di deploy backend yang hanya memasang dependensi server,
// karena di sana `vite` memang tidak terpasang dan frontend dibuild terpisah oleh GitHub Pages.
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));

if (!existsSync(viteBin)) {
  if (process.env.GITHUB_ACTIONS) {
    console.error('[build] vite tidak ditemukan di GitHub Actions. Pastikan langkah "npm ci" berjalan sebelum build.');
    process.exit(1);
  }
  console.log('[build] vite tidak terpasang (deploy backend); build frontend dilewati.');
  process.exit(0);
}

const result = spawnSync(process.execPath, [viteBin, 'build', ...process.argv.slice(2)], {stdio: 'inherit'});
process.exit(result.status ?? 1);
