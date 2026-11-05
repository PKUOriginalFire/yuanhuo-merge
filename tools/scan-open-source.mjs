/**
 * 开源前的敏感信息扫描。
 *   node tools/scan-open-source.mjs [仓库根目录]
 * 只读，不修改任何文件。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = process.argv[2] || '.';
const SKIP_DIRS = new Set(['.git', 'node_modules', 'test-results', 'scratch-db', '.vite', 'dist']);
const SKIP_EXT = new Set(['.tar.gz', '.gz', '.db', '.db-wal', '.db-shm', '.png', '.jpg', '.jpeg', '.webp', '.ogg', '.mp3', '.wav', '.ico', '.woff2', '.ttf']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.sh', '.ps1', '.py', '.html', '.css', '.txt', '.yml', '.yaml', '.conf', '.service', '.timer', '.env', '.example', '']);

const RULES = [
  ['IPv4 地址', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (m) => !/^127\.|^0\.0\.0\.0|^255\.|^1\.0\.0|^0\.0\.0/.test(m)],
  ['生产域名', /[a-z0-9-]+\.dismused-beat\.cloud/gi],
  ['SSH 主机别名', /your-server/g],
  ['服务器路径', /\/opt\/yuanhuo-merge/g],
  ['临时路径', /\/tmp\/[A-Za-z0-9_.-]+/g],
  ['Windows 绝对路径', /[A-Z]:\\\\Users\\\\[A-Za-z0-9_.-]+/g],
  ['ADMIN_TOKEN', /ADMIN_TOKEN/g],
  ['IP_SALT', /IP_SALT/g],
  ['Bearer 令牌', /Bearer\s+[A-Za-z0-9]{16,}/g],
  ['数据库路径', /yuanhuo\.db/g],
  ['systemd 服务名', /yuanhuo-merge\.service|yuanhuo-recover\.service/g],
  ['IP 哈希', /\b[0-9a-f]{12}\b/g],
  ['邮箱', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
];
const PLAYER_NICKS = ['玩家A', '玩家B', '玩家O', '玩家E', '玩家G', '玩家H', '玩家P',
  '玩家Q', '玩家J', '玩家D', '玩家K', '玩家C', '玩家L', '玩家M', '玩家N', '玩家F', '测试账号', '玩家I'];

const hits = new Map();   // rule -> [{file, line, text}]
const nickHits = new Map();
let scanned = 0, skipped = 0;

function walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(join(dir, ent.name));
      continue;
    }
    const full = join(dir, ent.name);
    const ext = extname(ent.name).toLowerCase();
    if (SKIP_EXT.has(ext) || /\.tar\.gz$/.test(ent.name)) { skipped++; continue; }
    if (!TEXT_EXT.has(ext) && ext !== '') { skipped++; continue; }
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.size > 2_000_000) { skipped++; continue; }
    let text;
    try { text = readFileSync(full, 'utf8'); } catch { skipped++; continue; }
    scanned++;
    const rel = relative(ROOT, full).replace(/\\/g, '/');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const [name, re, filter] of RULES) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          if (filter && !filter(m[0])) continue;
          if (!hits.has(name)) hits.set(name, []);
          const arr = hits.get(name);
          if (arr.length < 400) arr.push({ file: rel, line: i + 1, text: line.trim().slice(0, 120), match: m[0] });
        }
      }
      for (const nick of PLAYER_NICKS) {
        if (line.includes(nick)) {
          if (!nickHits.has(nick)) nickHits.set(nick, []);
          nickHits.get(nick).push({ file: rel, line: i + 1 });
        }
      }
    }
  }
}

walk(ROOT);

console.log(`扫描 ${scanned} 个文本文件，跳过 ${skipped} 个（二进制/过大/忽略目录）\n`);
console.log('===== 命中统计 =====');
const rows = [...hits.entries()].sort((a, b) => b[1].length - a[1].length);
if (!rows.length) console.log('  （无命中）');
for (const [name, list] of rows) {
  const files = new Map();
  for (const h of list) files.set(h.file, (files.get(h.file) || 0) + 1);
  console.log(`\n【${name}】${list.length} 处，分布在 ${files.size} 个文件`);
  const top = [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [f, n] of top) console.log(`    ${String(n).padStart(4)}×  ${f}`);
  const samples = list.slice(0, 2).map(h => `      L${h.line} ${h.match}  | ${h.text}`).join('\n');
  console.log(samples);
}

console.log('\n===== 玩家昵称 =====');
const nickRows = [...nickHits.entries()].sort((a, b) => b[1].length - a[1].length);
if (!nickRows.length) console.log('  （无命中）');
for (const [nick, list] of nickRows) {
  const files = [...new Set(list.map(h => h.file))];
  console.log(`  「${nick}」 ${list.length} 处 → ${files.slice(0, 4).join(', ')}${files.length > 4 ? ` 等 ${files.length} 个文件` : ''}`);
}
