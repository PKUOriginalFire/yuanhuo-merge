// 影响范围：有多少在途/已提交记录被台账在中途判过
import { DatabaseSync } from 'node:sqlite';
import { ledgerFlag } from '/opt/yuanhuo/server/validate.js';
const db = new DatabaseSync('/opt/yuanhuo/server/data/yuanhuo.db', { readOnly: true });

console.log('=== run 表里带"台账上界"标记的记录 ===');
const runs = db.prepare(`SELECT r.id, r.mode, r.score, r.duration_ms, r.flag_reason, r.created_at, p.nickname
  FROM run r JOIN player p ON p.id = r.player_id WHERE r.flag_reason LIKE '%台账上界%' ORDER BY r.id`).all();
for (const r of runs) {
  const when = new Date(r.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).slice(5, 16);
  console.log(`  #${r.id} ${when} ${String(r.mode).padEnd(7)} ${String(r.score).padStart(6)} 分  ${r.nickname || '(无名)'}`);
  for (const f of String(r.flag_reason).split(' | ')) if (/台账|循环/.test(f)) console.log(`       · ${f.slice(0, 150)}`);
}

console.log('\n=== live_game 里带台账标记的在途行（含已提交的）===');
const lives = db.prepare(`SELECT l.id, l.flags, json_extract(l.state,'$.score') AS score, json_extract(l.state,'$.status') AS status,
    json_extract(l.state,'$.loopCount') AS loop, l.state, l.result, p.nickname
  FROM live_game l LEFT JOIN player p ON p.client_id = l.client_id
  WHERE l.flags LIKE '%台账上界%' OR l.flags LIKE '%循环 %'`).all();
for (const l of lives) {
  const s = JSON.parse(l.state);
  const nowFlag = ledgerFlag({ mode: s.mode, trace: s.trace, balls: s.balls, merges: s.merges, score: s.score, loopCount: s.loopCount });
  console.log(`  ${String(l.score).padStart(6)} 分 ${String(l.status).padEnd(7)} 循环 ${l.loop}  ${l.nickname || '(无名)'}`);
  console.log(`     在途时被判: ${String(l.flags).split(' | ').filter(f => /台账|循环/.test(f)).slice(0, 2).join(' / ').slice(0, 160)}`);
  console.log(`     用终局重算: ${nowFlag || '✅ 在界内（说明当时是误判）'}`);
}
if (!lives.length) console.log('  （没有）');
