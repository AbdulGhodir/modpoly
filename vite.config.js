import {defineConfig} from 'vite';

export default defineConfig({
  // Gunakan path relatif agar build tetap bekerja di root domain maupun
  // subpath GitHub Pages seperti /nama-repo/.
  base: './',
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/phaser/')) return 'phaser';
        }
      }
    }
  }
});
