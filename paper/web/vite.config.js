const { defineConfig } = require('vite');
module.exports = defineConfig({ root: __dirname, server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3000' } }, build: { outDir: 'dist', emptyOutDir: true } });
