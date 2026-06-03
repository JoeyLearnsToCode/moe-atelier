import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const now = new Date();
const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
const buildTime = [
  utc8.getUTCFullYear(),
  '-',
  String(utc8.getUTCMonth() + 1).padStart(2, '0'),
  '-',
  String(utc8.getUTCDate()).padStart(2, '0'),
  ' ',
  String(utc8.getUTCHours()).padStart(2, '0'),
  ':',
  String(utc8.getUTCMinutes()).padStart(2, '0'),
  ':',
  String(utc8.getUTCSeconds()).padStart(2, '0'),
].join('');

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp}'],
      },
      manifest: {
        name: '萌图工坊',
        short_name: '萌图工坊',
        description: 'AI 图片生成工具',
        theme_color: '#fff0f3',
        icons: [
          { src: 'vite.svg', sizes: '192x192', type: 'image/svg+xml' },
          { src: 'vite.svg', sizes: '512x512', type: 'image/svg+xml' },
        ],
      },
    }),
  ],
  server: {
    host: process.env.VITE_HOST || '127.0.0.1',
  },
})
