// Build config for scripts/mywork-dom-check.mjs — see that file's header.
// Only `../api` and the auth context are stubbed; everything else is real code.
//
// ENTRY and API_STUB select WHICH harness is built, so a second surface does not
// need a second copy of this file:
//   ENTRY=scripts/approval-deck-dom-entry.jsx API_STUB=scripts/approval-deck-api-stub.js \
//     npx vite build -c scripts/mywork-dom.vite.config.mjs
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
const ENTRY = process.env.ENTRY || 'scripts/mywork-dom-entry.jsx'
const API_STUB = process.env.API_STUB || 'scripts/mywork-dom-api-stub.js'
// A harness may bring its own auth stub (home-dom needs a configurable canView).
const AUTH_STUB = process.env.AUTH_STUB || 'scripts/mywork-dom-auth-stub.js'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Only the api module is swapped; everything else is the real code.
      { find: /^\.\.\/api$/, replacement: path.resolve(process.cwd(), API_STUB) },
      { find: /^\.\.\/\.\.\/api$/, replacement: path.resolve(process.cwd(), API_STUB) },
      // Anchored at both ends: a partial match leaves the '../' prefix in place
      // and vite tries to load '..//abs/path'.
      { find: /^\.\.\/context\/AuthContext$/, replacement: path.resolve(process.cwd(), AUTH_STUB) },
      { find: /^\.\.\/\.\.\/context\/AuthContext$/, replacement: path.resolve(process.cwd(), AUTH_STUB) },
    ],
  },
  build: {
    ssr: ENTRY,
    outDir: '.domsmoke/out',
    emptyOutDir: true,
    rollupOptions: { external: ['react', 'react-dom', 'react-dom/client', 'react-dom/server', 'react-router-dom', 'lucide-react'] },
  },
  logLevel: 'error',
  esbuild: { target: 'node18' },
})
