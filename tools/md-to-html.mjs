/**
 * 极简 Markdown → 单文件 HTML（只支持本仓库报告用到的子集）。
 *   node tools/md-to-html.mjs <in.md> <out.html> [标题]
 *
 * 支持：h1–h6 / 段落 / 粗体 / 行内 code / 删除线 / 链接 / 有序无序列表 /
 *       GFM 表格（含 :---: 对齐）/ 围栏代码块 / 引用 / 分隔线。
 * 不支持：嵌套列表、图片语法以外的内联 HTML、脚注。够用就行。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath, docTitle] = process.argv;
if (!inPath || !outPath) { console.error('用法: node tools/md-to-html.mjs <in.md> <out.html> [标题]'); process.exit(1); }

const PH_OPEN = '\u0000', PH_CLOSE = '\u0001';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return PH_OPEN + (codes.length - 1) + PH_CLOSE; });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000?([\u0000\u0001])/g, '$1');
  s = s.replace(new RegExp(PH_OPEN + '(\\d+)' + PH_CLOSE, 'g'), (_, i) => '<code>' + esc(codes[Number(i)]) + '</code>');
  return s;
}

const splitRow = (line) => {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map(c => c.trim());
};
const isSepRow = (line) => line != null && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');

function alignOf(sep) {
  return splitRow(sep).map(c => {
    const l = c.startsWith(':'), r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  });
}

const lines = readFileSync(inPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
const out = [];
const SPECIAL = /^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s|\s*>|---+\s*$)/;
let inList = null;   // 'ul' | 'ol'
const idCount = new Map();

const closeList = () => { if (inList) { out.push(`</${inList}>`); inList = null; } };

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  if (!line.trim()) { closeList(); continue; }

  // 围栏代码块
  if (/^```/.test(line)) {
    closeList();
    const buf = [];
    i++;
    while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
    out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
    continue;
  }

  // 分隔线
  if (/^---+\s*$/.test(line.trim())) { closeList(); out.push('<hr>'); continue; }

  // 标题
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) {
    closeList();
    const lv = h[1].length;
    const base = h[2].replace(/[^\u4e00-\u9fa5\w\s-]/g, '').trim().replace(/\s+/g, '-');
    const n = (idCount.get(base) || 0) + 1; idCount.set(base, n);
    const id = n === 1 ? base : `${base}-${n}`;
    out.push(`<h${lv} id="${id}">${inline(h[2])}</h${lv}>`);
    continue;
  }

  // 表格
  if (line.includes('|') && isSepRow(lines[i + 1])) {
    closeList();
    const head = splitRow(line);
    const align = alignOf(lines[i + 1]);
    i += 2;
    const rows = [];
    while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
    const th = head.map((c, k) => `<th${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</th>`).join('');
    const tb = rows.map(r => '<tr>' + r.map((c, k) => `<td${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</td>`).join('') + '</tr>').join('');
    out.push(`<div class="tw"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
    i--;
    continue;
  }

  // 引用
  if (/^\s*>/.test(line)) {
    closeList();
    const buf = [];
    while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
    out.push('<blockquote>' + buf.map(t => t.trim() ? `<p>${inline(t)}</p>` : '').join('') + '</blockquote>');
    i--;
    continue;
  }

  // 无序列表
  if (/^\s*[-*]\s+/.test(line)) {
    if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; }
    out.push('<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>');
    continue;
  }

  // 有序列表
  if (/^\s*\d+\.\s+/.test(line)) {
    if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; }
    out.push('<li>' + inline(line.replace(/^\s*\d+\.\s+/, '')) + '</li>');
    continue;
  }

  // 段落：吞掉后续的非空、非特殊行
  closeList();
  const buf = [line];
  while (i + 1 < lines.length && lines[i + 1].trim() && !SPECIAL.test(lines[i + 1]) && !(lines[i + 1].includes('|') && isSepRow(lines[i + 2]))) buf.push(lines[++i]);
  out.push('<p>' + buf.map(t => inline(t)).join('<br>') + '</p>');
}
closeList();

const title = docTitle || (lines.find(l => /^#\s/.test(l)) || '# 报告').replace(/^#\s*/, '');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
  :root { --ink:#1c1917; --ink2:#57534e; --ink3:#8b8580; --line:#e7e5e4; --bg:#fdfcfb; --accent:#c2453a; }
  * { box-sizing: border-box; }
  body {
    margin:0; padding:52px 28px 96px; background:var(--bg); color:var(--ink);
    font:16px/1.78 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .doc { max-width: 880px; margin: 0 auto; }
  h1 { font-size:31px; line-height:1.3; margin:0 0 22px; letter-spacing:-.02em; font-weight:700; }
  h2 { font-size:21px; margin:52px 0 14px; padding-bottom:8px; border-bottom:2px solid var(--line); letter-spacing:-.01em; }
  h3 { font-size:16.5px; margin:30px 0 10px; color:var(--accent); }
  h4 { font-size:15px; margin:22px 0 8px; }
  p { margin:13px 0; }
  strong { font-weight:650; }
  a { color:var(--accent); text-decoration:none; border-bottom:1px solid rgba(194,69,58,.35); }
  a:hover { border-bottom-color:var(--accent); }
  hr { border:0; border-top:1px solid var(--line); margin:40px 0; }
  code { background:#f2f0ee; padding:1.5px 5px; border-radius:4px; font-size:13.5px;
         font-family:"SF Mono",Menlo,Consolas,monospace; }
  pre { background:#f7f5f3; border:1px solid var(--line); border-radius:9px; padding:15px 18px;
        overflow-x:auto; margin:16px 0; line-height:1.65; }
  pre code { background:none; padding:0; font-size:12.5px; line-height:1.6; }
  blockquote { margin:18px 0; padding:2px 0 2px 16px; border-left:3px solid var(--accent);
               color:var(--ink2); font-size:14.5px; background:#faf8f6; }
  blockquote p { margin:8px 0; }
  ul, ol { margin:13px 0; padding-left:26px; }
  li { margin:6px 0; }
  .tw { overflow-x:auto; margin:18px 0; }
  table { width:100%; border-collapse:collapse; font-size:14px; font-variant-numeric:tabular-nums; }
  th, td { padding:8px 11px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
  th { background:#f7f5f3; font-weight:600; font-size:13px; color:var(--ink2); white-space:nowrap;
       border-bottom:1.5px solid var(--line); }
  tbody tr:hover { background:#fbf9f7; }
  del { color:var(--ink3); }
  img { max-width:100%; height:auto; border-radius:8px; }
  @media print {
    body { padding:0; background:#fff; font-size:12.5px; }
    h2 { page-break-after:avoid; } table, pre { page-break-inside:avoid; }
    a { color:var(--ink); border:0; }
  }
</style>
</head>
<body><div class="doc">
${out.join('\n')}
</div></body>
</html>
`;

writeFileSync(outPath, html, 'utf8');
console.log('written', outPath, (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB', out.length + ' 个块');
