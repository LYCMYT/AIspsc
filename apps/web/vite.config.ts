import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), plugins: [vue()], server: { host: '127.0.0.1', strictPort: true, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } }, build: { target: 'es2022' } });
