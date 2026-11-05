/**
 * 多进程入口。
 *
 * 为什么需要：`server/index.js` 是**单线程**的。实测一次最坏 checkpoint 要 ~20ms CPU，
 * 也就是单个进程每秒最多处理 ~32 次。哪怕 nginx 已经把每个 IP 按 10r/s 卡住，
 * 只要凑够几个 IP，单个 Node 进程被占满时**全站都会卡**（事件循环是共享的）。
 * 起 N 个 worker 之后，一个被刷爆不会连累其他。
 *
 * 用法：
 *   WEB_CONCURRENCY=4 node cluster.js     # 起 4 个 worker，共享同一个端口
 *   node cluster.js                       # WEB_CONCURRENCY 未设置或 ≤1 → 直接跑单进程
 *
 * ⚠️ 代价（已知且接受）：
 *   1. `index.js` 里那个内存限流表变成**每个 worker 一份**，所以应用层限额的实际总量
 *      会乘以 worker 数。所以真正的第一道闸必须是 nginx（见
 *      `/etc/nginx/snippets/yuanhuo-limits.conf`），别指望应用层限流。
 *   2. 多个进程同时写同一个 SQLite。WAL + `PRAGMA busy_timeout = 5000`（见 db.js）
 *      已经覆盖；写入速率本来就低（每个玩家 1–2 次/秒）。
 *   3. 每个 worker 各自持有一份内存缓存/限流表，统计口径要合并着看。
 */
import cluster from 'node:cluster';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKERS = Math.max(1, Math.min(8, Number(process.env.WEB_CONCURRENCY || 1) || 1));
/** cluster 的 exec 是相对 **cwd** 解析的，必须给绝对路径，否则从别的目录启动会找不到 index.js */
const ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'index.js');

if (WORKERS > 1 && cluster.isPrimary) {
  console.log(`🔥 合成大元火 · 后端主进程（${WORKERS} 个 worker，端口由 Node 共享）`);
  cluster.setupPrimary({ exec: ENTRY });

  for (let i = 0; i < WORKERS; i++) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    console.error(`[cluster] worker #${worker.id} 退出（code=${code} signal=${signal}），立刻补一个`);
    // 只在主进程还活着的时候补，避免 systemd 正在关服务时无限重启
    if (!stopping) cluster.fork();
  });

  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      stopping = true;
      console.log(`\n[cluster] 收到 ${sig}，通知 ${WORKERS} 个 worker 退出…`);
      for (const worker of Object.values(cluster.workers ?? {})) worker.kill(sig);
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
} else {
  // 动态 import 相对**模块文件**解析，和 cwd 无关，所以这里用 './index.js' 是对的
  await import('./index.js');
}
