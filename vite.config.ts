/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { bundleLicenses } from './scripts/vite-plugin-licenses.ts'

export default defineConfig({
  // 相对路径产物：本地 file:// 打开、或放到任意子目录部署都能直接用
  base: './',
  plugins: [react(), bundleLicenses()],
  server: {
    port: 5173,
    open: false,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environmentMatchGlobs: [
      ['src/components/**', 'jsdom'],
      ['src/export/**', 'jsdom'],
    ],
    setupFiles: ['src/test-setup.ts'],
  },
})
