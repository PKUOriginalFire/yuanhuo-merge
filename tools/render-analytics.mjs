/**
 * 把 analytics.json 塞进模板，产出单文件 HTML 报告。
 *   node tools/render-analytics.mjs docs/analytics.json tools/analytics-template.html docs/analytics.html
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , jsonPath, tplPath, outPath] = process.argv;
if (!jsonPath || !tplPath || !outPath) {
  console.error('用法: node tools/render-analytics.mjs <analytics.json> <template.html> <out.html>');
  process.exit(1);
}

const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
const tpl = readFileSync(tplPath, 'utf8');
if (!tpl.includes('__DATA__')) throw new Error('模板里找不到 __DATA__ 占位符');

// JSON 直接内联；把 </script> 转义掉，避免提前闭合
const payload = JSON.stringify(data).replace(/<\/script/gi, '<\\/script');
writeFileSync(outPath, tpl.replace('__DATA__', payload), 'utf8');
console.log('written', outPath, (writeFileSync ? '' : ''));
console.log('大小', (readFileSync(outPath).length / 1024).toFixed(1), 'KB');
