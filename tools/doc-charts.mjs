/**
 * 为 Word 文档生成独立图表 PNG。
 *   node tools/doc-charts.mjs <data.json> <输出目录>
 *
 * 关键：画布按 960 单位设计，但插进 A4（正文宽 14.66cm = 555pt）时缩放系数是
 * 555/960 ≈ 0.578。所以所有字号都要先乘 FS，否则印出来只有 6pt，看不清。
 *   标题 13*1.65 ≈ 21.5 → 印出 12.4pt
 *   说明/刻度 11*1.65 ≈ 18   → 印出 10.5pt
 *
 * 每张图是**纯 SVG**（标题、说明、图例都在 SVG 里），PNG 尺寸与 SVG 完全一致，
 * 截图时不会有多余留白。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , dataPath, outDir] = process.argv;
if (!dataPath || !outDir) { console.error('用法: node tools/doc-charts.mjs <data.json> <outDir>'); process.exit(1); }
const D = JSON.parse(readFileSync(dataPath, 'utf8'));
mkdirSync(outDir, { recursive: true });

const FS = 1.65;                 // 字号放大系数（抵消插入时的缩小）
const C = {
  ink: '#1c1917', ink2: '#57534e', ink3: '#8a8580', grid: '#ebe8e6',
  red: '#c2453a', blue: '#3b6fd8', orange: '#d98324', purple: '#6d4fd8', green: '#2f9e63',
};
const FONT = '"Microsoft YaHei","PingFang SC","Segoe UI",sans-serif';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const N = [];
const el = (tag, a = {}) => {
  N.push('<' + tag + Object.entries(a).map(([k, v]) => ` ${k}="${v}"`).join('') + '/>');
};
const txt = (x, y, s, { size = 11, fill = C.ink3, anchor = 'middle', bold = false, rotate = null } = {}) => {
  const t = rotate ? ` transform="rotate(${rotate[0]} ${rotate[1]} ${rotate[2]})"` : '';
  N.push(`<text x="${x}" y="${y}" font-size="${(size * FS).toFixed(2)}" fill="${fill}" text-anchor="${anchor}" font-family='${FONT}'` +
    (bold ? ' font-weight="600"' : '') + t + `>${esc(s)}</text>`);
};
const rect = (x, y, w, h, fill, o = 1, rx = 2) => el('rect', { x, y, width: Math.max(w, 0.4), height: Math.max(h, 0.4), fill, opacity: o, rx });
const line = (x1, y1, x2, y2, stroke, w = 1, dash = '') => el('line', { x1, y1, x2, y2, stroke, 'stroke-width': w, ...(dash ? { 'stroke-dasharray': dash } : {}) });
const poly = (pts, stroke, w = 2, fill = 'none', dash = '') =>
  el('polyline', { points: pts.map(p => p.join(',')).join(' '), fill, stroke, 'stroke-width': w, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', ...(dash ? { 'stroke-dasharray': dash } : {}) });

function niceTicks(max, target = 4) {
  if (!(max > 0)) return { top: 1, ticks: [0, 1], step: 1 };
  const raw = max / target, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let v = 0; v <= top + step * 1e-6; v += step) ticks.push(+v.toFixed(6));
  return { top, ticks, step };
}
const L0 = 68;                   // 统一左边距（刻度数字放大后需要）
function axisY(x0, y0, w, h, max, target = 4) {
  const { top, ticks, step } = niceTicks(max, target);
  for (const v of ticks) {
    const y = y0 + h - h * (v / top);
    line(x0, y, x0 + w, y, C.grid, 1, v === 0 ? '' : '3 5');
    txt(x0 - 11, y + 6, step >= 1 ? String(Math.round(v)) : String(+v.toFixed(1)), { anchor: 'end' });
  }
  return top;
}
const TOP = 74;
const head = (title, hint) => {
  txt(0, 27, title, { size: 13, fill: C.ink, anchor: 'start', bold: true });
  if (hint) txt(0, 55, hint, { size: 10.5, fill: C.ink3, anchor: 'start' });
};
const legend = (y, items) => {
  let x = 2;
  for (const [label, color, opacity] of items) {
    rect(x, y - 13, 15, 15, color, opacity ?? 1, 3);
    txt(x + 22, y, label, { size: 10.5, fill: C.ink2, anchor: 'start' });
    x += 22 + label.length * 12.5 + 34;
  }
};
const wrap = (W, H) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` + N.join('') + '</svg>';
const reset = () => { N.length = 0; };

const W = 960;
const PLOT = 285;
const charts = {};

// 图1
charts.daily = () => {
  const rows = D.daily, H = TOP + PLOT + 82;
  head('图 1　每日开局数与完赛数', '开局 = 真的点进去打了（含中途退出）；完赛 = 打完并成功提交');
  const L = L0, dw = W - L - 12;
  const max = axisY(L, TOP, dw, PLOT, Math.max(...rows.map(r => Math.max(r.started, r.submitted))));
  const step = dw / rows.length, bw = Math.min(26, step * 0.31);
  rows.forEach((r, i) => {
    const cx = L + step * (i + 0.5);
    rect(cx - bw - 1, TOP + PLOT - PLOT * (r.started / max), bw, PLOT * (r.started / max), C.red, .88);
    rect(cx + 1, TOP + PLOT - PLOT * (r.submitted / max), bw, PLOT * (r.submitted / max), C.blue, .88);
  });
  const ma = rows.map((_, i) => { const w = rows.slice(Math.max(0, i - 6), i + 1); return w.reduce((s, r) => s + r.started, 0) / w.length; });
  poly(ma.map((v, i) => [L + step * (i + 0.5), TOP + PLOT - PLOT * (v / max)]), C.red, 2.5, 'none', '7 5');
  rows.forEach((r, i) => txt(L + step * (i + 0.5), TOP + PLOT + 26, r.date.slice(5), { size: 9.5 }));
  legend(H - 22, [['每日开局数', C.red], ['每日完赛数', C.blue], ['开局 7 日均线', C.red, .45]]);
  return [W, H];
};

// 图2
charts.users = () => {
  const rows = D.daily, H = TOP + PLOT + 82;
  head('图 2　每日新增玩家与日活跃玩家', '柱 = 当天第一次开局的人，浅色为幽灵账号（提交的每一局都被判作弊）');
  const L = L0, dw = W - L - 12;
  const max = axisY(L, TOP, dw, PLOT, Math.max(...rows.map(r => Math.max(r.newByFirstGame, r.activeClients))));
  const step = dw / rows.length, bw = Math.min(30, step * 0.44);
  rows.forEach((r, i) => {
    const cx = L + step * (i + 0.5), real = Math.max(0, r.newByFirstGame - (r.newPhantom || 0));
    const hp = PLOT * ((r.newPhantom || 0) / max), hr = PLOT * (real / max);
    if (r.newPhantom) rect(cx - bw / 2, TOP + PLOT - hp, bw, hp, C.orange, .28);
    rect(cx - bw / 2, TOP + PLOT - hp - hr, bw, hr, C.orange, .88);
  });
  const pts = rows.map((r, i) => [L + step * (i + 0.5), TOP + PLOT - PLOT * (r.activeClients / max)]);
  poly(pts, C.purple, 2.6);
  pts.forEach(p => el('circle', { cx: p[0], cy: p[1], r: 3.6, fill: '#fff', stroke: C.purple, 'stroke-width': 2.2 }));
  rows.forEach((r, i) => txt(L + step * (i + 0.5), TOP + PLOT + 26, r.date.slice(5), { size: 9.5 }));
  legend(H - 22, [['真实新玩家', C.orange], ['幽灵账号', C.orange, .28], ['日活跃玩家', C.purple]]);
  return [W, H];
};

// 图3
charts.hour = () => {
  const rows = D.hourly, H = TOP + PLOT + 82;
  head(`图 3　每小时的开局数（全部 ${D.summary.started} 局）`, '按开局时间落在哪个小时统计，时区 Asia/Shanghai');
  const L = L0, dw = W - L - 12;
  const max = axisY(L, TOP, dw, PLOT, Math.max(...rows.map(r => r.started)));
  const step = dw / 24, bw = step * 0.62, peak = Math.max(...rows.map(r => r.started));
  rows.forEach((r, i) => {
    const cx = L + step * (i + 0.5);
    const hc = PLOT * (r.classic / max), he = PLOT * (r.endless / max);
    rect(cx - bw / 2, TOP + PLOT - hc, bw, hc, C.red, .88);
    rect(cx - bw / 2, TOP + PLOT - hc - he, bw, he, C.blue, .88);
    if (r.started === peak) txt(cx, TOP + PLOT - hc - he - 9, r.started + ' 局', { size: 10, fill: C.red, bold: true });
  });
  rows.forEach((r, i) => { if (i % 2 === 0) txt(L + step * (i + 0.5), TOP + PLOT + 26, String(r.hour), { size: 9.5 }); });
  legend(H - 22, [['经典模式', C.red], ['无尽模式', C.blue]]);
  return [W, H];
};

// 图4 热力图
charts.heat = () => {
  const rows = D.daily, cw = 36, ch = 23, L = 92;
  const H = TOP - 20 + 26 + ch * rows.length + 42;
  head('图 4　日期 × 小时 热力图', '每格 = 那一小时里开了几局；颜色越深越热闹');
  const max = Math.max(1, ...D.heatmap.map(x => x.n));
  const idx = new Map(D.heatmap.map(x => [x.date + '|' + x.hour, x.n]));
  const y0 = TOP - 20 + 20;
  for (let h = 0; h < 24; h++) txt(L + cw * (h + 0.5), y0, h % 2 === 0 ? String(h) : '', { size: 9.5 });
  rows.forEach((r, ri) => {
    txt(L - 12, y0 + 6 + ch * (ri + 0.62), r.date.slice(5) + ' ' + r.weekday, { anchor: 'end', size: 10, fill: C.ink2 });
    for (let h = 0; h < 24; h++) {
      const n = idx.get(r.date + '|' + h) || 0;
      const a = n === 0 ? 0 : 0.11 + 0.89 * Math.pow(n / max, 0.45);
      rect(L + cw * h + 1, y0 + 6 + ch * ri + 1, cw - 2, ch - 2, n === 0 ? '#f5f3f1' : C.red, n === 0 ? 1 : a, 3);
    }
  });
  txt(L, y0 + 6 + ch * rows.length + 26, '最深格 = 10-17（周六）21 点，142 局；空格 = 那一小时没有任何人开局', { size: 10, anchor: 'start' });
  return [W, H];
};

// 图5
charts.plays = () => {
  const rows = D.playsPerPlayer, bh = 36, L = 168, R = 215;
  const H = TOP - 10 + bh * rows.length + 26;
  head('图 5　每个浏览器开过几局',
    `共 ${D.summary.uniqueClients} 个浏览器；${D.summary.onceOnly} 个（${D.summary.onceOnlyRate.toFixed(0)}%）只开过 1 局就再没回来`);
  const max = Math.max(...rows.map(r => r.n)), total = rows.reduce((s, r) => s + r.n, 0);
  rows.forEach((r, i) => {
    const y = TOP - 10 + bh * i + 3, w = (W - L - R) * (r.n / max);
    txt(L - 14, y + 18, r.label + ' 局', { anchor: 'end', size: 10.5, fill: C.ink2 });
    rect(L, y, Math.max(w, 1), bh - 11, C.blue, .22 + 0.7 * (1 - i / rows.length), 3);
    txt(L + w + 12, y + 18, r.n + ' 人　' + (r.n / total * 100).toFixed(1) + '%', { anchor: 'start', size: 10, fill: C.ink2 });
  });
  return [W, H];
};

// 分布类
function dist(title, hint, rows, color, note) {
  const L = L0, dw = W - L - 12, XLAB = note ? 108 : 88;
  const H = TOP + 250 + XLAB;
  head(title, hint);
  const max = axisY(L, TOP, dw, 250, Math.max(...rows.map(r => r.n)), 3);
  const step = dw / rows.length, bw = Math.min(72, step * 0.6);
  rows.forEach((r, i) => {
    const cx = L + step * (i + 0.5), hh = 250 * (r.n / max);
    rect(cx - bw / 2, TOP + 250 - hh, bw, hh, color, .85, 3);
    txt(cx, TOP + 250 + 28, r.label, { size: 10, fill: C.ink2, rotate: [-30, cx, TOP + 250 + 28] });
    if (r.n > 0) txt(cx, TOP + 250 - hh - 9, String(r.n), { size: 10, fill: color, bold: true });
  });
  if (note) txt(L, H - 14, note, { size: 10, anchor: 'start', fill: C.ink2 });
  return [W, H];
}
const SUM = D.summary;
/** 桶求和 / 桶总计 —— 图注里的百分比必须从数据算，不能写死 */
const bsum = (list, labels) => list.filter(b => labels.includes(b.label)).reduce((s, b) => s + b.n, 0);
const btot = (list) => list.reduce((s, b) => s + b.n, 0);
const pct = (a, b) => (b ? (a / b * 100) : 0);

charts.score = () => dist(
  `图 6　单局得分分布（${btot(D.scoreBuckets)} 局，已剔除作弊）`,
  `2000–5000 分占 ${pct(bsum(D.scoreBuckets, ['2000–3000', '3000–5000']), btot(D.scoreBuckets)).toFixed(1)}%` +
  `（${bsum(D.scoreBuckets, ['2000–3000', '3000–5000'])} 局）；3000 分是一道真实门槛`,
  D.scoreBuckets, C.red);
charts.duration = () => dist(
  `图 7　单局时长分布（${btot(D.durationBuckets)} 局，游戏内计时）`,
  `${pct(bsum(D.durationBuckets, ['20m–40m', '40m–2h']), btot(D.durationBuckets)).toFixed(0)}% 的对局落在 20 分钟到 2 小时之间；` +
  `中位 ${SUM.durationMin.toFixed(1)} 分钟，P90 ${SUM.durationP90.toFixed(0)} 分钟`,
  D.durationBuckets, C.green);
charts.drops = () => dist(
  `图 8　单局落球数分布（${btot(D.dropsBuckets)} 局）`,
  '★ 50–200 球之间一局都没有 —— 这不是采样噪声，是结构性空档', D.dropsBuckets, C.purple,
  '★ 落球数不是熟练度的连续刻度，而是一个开关：要么 50 球内就走，要么直接玩到 200 球以上。');

const sizes = {};
for (const [key, draw] of Object.entries(charts)) {
  reset();
  const [w, h] = draw();
  const svg = wrap(w, h);
  writeFileSync(join(outDir, `${key}.svg`), svg, 'utf8');
  writeFileSync(join(outDir, `${key}.html`),
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}svg{display:block}</style></head><body>${svg}</body></html>`, 'utf8');
  sizes[key] = [w, h];
}
writeFileSync(join(outDir, 'sizes.json'), JSON.stringify(sizes, null, 1));
console.log(JSON.stringify(sizes));
