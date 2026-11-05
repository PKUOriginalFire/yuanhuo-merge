// 开源前扫描：仓库里有没有不该公开的东西
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.argv[2] ?? '.';
const SKIP = new Set(['node_modules', '.git', 'dist', 'data', '.vite', 'scratch-db']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
console.log(`扫描 ${files.length} 个文件\n`);

// ① 疑似密钥文件
const secretish = files.filter(f => /(^|[\\/])(\.env|\.env\..*|.*\.pem|.*\.key|id_rsa.*|.*\.p12|.*\.pfx|secrets?\..*)$/i.test(f));
console.log('① 疑似密钥/环境文件:', secretish.length ? secretish.map(f => relative(ROOT, f)).join(', ') : '（无）');

// ② 源码里的敏感串
const patterns = [
  [/ADMIN_TOKEN\s*[=:]\s*['"][^'"]{8,}/, '硬编码 ADMIN_TOKEN'],
  [/IP_SALT\s*[=:]\s*['"][^'"]{8,}/, '硬编码 IP_SALT'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
  [/[0-9a-f]{32,}/i, '疑似长十六进制串（可能是 token）'],
  [/(?:password|passwd|secret|token)\s*[=:]\s*['"][^'"]{6,}['"]/i, '明文口令赋值'],
];
const findings = [];
for (const f of files) {
  if (/\.(png|jpg|jpeg|webp|gif|ico|mp3|ogg|wav|woff2?|ttf|db|sqlite|zstd)$/i.test(f)) continue;
  if (statSync(f).size > 400_000) continue;
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  for (const [re, label] of patterns) {
    const m = text.match(re);
    if (m) findings.push({ file: relative(ROOT, f), label, sample: String(m[0]).slice(0, 60) });
  }
}
console.log('\n② 源码里的敏感串:');
if (!findings.length) console.log('  （无）');
for (const x of findings.slice(0, 25)) console.log(`  ${x.file}  ← ${x.label}: ${x.sample}`);

// ③ 服务器信息（IP / 域名 / 用户名）
const infra = { ip: new Set(), domain: new Set(), ssh: new Set() };
for (const f of files) {
  if (/\.(png|jpg|jpeg|webp|gif|ico|mp3|ogg|wav|woff2?|ttf|db|sqlite|zstd)$/i.test(f)) continue;
  if (statSync(f).size > 400_000) continue;
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  for (const m of text.matchAll(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g)) infra.ip.add(m[1]);
  for (const m of text.matchAll(/\b([a-z0-9-]+\.)+(dismused-beat\.cloud|com|cn)\b/gi)) infra.domain.add(m[0]);
  for (const m of text.matchAll(/ubuntu@[^\s'"]+/g)) infra.ssh.add(m[0]);
}
console.log('\n③ 基础设施信息（开源前考虑泛化）:');
console.log('  IP:', [...infra.ip].join(', ') || '（无）');
console.log('  域名:', [...infra.domain].slice(0, 10).join(', ') || '（无）');
console.log('  SSH:', [...infra.ssh].join(', ') || '（无）');

// ④ 是否已有 git / .gitignore
console.log('\n④ 版本控制:');
try { statSync(join(ROOT, '.git')); console.log('  有 .git'); } catch { console.log('  没有 .git（还没初始化仓库）'); }
try { console.log('  .gitignore:\n' + readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map(l => '    ' + l).join('\n')); }
catch { console.log('  没有 .gitignore'); }
