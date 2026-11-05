// 量「玩家F」那局提交时请求体有多大，以及限制在哪一层
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('/opt/yuanhuo/server/data/yuanhuo.db', { readOnly: true });
const row = db.prepare("SELECT l.id, l.client_id, l.revision, l.active, l.abandoned, l.result, l.updated_at, l.started_at, l.sim_checks, l.sim_bias, l.state, p.nickname FROM live_game l LEFT JOIN player p ON p.client_id = l.client_id WHERE json_extract(l.state,'$.score') = 13527").get();
if (!row) { console.log('找不到该局'); process.exit(0); }

const state = JSON.parse(row.state);
const traceJson = JSON.stringify(state.trace);
console.log('玩家:', row.nickname || '(无名)');
console.log('live id:', row.id, ' clientId:', row.client_id);
console.log('revision:', row.revision, ' active:', row.active, ' abandoned:', row.abandoned);
console.log('result 字段:', row.result ? String(row.result).slice(0, 100) : '(null = 从未成功提交)');
console.log('最后更新:', new Date(row.updated_at).toISOString());
console.log('');
console.log('state 总大小:', (JSON.stringify(state).length / 1024).toFixed(1), 'KB');
console.log('其中 trace:', (traceJson.length / 1024).toFixed(1), 'KB，', state.trace.length, '条，平均每条', Math.round(traceJson.length / state.trace.length), '字节');
console.log('');
// 估算提交请求体：trace + 少量字段
const submitBody = JSON.stringify({
  clientId: row.client_id, id: row.id, key: 'x'.repeat(43), lease: 'x'.repeat(43),
  revision: row.revision, mode: state.mode, score: state.score, maxLevel: state.maxLevelReached,
  merges: state.merges, loopCount: state.loopCount, durationMs: Math.round(state.elapsed), trace: state.trace,
});
console.log('提交请求体估算:', (submitBody.length / 1024).toFixed(1), 'KB');
console.log('');
// 看看库里其它高分局的 trace 大小，判断多大才算"正常"
const sizes = db.prepare('SELECT r.id, r.score, LENGTH(r.trace) AS n, r.drops FROM run r ORDER BY LENGTH(r.trace) DESC LIMIT 6').all();
console.log('库里 trace 最大的几局（存的是截断后的）:');
for (const s of sizes) console.log(`  #${s.id} ${s.score} 分，trace 存储 ${(s.n / 1024).toFixed(1)} KB，投放 ${s.drops} 次`);
