/**
 * 安防报告的图表（纯 SVG，字号按插进 A4 的缩小系数预放大）。
 *   node tools/doc-charts-security.mjs <security-stats.json> <输出目录>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , dataPath, outDir] = process.argv;
if (!dataPath || !outDir) { console.error('用法: node tools/doc-charts-security.mjs <security-stats.json> <outDir>'); process.exit(1); }
const D = JSON.parse(readFileSync(dataPath, 'utf8'));
mkdirSync(outDir, { recursive: true });

const FS = 1.65;
const C = {
  ink: '#1c1917', ink2: '#57534e', ink3: '#8a8580', grid: '#ebe8e6',
  red: '#c2453a', blue: '#3b6fd8', orange: '#d98324', purple: '#6d4fd8', green: '#2f9e63', gray: '#b9b3ad',
};
const FONT = '"Microsoft YaHei","PingFang SC","Segoe UI",sans-serif';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const N = [];
const el = (tag, a = {}) => { N.push('<' + tag + Object.entries(a).map(([k, v]) => ` ${k}="${v}"`).join('') + '/>'); };
const txt = (x, y, s, { size = 11, fill = C.ink3, anchor = 'middle', bold = false, rotate = null } = {}) => {
  const t = rotate ? ` transform="rotate(${rotate[0]} ${rotate[1]} ${rotate[2]})"` : '';
  N.push(`<text x="${x}" y="${y}" font-size="${(size * FS).toFixed(2)}" fill="${fill}" text-anchor="${anchor}" font-family='${FONT}'` +
    (bold ? ' font-weight="600"' : '') + t + `>${esc(s)}</text>`);
};
const rect = (x, y, w, h, fill, o = 1, rx = 2) => el('rect', { x, y, width: Math.max(w, 0.4), height: Math.max(h, 0.4), fill, opacity: o, rx });
const line = (x1, y1, x2, y2, stroke, w = 1, dash = '') => el('line', { x1, y1, x2, y2, stroke, 'stroke-width': w, ...(dash ? { 'stroke-dasharray': dash } : {}) });
const circle = (cx, cy, r, fill, o = 1, stroke = 'none') => el('circle', { cx, cy, r, fill, opacity: o, stroke, 'stroke-width': stroke === 'none' ? 0 : 1 });
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
const L0 = 68;
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
const charts = {};

// 图1 每日提交 / 标记
charts.daily = () => {
  const rows = D.daily, PLOT = 285, H = TOP + PLOT + 82;
  head('图 4　每日提交数与被判作弊数', '柱 = 当天提交的成绩；折线 = 当天被判作弊的比例');
  const L = L0, dw = W - L - 58;
  const max = axisY(L, TOP, dw, PLOT, Math.max(...rows.map(r => r.total)));
  const step = dw / rows.length, bw = Math.min(26, step * 0.31);
  rows.forEach((r, i) => {
    const cx = L + step * (i + 0.5);
    rect(cx - bw - 1, TOP + PLOT - PLOT * (r.total / max), bw, PLOT * (r.total / max), C.blue, .85);
    rect(cx + 1, TOP + PLOT - PLOT * (r.flagged / max), bw, PLOT * (r.flagged / max), C.red, .85);
  });
  // 标记率折线（右轴 0–100%）
  const pts = rows.map((r, i) => [L + step * (i + 0.5), TOP + PLOT - PLOT * (r.rate / 100)]);
  poly(pts, C.orange, 2.5, 'none', '7 5');
  pts.forEach((p, i) => { if (rows[i].rate > 0) circle(p[0], p[1], 3.4, '#fff', 1, C.orange); });
  // 右轴刻度
  for (const v of [0, 25, 50, 75, 100]) {
    const y = TOP + PLOT - PLOT * (v / 100);
    txt(L + dw + 8, y + 5, v + '%', { anchor: 'start', size: 9.5, fill: C.orange });
  }
  rows.forEach((r, i) => txt(L + step * (i + 0.5), TOP + PLOT + 26, r.date.slice(5), { size: 9.5 }));
  legend(H - 22, [['当日提交', C.blue], ['被判作弊', C.red], ['作弊率（右轴）', C.orange]]);
  return [W, H];
};

// 图2 判据命中
charts.rules = () => {
  const rows = D.rules, bh = 34, L = 300, R = 110;
  const H = TOP - 12 + bh * rows.length + 30;
  head('图 1　各判据的命中次数',
    `一局可能同时命中多条判据（${D.totals.flagged} 局里有 ${D.totals.multiReasonRuns} 局是多条）`);
  const max = Math.max(...rows.map(r => r.n));
  rows.forEach((r, i) => {
    const y = TOP - 12 + bh * i + 3, w = (W - L - R) * (r.n / max);
    txt(L - 14, y + 19, r.rule, { anchor: 'end', size: 10, fill: C.ink2 });
    rect(L, y, Math.max(w, 1.5), bh - 12, C.red, .25 + 0.65 * (r.n / max), 3);
    txt(L + w + 12, y + 19, r.n + ' 局', { anchor: 'start', size: 10, fill: C.ink2 });
  });
  return [W, H];
};

// 图3 分数 vs 落球 散点（双对数）
charts.scatter = () => {
  const PLOT = 330, H = TOP + PLOT + 116;
  head('图 3　分数与落球数的关系（双对数）',
    `灰 = ${D.profile.clean.n} 局真人；红 = ${D.profile.dirty.n} 局被判作弊。红点几乎全在灰带之外`);
  const L = 78, dw = W - L - 20;
  const XMIN = 1, XMAX = 12000, YMIN = 1, YMAX = 1e6;
  const lx = (v) => L + dw * (Math.log10(v) - Math.log10(XMIN)) / (Math.log10(XMAX) - Math.log10(XMIN));
  const ly = (v) => TOP + PLOT - PLOT * (Math.log10(v) - Math.log10(YMIN)) / (Math.log10(YMAX) - Math.log10(YMIN));
  // 网格
  for (const v of [1, 10, 100, 1000, 10000]) line(L, ly(v), L + dw, ly(v), C.grid, 1, '3 5');
  for (const v of [1, 10, 100, 1000, 10000]) line(lx(v), TOP, lx(v), TOP + PLOT, C.grid, 1, '3 5');
  for (const v of [1, 10, 100, 1000, 10000, 100000, 1000000]) txt(L - 11, ly(v) + 5, v >= 1000 ? (v / 1000) + 'k' : String(v), { anchor: 'end', size: 9 });
  for (const v of [1, 10, 100, 1000, 10000]) txt(lx(v), TOP + PLOT + 24, String(v), { size: 9 });
  // 参考线：真人中位数 4.01 分/球
  poly([[lx(10), ly(40.1)], [lx(10000), ly(40100)]], C.gray, 1.6, 'none', '6 5');
  txt(lx(140), ly(3000), `真人中位 ${D.profile.clean.scorePerDropMed.toFixed(1)} 分/球`, { anchor: 'start', size: 10, fill: C.ink3 });
  for (const p of D.scatter) {
    if (p.bad) circle(lx(p.d), ly(p.s), 3.6, C.red, .8);
    else circle(lx(p.d), ly(p.s), 2.6, C.ink3, .32);
  }
  for (const p of D.scatter) if (p.bad) circle(lx(p.d), ly(p.s), 3.6, 'none', 1, C.red);
  txt(L, TOP + PLOT + 46, '横轴 = 一局投放了多少个球　纵轴 = 上报分数（对数）', { anchor: 'start', size: 10, fill: C.ink2 });
  legend(H - 12, [[`真人（${D.profile.clean.n} 局）`, C.ink3, .45], [`被判作弊（${D.profile.dirty.n} 局）`, C.red, .8]]);
  return [W, H];
};

// 图4 判据余量（阈值 ÷ 真人极限）
charts.margin = () => {
  const rows = [
    ['存档频率（次/分）', 15.5, '真人 31–126，阈值 2'],
    ['落点跨度（px）', 11.5, '真人最小 459，阈值 40'],
    ['终局球离地（px）', 10.3, '真人 ≤140，阈值 1442'],
    ['落点位置数（种）', 5.3, '真人最少 158，阈值 30'],
    ['单球速度（px/s）', 2.7, '真人不超 1106，阈值 3000'],
    ['投放间隔模态占比', 1.8, '真人最高 28%，阈值 50%'],
    ['每次投放得分', 1.5, '真人最高 7.85，阈值 12'],
  ].sort((a, b) => b[1] - a[1]);
  const bh = 40, L = 236, BARW = 300;
  const H = TOP + bh * rows.length + 66;
  head('图 5　各判据留给真人的余量（阈值 ÷ 真人实测极限）', '余量 = 阈值是真人的几倍；虚线 2× 是「薄余量」警戒线');
  const max = 16;
  const x2 = L + BARW * (2 / max);
  line(x2, TOP - 4, x2, TOP + bh * rows.length - 10, C.orange, 2, '6 5');
  rows.forEach(([rule, ratio, note], i) => {
    const y = TOP + bh * i + 3, w = BARW * (ratio / max);
    txt(L - 14, y + 21, rule, { anchor: 'end', size: 10, fill: C.ink2 });
    rect(L, y, Math.max(w, 2), bh - 15, ratio < 2 ? C.orange : C.blue, ratio < 2 ? .8 : .62, 3);
    txt(L + w + 12, y + 21, ratio.toFixed(1) + '×', { anchor: 'start', size: 10.5, fill: ratio < 2 ? C.orange : C.ink, bold: true });
    txt(L + BARW + 78, y + 21, note, { anchor: 'start', size: 9.6, fill: C.ink3 });
  });
  txt(x2, TOP + bh * rows.length + 12, '2× 警戒线', { size: 9.8, fill: C.orange, bold: true });
  txt(0, H - 14, '余量越大越安全，但漏判风险也越大。余量低于 2× 的两条（投放得分、间隔模态）是最薄的地方。',
    { anchor: 'end', size: 10, fill: C.ink2 });
  return [W, H];
};

// 图5 网络层攻击规模
charts.network = () => {
  const rows = [
    ['云凭据扫描（单 IP 一天）', 12467, '找腾讯云 / 阿里云 OSS 密钥'],
    ['密钥扫描（.env / .git）', 11527, '两周累计 401 + 404'],
    ['SSH 暴力破解', 5985, 'fail2ban 封 208 个 IP'],
    ['存档接口洪泛（单 IP 40 分钟）', 2586, '峰值 923 次/分，797 次被限流'],
    ['后台 API 爆破', 47, '含空字节注入与路径穿越'],
  ];
  const bh = 44, L = 272, BARW = 250;
  const H = TOP + bh * rows.length + 62;
  head('图 6　两周内观测到的网络层攻击规模', '纵轴为请求次数（线性）。后台 API 那 47 次全部被挡在 403，零命中');
  const max = Math.max(...rows.map(r => r[1]));
  rows.forEach(([rule, n, note], i) => {
    const y = TOP + bh * i + 3, w = BARW * (n / max);
    txt(L - 14, y + 21, rule, { anchor: 'end', size: 10, fill: C.ink2 });
    rect(L, y, Math.max(w, 2), bh - 16, i >= 3 ? C.orange : C.red, i >= 3 ? .78 : .62, 3);
    txt(L + BARW + 14, y + 21, n.toLocaleString('en-US') + ' 次', { anchor: 'start', size: 10.5, fill: C.ink, bold: true });
    txt(L + BARW + 118, y + 21, note, { anchor: 'start', size: 9.6, fill: C.ink3 });
  });
  txt(0, H - 16, '无差别背景扫描（挖矿矿池探测、RDP、Nmap、WordPress 路径探测）每天都在，量级另计，未入图。',
    { anchor: 'end', size: 10, fill: C.ink2 });
  return [W, H];
};

// 图6 真人 vs 作弊 画像
charts.profile = () => {
  const P = D.profile;
  // T0 是绘图区顶部：标题、面板名、柱子上的数值标签各占一行，三层要分开，
  // 否则最高的那根柱子（第三栏的对数刻度）会把标签顶到面板名上。
  const PLOT = 240, T0 = TOP + 48, H = T0 + PLOT + 82;
  const BASE = T0 + PLOT;
  head('图 2　真人局与作弊局的画像差异', '作弊者不是「玩得更久」，而是「几乎不玩就直接上报」');
  const panels = [
    { title: '中位单局时长', a: P.clean.durMedMin, b: P.dirty.durMedMin, max: Math.max(P.clean.durMedMin, P.dirty.durMedMin), unit: ' 分钟' },
    { title: '中位单局落球', a: P.clean.dropsMed, b: P.dirty.dropsMed, max: Math.max(P.clean.dropsMed, P.dirty.dropsMed), unit: ' 个' },
    { title: '分数 / 落球 最大值', a: P.clean.scorePerDropMax, b: P.dirty.scorePerDropMax, max: Math.max(P.clean.scorePerDropMax, P.dirty.scorePerDropMax), unit: ' 分/球', log: true },
  ];
  const L = 70, pw = (W - L - 30) / panels.length;
  panels.forEach((p, i) => {
    const x0 = L + pw * i, bw = pw * 0.24;
    const lg = (v) => Math.log10(Math.max(1, v)) / Math.log10(Math.max(10, p.max * 1.05));
    // 只用到 84% 高度，给柱顶的数值标签留位置
    const h = (v) => PLOT * 0.84 * (p.log ? lg(v) : v / (p.max * 1.18));
    txt(x0 + pw / 2, T0 - 18, p.title, { size: 10.5, fill: C.ink2, bold: true });
    [['真人', p.a, C.ink3, x0 + pw * 0.32], ['作弊', p.b, C.red, x0 + pw * 0.66]].forEach(([label, v, color, cx]) => {
      rect(cx - bw / 2, BASE - h(v), bw, h(v), color, .8, 3);
      const shown = v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2).replace(/\.?0+$/, '');
      txt(cx, BASE - h(v) - 10, shown + p.unit, { size: 10, fill: color, bold: true });
      txt(cx, BASE + 26, label, { size: 10, fill: C.ink2 });
    });
    line(x0, BASE, x0 + pw, BASE, C.ink3, 1.2);
  });
  txt(L, H - 16, '第三栏用对数刻度：作弊局的「分数 / 落球」最大值是真人上限的一万多倍，分数和落球彻底脱钩。',
    { anchor: 'start', size: 10, fill: C.ink2 });
  return [W, H];
};

const sizes = {};
for (const [key, draw] of Object.entries(charts)) {
  reset();
  const [w, h] = draw();
  writeFileSync(join(outDir, `${key}.svg`), wrap(w, h), 'utf8');
  writeFileSync(join(outDir, `${key}.html`),
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}svg{display:block}</style></head><body>${wrap(w, h)}</body></html>`, 'utf8');
  sizes[key] = [w, h];
}
writeFileSync(join(outDir, 'sizes.json'), JSON.stringify(sizes, null, 1));
console.log(JSON.stringify(sizes));
