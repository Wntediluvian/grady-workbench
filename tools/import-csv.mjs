// 把已发文章的数据表导进麦田：一篇文章一期，各平台记为“已发布”并带链接，表里的读数按采集日存成每日流量。
// 用法：node tools/import-csv.mjs <文章数据.csv> [--only 标识1,标识2] [--articles <文章目录>] [--projects <工程目录>] [--dry]
//   --articles  文章档案的根目录（每篇一个以标识命名的文件夹），用来找封面
//   --projects  给每篇建一个麦田工程目录（publish.json + 封面），大屏的封面和详情页靠它；不给就只登记数据
// 表头（UTF-8，可带 BOM）：采集日期(北京),文章标识,标题,平台,发布时间(北京),链接,浏览,点赞,评论,分享,收藏,其他,备注
// 可以重复跑：同一篇、同一平台、同一采集日会覆盖，不会重复。没有文章标识的行（以“（”开头）跳过。
import fs from 'node:fs'; import path from 'node:path';
import { db, upsertEpisode, setTask, getTask, log } from '../src/db.mjs';

const PLAT = { 'X': 'x', '抖音': 'douyin', '小红书': 'xhs', 'B站': 'bilibili', '微信公众号': 'wechat', '公众号': 'wechat', '视频号': 'channels', 'YouTube': 'youtube' };
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const optVals = ['--only', '--articles', '--projects'].map(opt);
const file = args.find((a) => !a.startsWith('--') && !optVals.includes(a));
if (!file) { console.error('用法：node tools/import-csv.mjs <文章数据.csv> [--only 标识1,标识2] [--articles <文章目录>] [--projects <工程目录>] [--dry]'); process.exit(2); }
const only = opt('--only') ? new Set(opt('--only').split(',')) : null;
const articles = opt('--articles'), projects = opt('--projects'), dry = args.includes('--dry');

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift().map((h) => h.replace(/^﻿/, '').trim());
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}
const num = (s) => (s === '' || s == null || isNaN(+s) ? null : +s);
const iso = (s) => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.slice(0, 16).replace(' ', 'T') + ':00+08:00' : null);

// 在文章档案里找封面：文件名带“封面”或 cover 的图片，排除候选稿、旧版、截图和证据。竖版当 3x4，横版当 16x9。
function findCovers(dir) {
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(png|jpe?g|webp)$/i.test(e.name) && /封面|cover/i.test(e.name) && !/候选|裁切|证据|确认码|截图|v\d/i.test(p.slice(dir.length))) hits.push(p);
    }
  };
  walk(dir, 0);
  const pick = (res) => { for (const re of res) { const f = hits.find((h) => re.test(h.slice(dir.length))); if (f) return f; } return null; };
  const tall = pick([/3x4/i, /抖音/, /3x5/i, /小红书/]);
  const wide = pick([/16x9/i, /B站/i, /21x9/i, /公众号/, /10-X/]);
  const out = {};
  if (tall) out['3x4'] = tall;
  if (wide && wide !== tall) out['16x9'] = wide;
  if (!tall && !wide && hits[0]) out['3x4'] = hits[0];
  return out;
}

const rows = parseCsv(fs.readFileSync(file, 'utf8'));
const byId = new Map();
for (const r of rows) {
  const id = r['文章标识'];
  if (!id || id.startsWith('（') || (only && !only.has(id))) continue;
  if (!byId.has(id)) byId.set(id, []);
  byId.get(id).push(r);
}
// 期号：全表按首发时间排，早的在前；只导一部分时期号也和全量一致
const firstOf = new Map();
for (const r of rows) {
  const id = r['文章标识'], t = iso(r['发布时间(北京)']);
  if (!id || id.startsWith('（') || !t) continue;
  if (!firstOf.has(id) || t < firstOf.get(id)) firstOf.set(id, t);
}
const order = [...firstOf.entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(([id]) => id);

const putMetric = db.prepare(`INSERT INTO metrics (day, episode_id, platform, views, likes, comments, favorites, shares, extra, collected_at) VALUES (?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(day, episode_id, platform) DO UPDATE SET views=excluded.views, likes=excluded.likes, comments=excluded.comments, favorites=excluded.favorites, shares=excluded.shares, extra=excluded.extra, collected_at=excluded.collected_at`);
let nEp = 0, nTask = 0, nMetric = 0, nCover = 0;
const skipped = [], noCover = [];
for (const [id, list] of byId) {
  const first = firstOf.get(id) || null, episode = order.indexOf(id) >= 0 ? order.indexOf(id) + 1 : null;
  const name = list[0]['标题'] || id;
  const src = articles && fs.existsSync(path.join(articles, id)) ? path.join(articles, id) : '';
  // 同一平台同一采集日可能有两行（先读公开接口，后补采后台）：逐项合并，后一行有值就用后一行的
  const merged = new Map();
  for (const r of list) {
    const k = `${r['平台']}|${r['采集日期(北京)']}`;
    const old = merged.get(k);
    if (!old) { merged.set(k, { ...r }); continue; }
    for (const f of Object.keys(r)) if (r[f] !== '') old[f] = f === '备注' && old[f] ? `${old[f]}；${r[f]}` : r[f];
  }
  let dir = src;
  if (projects) {
    dir = path.join(projects, id);
    const covers = {}, found = src ? findCovers(src) : {};
    if (!dry) fs.mkdirSync(path.join(dir, '封面'), { recursive: true });
    for (const [k, f] of Object.entries(found)) {
      const rel = `封面/cover-${k}${path.extname(f).toLowerCase()}`;
      covers[k] = rel;
      if (!dry) fs.copyFileSync(f, path.join(dir, rel));
    }
    if (Object.keys(covers).length) nCover++; else noCover.push(id);
    const platforms = {};
    for (const r of merged.values()) { const p = PLAT[r['平台']]; if (p) platforms[p] = { title: r['标题'] || name, covers: Object.keys(covers).slice(0, 1) }; }
    const pj = { version: 1, id, name, kind: 'article', schedule: first, source: src, covers, platforms };
    if (!dry) fs.writeFileSync(path.join(dir, 'publish.json'), JSON.stringify(pj, null, 2));
  }
  console.log(`第 ${episode ?? '–'} 期｜${id}｜${name.slice(0, 24)}｜首发 ${first ? first.slice(0, 16) : '未知'}｜${merged.size} 个读数`);
  if (!dry) {
    upsertEpisode({ id, episode, name, dir, schedule: first });
    // 麦田按登记时间排“最新一期”；导入的旧文章把登记时间对齐到首发时间，顺序才对
    if (first) db.prepare('UPDATE episodes SET created_at=? WHERE id=?').run(new Date(first).toISOString(), id);
    db.prepare('DELETE FROM snapshots WHERE episode_id=?').run(id);
  }
  nEp++;
  for (const r of merged.values()) {
    const p = PLAT[r['平台']];
    if (!p) { skipped.push(`${id} ${r['平台']}`); continue; }
    const when = iso(r['发布时间(北京)']);
    if (!dry) {
      const old = getTask(id, p);
      setTask(id, p, 'published', when ? `发布于 ${r['发布时间(北京)']}` : '已发布', { url: r['链接'] || (old && old.url) || undefined });
      putMetric.run(r['采集日期(北京)'], id, p, num(r['浏览']), num(r['点赞']), num(r['评论']), num(r['收藏']), num(r['分享']), JSON.stringify({ source: 'csv', note: r['备注'] || '' }), new Date().toISOString());
    }
    nTask++; nMetric++;
  }
  if (!dry) log(id, '', 'import-csv', `${merged.size} 个读数`);
}
console.log(`${dry ? '（演练，没写库）' : '已写入'}：${nEp} 篇，${nTask} 个平台状态，${nMetric} 条流量${projects ? `，${nCover} 篇有封面` : ''}`);
if (noCover.length) console.log('没找到封面：' + noCover.join('；'));
if (skipped.length) console.log('不认识的平台，跳过：' + skipped.join('；'));
