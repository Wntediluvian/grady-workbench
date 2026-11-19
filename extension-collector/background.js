// 麦田采集（只读）：每天第一次机会（北京时间 9 点以后）把各平台后台列表页读一遍，交给本机麦田。
// 点工具栏图标 = 现在采一次。一次只开一个页面，读完就关；没登录的平台记下来以后跳过，点图标时会重试。
import * as P from './pages.js';
import { BASE, TOKEN, X_HANDLE, PROFILE, ACCOUNTS } from './token.js';
// ACCOUNTS：每个平台只认这一个账号（抖音号、小红书账号、B站 mid、公众号名称）。
// 这个浏览器里登录的是别的账号，或者没配账号，就不读它的数据，免得把别的号的数记进来。

// 每次改了这个文件夹里的代码就改这个编号。插件开工前会问麦田磁盘上的编号是多少，不一样就自己重新加载，
// 所以以后改读取规则不用再去扩展管理页手动点“重新加载”。
const BUILD = '2026-11-19.3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bjNow = () => new Date(Date.now() + 8 * 3600e3);
const bjDay = () => bjNow().toISOString().slice(0, 10);

// 顺序有讲究：先读要核对账号的平台，X 放最后。X 的主页是公开的，核对不了登录的是谁，
// 所以只有这个浏览器里至少有一个平台核对上了账号（说明这是放自媒体账号的那个配置），才读 X。
// 这样插件即使被装进别的浏览器配置，也什么都不会交。
const PLANS = {
  douyin: [{ url: 'https://creator.douyin.com/creator-micro/home', fn: P.douyinHome }, { url: 'https://creator.douyin.com/creator-micro/content/manage', fn: P.douyinList, scroll: true }],
  xhs: [{ url: 'https://creator.xiaohongshu.com/new/home', fn: P.xhsHome }, { url: 'https://creator.xiaohongshu.com/new/note-manager', fn: P.xhsList, scroll: true }],
  bilibili: [{ url: 'https://member.bilibili.com/platform/upload-manager/opus', fn: P.biliList, allFrames: true, settle: 9000 }],
  wechat: [{ url: 'https://mp.weixin.qq.com/', fn: P.wechatHome }],
  x: X_HANDLE ? [{ url: `https://x.com/${X_HANDLE}`, fn: P.xProfile }] : [],
};

async function waitLoaded(tabId, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error('页面被关掉了');
    if (t.status === 'complete') return t;
    await sleep(1000);
  }
  throw new Error('页面 40 秒没加载完');
}
const run = async (tabId, func, allFrames = false) => (await chrome.scripting.executeScript({ target: { tabId, allFrames }, func })).map((r) => r.result).filter((r) => r != null);

async function readStep(step) {
  const tab = await chrome.tabs.create({ url: step.url, active: false });
  try {
    await waitLoaded(tab.id);
    await sleep(step.settle || 6000);
    if ((await run(tab.id, P.loggedOut))[0]) return { error: 'not_logged_in' };
    if (step.scroll) await run(tab.id, P.scrollAll);
    const got = await run(tab.id, step.fn, !!step.allFrames);
    return got[0] || {};
  } finally { await chrome.tabs.remove(tab.id).catch(() => {}); }
}

// B站粉丝数：用已登录的身份问它自己的公开接口（和麦田原来的做法一样）
async function biliWho() {
  try {
    const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' }).then((r) => r.json());
    const mid = nav && nav.data && nav.data.mid;
    if (!mid) return { mid: '' };
    const st = await fetch(`https://api.bilibili.com/x/relation/stat?vmid=${mid}`, { credentials: 'include' }).then((r) => r.json());
    return { mid: String(mid), followers: st && st.data ? st.data.follower : null };
  } catch { return { mid: '' }; }
}

async function collectPlatform(p) {
  const out = { platform: p, followers: null, items: [] };
  const want = String((ACCOUNTS || {})[p] || '');
  if (p !== 'x' && !want) return { platform: p, error: 'no_account_configured' };
  if (p === 'bilibili') {   // 先核对账号，再开页面
    const who = await biliWho();
    if (!who.mid) return { platform: p, error: 'not_logged_in' };
    if (who.mid !== want) return { platform: p, error: 'wrong_account' };
    out.followers = who.followers ?? null;
  }
  for (const step of PLANS[p]) {
    const r = await readStep(step);
    if (r.error) return { platform: p, error: r.error };
    if (r.account !== undefined && r.account !== want) return { platform: p, error: r.account ? 'wrong_account' : 'not_logged_in' };
    if (r.head !== undefined && !r.head.includes(want)) return { platform: p, error: 'wrong_account' };
    if (r.followers != null) out.followers = r.followers;
    if (r.items) out.items.push(...r.items);
    await sleep(3000 + Math.random() * 4000);
  }
  return out;
}

async function post(payload) {
  const r = await fetch(`${BASE}/api/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN, ...payload }) });
  if (!r.ok) throw new Error(`麦田返回 ${r.status}`);
  return r.json();
}

let running = false;
async function collectAll(force) {
  if (running) return;
  running = true;
  await chrome.action.setBadgeText({ text: '…' });
  const st = await chrome.storage.local.get(['off', 'pending']);
  const off = force ? {} : st.off || {};
  const results = [];
  try {
    for (const p of Object.keys(PLANS)) {
      if (!PLANS[p].length || off[p]) continue;
      if (p === 'x' && !results.some((r) => !r.error)) { results.push({ platform: 'x', error: 'not_home_profile' }); continue; }
      let r;
      try { r = await collectPlatform(p); } catch (e) { r = { platform: p, error: String(e.message || e).slice(0, 120) }; }
      if (['not_logged_in', 'wrong_account', 'no_account_configured'].includes(r.error)) off[p] = bjDay();   // 这个浏览器没登录、登录的是别的号、或没配账号：以后不再打开，点图标时重试
      results.push(r);
    }
    const payload = { profile: await who(), at: new Date().toISOString(), build: BUILD, results };
    const pending = [...(st.pending || []), payload].slice(-5);
    const left = [];
    for (const one of pending) { try { await post(one); } catch { left.push(one); } }
    await chrome.storage.local.set({ off, pending: left, lastRunDay: bjDay(), lastRun: { at: payload.at, summary: results.map((r) => `${r.platform}:${r.error || (r.items || []).length}`).join(' ') } });
    await chrome.action.setBadgeText({ text: left.length ? '!' : '✓' });
  } finally { running = false; }
}

// 磁盘上的代码比正在跑的新：记下“重载后要不要接着采”，然后重新加载自己。返回 true 表示已经去重载了
async function reloadIfStale(thenRun) {
  try {
    const r = await fetch(`${BASE}/api/collect/build?token=${encodeURIComponent(TOKEN)}`);
    const disk = r.ok ? (await r.json()).build : '';
    if (!disk || disk === BUILD) return false;
    await chrome.storage.local.set({ runAfterReload: thenRun || '' });
    chrome.runtime.reload();
    return true;
  } catch { return false; }
}
// 同一个文件夹会装进几个浏览器配置：给每个配置随机起个短编号，麦田那边才分得清是谁交的
async function who() {
  let { pid } = await chrome.storage.local.get('pid');
  if (!pid) { pid = Math.random().toString(36).slice(2, 6); await chrome.storage.local.set({ pid }); }
  return `${PROFILE || 'browser'}-${pid}`;
}
async function start(force) {
  if (await reloadIfStale(force ? 'force' : 'auto')) return;
  const me = await who();
  await post({ profile: me, at: new Date().toISOString(), build: BUILD, results: [] }).catch(() => {});   // 先打个招呼，麦田那边能看到“开始采了”
  try { await collectAll(force); } catch (e) { await post({ profile: me, at: new Date().toISOString(), build: BUILD, results: [{ platform: '_run', error: String(e && e.message || e).slice(0, 200) }] }).catch(() => {}); running = false; await chrome.action.setBadgeText({ text: '!' }); }
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('tick', { periodInMinutes: 30, delayInMinutes: 2 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('tick', { periodInMinutes: 30, delayInMinutes: 5 }));
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'tick') return;
  const { lastRunDay } = await chrome.storage.local.get('lastRunDay');
  if (bjNow().getUTCHours() >= 9 && lastRunDay !== bjDay()) await start(false);
  else await reloadIfStale('');
});
chrome.action.onClicked.addListener(() => start(true));
// 刚因为代码更新重载过：把重载前要做的那次采集接着做完
chrome.storage.local.get('runAfterReload').then(async (v) => {
  if (!v.runAfterReload) return;
  await chrome.storage.local.remove('runAfterReload');
  await start(v.runAfterReload === 'force');
});
