import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

/**
 * 构建产物直接进根包的 dist/dashboard-ui/，由 server.ts 静态托管。
 * base: './' 保证相对路径引用资源（server.ts 把整个目录挂在任意路由前缀下都能用）。
 * 开发时 `pnpm dev` 起本地 5181，用 /api 代理到已经在跑的 bridge（5180），
 * 这样改前端不用重启 bridge、也不用手动跨域配置。
 */
export default defineConfig({
  base: './',
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5181,
    proxy: {
      '/api': 'http://127.0.0.1:5180',
    },
  },
});
