/**
 * 单文件构建：把 JS / CSS / 字体全部内联进一个 .html
 * 产物可以直接双击打开（file://），不需要服务器、不需要装任何东西。
 * 构建：npx vite build --config vite.config.singlefile.ts
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { bundleLicenses } from './scripts/vite-plugin-licenses.ts'

export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile(), bundleLicenses({ singleFile: true })],
  build: {
    outDir: 'dist-single',
    // 字体 2.9MB，必须内联成 data URI，否则 file:// 下拿不到
    assetsInlineLimit: 6 * 1024 * 1024,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        // 动态 import（docx / pdf-lib）必须打进同一个文件，file:// 下没有服务器可请求
        inlineDynamicImports: true,
      },
    },
  },
})
