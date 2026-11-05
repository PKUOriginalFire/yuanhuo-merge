import { BOARD } from './config';

/**
 * 昵称校验 —— 前端做即时反馈，服务端有同一套规则兜底。
 * ⚠️ 改这里的规则时，记得同步改 server/validate.js 的 validateNickname。
 */

/** 零宽字符、方向控制符等隐形字符，直接剥掉 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
/** C0/C1 控制字符 */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

const BANNED: RegExp[] = [
  /(傻|煞|沙)\s*逼/i,
  /操\s*你|草\s*你|日\s*你/,
  /他妈|妈的|尼玛|泥马/,
  /nmsl|cnm|tmd/i,
  /fuck|shit|bitch|asshole/i,
  /加\s*(微信|wx|qq|群)/i,
  /代\s*刷|刷\s*分|外挂|脚本/,
  /出售|低价|私聊|广告位/,
  /https?:\/\//i,
  /www\./i,
];

/** 粗略统计 emoji 数量，防止 12 个 emoji 把榜单撑爆 */
function countEmoji(s: string): number {
  const m = s.match(/\p{Extended_Pictographic}/gu);
  return m ? m.length : 0;
}

/** 返回 null 表示合法，否则返回给用户看的错误提示 */
export function validateNickname(raw: string): string | null {
  const nick = raw.replace(INVISIBLE, '').replace(CONTROL, '').trim();

  if (!nick) return '签名不能是空的哦';
  if (/\s{2,}/.test(nick)) return '不要连续打空格';

  const len = Array.from(nick).length;
  if (len < BOARD.nickMin) return '太短啦';
  if (len > BOARD.nickMax) return `最多 ${BOARD.nickMax} 个字（现在 ${len} 个）`;

  if (countEmoji(nick) > 3) return 'emoji 最多 3 个';

  // 至少得有一个字母/数字/汉字，纯符号不行
  if (!/[\p{L}\p{N}]/u.test(nick)) return '至少要有字母、数字或汉字';

  for (const re of BANNED) {
    if (re.test(nick)) return '这个签名不能用，换一个吧';
  }
  return null;
}

/** 清洗：剥隐形字符 + 去首尾空白 + 截断到上限 */
export function cleanNickname(raw: string): string {
  return Array.from(raw.replace(INVISIBLE, '').replace(CONTROL, '').trim())
    .slice(0, BOARD.nickMax)
    .join('');
}
