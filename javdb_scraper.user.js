// ==UserScript==
// @name         JavDB 万能磁链提取器
// @namespace    http://tampermonkey.net/
// @version      5.13.90
// @description  JavDB 磁链批量提取：支持按当前列表、番号段、女优/组合三种模式抓取磁力链接；当前列表支持作品范围与起始页码；自动优先字幕版并选择最小体积，去重后导出迅雷专用 TXT；内置 429/封禁重试、备用域名自动切换与多标签排队保护；每6小时定期自动同步最新备用网址(javdb.com/TG/官方App)并本地缓存；自动跳过 登录图形验证码自动识别+VR 及时长超过 2.5 小时的作品。
// @author       Assistant
// @license      MIT
// @match        *://javdb.com/*
// @match        *://*.javdb.com/*
// @match        *://*.javdb575.com/*
// @match        *://javdb575.com/*
// @include      /^https?:\/\/(www\.)?javdb\d*\.(com|org|net)\/.*$/
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.registerMenuCommand
// @connect      t.me
// @connect      javdb.com
// @connect      javdb575.com
// @connect      app.javdb.com
// Dynamic app.javdbNNN.com has no partial-wildcard support and cannot be enumerated, keep * (see fetchLatestDomainFromApp).
// @connect      *
// @updateURL    https://raw.githubusercontent.com/lijianbin2/javdb/main/javdb_scraper.user.js
// @downloadURL  https://raw.githubusercontent.com/lijianbin2/javdb/main/javdb_scraper.user.js
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_VERSION = '5.13.90';
  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function getRandomDelay(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  const origTitle = document.title;

  let isRunning = false;
  let shouldStop = false;
  let isJumping = false;
  let loginStopped = false;
  let tagFailed = false;
  let banStopped = false;
  let currentMode = 'current';
  const ITEM_INTERVAL_MS = 2000;

  var rmbCached = null;
  function autoCheckRememberMe() {
    try {
      if (rmbCached && rmbCached.isConnected && rmbCached.checked) { return 1; }
      if (rmbCached && !rmbCached.isConnected) { rmbCached = null; }
    } catch(eC) {}
    var boxes = null;
    try { boxes = document.querySelectorAll("input[type=checkbox]"); } catch(e) { return 0; }
    if (!boxes || !boxes.length) { return 0; }
    var n = 0;
    boxes.forEach(function(cb) {
      try {
        if (cb.checked) { return; }
        var t = "";
        try { t = (cb.getAttribute("value") || "") + " " + (cb.name || "") + " " + (cb.id || ""); } catch(e0) {}
        var lb = "";
        try { lb = cb.closest("label").textContent || ""; } catch(e1) {}
        if (!lb) { try { lb = cb.parentElement.textContent || ""; if (lb.length > 60) { lb = ""; } } catch(e2) {} }
        t = t + " " + lb;
        var low = "";
        try { low = t.toLowerCase(); } catch(e3) { low = t; }
        var isRm = false;
        if (low.indexOf("remember") >= 0) { isRm = true; }
        if (t.indexOf("记住") >= 0) { isRm = true; }
        if (t.indexOf("保持") >= 0) { isRm = true; }
        if (t.indexOf("七天") >= 0) { isRm = true; }
        if (t.indexOf("免登") >= 0) { isRm = true; }
        if (t.indexOf("自动登录") >= 0) { isRm = true; }
        if (!isRm) { return; }
        try { cb.checked = true; } catch(e4) {}
        try { cb.dispatchEvent(new Event("input", { bubbles: true })); } catch(e5) {}
        try { cb.dispatchEvent(new Event("change", { bubbles: true })); } catch(e6) {}
        n++;
        try { rmbCached = cb; } catch(eF) {}
      } catch(e7) {}
    });
    return n;
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoCheckRememberMe);
  } else {
    try { autoCheckRememberMe(); } catch(e8) {}
  }
  try {
    var rmbTs = 0;
    var rmbObs = new MutationObserver(function() {
      var now = Date.now();
      if (now - rmbTs < 1500) { return; }
      rmbTs = now;
      if (isRunning) { return; }
      try { autoCheckRememberMe(); } catch(e9) {}
    });
    rmbObs.observe(document.documentElement, { childList: true, subtree: true });
  } catch(e10) {}
  try { setInterval(function() { if (isRunning) { return; } try { autoCheckRememberMe(); } catch(e11) {} }, 2000); } catch(e12) {}

  // 🔒 独立时间戳分布式并发排队锁
  const QUEUE_PREFIX = 'javdb_q_';
  const LOCK_KEY = 'javdb_scraper_active_tab';
  const LOCK_TIME_KEY = LOCK_KEY + '_time';
  const LOCK_EXPIRY_MS = 45000; // 超过这个时间视为锁失效（45s）
  const TAB_ID = Math.random().toString(36).substring(2, 9);
  const MY_Q_KEY = QUEUE_PREFIX + TAB_ID;

  let lastRegWrite = 0;
  function registerInQueue() {
    try {
      const nowMs = Date.now();
      if (!localStorage.getItem(MY_Q_KEY)) {
        localStorage.setItem(MY_Q_KEY, nowMs.toString());
        localStorage.setItem(MY_Q_KEY + "_time", nowMs.toString());
        lastRegWrite = nowMs;
        return;
      }
      if (nowMs - lastRegWrite < 5000) {
        return;
      }
      localStorage.setItem(MY_Q_KEY + "_time", nowMs.toString());
      lastRegWrite = nowMs;
    } catch (e) {
      // ignore storage errors
    }
  }

  function removeFromQueue() {
    try {
      localStorage.removeItem(MY_Q_KEY);
      localStorage.removeItem(MY_Q_KEY + '_time');
      if (lockStoreGet(LOCK_KEY) === TAB_ID) {
        lockStoreDel(LOCK_KEY);
        lockStoreDel(LOCK_TIME_KEY);
      }
    } catch (e) {}
  }

  function isLockExpired() {
    try {
      const t = parseInt(lockStoreGet(LOCK_TIME_KEY) || '0', 10);
      if (!t) return true;
      return (Date.now() - t) > LOCK_EXPIRY_MS;
    } catch (e) {
      return true;
    }
  }

  let lastQueueSweep = 0;
  function getQueuePosition() {
    registerInQueue();
    const now = Date.now();
    const doSweep = now - lastQueueSweep > 10000;
    const entries = [];

    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(QUEUE_PREFIX)) keys.push(key);
    }

    for (const key of keys) {
      if (key.endsWith('_time')) continue;
      const id = key.slice(QUEUE_PREFIX.length);
      const lastTime = parseInt(localStorage.getItem(key + '_time') || '0', 10);

      if (now - lastTime < 12000) {
        const regTime = parseInt(localStorage.getItem(key) || '0', 10);
        entries.push({ id, regTime });
      } else {
        if (doSweep) {
        // 清理过期队列项
          try {
            localStorage.removeItem(key);
            localStorage.removeItem(key + '_time');
          } catch (e) {}
        }
      }
    }

    if (doSweep) { lastQueueSweep = now; }
    entries.sort((a, b) => a.regTime - b.regTime);
    const myIdx = entries.findIndex(e => e.id === TAB_ID);
    if (myIdx === -1) return { pos: 1, total: entries.length + 1 };
    return { pos: myIdx + 1, total: entries.length };
  }

  async function acquireLock() {
    const statusEl = document.getElementById('scraper-status');
    const logEl = document.getElementById('scraper-log');
    let queueWaitLogged = false;
    let lastPos = 0;

    while (true) {
      if (shouldStop) {
        removeFromQueue();
        return false;
      }
      if (isFreshBanForCurrentHost()) {
        try { removeFromQueue(); } catch (e) {}
        return false;
      }

      // 如果已有锁但超过过期时间，则回收它
      const currentLock = lockStoreGet(LOCK_KEY);
      if (currentLock && currentLock !== TAB_ID && isLockExpired()) {
        try {
          lockStoreDel(LOCK_KEY);
          lockStoreDel(LOCK_TIME_KEY);
          if (logEl) {
            log("🔧 发现过期锁（" + currentLock + ")，已回收。");
          }
        } catch (e) {}
      }

      const { pos } = getQueuePosition();

      if (pos === 1) {
        try {
          const holder = lockStoreGet(LOCK_KEY);
          if (!holder || holder === TAB_ID || isLockExpired()) {
            lockStoreSet(LOCK_KEY, TAB_ID);
            lockStoreSet(LOCK_TIME_KEY, Date.now().toString());
          }
        } catch (e) {}

        await sleep(100);

        if (lockStoreGet(LOCK_KEY) === TAB_ID) return true;
      }

      const aheadCount = pos - 1;
      if (pos !== lastPos) {
        if (statusEl) statusEl.innerText = `⏳ 排队中 (前面还有 ${aheadCount} 个任务)...`;
        document.title = `⏳[排队第${pos}位] ${origTitle}`;
        lastPos = pos;
      }

      if (logEl && !queueWaitLogged) {
        queueWaitLogged = true;
        log("⏳ 前方有 " + aheadCount + " 个任务正在抓取，排队等待中...");
      }

      await sleep(pos > 3 ? 4000 : 1500);
    }
  }

  let lastBeatWrite = 0;
  function updateLockHeartbeat() {
    registerInQueue();
    try {
      if (lockStoreGet(LOCK_KEY) === TAB_ID) {
        var nowB = Date.now();
        if (nowB - lastBeatWrite < 5000) {
          return true;
        }
        lastBeatWrite = nowB;
        lockStoreSet(LOCK_TIME_KEY, nowB.toString());
        return true;
      }
    } catch (e) {}
    return false;
  }

  window.addEventListener('beforeunload', (e) => {
    if (isRunning && !isJumping) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  window.addEventListener('pagehide', () => {
    document.title = origTitle;
    removeFromQueue();
  });

  // 纯数字备用域名列表（兜底）
  const STATIC_BACKUP_DOMAINS = [
    'javdb575.com', 'javdb574.com', 'javdb573.com',
    'javdb572.com', 'javdb571.com', 'javdb570.com'
  ];
  // 自动更新域名：缓存键与定时
  const DOMAIN_CACHE_KEY = 'javdb_latest_domain';
  const DOMAIN_CACHE_TIME_KEY = 'javdb_latest_domain_time';
  const DOMAIN_CACHE_SOURCE_KEY = 'javdb_latest_domain_source';
  const DOMAIN_AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6小时
  let domainAutoTimer = window.__javdbScraperTimer || null;
  if (domainAutoTimer) { try { clearInterval(domainAutoTimer); } catch (e) {} }

  function isLoginPage(url, html) {
    try {
      if (url && /\/login(\?|$)/.test(String(url))) return true;
    } catch (e) {}
    try {
      const head = String(html || "").slice(0, 20000);
      if (/type=\s*['"]password['"]/i.test(head)) return true;
    } catch (e) {}
    return false;
  }

  function handleLoginRedirect(url, html, label) {
    if (!isLoginPage(url, html)) return false;
    try { log('[!] ' + label + ' 即将跳转登录页，请先登录 JavDB 后再执行'); } catch (e) {}
    try { shouldStop = true; loginStopped = true; statusEl.innerText = '状态: 请先登录 JavDB 后再抓取'; } catch (e) {}
    return true;
  }

  function isBannedPage(status, textStr) {
    if (status === 403) return true;
    if (textStr) {
      const text = String(textStr).toLowerCase();
      if (
        text.includes('banned your access') ||
        text.includes('access denied') ||
        text.includes('ip banned') ||
        text.includes('ip blocked') ||
        text.includes('copyright restrictions') ||
        text.includes('not available in your country') ||
        text.includes('访问被拒绝') ||
        text.includes('訪問被拒絕') ||
        text.includes('已被封禁') ||
        text.includes('基于你的异常行为') ||
        text.includes('基於你的異常行為') ||
        text.includes('禁止了你的访问') ||
        text.includes('禁止了你的訪問')
      ) {
        return true;
      }
    }
    return false;
  }

  // —— GM 存储兼容层（GM + localStorage 双写）——
  // Memory cache for async-only GM stores (filled by prefetch below).
  var __asyncGmCache = {};
  function gmGetValueCompat(key, defVal) {
    try {
      if (typeof GM_getValue !== 'undefined') {
        const v = GM_getValue(key, defVal);
        if (v !== undefined) return v;
      }
      if (typeof GM !== 'undefined' && GM.getValue) {
        // GM.getValue 可能是异步，这里不依赖
      }
    } catch (e) {}
    try {
      if (Object.prototype.hasOwnProperty.call(__asyncGmCache, key)) return __asyncGmCache[key];
    } catch (e) {}
    try {
      const ls = localStorage.getItem(key);
      if (ls !== null) return ls;
    } catch (e) {}
    return defVal;
  }
  function gmSetValueCompat(key, val) {
    try { if (typeof GM_setValue !== 'undefined') GM_setValue(key, val); } catch (e) {}
    try { __asyncGmCache[key] = String(val); } catch (e) {}
    try { localStorage.setItem(key, String(val)); } catch (e) {}
  }

  // GM cross-domain global lock store (shared across javdb mirror domains).
  // GM values are script-level and visible on all origins; localStorage is the same-origin fallback.
  function lockStoreGet(key) {
    try {
      if (typeof GM_getValue !== 'undefined') {
        const v = GM_getValue(key, null);
        if (v !== undefined && v !== null && v !== '') return String(v);
      }
    } catch (e) {}
    try {
      if (Object.prototype.hasOwnProperty.call(__asyncGmCache, key)) {
        const cv = __asyncGmCache[key];
        if (cv !== undefined && cv !== null && cv !== '') return String(cv);
      }
    } catch (e) {}
    try {
      const ls = localStorage.getItem(key);
      if (ls !== null && ls !== '') return ls;
    } catch (e) {}
    return null;
  }
  function lockStoreSet(key, val) {
    try { if (typeof GM_setValue !== 'undefined') GM_setValue(key, String(val)); } catch (e) {}
    try { __asyncGmCache[key] = String(val); } catch (e) {}
    try { localStorage.setItem(key, String(val)); } catch (e) {}
  }
  function lockStoreDel(key) {
    try { if (typeof GM_setValue !== 'undefined') GM_setValue(key, ''); } catch (e) {}
    try { delete __asyncGmCache[key]; } catch (e) {}
    try { localStorage.removeItem(key); } catch (e) {}
  }
  const BAN_HOST_KEY = "javdb_ban_host";
  const BAN_TIME_KEY = "javdb_ban_time";
  const BAN_TTL_MS = 90000;
  // Async-GM prefetch (MV3/Violentmonkey): sync GM_getValue may be absent while
  // promise-based GM.getValue exists. Mirror the small known key set into
  // __asyncGmCache once so the sync getters above keep working cross-origin.
  try {
    var __asyncGet = (typeof GM !== 'undefined' && GM && GM.getValue) ? GM.getValue : null;
    if (__asyncGet && typeof GM_getValue === 'undefined') {
      (function (getFn, keyList) {
        keyList.forEach(function (k) {
          try {
            var p = getFn.call(GM, k, null);
            if (p && typeof p.then === 'function') {
              p.then(function (v) {
                try { if (v !== undefined && v !== null) __asyncGmCache[k] = String(v); } catch (e2) {}
              }, function () {});
            } else if (p !== undefined && p !== null) {
              __asyncGmCache[k] = String(p);
            }
          } catch (e) {}
        });
      })(__asyncGet, [LOCK_KEY, LOCK_TIME_KEY, DOMAIN_CACHE_KEY, DOMAIN_CACHE_TIME_KEY, DOMAIN_CACHE_SOURCE_KEY, BAN_HOST_KEY, BAN_TIME_KEY]);
    }
  } catch (e) {}
  function broadcastBanForCurrentHost() {
    try {
      var h = "";
      try { h = window.location.hostname.toLowerCase(); } catch (e) {}
      if (!h) return;
      lockStoreSet(BAN_HOST_KEY, h);
      lockStoreSet(BAN_TIME_KEY, String(Date.now()));
    } catch (e) {}
  }
  function isFreshBanForCurrentHost() {
    try {
      var b = lockStoreGet(BAN_HOST_KEY);
      if (!b) return false;
      var cur = "";
      try { cur = window.location.hostname.toLowerCase(); } catch (e) {}
      if (!cur || b !== cur) return false;
      var ts = parseInt(lockStoreGet(BAN_TIME_KEY) || "0", 10);
      if (!ts) return false;
      return (Date.now() - ts) < BAN_TTL_MS;
    } catch (e) { return false; }
  }


  function gmGet(url) {
    return new Promise((resolve) => {
      let gmSettled = false;
      const gmDone = (v) => { if (!gmSettled) { gmSettled = true; try { clearTimeout(gmTimer); } catch (e2) {} resolve(v); } };
      const gmTimer = setTimeout(() => gmDone(null), 10000);
      const request = (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) ||
        (typeof GM !== 'undefined' && GM.xmlHttpRequest) || null;
      if (!request) {
        gmDone(null);
        return;
      }
      try {
        request({
          method: 'GET',
          url: url,
          timeout: 8000,
          onload: function (response) { gmDone(response); },
          onerror: function () { gmDone(null); },
          ontimeout: function () { gmDone(null); }
        });
      } catch (e) {
        gmDone(null);
      }
    });
  }

  function parseMaxJavdbDomain(html) {
    if (!html) return null;
    const matches = html.match(/javdb\d+\.com/gi);
    if (!matches || matches.length === 0) return null;
    const list = matches.map(d => {
      const m = d.match(/\d+/);
      return { domain: d.toLowerCase(), num: m ? parseInt(m[0], 10) : 0 };
    });
    const saneList = list.filter((x) => x.num >= 1 && x.num <= 5000);
    if (saneList.length === 0) return null;
    saneList.sort((a, b) => b.num - a.num);
    try {
      const cm = window.location.hostname.match(/javdb(\d+)\.com/i);
      const curNum = cm ? parseInt(cm[1], 10) : 0;
      if (curNum > 0 && saneList[0].num > curNum + 50) {
        const sane = saneList.find((x) => x.num <= curNum + 50);
        return (sane || saneList[saneList.length - 1]).domain;
      }
    } catch (e) {}
    return saneList[0].domain;
  }

  function getCachedDomain() {
    const d = gmGetValueCompat(DOMAIN_CACHE_KEY, null);
    const t = gmGetValueCompat(DOMAIN_CACHE_TIME_KEY, 0);
    const s = gmGetValueCompat(DOMAIN_CACHE_SOURCE_KEY, '');
    if (d && /^javdb\d+\.com$/i.test(d)) return { domain: String(d).toLowerCase(), time: Number(t) || 0, source: String(s) };
    return null;
  }
  function setCachedDomain(domain, source) {
    if (!domain) return;
    gmSetValueCompat(DOMAIN_CACHE_KEY, domain.toLowerCase());
    gmSetValueCompat(DOMAIN_CACHE_TIME_KEY, String(Date.now()));
    gmSetValueCompat(DOMAIN_CACHE_SOURCE_KEY, source || '');
  }
  function buildBackupDomainList(latestDomain) {
    const out = [];
    const seen = new Set();
    const push = (d) => { const v=d.toLowerCase(); if(!seen.has(v)){seen.add(v); out.push(v);} };
    if (latestDomain) {
      const m = latestDomain.match(/javdb(\d+)\.com/i);
      if (m) {
        const top = parseInt(m[1], 10);
        for (let i = top; i >= Math.max(1, top - 6); i--) push(`javdb${i}.com`);
      } else {
        push(latestDomain);
      }
    }
    STATIC_BACKUP_DOMAINS.forEach(push);
    // 再补一个兜底递减（以当前 host 为基准）
    try {
      const cur = window.location.hostname.toLowerCase();
      const cm = cur.match(/javdb(\d+)\.com/);
      if (cm) {
        const n = parseInt(cm[1], 10);
        for (let i = n - 1; i >= Math.max(1, n - 4); i--) push(`javdb${i}.com`);
      }
    } catch(e){}
    return out;
  }

  async function fetchLatestDomainFromJavdb() {
    // javdb.com 首页公告里的最新网址（需代理时可能失败，失败即返回 null）
    const resp = await gmGet('https://javdb.com/');
    if (!resp || resp.status !== 200) return null;
    const html = resp.responseText || '';
    // 优先解析公告区域，其次全页 max
    return parseMaxJavdbDomain(html);
  }
  async function fetchLatestDomainFromTG() {
    const response = await gmGet('https://t.me/s/javdbnews');
    if (!response || response.status !== 200) return null;
    const html = response.responseText || '';
    return parseMaxJavdbDomain(html);
  }
  function buildAppHostUrls(cachedDomain, currentHost) {
    const out = [];
    const seen = new Set();
    const push = (u) => { if (!seen.has(u)) { seen.add(u); out.push(u); } };
    const appOf = (x) => 'https://app.' + String(x).toLowerCase() + '/';
    const numOf = (h) => { try { const m = String(h || '').toLowerCase().match(/javdb(\d+)\.com/); return m ? parseInt(m[1], 10) : 0; } catch (e) { return 0; } };
    if (cachedDomain) { try { push(appOf(cachedDomain)); } catch (e) {} const cn = numOf(cachedDomain); for (let i = cn - 1; i >= Math.max(1, cn - 2); i--) push('https://app.javdb' + i + '.com/'); }
    let ch = '';
    try { ch = String(currentHost || '').toLowerCase().replace(/^www\./, ''); } catch (e) {}
    const n = numOf(ch);
    if (n > 0) { push(appOf(ch)); for (let i = n + 2; i >= Math.max(1, n - 3); i--) push('https://app.javdb' + i + '.com/'); }
    STATIC_BACKUP_DOMAINS.forEach((z) => push(appOf(z)));
    push('https://app.javdb.com/');
    return out;
  }
  async function fetchLatestDomainFromApp() {
    // 官方 App 关于页常见域名：app.<mirror>.com / app.javdb.com
    let cachedDomain = null;
    try { const c0 = getCachedDomain(); if (c0 && c0.domain) cachedDomain = c0.domain; } catch (e) {}
    let curHost = '';
    try { curHost = window.location.hostname || ''; } catch (e) {}
    const urls = buildAppHostUrls(cachedDomain, curHost);
    const BATCH = 4;
    let idxA = 0;
    while (idxA < urls.length) {
      const batch = urls.slice(idxA, idxA + BATCH);
      idxA += BATCH;
      const rs = await Promise.all(batch.map((u) => gmGet(u)));
      for (const r of rs) {
        if (r && r.status === 200 && r.responseText) {
          const d = parseMaxJavdbDomain(r.responseText);
          if (d) return d;
        }
      }
    }
    return null;
  }
  async function fetchLatestDomainMultiSource() {
    // 真抢跑：三源同时起跑，高优先级源短暂优先，其他源命中立即返回；整体最多等待 30 秒
    const cap = (p, ms) => {
      try {
        return new Promise((resolve) => {
          let done = false;
          let timer = null;
          const fin = (v) => { if (!done) { done = true; try { clearTimeout(timer); } catch (e2) {} resolve(v); } };
          try { timer = setTimeout(() => fin(null), ms); } catch (e) {}
          try { Promise.resolve(p).then((v) => fin(v), () => fin(null)); } catch (e) { fin(null); }
        });
      } catch (e) { return Promise.resolve(null); }
    };
    let p1 = null;
    let p2 = null;
    let p3 = null;
    try { p1 = fetchLatestDomainFromJavdb(); } catch (e) { p1 = null; }
    try { p2 = fetchLatestDomainFromTG(); } catch (e) { p2 = null; }
    try { p3 = fetchLatestDomainFromApp(); } catch (e) { p3 = null; }
    try { if (p1 && p1.catch) p1.catch(() => null); } catch (e) {}
    try { if (p2 && p2.catch) p2.catch(() => null); } catch (e) {}
    try { if (p3 && p3.catch) p3.catch(() => null); } catch (e) {}
    const sourceEntries = [
      { promise: p1, source: "javdb.com" },
      { promise: p2, source: "telegram" },
      { promise: p3, source: "app" }
    ];
    const neverSettling = () => new Promise(() => {});
    const settled = sourceEntries.filter(({ promise }) => promise).map(({ promise, source }) =>
      Promise.resolve(promise).then(
        (domain) => domain ? { domain, source } : neverSettling(),
        () => neverSettling()
      )
    );

    // 给高优先级源 1.5 秒短暂窗口，避免它只慢几百毫秒就被低优先级源抢先。
    try {
      const highPriority = await cap(settled[0], 1500);
      if (highPriority) return highPriority;
    } catch (e) {}

    // 其余源已经同时在跑，谁先成功就返回；总上限为 1.5 + 28.5 = 30 秒。
    try {
      return await cap(Promise.race(settled), 28500);
    } catch (e) {
      return null;
    }
  }


  let lastDomainUI = "";
  function getCurrentNumericDomain() {
    try {
      const host = String(window.location.hostname || '').toLowerCase();
      const match = host.match(/^javdb(\d+)\.com$/);
      return match ? host : null;
    } catch (e) { return null; }
  }

  function updateDomainStatusUI(force = false) {
    const el = document.getElementById("scraper-domain-status");
    if (!el) return;
    const cached = getCachedDomain();
    const currentDomain = getCurrentNumericDomain();
    const isRefreshing = !!window.__javdbDomainRefreshing;
    var nextHTML = "";
    if (cached) {
      const ageText = cached.time > 0 ? ` · ${((Date.now() - cached.time) / 3600000).toFixed(1)}h前` : '';
      const checkText = isRefreshing ? ' · 检查中' : '';
      nextHTML = `最新域名: <b style="color:#00d26a;">${escapeHtml(cached.domain)}</b> <span style="color:#888;">(${escapeHtml(cached.source||"缓存")}${ageText}${checkText})</span>`;
    } else if (currentDomain) {
      const checkText = isRefreshing ? '检查中' : '远端检查失败时使用备用列表';
      nextHTML = `最新域名: <b style="color:#ffcc00;">${escapeHtml(currentDomain)}</b> <span style="color:#888;">(当前可用域名 · ${checkText})</span>`;
    } else {
      const checkText = isRefreshing ? '检查中' : '未缓存（将按备用列表兜底）';
      nextHTML = `最新域名: <span style="color:#888;">${checkText}</span>`;
    }
    if (!force && nextHTML === lastDomainUI) {
      return;
    }
    lastDomainUI = nextHTML;
    el.innerHTML = nextHTML;
  }

  async function refreshLatestDomain(manual = false) {
    const statusEl = document.getElementById('scraper-status');
    const logEl = document.getElementById('scraper-log');
    if (window.__javdbDomainRefreshing) return null;
    window.__javdbDomainRefreshing = true;
    let res = null;
    try {
      if (manual && statusEl) { statusEl.innerText = '状态: 正在同步最新域名...'; statusEl.style.color = '#ffcc00'; }
      if (logEl) { log("🔄 同步最新备用网址中..."); }
      updateDomainStatusUI();
      res = await fetchLatestDomainMultiSource();
    } catch (e) {
      res = null;
    } finally {
      window.__javdbDomainRefreshing = false;
    }
    if (res && res.domain) {
      setCachedDomain(res.domain, res.source);
      updateDomainStatusUI();
    if (logEl) { logHtml("[" + escapeHtml(new Date().toLocaleTimeString()) + "] ✅ 已更新: <b>" + escapeHtml(res.domain) + "</b>（来源 " + escapeHtml(res.source) + ")<br>"); }
      if (statusEl && manual) { statusEl.innerText = `✅ 已同步: ${res.domain}`; statusEl.style.color = '#00d26a'; }
      return res.domain;
    } else {
      updateDomainStatusUI();
    if (logEl) { log("[" + escapeHtml(new Date().toLocaleTimeString()) + "] ⚠️ 同步失败，使用本地缓存/兜底列表"); }
      if (statusEl && manual) { statusEl.innerText = '⚠️ 同步失败，已保留缓存'; statusEl.style.color = '#ff6b6b'; }
      return null;
    }
  }

  function scheduleDomainAutoUpdate() {
    if (window.__javdbDomainSchedDone) { return; }
    window.__javdbDomainSchedDone = true;
    if (domainAutoTimer) clearInterval(domainAutoTimer);
    // 启动时：若超过 6h 或无缓存则立即同步，否则仅更新 UI
    try { updateDomainStatusUI(); } catch (e) {}
    try {
      setTimeout(() => { try { updateDomainStatusUI(true); } catch (e) {} }, 800);
      setTimeout(() => { try { updateDomainStatusUI(true); } catch (e) {} }, 3000);
    } catch (e) {}
    const cached = getCachedDomain();
    if (!cached || (Date.now() - cached.time) > DOMAIN_AUTO_UPDATE_INTERVAL_MS) {
      refreshLatestDomain(false);
    } else {
      updateDomainStatusUI();
    }
    domainAutoTimer = window.__javdbScraperTimer = setInterval(() => {
      // 页面可见时才请求，避免后台空转
      if (document.visibilityState === 'visible') refreshLatestDomain(false);
      else updateDomainStatusUI();
    }, DOMAIN_AUTO_UPDATE_INTERVAL_MS);
    var lastVisSync = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        var nowV = Date.now();
        if (nowV - lastVisSync < 60000) {
          updateDomainStatusUI();
          return;
        }
        lastVisSync = nowV;
        const c = getCachedDomain();
        if (!c || (Date.now() - c.time) > DOMAIN_AUTO_UPDATE_INTERVAL_MS) refreshLatestDomain(false);
        else updateDomainStatusUI();
      }
    });
    // 菜单命令
    try {
      if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('🔄 立即同步最新域名', () => refreshLatestDomain(true));
      } else if (typeof GM !== 'undefined' && GM.registerMenuCommand) {
        GM.registerMenuCommand('🔄 立即同步最新域名', () => refreshLatestDomain(true));
      }
    } catch(e){}
  }

  async function triggerDomainJump(reason = '检测到拦截封禁') {
    removeFromQueue();
    document.title = origTitle;
    const currentHost = window.location.hostname.toLowerCase();
    try { broadcastBanForCurrentHost(); } catch (e) {}
    const statusEl = document.getElementById('scraper-status');
    const logEl = document.getElementById('scraper-log');

    if (logEl) {
      logHtml("<br><span style='color:#ffcc00; font-weight:bold;'>🚨 [" + escapeHtml(reason) + "] 触发封禁，立即自动切域名...</span><br>");
    }
    if (statusEl) {
      statusEl.innerText = `🚨 正在切号复活中...`;
      statusEl.style.color = '#ffcc00';
    }

    // 优先用缓存/实时多源
    let targetDomain = null;
    let source = '';
    const cached = getCachedDomain();
    // 若缓存新鲜（24h内）直接用
    if (cached && (Date.now() - cached.time) < 24*3600000) {
      if (cached.domain !== currentHost) { targetDomain = cached.domain; source = '缓存:'+cached.source; }
    }
    if (!targetDomain) {
      const res = await fetchLatestDomainMultiSource();
      if (res && res.domain && res.domain !== currentHost) { targetDomain = res.domain; source = res.source; setCachedDomain(res.domain, res.source); }
      else if (cached && cached.domain !== currentHost) { targetDomain = cached.domain; source = '缓存兜底'; }
    }

    // 算号退回 + 备用列表兜底
    if (!targetDomain || targetDomain === currentHost) {
      const backupList = buildBackupDomainList(targetDomain || (cached?cached.domain:null));
      let idx = backupList.findIndex(d => d === currentHost);
      if (idx >= 0 && idx + 1 < backupList.length) targetDomain = backupList[idx+1];
      else {
        const m = currentHost.match(/javdb(\d+)\.com/);
        if (m) targetDomain = `javdb${Math.max(parseInt(m[1],10)-1,1)}.com`;
        else targetDomain = backupList[0] || STATIC_BACKUP_DOMAINS[0];
      }
      source = source || '递减兜底';
    }

    if (!targetDomain || targetDomain === currentHost) {
      if (logEl) {
        logHtml("<br><span style='color:#ff5555; font-weight:bold;'>已在最小可用域名上且无备用域名可跳，已停止自动跳转。请稍后手动重试。</span><br>");
      }
      if (statusEl) {
        statusEl.innerText = '状态: 暂无可用备用域名，已停止';
        statusEl.style.color = '';
      }
      try { banStopped = true; shouldStop = true; } catch (e) {}
      isJumping = false;
      try {
        var bS0 = document.getElementById('btn-start');
        var bT0 = document.getElementById('btn-stop');
        if (bS0) bS0.disabled = false;
        if (bT0) bT0.disabled = true;
      } catch (e) {}
      return;
    }

    if (logEl) {
      logHtml("✅ 锁定新域名: <b>" + escapeHtml(targetDomain) + "</b> <span style='color:#888;'>(" + escapeHtml(source) + ")</span>，3秒后自动跳转复活...<br>");
    }
    if (statusEl) {
      statusEl.innerText = `🔄 3秒后跳转至: ${targetDomain}`;
    }

    isJumping = true;
    try { shouldStop = true; } catch (e) {}
    setTimeout(() => {
      try {
        const url = new URL(window.location.href);
        url.hostname = targetDomain;
        window.location.href = url.toString();
      } catch (e) {
        window.location.href = `${window.location.protocol}//${targetDomain}${window.location.pathname}${window.location.search}${window.location.hash}`;
      }
    }, 2500);
    setTimeout(() => {
      try {
        if (window.location.hostname === currentHost && isJumping) {
          isJumping = false;
          var sEl = document.getElementById("scraper-status");
          var bS = document.getElementById("btn-start");
          var bT = document.getElementById("btn-stop");
          if (sEl) { sEl.style.color = ""; sEl.innerText = "状态: 跳转未完成，可重试"; }
          if (bS) bS.disabled = false;
          if (bT) bT.disabled = true;
        }
      } catch (e) {}
    }, 8000);
  }

  // 页面入口即检查：若打开网页本身就是封禁页，立即触发切域名
  const pageBodyText = document.body
    ? document.body.innerText
    : (document.documentElement ? document.documentElement.innerText : '');
  if (isBannedPage(200, pageBodyText)) {
    triggerDomainJump('访问被拦截');
    return;
  }

  const oldPanel = document.getElementById('javdb-scraper-panel');
  if (oldPanel) oldPanel.remove();

  const panel = document.createElement('div');
  panel.id = 'javdb-scraper-panel';
  panel.innerHTML = `
    <div id="scraper-header" style="font-weight: bold; margin-bottom: 8px; font-size: 14px; border-bottom: 1px solid #444; padding-bottom: 4px; cursor: move; user-select: none; display: flex; justify-content: space-between; align-items: center;">
      <span>🐢 JavDB 磁链提取器 v5.13.90 (自动更新域名版)</span>
      <span style="font-size: 10px; color: #888;">(按住拖动)</span>
    </div>

    <div style="display: flex; gap: 6px; margin-bottom: 10px; font-size: 11px; justify-content: center; background: #2a2a2a; padding: 4px; border-radius: 4px;">
      <label style="cursor: pointer;"><input type="radio" name="scraper-mode" value="current" checked> 当前列表</label>
      <label style="cursor: pointer;"><input type="radio" name="scraper-mode" value="code"> 按番号段</label>
      <label style="cursor: pointer;"><input type="radio" name="scraper-mode" value="actor"> 女优/组合</label>
    </div>

    <div id="section-current" style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; font-size: 12px;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <label>作品范围:</label>
        <div style="display: flex; gap: 4px; align-items: center;">
          <input id="scraper-curr-start" type="number" value="1" min="1" max="500" step="1" placeholder="1" style="width: 48px; background: #333; color: #fff; border: 1px solid #555; padding: 2px 4px; border-radius: 3px;">
          <span>~</span>
          <input id="scraper-curr-end" type="number" value="20" min="1" max="500" step="1" placeholder="20" style="width: 48px; background: #333; color: #fff; border: 1px solid #555; padding: 2px 4px; border-radius: 3px;">
        </div>
      </div>

      <div style="display: flex; align-items: center; justify-content: space-between;">
        <label for="scraper-curr-page-start">起始页码:</label>
        <input id="scraper-curr-page-start" type="number" value="1" min="1" step="1" placeholder="1" style="width: 48px; background: #333; color: #fff; border: 1px solid #555; padding: 2px 4px; border-radius: 3px;">
      </div>

    </div>

    <div id="section-code" style="display: none; flex-direction: column; gap: 6px; margin-bottom: 10px; font-size: 12px;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <label for="scraper-prefix">番号前缀:</label>
        <div style="display: flex; gap: 4px; align-items: center;">
                  <input id="scraper-prefix" type="text" value="" style="width: 72px; background: #333; color: #fff; border: 1px solid #555; padding: 2px 5px; border-radius: 3px;">
          <button id="btn-goto-code" title="打开番号前缀页（新标签页）" style="padding: 2px 8px; background: #17a2b8; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">跳转</button>
        </div>
      </div>
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <label>数字范围:</label>
        <div style="display: flex; gap: 4px; align-items: center;">
          <input id="scraper-start" type="number" value="1" min="1" style="width: 48px; background: #333; color: #fff; border: 1px solid #555; padding: 2px 4px; border-radius: 3px;">
          <span>~</span>
          <input id="scraper-end" type="number" value="50" min="1" style="width: 48px; background: #333; color: #fff; border: 1px solid #555; padding: 2px 4px; border-radius: 3px;">
        </div>
      </div>
    </div>

    <div id="section-actor" style="display: none; flex-direction: column; gap: 6px; margin-bottom: 10px; font-size: 12px;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <label for="scraper-actor">女优姓名(选填):</label>
        <input id="scraper-actor" type="text" value="" style="width: 110px; background: #333; color: #fff; border: 1px solid #555; padding: 2px 5px; border-radius: 3px;">
      </div>
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <label for="scraper-genre">类型/标签(选填):</label>
        <input id="scraper-genre" type="text" value="業餘" style="width: 110px; background: #333; color: #fff; border: 1px solid #555; padding: 2px 5px; border-radius: 3px;">
      </div>
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <label>抓取页数:</label>
        <div style="display: flex; gap: 4px; align-items: center;">
          <input id="scraper-start-page" type="number" value="1" min="1" max="500" step="1" style="width: 48px; background: #333; color: #fff; border: 1px solid #555; padding: 2px 4px; border-radius: 3px;">
          <span>~</span>
          <input id="scraper-end-page" type="number" value="1" min="1" max="500" step="1" style="width: 48px; background: #333; color: #fff; border: 1px solid #555; padding: 2px 4px; border-radius: 3px;">
        </div>
      </div>
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <label for="scraper-order">抓取顺序:</label>
        <select id="scraper-order" style="width: 110px; background: #333; color: #fff; border: 1px solid #555; padding: 2px 5px; border-radius: 3px;">
          <option value="new">新 ➔ 旧 (最新优先)</option>
          <option value="old">旧 ➔ 新 (早期优先)</option>
        </select>
      </div>
    </div>

    </div>

    <div id="scraper-domain-box" style="background:#1a1a1a; border:1px solid #333; border-radius:4px; padding:6px 8px; margin-bottom:8px; font-size:11px; line-height:1.4;">
      <div id="scraper-domain-status" style="color:#aaa; word-break:break-all;">最新域名: 读取缓存...</div>
    </div>

    <div id="scraper-status" style="margin-bottom: 6px; color: #aaa; font-size: 12px;">状态: 准备就绪</div>
    <div id="scraper-progress" style="margin-bottom: 8px; font-weight: bold; color: #00d26a; font-size: 13px;">进度: - / -</div>

    <div style="display: flex; gap: 8px;">
      <button id="btn-start" style="flex: 1; padding: 6px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">开始抓取</button>
      <button id="btn-stop" style="flex: 1; padding: 6px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;" disabled>停止</button>
    </div>

    <div id="scraper-log" style="margin-top: 8px; height: 90px; overflow-y: auto; background: #1e1e1e; color: #00ff66; padding: 6px; font-family: monospace; font-size: 11px; border-radius: 4px;">
      🐢 已就绪：每个作品之间保持 2 秒间隔，降低请求频率...
    </div>
  `;

  Object.assign(panel.style, {
    position: 'fixed', bottom: '40px', right: '20px', zIndex: '999999', width: '260px',
    backgroundColor: '#222', color: '#fff', padding: '12px', borderRadius: '8px',
    boxShadow: '0 4px 15px rgba(0,0,0,0.5)', fontFamily: 'sans-serif'
  });

  if (!document.body) return;
  document.body.appendChild(panel);
  // 定时同步最新域名（每6h + 可见性触发 + 菜单手动）
  try { scheduleDomainAutoUpdate(); } catch(e){}

  const header = document.getElementById('scraper-header');
  let isDragging = false, offsetX = 0, offsetY = 0;
  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    offsetX = e.clientX - panel.offsetLeft; offsetY = e.clientY - panel.offsetTop;
    panel.style.bottom = 'auto'; panel.style.right = 'auto';
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    panel.style.left = `${e.clientX - offsetX}px`; panel.style.top = `${e.clientY - offsetY}px`;
  });
  document.addEventListener('mouseup', () => { isDragging = false; });

  const secCurrent = document.getElementById('section-current');
  const secCode = document.getElementById('section-code');
  const secActor = document.getElementById('section-actor');
  document.querySelectorAll('input[name="scraper-mode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      currentMode = e.target.value;
      secCurrent.style.display = currentMode === 'current' ? 'flex' : 'none';
      secCode.style.display = currentMode === 'code' ? 'flex' : 'none';
      secActor.style.display = currentMode === 'actor' ? 'flex' : 'none';
    });
  });

  const statusEl = document.getElementById('scraper-status');
  const progressEl = document.getElementById('scraper-progress');
  const logEl = document.getElementById('scraper-log');
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const btnGotoCode = document.getElementById('btn-goto-code');
btnGotoCode.addEventListener('click', () => {
  const prefix = (document.getElementById('scraper-prefix').value || '').trim().toUpperCase();
  if (!prefix) { alert('请先填写番号前缀'); return; }
  window.open(`${location.origin}/video_codes/${encodeURIComponent(prefix)}`, '_blank');
});


  function logTrim() {
    while (logEl.childElementCount > 400) {
      logEl.removeChild(logEl.firstChild);
    }
  }
  function logHtml(html) {
    var d = document.createElement("div");
    d.innerHTML = html;
    logEl.appendChild(d);
    logTrim();
    logEl.scrollTop = logEl.scrollHeight;
  }
  function log(msg) {
    const time = new Date().toLocaleTimeString();
    var row = document.createElement("div");
    row.textContent = "[" + time + "] " + msg;
    logEl.appendChild(row);
    logTrim();
    logEl.scrollTop = logEl.scrollHeight;
  }

  // sleep/getRandomDelay hoisted to top (SCRIPT_VERSION block).

  const ESC_MAP = {"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"};

  const ESC_RE = /[&<>"']/g;
  function escapeHtml(str) {
    return String(str).replace(ESC_RE, (c) => ESC_MAP[c]);
  }

  async function fetchWithRetry(url, label = '请求') {
    let lastStatus = 0;
    for (let attempt = 0; attempt <= 3; attempt++) {
      if (shouldStop) return null;
      updateLockHeartbeat();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let res;
        try { res = await fetch(url, { signal: controller.signal }); } finally { clearTimeout(timer); }
        if (res.status === 429) { lastStatus = 429; }
        else if (res.status >= 500 && res.status <= 599) { lastStatus = res.status; }
        else return res;
      } catch (e) {
        lastStatus = -1;
        if (e && e.name === 'AbortError') log('timeout ' + label);
      }
      if (attempt < 3) {
        const delay = Math.min(3000 * Math.pow(2, attempt), 30000) + getRandomDelay(0, 1000);
        log(`⚠️ ${label}${lastStatus === 429 ? '触发限流' : (lastStatus >= 500 ? '服务器错误' : '网络错误')}，约 ${Math.round(delay / 1000)} 秒后重试 (${attempt + 1}/3)...`);
        { const __t0 = Date.now(); let __left = delay; while (__left > 0) { if (shouldStop) return null; const __step = Math.min(5000, __left); await sleep(__step); updateLockHeartbeat(); __left = delay - (Date.now() - __t0); } }
      }
    }
    log(`⚠️ ${label}重试 3 次仍失败，已跳过`);
    return null;
  }

  function parseSizeToMB(sizeStr) {
    if (!sizeStr) return Infinity;
    const match = sizeStr.toUpperCase().match(SIZE_RE);
    if (!match) return Infinity;
    const num = parseFloat(match[1]);
    const unit = match[2];
    if (unit === 'TB') return num * 1024 * 1024;
    if (unit === 'GB') return num * 1024;
    if (unit === 'MB') return num;
    if (unit === 'KB') return num / 1024;
    if (unit === 'B') return num / 1024 / 1024;
    return Infinity;
  }

  const DUR_LABELS = "(?:時長|时长|長度|长度|片長|片长|時間|时间|Length|Duration|Time)";
  const DUR_HM_RE = new RegExp(DUR_LABELS + "[\s\S]{0,40}?(\d+)\s*(?:小時|小时|時|时|h(?:ours?|r)?)\s*(?:(\d+)\s*(?:分鍾|分鐘|分钟|分|min(?:ute)?s?))?", "i");
  const DUR_M_RE = new RegExp(DUR_LABELS + "[\s\S]{0,40}?(\d+)\s*(?:分鍾|分鐘|分钟|分|min(?:ute)?s?)", "i");

  const SUB_C_RE = /-C(?![A-Z0-9])/;
  const SIZE_RE = /([\d\.]+)\s*(TB|GB|MB|KB|B)/;
  const VR_LABEL_TRIM_RE = /[:：]\s*$/;
  const VR_CAT_RE = /^(?:類別|类别|分類|分类|categories?|genres?)$/;
  const VR_TOKEN_RE = /(?:^|[^a-z0-9])vr(?:$|[^a-z0-9])/i;
  const NBSP_RE = /\u00A0/g;
  function parseDurationMin(doc) {
    const panel = doc.querySelector('.movie-panel-info') || doc.body;
    const text = (panel.textContent || '').replace(NBSP_RE, " ");
    const hm = text.match(DUR_HM_RE);
    if (hm) return parseInt(hm[1], 10) * 60 + (hm[2] ? parseInt(hm[2], 10) : 0);
    const m = text.match(DUR_M_RE);
    if (m) return parseInt(m[1], 10);
    // bare-number fallback removed: it matched counts/dates without a duration label
    // and wrongly skipped videos. Only label-anchored durations above are trusted.
    return null;
  }

  function hasVrCategory(doc) {
    const panel = doc.querySelector('.movie-panel-info');
    const blocks = panel ? panel.querySelectorAll('.panel-block') : doc.querySelectorAll('.panel-block');

    for (const block of blocks) {
      const labelEl = block.querySelector('strong');
      const label = (labelEl ? labelEl.textContent : '').replace(VR_LABEL_TRIM_RE, "").trim().toLowerCase();
      if (!VR_CAT_RE.test(label)) continue;

      const categories = Array.from(block.querySelectorAll('.value a, a'));
      const hasVr = categories.some(el => VR_TOKEN_RE.test((el.textContent || '').trim()));
      if (hasVr) return true;
    }

    return false;
  }

  // resolve relative hrefs to absolute
  function toAbsoluteUrl(href) {
    try {
      return new URL(href, window.location.href).toString();
    } catch (e) {
      return href;
    }
  }

  let __sharedParser = null;
  function sharedParser() {
    if (!__sharedParser) { try { __sharedParser = new DOMParser(); } catch(eP) {} }
    return __sharedParser;
  }
  async function processDetailPage(movieHref, movieCode, genreTarget = '') {
    try {
      updateLockHeartbeat();
      const detailUrl = toAbsoluteUrl(movieHref);
      const detailRes = await fetchWithRetry(detailUrl, `详情页 ${movieCode} `);
      if (!detailRes) return null;

      const detailHtml = await detailRes.text();

      if (isBannedPage(detailRes.status, detailHtml)) {
        return 'IP_BANNED';
      }

      if (isLoginPage(detailRes.url, detailHtml)) {
        log(`[!] ${movieCode} 即将跳转登录页，请先登录 JavDB 后再执行`);
        try { shouldStop = true; loginStopped = true; statusEl.innerText = '状态: 请先登录 JavDB 后再抓取'; } catch (e) {}
        return null;
      }

      const parser = sharedParser() || new DOMParser();
      const detailDoc = parser.parseFromString(detailHtml, 'text/html');

      if (hasVrCategory(detailDoc)) {
        log(`[-] ${movieCode} 類別含 VR，跳过`);
        return null;
      }

      if (genreTarget) {
        const genreLower = genreTarget.toLowerCase();
        const tagElements = detailDoc.querySelectorAll('a[href*="/tags/"], a[href*="/genres/"], .tags .button, .meta-value a, .panel-block a');
        const matched = Array.from(tagElements).some(el => {
          const tagText = (el.textContent || "").trim().toLowerCase();
          return tagText === genreLower || tagText.includes(genreLower);
        });

        if (!matched) {
          const infoPanel = detailDoc.querySelector('.movie-panel-info') || detailDoc.body;
          if (!(infoPanel.textContent || '').toLowerCase().includes(genreLower)) {
            log(`[-] ${movieCode} 不含标签 [${genreTarget}]，跳过`);
            return null;
          }
        }
      }

      const durationMin = parseDurationMin(detailDoc);
      if (durationMin !== null && durationMin > 150) {
        log(`[-] ${movieCode} 时长 ${durationMin} 分钟，超过 150 分钟(2.5 小时)，跳过`);
        return null;
      }


      const magnetItems = detailDoc.querySelectorAll('#magnets-content .item, #magnets-content tr');
      const magnetsData = [];

      magnetItems.forEach((mItem) => {
        let linkTag = mItem.querySelector('a[href^="magnet:?"]');
        if (!linkTag) {
          const anchors = mItem.querySelectorAll('a[href]');
          for (const anchorEl of anchors) {
            if ((anchorEl.getAttribute("href") || "").slice(0, 8).toLowerCase() === "magnet:?") { linkTag = anchorEl; break; }
          }
        }
        if (!linkTag) return;

        const rawText = mItem.textContent || "";
        const sizeEl = mItem.querySelector('.meta, .size, [class*=size i]');
        const sizeText = ((sizeEl ? sizeEl.textContent : rawText) || "").trim();
        const fullText = rawText.toUpperCase();

        const isSubbed = fullText.includes('字幕') || fullText.includes('中文') || SUB_C_RE.test(fullText);

        magnetsData.push({
          magnet: linkTag.getAttribute('href'),
          sizeText: sizeText,
          sizeMB: parseSizeToMB(sizeText),
          isSubbed: isSubbed
        });
      });

      if (magnetsData.length === 0) {
        log(`[-] ${movieCode} 无可用磁链`);
        return null;
      } else {
        // 超过 10GB 的磁链直接跳过（无法识别大小的保留）
        let bestAny = null;
        let bestSub = null;
        for (const m of magnetsData) {
          if (m.sizeMB !== Infinity && m.sizeMB > 10240) { continue; }
          if (!bestAny || m.sizeMB < bestAny.sizeMB) { bestAny = m; }
          if (m.isSubbed && (!bestSub || m.sizeMB < bestSub.sizeMB)) { bestSub = m; }
        }
        if (!bestAny) {
          log(`[-] ${movieCode} 磁链全部超过 10GB，跳过`);
          return null;
        }
        const chosen = bestSub || bestAny;

        if (bestSub) {
          log(`[✓] ${movieCode} | 字幕版: ${chosen.sizeText}`);
        } else {
          log(`[✓] ${movieCode} | 无字幕: ${chosen.sizeText}`);
        }
        return chosen.magnet;
      }
    } catch (err) {
      log(`[!] ${movieCode} 详情页读取失败` + (err && err.message ? ": " + String(err.message).slice(0, 120) : ""));
      return null;
    }
  }

  // sanitize filename, trim length
  function sanitizeFileName(name) {
    try {
      let s = String(name || '')
        .replace(/[\/\\:\*\?"<>\|\u0000-\u001f]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/[. ]+$/g, '')
        .substring(0, 120);
      return s || 'javdb_export';
    } catch (e) {
      return 'javdb_export';
    }
  }

  async function runScraper() {
    isRunning = true; shouldStop = false; isJumping = false; loginStopped = false; tagFailed = false; banStopped = false;
    btnStart.disabled = true; btnStop.disabled = false;

    const lockAcquired = await acquireLock();
    if (!lockAcquired || shouldStop) {
      document.title = origTitle;
      statusEl.innerText = '状态: 已取消';
      btnStart.disabled = false; btnStop.disabled = true;
      isRunning = false;
      return;
    }

    document.title = `⚡[抓取中...] ${origTitle}`;
    statusEl.innerText = '状态: 正在抓取中...';
    const results = [];
    const parser = new DOMParser();
    let lastItemStartedAt = 0;

    async function waitForNextItemSlot() {
      if (shouldStop) return false;
      if (isFreshBanForCurrentHost()) {
        try { log("[ban] 同域已有新鲜封禁广播，本标签停止排队"); } catch (e) {}
        try { banStopped = true; shouldStop = true; } catch (e2) {}
        return false;
      }
      if (lastItemStartedAt) {
        try {
          if (lockStoreGet(LOCK_KEY) !== TAB_ID) {
            log('丢失排队锁，重新排队等待中...');
            const ok = await acquireLock();
            if (!ok || shouldStop) return false;
            lastItemStartedAt = Date.now();
            return true;
          }
        } catch (e) {}
      }
      if (!lastItemStartedAt) {
        lastItemStartedAt = Date.now();
        return true;
      }

      const elapsed = Date.now() - lastItemStartedAt;
      const waitMs = ITEM_INTERVAL_MS + getRandomDelay(0, 1200) - elapsed; // +0~1.2s jitter against synchronized bursts
      if (waitMs > 0) {
        log(`⏳ 等待 ${(waitMs / 1000).toFixed(1)} 秒后处理下一个...`);
        var __t1 = Date.now();
        var __left1 = waitMs;
        while (__left1 > 0) {
          if (shouldStop) return false;
          var __step1 = Math.min(500, __left1);
          await sleep(__step1);
          try { updateLockHeartbeat(); } catch (e3) {}
          __left1 = waitMs - (Date.now() - __t1);
        }
        if (shouldStop) return false;
      }
      lastItemStartedAt = Date.now();
      return true;
    }


    try {
      if (currentMode === 'current') {
        const rawStart = Number(document.getElementById('scraper-curr-start').value);
        const rawEnd = Number(document.getElementById('scraper-curr-end').value);
        const rangeStart = Number.isInteger(rawStart) && rawStart >= 1 && rawStart <= 500 ? rawStart : -1;
        const rangeEnd = Number.isInteger(rawEnd) && rawEnd >= 1 && rawEnd <= 500 ? rawEnd : -1;

        if (rangeStart < 0 || rangeEnd < 0 || rangeStart > rangeEnd) {
          alert('请输入有效的作品范围（1～500，且起始不大于结束）！');
          btnStart.disabled = false; btnStop.disabled = true; isRunning = false;
          removeFromQueue(); document.title = origTitle; return;
        }

        const rawCurrPage = Number(document.getElementById('scraper-curr-page-start')?.value);
        if (!Number.isInteger(rawCurrPage) || rawCurrPage < 1 || rawCurrPage > 500) { alert('请检查正确的起始页码！'); btnStart.disabled = false; btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return; }
        const currPageStart = rawCurrPage;

        log('当前页面模式: 起始页码 ' + currPageStart + '，请求抓取范围 ' + rangeStart + '-' + rangeEnd);

        try {
          updateLockHeartbeat();
          const currPageUrl = (() => {
            try {
              const u = new URL(window.location.href);
              u.searchParams.set('page', String(currPageStart));
              return u.toString();
            } catch (e) { return window.location.href; }
          })();
          const searchRes = await fetchWithRetry(currPageUrl, '当前页面列表 第' + currPageStart + '页');
          if (shouldStop) { /* nothing to do */ }
          else if (!searchRes) {
            log('[-] 获取当前页面失败');
          } else {
            const searchHtml = await searchRes.text();
            if (isBannedPage(searchRes.status, searchHtml)) {
              await triggerDomainJump('当前域名已遭封禁');
            } else if (!handleLoginRedirect(searchRes.url, searchHtml, '当前页面列表')) {
              const searchDoc = parser.parseFromString(searchHtml, 'text/html');
              const movieNodeList = searchDoc.querySelectorAll('.movie-list .item');
              const allItems = movieNodeList ? Array.from(movieNodeList) : [];

              if (allItems.length === 0) {
                log('[-] 当前页面没有可抓取的作品');
              } else if (rangeStart > allItems.length) {
                log('[-] 起始位置 ' + rangeStart + ' 超出第 ' + currPageStart + ' 页作品数 ' + allItems.length + '，本页无可抓取范围');
              } else {
                const actualEnd = Math.min(rangeEnd, allItems.length);
                const items = allItems.slice(rangeStart - 1, actualEnd);
                log('第 ' + currPageStart + ' 页共 ' + allItems.length + ' 个作品，请求范围 ' + rangeStart + '-' + rangeEnd + '，实际抓取 ' + rangeStart + '-' + actualEnd + '，共 ' + items.length + ' 个');

                for (let idx = 0; idx < items.length; idx++) {
                  if (shouldStop) break;
                  if (!(await waitForNextItemSlot())) break;
                  const item = items[idx];
                  const aTag = item.querySelector('a');
                  if (!aTag) continue;

                  const movieHref = aTag.getAttribute('href');
                  if (!movieHref || movieHref.indexOf('/v/') < 0) continue;
                  const codeEl = item.querySelector('.uid') || item.querySelector('strong');
                  const movieCode = codeEl ? codeEl.textContent.trim() : ('作品' + (idx + 1));

                  progressEl.innerText = '进度: (' + (idx + 1) + '/' + items.length + ')';
                  document.title = '⚡[抓取 ' + (idx + 1) + '/' + items.length + '] ' + origTitle;
                  log('提取中: ' + movieCode + '...');

                  const magnet = await processDetailPage(movieHref, movieCode);

                  if (magnet === 'IP_BANNED') {
                    await triggerDomainJump('抓取中遭遇域名拦截');
                    break;
                  }

                  if (magnet) results.push(magnet);
                }
              }
            }
          }
        } catch (e) {
          log('[!] 当前页面提取失败');
        }

        const pageTitle = origTitle || 'JavDB_列表';
        if (!isJumping && results.length > 0) downloadTXT(results, sanitizeFileName(pageTitle + '_当前页面_第' + currPageStart + '页_' + rangeStart + '-' + rangeEnd));

      } else if (currentMode === 'code') {
        const rawPrefix = document.getElementById('scraper-prefix').value.trim().toUpperCase();
        const startNum = Number(document.getElementById('scraper-start').value);
        const endNum = Number(document.getElementById('scraper-end').value);

        if (!rawPrefix) { alert('请输入番号前缀！'); btnStart.disabled = false; btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return; }
        const totalCount = endNum - startNum + 1;
        if (!Number.isInteger(startNum) || !Number.isInteger(endNum) || startNum < 1 || endNum < 1 || startNum > endNum || totalCount > 500) { alert('请输入有效的数字范围（单次最多 500 个番号）！'); btnStart.disabled = false; btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return; }

        const purePrefix = rawPrefix.replace(/[-_\s]*\d+$/, '');
        const basePrefix = (purePrefix && purePrefix !== rawPrefix) ? purePrefix : rawPrefix;

        let domainJumped = false;
        for (let i = startNum; i <= endNum; i++) {
          if (shouldStop || domainJumped) break;
          if (!(await waitForNextItemSlot())) break;

          const rawNumStr = String(i);
          const pad3Str = rawNumStr.padStart(3, '0');

          const searchTerms = [...new Set([
            `${basePrefix}-${pad3Str}`,
            `${basePrefix}-${rawNumStr}`,
            `${basePrefix}${pad3Str}`
          ])];

          const currentIdx = i - startNum + 1;
          progressEl.innerText = `进度: ${currentIdx} / ${totalCount} (${basePrefix}-${pad3Str})`;
          document.title = `⚡[抓取 ${currentIdx}/${totalCount}] ${origTitle}`;
          log(`检索中: ${basePrefix}-${pad3Str}...`);

          let targetMovieLink = null;

          for (const term of searchTerms) {
            if (shouldStop) break;
            try {
              updateLockHeartbeat();
              const searchRes = await fetchWithRetry(`/search?q=${encodeURIComponent(term)}&f=all`, '搜索 ');
              if (!searchRes) {
                if (shouldStop) break;
                continue;
              }

              const searchHtml = await searchRes.text();

              if (isBannedPage(searchRes.status, searchHtml)) {
                await triggerDomainJump('检索过程遭遇域名拦截');
                domainJumped = true;
                break;
              }

              if (handleLoginRedirect(searchRes.url, searchHtml, '番号检索')) break;

              const searchDoc = parser.parseFromString(searchHtml, 'text/html');
              const movieItems = searchDoc.querySelectorAll('.movie-list .item a');

              if (movieItems && movieItems.length > 0) {
                for (const item of movieItems) {
                  const text = ((item.textContent || '') + ' ' + (item.getAttribute('title') || '')).toUpperCase();
                  if (text.includes(term.toUpperCase())) {
                    targetMovieLink = item.getAttribute('href');
                    break;
                  }
                }
              }

              if (targetMovieLink) break;
            } catch (e) {}
          }

          if (shouldStop || domainJumped) break;


          if (!targetMovieLink) {
            log(`[-] ${basePrefix}-${pad3Str} 不存在/未录入`);
          } else {
            const absLink = toAbsoluteUrl(targetMovieLink);
            const magnet = await processDetailPage(absLink, `${basePrefix}-${pad3Str}`);

            if (magnet === 'IP_BANNED') {
              await triggerDomainJump('抓取详情遭遇域名拦截');
              domainJumped = true;
              break;
            }

            if (magnet) results.push(magnet);
          }
        }
        if (!isJumping && results.length > 0) downloadTXT(results, sanitizeFileName(`${basePrefix}_${startNum}-${endNum}`));

      } else {
        const actorName = document.getElementById('scraper-actor').value.trim();
        const genreName = document.getElementById('scraper-genre').value.trim();
        let inputStartPage = Number(document.getElementById('scraper-start-page').value);
        let inputEndPage = Number(document.getElementById('scraper-end-page').value);
        const orderMode = document.getElementById('scraper-order').value;
        if (!Number.isInteger(inputStartPage) || !Number.isInteger(inputEndPage) || inputStartPage < 1 || inputEndPage < 1 || inputStartPage > 500 || inputEndPage > 500) { alert("请检查正确的页码范围！"); btnStart.disabled = false; btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return; }

        const useCurrentList = !actorName;
        let baseCategoryUrl = null;
        if (useCurrentList) {
          if (/\/tags(\/|$|\?)/.test(location.pathname + location.search)) {
            baseCategoryUrl = window.location.href;
          } else if (genreName) {
            const normTag = s => (s || '').replace(/\s+/g, '').replace(/[（(][^)）]*[)）]/g, '').toLowerCase();
            const wanted = normTag(genreName);
            const inheritCParams = (u, ...srcUrls) => {
              for (const src of srcUrls) {
                try {
                  new URL(src, window.location.href).searchParams.forEach((v, k) => {
                    if (/^c\d+$/.test(k) && !u.searchParams.has(k)) u.searchParams.set(k, v);
                  });
                } catch (e) {}
              }
              return u;
            };
            const matchTagLinks = (doc) => {
              const links = Array.from(doc.querySelectorAll('a[href*="/tags?"]'))
                .filter(a => /[?&]c\d+=\d+/.test(a.getAttribute('href') || ''));
              let h = links.find(a => normTag(a.textContent) === wanted);
              if (!h) h = links.find(a => { const t = normTag(a.textContent); return t && (t.includes(wanted) || wanted.includes(t)); });
              return { hit: h, count: links.length };
            };
            for (const idxUrl of ['/tags?c10=1', '/tags/uncensored?c10=1']) {
              if (baseCategoryUrl || shouldStop) break;
              const tagRes = await fetchWithRetry(idxUrl, '标签索引 ');
              if (!tagRes) { log(`[-] 标签索引 ${idxUrl} 请求失败`); continue; }
              const tagHtml = await tagRes.text();
              if (isBannedPage(tagRes.status, tagHtml)) { try { broadcastBanForCurrentHost(); } catch (e) {} continue; }
              const tagDoc = parser.parseFromString(tagHtml, 'text/html');
              const { hit: linkHit, count } = matchTagLinks(tagDoc);
              log(`标签索引 ${idxUrl}: 状态 ${tagRes.status}，标签链接 ${count} 个${(tagRes.url || '').includes('/login') ? '（跳转到登录页，请先登录）' : ''}`);
              let hit = linkHit;
              if (!hit) {
                const boxes = Array.from(tagDoc.querySelectorAll('input[type="checkbox"][name^="c"][value]'));
                const boxHit = boxes.find(b => {
                  const label = b.closest('label') || (b.id && tagDoc.querySelector(`label[for="${b.id}"]`)) || b.parentElement;
                  const t = normTag(label ? label.textContent : '');
                  return t && (t === wanted || t.includes(wanted) || wanted.includes(t));
                });
                if (boxHit) hit = { getAttribute: () => `/tags?${boxHit.name.replace(/\[\]$/, '')}=${boxHit.value}` };
              }
              if (hit) baseCategoryUrl = inheritCParams(new URL(hit.getAttribute('href'), window.location.href), idxUrl, window.location.href).toString();
            }
            if (!baseCategoryUrl && !shouldStop) {
              log('索引页未命中，尝试通过搜索结果详情页反查标签链接...');
              const sRes = await fetchWithRetry(`/search?q=${encodeURIComponent(genreName)}&f=all`, '搜索 ');
              if (sRes) {
                const sHtml = await sRes.text();
                if (!handleLoginRedirect(sRes.url, sHtml, '标签反查') && !isBannedPage(sRes.status, sHtml)) {
                  const sDoc = parser.parseFromString(sHtml, 'text/html');
                  const candidates = Array.from(sDoc.querySelectorAll('.movie-list .item a[href^="/v/"]')).slice(0, 5);
                  if (candidates.length === 0) {
                    const allA = Array.from(sDoc.querySelectorAll('.movie-list .item a'));
                    for (const a of allA) {
                      if (candidates.length >= 5) break;
                      const h = (a.getAttribute('href') || '').toLowerCase();
                      if (h.indexOf('/v/') >= 0) candidates.push(a);
                    }
                  }
                  for (const a of candidates) {
                    if (baseCategoryUrl || shouldStop) break;
                    const dRes = await fetchWithRetry(a.getAttribute('href'), '详情反查 ');
                    if (!dRes) continue;
                    const dHtml = await dRes.text();
                    if (handleLoginRedirect(dRes.url, dHtml, '标签反查')) break;
                    if (isBannedPage(dRes.status, dHtml)) { try { broadcastBanForCurrentHost(); } catch (e) {} continue; }
                    const dDoc = parser.parseFromString(dHtml, 'text/html');
                    const { hit } = matchTagLinks(dDoc);
                    if (hit) {
                      baseCategoryUrl = inheritCParams(new URL(hit.getAttribute('href'), window.location.href), window.location.href).toString();
                      break;
                    }
                  }
                }
              }
            }
            if (baseCategoryUrl) log(`标签「${genreName}」解析为: ${baseCategoryUrl}`);
          }
          if (!baseCategoryUrl) {
            if (loginStopped) { btnStart.disabled = false; btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return; }
            if (isFreshBanForCurrentHost()) {
              await triggerDomainJump("标签反查遭遇域名拦截");
              return;
            }
            if (genreName) {
              log(`❌ 未能解析标签「${genreName}」，已中止抓取（避免抓错列表）。请确认已登录，或直接打开该标签页后再点开始`);
              tagFailed = true; statusEl.innerText = '状态: 标签解析失败';
              btnStart.disabled = false; btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle;
              return;
            }
            baseCategoryUrl = window.location.href;
          }
          log(`抓取分类列表：${baseCategoryUrl}`);
        }

        const minPage = Math.min(inputStartPage, inputEndPage);
        const maxPage = Math.max(inputStartPage, inputEndPage);

        const pagesToVisit = [];
        if (orderMode === 'new') {
          for (let p = minPage; p <= maxPage; p++) pagesToVisit.push(p);
        } else {
          for (let p = maxPage; p >= minPage; p--) pagesToVisit.push(p);
        }

        let domainJumped = false;
        let emptyStreak = 0;
        for (let pIdx = 0; pIdx < pagesToVisit.length; pIdx++) {
          if (shouldStop || domainJumped) break;
          const page = pagesToVisit[pIdx];
          log(useCurrentList ? `抓取当前分类 第 ${page} 页...` : `检索女优 [${actorName}] 第 ${page} 页...`);

          try {
            updateLockHeartbeat();
            let searchUrl;
            if (useCurrentList) {
              const listObj = new URL(baseCategoryUrl || window.location.href);
              listObj.searchParams.set('page', page);
              searchUrl = listObj.toString();
            } else {
              searchUrl = `/search?q=${encodeURIComponent(actorName)}&page=${page}&f=all`;
            }
            const searchRes = await fetchWithRetry(searchUrl, '检索 ');
            if (!searchRes) {
              if (shouldStop) break;
              continue;
            }

            const searchHtml = await searchRes.text();

            if (isBannedPage(searchRes.status, searchHtml)) {
              await triggerDomainJump('检索过程遭遇域名拦截');
              domainJumped = true;
              break;
            }

            if (handleLoginRedirect(searchRes.url, searchHtml, '分类/女优检索')) break;

            const searchDoc = parser.parseFromString(searchHtml, 'text/html');
            const movieNodeList = searchDoc.querySelectorAll('.movie-list .item');

            if (!movieNodeList || movieNodeList.length === 0) { emptyStreak++; if (emptyStreak >= 3) { log(`连续 3 页无作品，提前结束`); break; } log(`[-] 第 ${page} 页无作品，跳过`); continue; }

            let movieItems = Array.from(movieNodeList);
            emptyStreak = 0;
            if (orderMode === 'old') movieItems.reverse();

            for (let idx = 0; idx < movieItems.length; idx++) {
              if (shouldStop) break;
              if (!(await waitForNextItemSlot())) break;
              const item = movieItems[idx];
              const aTag = item.querySelector('a');
              if (!aTag) continue;

              const movieHref = aTag.getAttribute('href');
              if (!movieHref || movieHref.indexOf('/v/') < 0) continue;
              const codeEl = item.querySelector('.uid') || item.querySelector('strong');
              const movieCode = codeEl ? codeEl.textContent.trim() : `作品${idx + 1}`;

              progressEl.innerText = `进度: 页 ${page} (${idx + 1}/${movieItems.length})`;
              document.title = `⚡[抓取 ${page}页 ${idx + 1}/${movieItems.length}] ${origTitle}`;
              log(`检查标签中: ${movieCode}...`);

              const magnet = await processDetailPage(movieHref, movieCode, useCurrentList ? '' : genreName);

              if (magnet === 'IP_BANNED') {
                await triggerDomainJump('抓取详情遭遇域名拦截');
                domainJumped = true;
                break;
              }

              if (magnet) results.push(magnet);
            }
          } catch (e) { log(`[!] 第 ${page} 页抓取失败`); }
        }

        const orderLabel = orderMode === 'new' ? '新到旧' : '旧到新';
        const fileLabel = useCurrentList ? (genreName || (origTitle || 'JavDB_列表')) : (genreName ? `${actorName}_${genreName}` : actorName);
        if (!isJumping && results.length > 0) downloadTXT(results, sanitizeFileName(`${fileLabel}_第${minPage}-${maxPage}页_${orderLabel}`));
      }
    } finally {
      document.title = origTitle;
      isRunning = false;
      removeFromQueue();
    }

    if (isJumping) return; // jump pending: keep jump status, skip re-enable
    statusEl.style.color = '';
    statusEl.innerText = banStopped ? '状态: 同域封禁广播，已停止排队' : tagFailed ? '状态: 标签解析失败' : loginStopped ? '状态: 请先登录 JavDB 后再抓取' : (shouldStop ? '状态: 已手动停止' : '状态: 完成！');
    btnStart.disabled = false; btnStop.disabled = true;
  }

  function downloadTXT(magnets, fileNameTag) {
    const valid = [...new Set(magnets.filter(m => m && m.toLowerCase().startsWith('magnet:?')))];
    if (valid.length === 0) { log('⚠️ 未抓取到有效磁链'); return; }

    const blob = new Blob([valid.join("\r\n")], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${fileNameTag}_迅雷专用.txt`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function() { try { URL.revokeObjectURL(url); } catch(e) {} }, 60000);
    log(`📁 导出成功：${fileNameTag}_迅雷专用.txt`);
  }

  btnStart.onclick = () => { if (!isRunning) runScraper(); };
  btnStop.onclick = () => { if (isRunning) { shouldStop = true; statusEl.innerText = '状态: 正在停止...'; } };

  const handleEnterKey = (e) => { if (e.key === 'Enter' && !isRunning) { e.preventDefault(); runScraper(); } };
  document.querySelectorAll('#javdb-scraper-panel input').forEach(input => {
    input.addEventListener('keydown', handleEnterKey);
  });
})();
