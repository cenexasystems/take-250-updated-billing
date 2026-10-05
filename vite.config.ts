import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  plugins: [
    react(),
    VitePWA({
      selfDestroying: true,
      includeAssets: [
        'yg-logo.png',
        'yg-logo-source.png',
        'yg-icon.png',
        'yg-icon-192.png',
        'yg-icon-512.png',
        'yg-icon-maskable-192.png',
        'yg-icon-maskable-512.png',
        'apple-touch-icon.png',
        'yg-favicon.png',
        'robots.txt',
      ],
      manifest: {
        name: 'YG ENTERPRISES Retail POS',
        short_name: 'YG',
        description: 'YG ENTERPRISES retail billing, barcode inventory, catalog, order, receipt, and invoice administration.',
        theme_color: '#0A0A0A',
        background_color: '#0A0A0A',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/yg-icon-192.png?v=7',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/yg-icon-512.png?v=7',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/yg-icon-maskable-192.png?v=7',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/yg-icon-maskable-512.png?v=7',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      devOptions: {
        enabled: true,
      },
      workbox: {
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,jpeg,jpg,woff,woff2}'],
        navigateFallbackDenylist: [/^\/api/, /^\/admin/, /^\/assets\//, /\.[a-zA-Z0-9]+$/],
        runtimeCaching: [
          {
            // API answers depend on who is signed in and which branch they are in: never cache them in the browser,
            // or a slow network could show one user's branch data to the next user of the same device.
            urlPattern: /\/api\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-stylesheets',
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: {
                maxEntries: 30,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
            },
          },
        ],
      },
    }),
  ],
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: (id: string) => {
          if (!id.includes('node_modules')) return
          if (id.includes('framer-motion')) return 'motion'
          if (id.includes('recharts') || id.includes('d3-') || id.includes('react-smooth') || id.includes('victory-')) return 'charts'
          if (id.includes('react-router')) return 'router'
          if (id.includes('lucide-react')) return 'icons'
          if (id.includes('jsbarcode') || id.includes('@zxing')) return 'barcode'
          if (id.includes('workbox') || id.includes('vite-plugin-pwa')) return 'pwa'
          return 'vendor'
        },
      },
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
  },
  server: {
    allowedHosts: true,
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    },
  },
})
