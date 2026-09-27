import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(), // Tailwind v4 via Vite plugin — no tailwind.config.js needed
    cloudflare(),
  ],
});