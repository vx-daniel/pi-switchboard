/**
 * The admin UI's browser build (#367): `src/admin/web/` (React, Tailwind CSS 4, daisyUI 5) into
 * `dist/admin-ui/`, which the admin listener serves under `/admin/` (`src/admin/assets.ts`).
 *
 * @remarks
 * Run after `vp pack`, which empties `dist/`: `pnpm run build` runs both. Nothing is inlined as a
 * `data:` URL and no module-preload polyfill is injected, so the pages load under the admin UI's
 * `default-src 'self'` policy with no inline script.
 *
 * @packageDocumentation
 */

import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  root: fileURLToPath(new URL('src/admin/web', import.meta.url)),
  base: '/admin/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@proxy': fileURLToPath(new URL('src', import.meta.url)) } },
  build: {
    outDir: fileURLToPath(new URL('dist/admin-ui', import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false }
  }
})
