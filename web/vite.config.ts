import { defineConfig } from 'vite';
import { rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

function updateManifest() {
  const root = resolve(import.meta.dirname, 'public/assets');
  mkdirSync(root, { recursive: true });
  const files: string[] = [];
  function walk(directory: string, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(resolve(directory, entry.name), relative + '/');
      else if (/\.(webp|png|jpe?g|svg)$/i.test(entry.name)) files.push(relative);
    }
  }
  walk(root);
  const digest = createHash('sha256');
  const versions: Record<string, string> = {};
  for (const file of files.sort()) {
    const data = readFileSync(resolve(root, file));
    digest.update(file).update(data);
    versions[file] = createHash('sha256').update(data).digest('hex').slice(0, 16);
  }
  writeFileSync(resolve(root, 'manifest.json'), JSON.stringify({ files, revision: digest.digest('hex').slice(0, 16), versions }));
}
updateManifest();

export default defineConfig({
  plugins: [
    {
      // public/ 下的东西会被原样拷进 dist，包括给美术看的 assets/README.md。
      // 那份文档写了内部路径，不该公开可访问 —— 构建完删掉。
      name: 'drop-asset-readme',
      buildStart() { updateManifest(); },
      closeBundle() {
        // 这里跑在 ESM 里，没有 __dirname，用 import.meta.dirname
        rmSync(resolve(import.meta.dirname, 'dist/assets/README.md'), { force: true });
      },
    },
  ],
  server: {
    // host: true 让手机连同一个 WiFi 就能直接扫码试玩
    host: true,
    port: 5173,
    proxy: {
      // 开发时把 /api 打到本地后端；生产环境由 Nginx 反代。
      // 注意端口是 8787 不是 3000 —— 3000 上本机跑着 QQ/NapCat。
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2020',
    // 美术图不做内联，保持独立文件 + 长缓存
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
  },
});
