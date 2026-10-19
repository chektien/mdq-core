import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: 'palette-licence-notices',
    enforce: 'post',
    // Tailwind/minification strips source comments. Attach the complete
    // notice after CSS generation, and also ship a readable sidecar.
    generateBundle(_options, bundle) {
      const notices = fs.readFileSync(path.resolve(__dirname, '../../THIRD_PARTY_NOTICES.md'), 'utf8')
      this.emitFile({ type: 'asset', fileName: 'third-party-notices.txt', source: notices })
      const banner = `/*! MDQ palette notices\n${notices.replaceAll('*/', '* /')}*/\n`
      for (const asset of Object.values(bundle)) {
        if (asset.type === 'asset' && asset.fileName.endsWith('.css')) {
          const css = typeof asset.source === 'string' ? asset.source : Buffer.from(asset.source).toString('utf8')
          asset.source = banner + css
        }
      }
    },
  }],
  resolve: {
    alias: {
      '@mdq/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
})
