/**
 * 兜底抢救的命令行入口（由 systemd timer 定时调用）。
 *
 * 用法：
 *   node server/recover-cli.js            正常执行
 *   node server/recover-cli.js --dry-run  只报告，不写库
 *
 * 环境变量：DB_PATH（默认 server/data/yuanhuo.db）
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recoverLostRuns, RECOVER_RULE } from './recover.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(HERE, 'data', 'yuanhuo.db');
const dryRun = process.argv.includes('--dry-run');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');

let result;
try {
  if (dryRun) {
    // 演练：开事务后回滚，走完全一样的代码路径但不落盘
    db.exec('BEGIN IMMEDIATE');
    result = recoverLostRuns(db, Date.now(), RECOVER_RULE);
    db.exec('ROLLBACK');
  } else {
    db.exec('BEGIN IMMEDIATE');
    result = recoverLostRuns(db, Date.now(), RECOVER_RULE);
    db.exec('COMMIT');
  }
} catch (error) {
  try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
  console.error('[recover] 失败：', error?.message ?? error);
  process.exit(1);
} finally {
  db.close();
}

const stamp = new Date().toISOString();
if (result.recovered.length) {
  for (const r of result.recovered) {
    console.log(`[recover] ${stamp} 抢救 run#${r.runId} (${r.nickname || '无名'}) ${r.mode} ${r.score} 分 / ${(r.durationMs / 1000).toFixed(0)} 秒 / 投放 ${r.drops}`
      + `${r.abandoned ? ' [已放弃行]' : ''}${r.simChecks ? ` 抽样${r.simChecks}` : ''}${dryRun ? ' [演练]' : ''}`);
  }
}
if (result.skipped.length) {
  for (const s of result.skipped) {
    if (/已入库/.test(s.why)) continue;          // 重复扫到的不刷日志
    console.log(`[recover] ${stamp} 跳过 live=${s.id}${s.score ? ` ${s.score} 分` : ''}：${s.why}`);
  }
}
if (!result.scanned) console.log(`[recover] ${stamp} 无待抢救对局`);
else console.log(`[recover] ${stamp} 扫描 ${result.scanned} 条，抢救 ${result.recovered.length} 条，跳过 ${result.skipped.length} 条${dryRun ? '（演练，未写库）' : ''}`);
