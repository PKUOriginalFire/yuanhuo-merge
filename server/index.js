/**
 * 排行榜与可恢复对局后端（node:http + node:sqlite + Matter.js）
 *
 * 启动：node server/index.js
 * 环境变量：
 *   PORT        监听端口，默认 8787
 *   HOST        监听地址，默认 127.0.0.1（交给 Nginx 反代时保持默认即可）
 *   DB_PATH     数据库路径，默认 server/data/yuanhuo.db
 *   ADMIN_TOKEN 后台令牌；不设则关闭 /api/admin/*
 *   IP_SALT     IP 哈希盐；生产环境建议设一个随机串
 *   SERVE_STATIC=1  同时托管 web/dist（不挂 Nginx 也能单进程跑起来）
 *
 * ⚠️ 为什么默认端口不是 3000：
 *    3000 是全世界最容易被占的端口（本机上 QQ/NapCat 就占着 IPv4 的 3000）。
 *    更坑的是，如果别的进程只占了 127.0.0.1:3000，而这里绑 ::（IPv6 全接口）
 *    居然能成功 —— 进程会打印"监听成功"，但你访问 127.0.0.1:3000 打到的
 *    是那个别的进程。所以这里显式绑 HOST，并且在 listen 后打印真实地址自检。
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  getOrCreatePlayer, setNickname, nicknameTaken, insertRun,
  leaderboard, rankOf, playerBest, stats,
  flaggedRuns, clearFlag, setBan, DB_PATH, db,
} from './db.js';
import { validateRun, validateNickname, cleanNickname } from './validate.js';
import { competitionClosed, competitionEndsAt, finalBoard, closedMessage } from './competition.js';
import { Game } from './sim/game.js';
import { createRunSessions, SessionError, simBiasFlag, SIM_FLAG_PREFIX } from './sessions.js';

// 增量校验的抽样参数可以用环境变量微调（不对外开放，只有能改 systemd 的人碰得到）：
//   SIM_SAMPLE=0.5        抽样率（默认 0.12）
//   SIM_MIN_INTERVAL_MS   两次校验的最小间隔（默认 1000）
//   SIM_MAX_CHECKS        单局最多校验次数（默认 200）
// 用途：上线观察期拉满抽样做标定，或者 CPU 吃紧时调低。非法值一律忽略。
function simTuning() {
  const tuning = {};
  const num = name => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const sample = num('SIM_SAMPLE');
  if (sample !== null) tuning.sample = Math.min(1, Math.max(0, sample));
  const interval = num('SIM_MIN_INTERVAL_MS');
  if (interval !== null) tuning.minIntervalMs = Math.max(0, interval);
  const max = num('SIM_MAX_CHECKS');
  if (max !== null) tuning.maxChecks = Math.max(0, Math.min(2000, Math.floor(max)));
  return tuning;
}

const sessions = createRunSessions(db, Game, Date.now, { sim: simTuning() });

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const IP_SALT = process.env.IP_SALT || 'yuanhuo-default-salt';
const SERVE_STATIC = process.env.SERVE_STATIC === '1';
const DIST = resolve(HERE, '..', 'web', 'dist');

const PROMPT_RANK = 100;   // 排进前多少名才弹签名框
const TOP_N = 100;
// 2026-10-19：2MB → 1MB。真实的 checkpoint 请求体只有 20–30KB（最大的头部对局 ~110KB），
// 2MB 的上限意味着攻击者可以让服务器先 JSON.parse 一个 2MB 的包（~7ms CPU）再拒掉它。
// 配合 nginx 的 client_max_body_size 1m 使用。
const MAX_BODY = 1 * 1024 * 1024;
/** clientId 长度：下限保证不是随手编的，上限防止拿它当填充物灌库 */
const CLIENT_ID_MIN = 8;
const CLIENT_ID_MAX = 64;
/** 存进库的 trace 上限。真人对局 1000 球约 40KB，2MB 远远够用 */
const TRACE_STORE_MAX = 200_000;
/** 参与校验的 trace 条目上限 */
const TRACE_VERIFY_MAX = 20000;

// ────────────────────────────────────────── 小工具

const json = (res, code, data) => {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
};

const hashIp = (ip) => createHash('sha256').update(IP_SALT + ip).digest('hex').slice(0, 16);

/**
 * 取客户端 IP，用于限流和 ip_hash。
 *
 * ⚠️ 绝对不要用 X-Forwarded-For 的最左值。
 *    nginx 的 `$proxy_add_x_forwarded_for` 会把客户端自带的 XFF **原样拼在最左边**，
 *    也就是 `"客户端伪造的值, 真实IP"` —— 取最左等于让攻击者自己填 IP，
 *    限流会 100% 失效，写进库的 ip_hash 也失去取证意义甚至能栽赃别人。
 *    （这是上线后实测确认过的漏洞。）
 *
 * 正确做法：只用 nginx 用 `$remote_addr` 设的 X-Real-IP，它客户端改不了。
 * 没有这个头（比如本机直连、开发环境）就退回 socket 地址。
 */
function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real.trim();
  return req.socket.remoteAddress || '0.0.0.0';
}

/** clientId 长度校验，两个接口共用 */
function badClientId(v) {
  return typeof v !== 'string' || v.length < CLIENT_ID_MIN || v.length > CLIENT_ID_MAX;
}

/** 只接受普通对象作为请求体，挡住 `null` / 数组 / 字符串引发的解构异常 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 把外部输入转成**有限整数**，否则返回 fallback。
 *
 * ⚠️ 不要写 `Number(v) || 0`：`Number('1e999')` 是 Infinity，会被原样写进
 *    声明为 INTEGER 的列（node:sqlite 接受），之后 JSON 序列化时又变成 null。
 *    `Number('abc')` 是 NaN，也会被 `|| 0` 悄悄吞掉，掩盖掉本该报错的输入。
 */
function numOr(v, fallback) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** 客户端侧的错误（4xx）。和代码 bug 引起的 500 区分开，避免把内部信息回显出去 */
class ClientError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ClientError('请求体过大', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      let parsed;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        reject(new ClientError('请求体不是合法 JSON'));
        return;
      }
      // JSON.parse('null' / '1' / '"x"' / '[]') 都能成功但类型不对，
      // 后面的解构会抛 TypeError → 500。这里提前挡掉。
      if (!isPlainObject(parsed)) {
        reject(new ClientError('请求体必须是 JSON 对象'));
        return;
      }
      resolvePromise(parsed);
    });
    req.on('error', reject);
  });
}

/** 简易内存限流：每个 IP 每分钟 N 次 */
const buckets = new Map();
function rateLimit(ip, key, limit, windowMs = 60_000) {
  const k = `${key}:${ip}`;
  const now = Date.now();
  let b = buckets.get(k);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(k, b);
  }
  b.count++;
  return b.count <= limit;
}

// 定期清理限流表，别让 Map 无限长
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k);
}, 60_000).unref();

// ────────────────────────────────────────── 静态文件（可选）

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(req, res, urlPath) {
  // 防目录穿越
  const safe = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(DIST, safe);
  if (!filePath.startsWith(DIST)) return false;

  try {
    const st = await stat(filePath);
    if (st.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // SPA 回退：任何非资源路径都返回 index.html
    if (extname(safe)) return false;
    filePath = join(DIST, 'index.html');
  }

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const immutable = ['.png', '.webp', '.jpg', '.mp3', '.ogg', '.woff2'].includes(ext)
      || filePath.includes(`${'assets'}`);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=2592000, immutable' : 'no-cache',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

// ────────────────────────────────────────── 业务处理

async function handleLeaderboard(req, res, url) {
  const mode = url.searchParams.get('mode') === 'endless' ? 'endless' : 'classic';
  const top = Math.min(TOP_N, Math.max(1, Number(url.searchParams.get('top')) || 50));

  if (!rateLimit(clientIp(req), 'board', 120)) {
    return json(res, 429, { error: '请求太快了，歇一会儿' });
  }
  // 截止之后只认静态最终榜单：名次从此不再随数据库变化。
  // 文件缺失时退化成实时查询（宁可显示实时榜，也不要给玩家一个打不开的排行榜）。
  if (competitionClosed()) {
    const frozen = finalBoard();
    if (frozen) {
      const rows = (frozen[mode] || []).slice(0, top);
      return json(res, 200, { rows, mode, total: rows.length, closed: true, closedAt: competitionEndsAt() });
    }
  }
  const rows = leaderboard(mode, top);
  json(res, 200, { rows, mode, total: rows.length, closed: competitionClosed() });
}

async function handleSubmit(req, res) {
  const ip = clientIp(req);
  if (!rateLimit(ip, 'submit', 30)) {
    return json(res, 429, { error: '提交太频繁了，缓一缓' });
  }
  if (competitionClosed()) {
    return json(res, 403, { error: closedMessage() });
  }

  const body = await readBody(req);
  const { clientId } = body;

  if (badClientId(clientId)) {
    return json(res, 400, { error: 'clientId 非法' });
  }

  const player = getOrCreatePlayer(clientId);
  if (player.banned) {
    return json(res, 403, { error: '该账号已被封禁' });
  }

  const response = sessions.finish(clientId, body, trusted => {
  const { mode, score, maxLevel, merges, loopCount, durationMs, trace } = trusted;
  const verdict = validateRun(trusted);
  // 对局过程中 checkpoint 的软校验结论也一并算进可疑原因（见 server/checkpoint.js）。
  const flags = [...new Set([...(trusted.flags ? String(trusted.flags).split(' | ') : []), ...(verdict.ok ? [] : verdict.flags)])];
  // 增量校验的累计偏差：真玩家是均值 0 的随机游走，注水者线性增长。
  // 判据是 4σ√N 界（见 sessions.js 的 SIM_RULE / simBiasFlag 标定）。
  // 多数情况这条在 checkpoint 阶段就已经记进 live_game.flags 了，这里补最后一次判定。
  const simFlag = simBiasFlag(numOr(trusted.simChecks, 0), numOr(trusted.simBias, 0));
  if (simFlag && !flags.some(flag => flag.startsWith(SIM_FLAG_PREFIX))) flags.push(simFlag);
  // 开局就退出的空对局不是作弊，别让它污染可疑队列（每天几十条，纯噪音）。
  const emptyRun = !(numOr(score, 0) || numOr(merges, 0) || (Array.isArray(trace) && trace.length));
  const suspicious = flags.length > 0 && !emptyRun;
  const previousBest = playerBest(player.id, mode);

  // 只存校验真正用得上的字段，并封顶。
  // 之前是 JSON.stringify(trace) 直接存 1.5MB —— 而 trace 里的 x 字段完全没被校验过，
  // 等于给了攻击者一条"每次请求往磁盘写 1.5MB 且 suspicious=0"的免费通道。
  const stored = Array.isArray(trace) ? trace.slice(0, TRACE_VERIFY_MAX) : [];
  const traceStr = JSON.stringify(stored).slice(0, TRACE_STORE_MAX);
  const runId = insertRun({
    playerId: player.id,
    mode,
    score: numOr(score, 0),
    maxLevel: numOr(maxLevel, 1),
    merges: numOr(merges, 0),
    loopCount: numOr(loopCount, 0),
    durationMs: numOr(durationMs, 0),
    drops: stored.length,
    trace: traceStr,
    suspicious,
    flagReason: suspicious ? flags.join(' | ').slice(0, 500) : null,
    ipHash: hashIp(ip),
  });

  if (suspicious) {
    console.warn(`[flag] run#${runId} ${mode} score=${score} → ${flags.join(' | ')}`);
    return {
      ok: false,
      rank: null,
      improved: false,
      promptSignature: false,
      reason: '成绩异常，已记录待人工复核',
    };
  }

  const improved = Number(score) > previousBest;
  // 名次按"这条成绩在榜上的位置"算
  const rank = rankOf(mode, Number(score), Date.now());
  const shouldPrompt = !player.nickname && rank !== null && rank <= PROMPT_RANK;

  return {
    ok: true,
    rank,
    improved,
    promptSignature: shouldPrompt,
  };
  });
  json(res, 200, response);
}

async function handleSession(req, res, action) {
  const ip = clientIp(req);
  const saving = action === 'sync' || action === 'checkpoint';
  // ⚠️ game-sync 的限额要和真实客户端对齐，别再往回加。
  //    真实客户端每 1–2 秒存档一次，6000/分钟 = 100 次/秒 是需求的 50–100 倍。
  //    实测一次最坏 checkpoint 要 ~20ms 服务端 CPU，而单线程节点每秒只能处理 ~32 次 ——
  //    也就是说旧限额下**一个 IP 就能把事件循环占满、全站卡死**。
  //    现在：应用层 1200/分钟（20/秒）+ nginx 边缘 10r/s，两道闸。
  //    20/秒 仍然够同一个 NAT 后面 5–10 个玩家同时正常游戏。
  if (!rateLimit(ip, saving ? 'game-sync' : 'game-session', saving ? 1200 : 120)) return json(res, 429, { error: '操作太频繁，请稍后重试' });
  // 截止后只拦「开新局」。resume / checkpoint / sync 不改变比赛结果，
  // 拦了只会让还在存档的页面报错，反而制造莫名其妙的失败。
  if (action === 'start' && competitionClosed()) {
    return json(res, 403, { error: closedMessage() });
  }
  const body = await readBody(req);
  if (badClientId(body.clientId)) return json(res, 400, { error: 'clientId 非法' });
  if (saving && !rateLimit(body.clientId, 'player-sync', 240)) return json(res, 429, { error: '操作太频繁，请稍后重试' });
  const player = getOrCreatePlayer(body.clientId);
  if (player.banned) return json(res, 403, { error: '该账号已被封禁' });
  let reply;
  if (action === 'start') reply = sessions.start(body.clientId, body.mode, body.requestId, body.protocol, body.easterEggs === 1);
  else if (action === 'resume') reply = sessions.resume(body.clientId, body.id, body.key, body.claimId, body);
  else if (action === 'checkpoint') reply = sessions.checkpoint(body.clientId, body);
  else reply = sessions.sync(body.clientId, body);
  json(res, 200, reply);
}

async function handleNickname(req, res) {
  const ip = clientIp(req);
  if (!rateLimit(ip, 'nick', 20)) {
    return json(res, 429, { error: '改签名太频繁了' });
  }

  const body = await readBody(req);
  const { clientId, nickname } = body;

  // 之前这里只有下限、没有上限 —— 实测能塞进 200000 字符的 clientId 并成功入库，
  // 等于给了一条"每请求往磁盘写 ~2MB"的通道。上限统一走 badClientId。
  if (badClientId(clientId)) {
    return json(res, 400, { error: 'clientId 非法' });
  }

  const err = validateNickname(nickname);
  if (err) return json(res, 400, { error: err });

  const clean = cleanNickname(nickname);
  const player = getOrCreatePlayer(clientId);
  if (player.banned) return json(res, 403, { error: '该账号已被封禁' });

  setNickname(player.id, clean);
  json(res, 200, { ok: true, nickname: clean, sameName: nicknameTaken(clean, player.id) });
}

function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) {
    json(res, 404, { error: '未开启后台' });
    return false;
  }
  const token = req.headers['x-admin-token'] || new URL(req.url, 'http://x').searchParams.get('token');
  if (token !== ADMIN_TOKEN) {
    json(res, 401, { error: '令牌不对' });
    return false;
  }
  return true;
}

// ────────────────────────────────────────── 服务器

/**
 * 安全地解析请求 URL。
 *
 * ⚠️ 这一行**必须**在 try 里面。
 *    之前它写在 createServer 回调的第一行、try 之外，而回调是 async ——
 *    `new URL(req.url, 'http://' + req.headers.host)` 遇到畸形 Host（比如 `[`）
 *    会抛 TypeError，变成 unhandled rejection，**整个进程直接退出**。
 *    实测：一个 `Host: [` 的请求就能打挂后端，systemd 再拉起，形成崩溃循环。
 */
function parseUrl(req) {
  try {
    return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return null;   // 交给调用方返回 400
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = parseUrl(req);
    if (!url) {
      return json(res, 400, { error: '请求头不合法' });
    }
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      if (req.method === 'GET' && path === '/api/health') {
        // 不回显数据库路径 —— 公网可见的绝对路径没有用处，只有坏处
        return json(res, 200, { ok: true, time: Date.now(), features: { continuation: 1, localCheckpoints: 2, easterEggs: 1 },
          competition: { ended: competitionClosed(), endsAt: competitionEndsAt() } });
      }
      if (req.method === 'GET' && path === '/api/leaderboard') {
        return await handleLeaderboard(req, res, url);
      }
      if (req.method === 'GET' && path === '/api/stats') {
        if (!rateLimit(clientIp(req), 'stats', 30)) {
          return json(res, 429, { error: '请求太快了' });
        }
        return json(res, 200, stats());
      }
      if (req.method === 'POST' && path === '/api/run/submit') {
        return await handleSubmit(req, res);
      }
      if (req.method === 'POST' && ['/api/run/start', '/api/run/resume', '/api/run/sync', '/api/run/checkpoint'].includes(path)) {
        return await handleSession(req, res, path.split('/').pop());
      }
      if (req.method === 'POST' && path === '/api/nickname') {
        return await handleNickname(req, res);
      }
      // ── 后台（需要 ADMIN_TOKEN）
      if (req.method === 'GET' && path === '/api/admin/flagged') {
        if (!rateLimit(clientIp(req), 'admin', 30)) {
          return json(res, 429, { error: '请求太快了' });
        }
        if (!requireAdmin(req, res)) return;
        return json(res, 200, { rows: flaggedRuns(200) });
      }
      if (req.method === 'POST' && path === '/api/admin/clear-flag') {
        if (!requireAdmin(req, res)) return;
        const b = await readBody(req);
        clearFlag(Number(b.runId));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/admin/ban') {
        if (!requireAdmin(req, res)) return;
        const b = await readBody(req);
        setBan(Number(b.runId), !!b.banned);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: '没有这个接口' });
    }

    if (SERVE_STATIC) {
      if (await serveStatic(req, res, path)) return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    // 客户端错误 → 4xx，只回显我们自己写的文案
    if (e instanceof ClientError || e instanceof SessionError) {
      if (!res.headersSent) json(res, e.status, { error: e.message });
      return;
    }
    // 真正的服务端 bug → 500，**不回显 e.message**（会泄露内部结构）
    console.error('[error]', req.method, req.url, e);
    if (!res.headersSent) json(res, 500, { error: '服务器内部错误' });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${PORT} 已被占用。`);
    console.error(`   换个端口：PORT=8899 node server/index.js`);
    console.error(`   看看是谁占的： netstat -ano | findstr :${PORT}\n`);
  } else {
    console.error('❌ 服务器错误：', e);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  console.log(`🔥 合成大元火 · 排行榜后端`);
  console.log(`   监听      http://${HOST}:${addr.port}`);
  console.log(`   数据库    ${DB_PATH}`);
  console.log(`   静态托管  ${SERVE_STATIC ? DIST : '关闭（由 Nginx 负责）'}`);
  console.log(`   后台令牌  ${ADMIN_TOKEN ? '已设置' : '未设置（/api/admin/* 已关闭）'}`);

  // 自检：真的能用这个地址访问到吗？
  // 防的就是"绑上了但地址不对"这类静默故障。
  const probe = http.get(
    { host: HOST, port: addr.port, path: '/api/health', timeout: 3000 },
    (res) => {
      if (res.statusCode === 200) {
        console.log(`   ✅ 自检通过：${HOST}:${addr.port}/api/health 可访问`);
      } else {
        console.error(`   ⚠️ 自检异常：/api/health 返回 ${res.statusCode}，可能有别的进程抢答`);
      }
      res.resume();
    },
  );
  probe.on('error', (e) => console.error(`   ⚠️ 自检失败：${e.message}`));
  probe.on('timeout', () => { probe.destroy(); console.error('   ⚠️ 自检超时'); });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，正在关闭…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// ────────────────────────────────────────── 进程级兜底
//
// Node 默认 --unhandled-rejections=throw：async 回调里漏出去的任何异常都会
// 直接结束进程。之前就因为这个，一个畸形 Host 头能把整个服务打挂。
// 这里兜住，记日志但不退出 —— 单次请求出错不该让所有在线玩家断线。
//
// 注意：这不代表可以不用 try/catch。它只防"没预料到的那一个"。
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] 已忽略，进程继续运行：', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] 已忽略，进程继续运行：', err);
});
