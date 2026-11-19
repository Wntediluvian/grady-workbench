// 麦田采集（只读）：每天第一次机会（北京时间 9 点以后）把各平台后台列表页读一遍，交给本机麦田。
// 点工具栏图标 = 现在采一次。一次只开一个页面，读完就关；没登录的平台记下来以后跳过，点图标时会重试。
import * as P from './pages.js';
import { BASE, TOKEN, X_HANDLE, PROFILE } from './token.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bjNow = () => new Date(Date.now() + 8 * 3600e3);
const bjDay = () => bjNow().toISOString().slice(0, 10);

const PLANS = {
  x: X_HANDLE ? [{ url: `https://x.com/${X_HANDLE}`, fn: P.xProfile }] : [],
  douyin: [{ url: 'https://creator.douyin.com/creator-micro/home', fn: P.douyinHome }, { url: 'https://creator.douyin.com/creator-micro/content/manage', fn: P.douyinList, scroll: true }],
  xhs: [{ url: 'https://creator.xiaohongshu.com/new/home', fn: P.xhsHome }, { url: 'https://creator.xiaohongshu.com/new/note-manager', fn: P.xhsList, scroll: true }],
  bilibili: [{ url: 'https://member.bilibili.com/platform/upload-manager/opus', fn: P.biliList, allFrames: true, settle: 9000 }],
  wechat: [{ url: 'https://mp.weixin.qq.com/', fn: P.wechatHome }],
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
async function biliFans() {
  try {
    const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' }).then((r) => r.json());
    const mid = nav && nav.data && nav.data.mid;
    if (!mid) return null;
    const st = await fetch(`https://api.bilibili.com/x/relation/stat?vmid=${mid}`, { credentials: 'include' }).then((r) => r.json());
    return st && st.data ? st.data.follower : null;
  } catch { return null; }
}

async function collectPlatform(p) {
  const out = { platform: p, followers: null, items: [] };
  for (const step of PLANS[p]) {
    const r = await readStep(step);
    if (r.error) return { platform: p, error: r.error };
    if (r.followers != null) out.followers = r.followers;
    if (r.items) out.items.push(...r.items);
    await sleep(3000 + Math.random() * 4000);
  }
  if (p === 'bilibili') out.followers = await biliFans();
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
      let r;
      try { r = await collectPlatform(p); } catch (e) { r = { platform: p, error: String(e.message || e).slice(0, 120) }; }
      if (r.error === 'not_logged_in') off[p] = bjDay();   // 这个浏览器没登录这个平台：以后不再打开，点图标时重试
      results.push(r);
    }
    const payload = { profile: PROFILE, at: new Date().toISOString(), results };
    const pending = [...(st.pending || []), payload].slice(-5);
    const left = [];
    for (const one of pending) { try { await post(one); } catch { left.push(one); } }
    await chrome.storage.local.set({ off, pending: left, lastRunDay: bjDay(), lastRun: { at: payload.at, summary: results.map((r) => `${r.platform}:${r.error || (r.items || []).length}`).join(' ') } });
    await chrome.action.setBadgeText({ text: left.length ? '!' : '✓' });
  } finally { running = false; }
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('tick', { periodInMinutes: 30, delayInMinutes: 2 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('tick', { periodInMinutes: 30, delayInMinutes: 5 }));
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'tick') return;
  const { lastRunDay } = await chrome.storage.local.get('lastRunDay');
  if (bjNow().getUTCHours() >= 9 && lastRunDay !== bjDay()) await collectAll(false);
});
chrome.action.onClicked.addListener(() => collectAll(true));
