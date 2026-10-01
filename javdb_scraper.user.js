// ==UserScript==
// @name         JavDB 万能磁链提取器
// @namespace    http://tampermonkey.net/
// @version      5.16.1
// @description  JavDB 磁链批量提取：支持按当前列表、番号段、女优/组合三种模式抓取磁力链接；当前列表支持作品范围与起始页码；自动优先字幕版并选择最小体积，去重后导出迅雷专用 TXT（每 100 条空行分组）；内置全自动自适应请求间隔（根据响应速度与限流情况自动提速降速，无需手动选择速度）；内置 429/封禁重试、备用域名自动切换与多标签排队保护；封禁跳转到新域名并重新登录后自动断点续抓（保留已抓磁链与进度）；每6小时定期自动同步最新备用网址(javdb.com/TG/官方App)并本地缓存；自动识别登录图形验证码；自动跳过 VR 及时长超过 2.5 小时的作品。
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
// @updateURL    https://update.greasyfork.org/scripts/598050/JavDB%20%E4%B8%87%E8%83%BD%E7%A3%81%E9%93%BE%E6%8F%90%E5%8F%96%E5%99%A8.user.js
// @downloadURL  https://update.greasyfork.org/scripts/598050/JavDB%20%E4%B8%87%E8%83%BD%E7%A3%81%E9%93%BE%E6%8F%90%E5%8F%96%E5%99%A8.user.js
// @homepageURL  https://github.com/lijianbin2/javdb
// @supportURL   https://github.com/lijianbin2/javdb/issues
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_VERSION = '5.16.1';
  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function getRandomDelay(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  const origTitle = document.title;

  let isRunning = false;
  let shouldStop = false;
  let restartRequested = false;
  let restartTimer = null;
  let isJumping = false;
  let loginStopped = false;
  let tagFailed = false;
  let banStopped = false;
  let currentMode = 'current';
  let activeTask = null;      // 当前运行任务（用于封禁跳域名前保存断点）
  let resumeState = null;     // 待恢复的抓取断点
  let resumeAutoTimer = null; // 恢复流程的定时器句柄
  // —— 自适应请求间隔 ——
  // 不再是固定 2 秒 + 固定 1.2 秒抖动，而是「基准间隔 × 比例抖动 + 遇限流自动退避」。
  // 连续成功时逐步提速，遇到 429/5xx/超时则自动降速并进入冷却。
  // 单一自适应档位：不再让用户选择速度，由脚本根据响应情况自动在
  // [AUTO_PACE.min, AUTO_PACE.max] 区间内自行调整间隔。
  const AUTO_PACE = { base: 1100, min: 500, max: 12000, jitter: 0.30, slowRspMs: 2500, fastRspMs: 700 };
  const paceState = { base: 0, floor: 0, cooldownUntil: 0, strikes: 0, inited: false, waitLogged: 0, slowRun: 0, fastRun: 0 };

  function paceInit() {
    if (paceState.inited) return;
    paceState.base = AUTO_PACE.base;
    paceState.floor = AUTO_PACE.min;
    paceState.cooldownUntil = 0;
    paceState.strikes = 0;
    paceState.waitLogged = 0;
    paceState.inited = true;
  }

  function paceReset() {
    paceState.inited = false;
    paceState.cooldownUntil = 0;
    paceState.strikes = 0;
    paceState.waitLogged = 0;
    paceInit();
  }

  // 请求成功：逐步回落到基准（最快只到 AUTO_PACE.base，不无限加速）
  function paceOnSuccess(rspMs) {
    paceInit();
    paceState.strikes = 0;
    // 响应时间反馈：连续多次变慢才放宽，连续多次很快才收紧。
    // 用连续计数避免被单次抖动（某次请求慢、CDN 冷启动等）带偏节奏。
    const ms = Number(rspMs);
    if (ms > AUTO_PACE.slowRspMs) { paceState.slowRun++; paceState.fastRun = 0; }
    else if (ms > 0 && ms < AUTO_PACE.fastRspMs) { paceState.fastRun++; paceState.slowRun = 0; }
    else { paceState.slowRun = 0; paceState.fastRun = 0; }

    if (paceState.slowRun >= 3) {
      paceState.slowRun = 0;
      const grow = Math.min(500, Math.round((ms - AUTO_PACE.slowRspMs) / 4) + 120);
      paceState.base = Math.min(AUTO_PACE.max, paceState.base + grow);
      paceState.floor = Math.min(AUTO_PACE.max, paceState.floor + grow);
    } else if (paceState.fastRun >= 3) {
      paceState.fastRun = 0;
      // 连续 3 次很快即明显收紧，保证网络恢复后能较快回到正常节奏
      const shrink = Math.min(300, Math.max(150, Math.round((AUTO_PACE.fastRspMs - ms) / 2)));
      paceState.base = Math.max(AUTO_PACE.min, paceState.base - shrink);
      paceState.floor = Math.max(AUTO_PACE.min, paceState.floor - shrink);
    } else if (paceState.slowRun === 0 && paceState.fastRun === 0) {
      // 响应处于健康区间：逐步回落到基准，不无限加速
      if (paceState.base > AUTO_PACE.base) paceState.base = Math.max(AUTO_PACE.base, paceState.base - 150);
      if (paceState.floor > AUTO_PACE.min) paceState.floor = Math.max(AUTO_PACE.min, paceState.floor - 150);
    }
    if (paceState.cooldownUntil && paceState.cooldownUntil < Date.now()) paceState.cooldownUntil = 0;
  }

  // 限流/错误：立刻退避并进入指数冷却
  function paceOnThrottle(kind) {
    paceInit();
    paceState.strikes++;
    const mult = kind === 'rate' ? 2.0 : 1.5;
    paceState.base = Math.min(AUTO_PACE.max, Math.round(paceState.base * mult) + 400);
    paceState.floor = Math.min(AUTO_PACE.max, Math.round(paceState.floor * mult) + 400);
    const cool = Math.min(45000, (kind === 'rate' ? 4000 : 1500) * Math.pow(2, Math.min(paceState.strikes, 4)));
    paceState.cooldownUntil = Math.max(paceState.cooldownUntil, Date.now() + cool);
  }

  // 本次请求前的目标间隔：比例抖动，避免固定节奏被识别
  function paceTargetMs() {
    paceInit();
    const b = Math.max(paceState.base, paceState.floor);
    const jitter = 1 + (Math.random() * 2 - 1) * AUTO_PACE.jitter;
    return Math.max(300, Math.round(b * jitter));
  }

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

  // 其他标签页是否正在抓取：锁存在、持有者不是本标签、且心跳仍在有效期内。
  // 断点存在只说明「某个标签页抓到一半」，不代表现在没人在跑；
  // 「番号跳转」新开的标签页据此避免把进行中的任务又自动跑一遍。
  function anotherTabIsRunning() {
    try {
      const holder = lockStoreGet(LOCK_KEY);
      if (!holder || holder === TAB_ID) return false;
      return !isLockExpired();
    } catch (e) {
      return false;
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
    try { if (isRunning) saveResumeTask('页面关闭'); } catch (e) {}
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
    // 登录中断：保留断点，登录后可继续
    try { if (isRunning) saveResumeTask('需要登录'); } catch (e) {}
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

  // —— 断点续抓（跨域：GM 存储在所有 JavDB 镜像域名间共享）——
  const TASK_RESUME_KEY = 'javdb_resume_task';
  const RESUME_TTL_MS = 45 * 60 * 1000; // 断点有效期 45 分钟
  const AUTO_RESUME_TTL_MS = 20 * 60 * 1000; // 超过 20 分钟不再自动抢焦点，仅保留「继续抓取」按钮
  const RESUME_FIELD_MAP = {
    currStart: 'scraper-curr-start',
    currEnd: 'scraper-curr-end',
    currPageStart: 'scraper-curr-page-start',
    prefix: 'scraper-prefix',
    codeStart: 'scraper-start',
    codeEnd: 'scraper-end',
    actorName: 'scraper-actor',
    genreName: 'scraper-genre',
    actorPageStart: 'scraper-start-page',
    actorPageEnd: 'scraper-end-page',
    order: 'scraper-order'
  };

  function collectPanelInputs() {
    const out = {};
    for (const key in RESUME_FIELD_MAP) {
      const el = document.getElementById(RESUME_FIELD_MAP[key]);
      if (el) out[key] = el.value;
    }
    return out;
  }

  function applyPanelInputs(inputs) {
    if (!inputs) return;
    for (const key in RESUME_FIELD_MAP) {
      const el = document.getElementById(RESUME_FIELD_MAP[key]);
      if (el && inputs[key] !== undefined && inputs[key] !== null) el.value = inputs[key];
    }
  }

  function currentBasePath() {
    try { return location.pathname + location.search; } catch (e) { return '/'; }
  }

  function saveResumeTask(reason) {
    if (!activeTask) return;
    try {
      const payload = {
        version: 1,
        timestamp: Date.now(),
        reason: reason || '',
        mode: activeTask.mode || currentMode,
        inputs: collectPanelInputs(),
        results: (activeTask.results || []).slice(),
        doneCodes: Array.from(activeTask.doneCodes || []),
        basePath: currentBasePath(),
        needsBasePath: !!(activeTask.needsBasePath),
        navCount: (resumeState && typeof resumeState.navCount === 'number') ? resumeState.navCount : 0
      };
      lockStoreSet(TASK_RESUME_KEY, JSON.stringify(payload));
    } catch (e) {}
  }

  function loadResumeTask() {
    try {
      const raw = lockStoreGet(TASK_RESUME_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || data.version !== 1 || !Array.isArray(data.results)) return null;
      if (!data.timestamp || (Date.now() - data.timestamp) > RESUME_TTL_MS) { clearResumeTask(); return null; }
      return data;
    } catch (e) { return null; }
  }

  function clearResumeTask() {
    try { lockStoreDel(TASK_RESUME_KEY); } catch (e) {}
    resumeState = null;
  }

  // 女优/组合模式留空女优名时，列表基准就是当前页面路径
  function modeNeedsBasePath(mode, inputs) {
    if (mode === 'current') return true;
    if (mode === 'actor') {
      const actorName = (inputs && inputs.actorName ? String(inputs.actorName) : '').trim();
      if (!actorName) return true;
      // 有女优名时依赖搜索 / 标签解析，不强制回跳
      return false;
    }
    return false;
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
      })(__asyncGet, [LOCK_KEY, LOCK_TIME_KEY, DOMAIN_CACHE_KEY, DOMAIN_CACHE_TIME_KEY, DOMAIN_CACHE_SOURCE_KEY, BAN_HOST_KEY, BAN_TIME_KEY, TASK_RESUME_KEY, DEAD_DOMAIN_KEY, JUMP_ATTEMPT_KEY]);
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


  function gmGet(url, timeoutMs) {
    const cap = (timeoutMs && timeoutMs > 0) ? Math.min(timeoutMs, 10000) : 10000;
    const reqTimeout = (timeoutMs && timeoutMs > 0) ? Math.max(1500, Math.min(timeoutMs, 8000)) : 8000;
    return new Promise((resolve) => {
      let gmSettled = false;
      const gmDone = (v) => { if (!gmSettled) { gmSettled = true; try { clearTimeout(gmTimer); } catch (e2) {} resolve(v); } };
      const gmTimer = setTimeout(() => gmDone(null), cap);
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
          timeout: reqTimeout,
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

  // —— 失效域名记忆 ——
  // 跳转前不再盲信缓存/算号递减：先探测是否真的可访问。
  // 刚探测失败的域名记入黑名单一段时间，避免反复跳到同一个死域名（来回弹跳）。
  const DEAD_DOMAIN_KEY = 'javdb_dead_domains';
  const DEAD_DOMAIN_TTL_MS = 2 * 60 * 60 * 1000; // 失效记忆 2 小时
  const DEAD_DOMAIN_MAX_STRIKES = 3; // 连续失败最多把记忆延长到 3 倍 TTL（6 小时）

  function getDeadDomains() {
    try {
      const raw = lockStoreGet(DEAD_DOMAIN_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return {};
      const now = Date.now();
      const out = {};
      let changed = false;
      for (const k in obj) {
        // 存储语义：{ t: 最后一次探测失败的时间戳, n: 连续失败次数 }
        // 兼容旧版本直接存时间戳的格式（按 n=1 处理）。
        const rec = obj[k];
        let t = 0;
        let n = 1;
        if (rec && typeof rec === 'object') {
          t = Number(rec.t || 0);
          n = Math.min(DEAD_DOMAIN_MAX_STRIKES, Math.max(1, Number(rec.n) || 1));
        } else {
          t = Number(rec || 0);
        }
        // 记忆时长随连续失败次数递增：2h → 4h → 6h（封顶）
        if (t && (now - t) < DEAD_DOMAIN_TTL_MS * n) out[k] = { t: t, n: n };
        else changed = true;
      }
      if (changed) { try { lockStoreSet(DEAD_DOMAIN_KEY, JSON.stringify(out)); } catch (e) {} }
      return out;
    } catch (e) { return {}; }
  }

  function markDomainDead(domain, reason) {
    if (!domain) return;
    try {
      const dead = getDeadDomains();
      const key = String(domain).toLowerCase();
      const prev = dead[key];
      // getDeadDomains 已过滤掉过期项，所以 prev 存在就说明记忆仍有效：
      // 在此基础上累加连续失败次数，封顶 DEAD_DOMAIN_MAX_STRIKES 次。
      const prevN = prev ? Math.min(DEAD_DOMAIN_MAX_STRIKES, Math.max(1, Number(prev.n) || 1)) : 0;
      dead[key] = { t: Date.now(), n: prevN + 1 };
      lockStoreSet(DEAD_DOMAIN_KEY, JSON.stringify(dead));
    } catch (e) {}
  }

  function isDomainKnownDead(domain) {
    if (!domain) return false;
    try { return !!getDeadDomains()[String(domain).toLowerCase()]; } catch (e) { return false; }
  }

  function clearDomainDeadMark(domain) {
    if (!domain) return;
    try {
      const dead = getDeadDomains();
      const k = String(domain).toLowerCase();
      if (dead[k]) { delete dead[k]; lockStoreSet(DEAD_DOMAIN_KEY, JSON.stringify(dead)); }
    } catch (e) {}
  }

  // 轻量探测：确认目标域名当前真的能打开，且不是封禁/停放页
  function hasGmRequest() {
    try {
      return !!((typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) ||
                (typeof GM !== 'undefined' && GM && GM.xmlHttpRequest));
    } catch (e) { return false; }
  }
  async function probeDomain(domain) {
    const d = String(domain || '').toLowerCase();
    if (!/^javdb\d*\.(com|org|net)$/.test(d) && d !== 'javdb.com') return { alive: false, reason: '域名格式不合法' };
    // 没有跨域请求能力时无法探测，此时不要因为探测失败而阻断跳转
    if (!hasGmRequest()) return { alive: true, reason: 'no-probe' };
    const resp = await gmGet('https://' + d + '/', 5000);
    if (!resp) return { alive: false, reason: '无法连接（超时/网络错误）' };
    const status = Number(resp.status) || 0;
    if (status === 0) return { alive: false, reason: '无响应' };
    if (status >= 500) return { alive: false, reason: '服务器错误 ' + status };
    if (isBannedPage(status, resp.responseText)) return { alive: false, reason: '该域名已被封禁' };
    const body = String(resp.responseText || '');
    // 停放页 / 域名回收后的默认页
    if (body.length < 200 && !/javdb/i.test(body)) return { alive: false, reason: '疑似停放页' };
    return { alive: true, reason: 'ok', status: status };
  }

  // —— 连续跳域次数限制（防止反复跳到死域名形成死循环）——
  const JUMP_ATTEMPT_KEY = 'javdb_jump_attempts';
  const JUMP_ATTEMPT_MAX = 4;
  const JUMP_ATTEMPT_WINDOW_MS = 20 * 60 * 1000;

  function getJumpAttempts() {
    try {
      const raw = lockStoreGet(JUMP_ATTEMPT_KEY);
      if (!raw) return { n: 0, t: 0 };
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return { n: 0, t: 0 };
      if ((Date.now() - Number(o.t || 0)) > JUMP_ATTEMPT_WINDOW_MS) return { n: 0, t: Date.now() };
      return { n: Number(o.n) || 0, t: Number(o.t) || 0 };
    } catch (e) { return { n: 0, t: 0 }; }
  }

  function bumpJumpAttempts() {
    try {
      const a = getJumpAttempts();
      a.n += 1;
      a.t = Date.now();
      lockStoreSet(JUMP_ATTEMPT_KEY, JSON.stringify(a));
      return a.n;
    } catch (e) { return 1; }
  }

  function clearJumpAttempts() {
    try { lockStoreDel(JUMP_ATTEMPT_KEY); } catch (e) {}
  }

  // 判断当前页面是否真的是 JavDB 站点（停放页/域名回收页会被判否）
  function looksLikeJavDBPage() {
    try {
      if (isLoginPage(window.location.href, '')) return true; // 登录页也算正常
      if (document.querySelector('.movie-list')) return true;
      if (document.querySelector('a[href*="/v/"]')) return true;
      if (document.querySelector('a[href*="/actors/"], a[href*="/video_codes/"], a[href*="/tags"]')) return true;
      const t = document.body ? (document.body.innerText || '') : '';
      if (/javdb|磁力|番号|女优|影片|影片庫/i.test(t.slice(0, 4000))) return true;
      if (document.title && /javdb/i.test(document.title)) return true;
    } catch (e) {}
    return false;
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
  async function refreshLatestDomain(manual = false) {
    const statusEl = document.getElementById('scraper-status');
    const logEl = document.getElementById('scraper-log');
    if (window.__javdbDomainRefreshing) return null;
    window.__javdbDomainRefreshing = true;
    let res = null;
    try {
      if (manual && statusEl) { statusEl.innerText = '状态: 正在同步最新域名...'; statusEl.style.color = '#ffcc00'; }
      if (logEl) { log("🔄 同步最新备用网址中..."); }
      res = await fetchLatestDomainMultiSource();
    } catch (e) {
      res = null;
    } finally {
      window.__javdbDomainRefreshing = false;
    }
    if (res && res.domain) {
      setCachedDomain(res.domain, res.source);
    if (logEl) { logHtml("[" + escapeHtml(new Date().toLocaleTimeString()) + "] ✅ 已更新: <b>" + escapeHtml(res.domain) + "</b>（来源 " + escapeHtml(res.source) + ")<br>"); }
      if (statusEl && manual) { statusEl.innerText = `✅ 已同步: ${res.domain}`; statusEl.style.color = '#00d26a'; }
      return res.domain;
    } else {
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
    const cached = getCachedDomain();
    if (!cached || (Date.now() - cached.time) > DOMAIN_AUTO_UPDATE_INTERVAL_MS) {
      refreshLatestDomain(false);
    }
    domainAutoTimer = window.__javdbScraperTimer = setInterval(() => {
      // 页面可见时才请求，避免后台空转
      if (document.visibilityState === 'visible') refreshLatestDomain(false);
    }, DOMAIN_AUTO_UPDATE_INTERVAL_MS);
    var lastVisSync = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        var nowV = Date.now();
        if (nowV - lastVisSync < 60000) {
          return;
        }
        lastVisSync = nowV;
        const c = getCachedDomain();
        if (!c || (Date.now() - c.time) > DOMAIN_AUTO_UPDATE_INTERVAL_MS) refreshLatestDomain(false);
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
    // 跳转前先落盘断点：新域名若要求重新登录，登录后可自动继续
    try { if (isRunning) saveResumeTask(reason); } catch (e) {}
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

    // 探测阶段最长可能持续近 100 秒，期间必须持续持有分布式锁：
    // 否则同域名的其它标签页会认为队列无人而正常开跑，造成并发请求（更容易被封）。
    // 真正发起跳转前再主动释放，避免新页面被旧锁挡住 45 秒。
    let jumpBeat = null;
    const stopJumpHeartbeat = () => {
      if (jumpBeat) { try { clearInterval(jumpBeat); } catch (e) {} jumpBeat = null; }
    };
    const startJumpHeartbeat = () => {
      stopJumpHeartbeat();
      try { updateLockHeartbeat(); } catch (e) {}
      jumpBeat = setInterval(function () { try { updateLockHeartbeat(); } catch (e) {} }, 3000);
    };
    const abortJump = (statusText, color) => {
      stopJumpHeartbeat();
      try { removeFromQueue(); } catch (e) {}
      isJumping = false;
      try { banStopped = true; shouldStop = true; } catch (e) {}
      if (statusEl) { statusEl.innerText = statusText; statusEl.style.color = color || ''; }
      try {
        var bS0 = document.getElementById('btn-start');
        var bT0 = document.getElementById('btn-stop');
        if (bS0) bS0.disabled = false;
        if (bT0) bT0.disabled = true;
      } catch (e) {}
    };
    startJumpHeartbeat();

    // 连续跳域上限前置判断：在花掉一整轮探测之前就停下，
    // 也避免把「刚验证可用」的目标域名写进失效记忆。
    if (getJumpAttempts().n >= JUMP_ATTEMPT_MAX) {
      clearJumpAttempts();
      if (logEl) {
        logHtml("<br><span style='color:#ff5555; font-weight:bold;'>⚠️ 20 分钟内已连续切换 " + JUMP_ATTEMPT_MAX + " 次域名仍未稳定，已停止自动跳转。请手动打开可用的 JavDB 地址后再继续（已抓取进度已保存）。</span><br>");
      }
      abortJump('状态: 备用域名连续失效，已停止跳转', '#ff5555');
      return;
    }

    // 候选顺序：实时多源 -> 缓存 -> 算号/静态兜底
    // 注意：不再让「24h 内的缓存」直接短路实时校验，缓存里的域名可能早已失效。
    let targetDomain = null;
    let source = '';
    const candidates = [];
    const pushCand = (d, s) => {
      if (!d) return;
      const v = String(d).toLowerCase();
      if (v === currentHost) return;
      if (!candidates.some(c => c.domain === v)) candidates.push({ domain: v, source: s });
    };

    // 1) 实时多源（封禁后正在等待，限制 9 秒，避免长时间卡住不跳转）
    let live = null;
    try {
      live = await new Promise((resolve) => {
        let done = false;
        const fin = (v) => { if (!done) { done = true; resolve(v); } };
        setTimeout(() => fin(null), 9000);
        Promise.resolve(fetchLatestDomainMultiSource()).then(fin, () => fin(null));
      });
    } catch (e) { live = null; }
    if (live && live.domain) { pushCand(live.domain, '实时:' + live.source); setCachedDomain(live.domain, live.source); }

    // 2) 缓存
    const cached = getCachedDomain();
    if (cached) pushCand(cached.domain, '缓存:' + cached.source);

    // 3) 算号递减 + 静态备用列表
    const fallbackList = buildBackupDomainList((live && live.domain) ? live.domain : (cached ? cached.domain : null));
    for (const d of fallbackList) pushCand(d, '兜底列表');
    if (!candidates.length) STATIC_BACKUP_DOMAINS.forEach(z => pushCand(z, '静态兜底'));

    // 4) 逐个探测，只跳到确认可用的域名
    if (logEl && candidates.length) {
      logHtml("🔍 共 " + candidates.length + " 个候选域名，逐个验证可用性后再跳转...<br>");
    }
    let probeList = candidates.filter(c => !isDomainKnownDead(c.domain));
    if (!probeList.length && candidates.length) {
      // 全部候选都在失效记忆里：清空记忆重新验证一次，避免彻底卡死
      try { lockStoreDel(DEAD_DOMAIN_KEY); } catch (e) {}
      probeList = candidates.slice();
      if (logEl) logHtml("<span style='color:#ffcc00;'>⚠️ 候选域名全部在失效记忆中，已清空记忆并重新验证。</span><br>");
    }

    for (const c of probeList) {
      // 探测可被「停止」中断：整轮探测最坏要近 100 秒，不能让用户干等
      if (shouldStop) {
        if (logEl) logHtml("<br><span style='color:#ffcc00;'>⏹️ 已取消自动切换域名。</span><br>");
        abortJump('状态: 已取消自动切换域名');
        return;
      }
      try { updateLockHeartbeat(); } catch (e) {}
      const r = await probeDomain(c.domain);
      if (r.alive) {
        targetDomain = c.domain;
        source = c.source;
        try { clearDomainDeadMark(c.domain); } catch (e) {}
        break;
      }
      try { markDomainDead(c.domain, r.reason); } catch (e) {}
      if (logEl) {
        logHtml("🚫 跳过 <b>" + escapeHtml(c.domain) + "</b>（" + escapeHtml(r.reason || '不可用') + "）<br>");
      }
    }

    if (logEl) {
      const deadN = Object.keys(getDeadDomains()).length;
      if (deadN) logHtml("<span style='color:#888;'>📋 失效域名记录：" + deadN + " 个（连续失败越多，记忆越久：2~" + (DEAD_DOMAIN_TTL_MS * DEAD_DOMAIN_MAX_STRIKES / 3600000) + " 小时）</span><br>");
    }

    if (!targetDomain || targetDomain === currentHost) {
      if (logEl) {
        logHtml("<br><span style='color:#ff5555; font-weight:bold;'>已在最小可用域名上且无备用域名可跳，已停止自动跳转。请稍后手动重试。</span><br>");
      }
      abortJump('状态: 暂无可用备用域名，已停止');
      return;
    }

    if (logEl) {
      logHtml("✅ 锁定新域名: <b>" + escapeHtml(targetDomain) + "</b> <span style='color:#888;'>(" + escapeHtml(source) + ")</span>，3秒后自动跳转复活...<br>");
    }
    if (logEl && isRunning) {
      logHtml("<span style='color:#8fd3ff;'>💾 已保存抓取断点：新域名如需登录，登录后会自动继续（已抓取结果不会丢失）。</span><br>");
    }
    if (statusEl) {
      statusEl.innerText = `🔄 3秒后跳转至: ${targetDomain}`;
    }

    // 真正跳转前释放锁：新页面用的是新的 TAB_ID，
    // 若把旧锁留到过期才清掉，断点续抓会白等 LOCK_EXPIRY_MS。
    bumpJumpAttempts();
    stopJumpHeartbeat();
    try { removeFromQueue(); } catch (e) {}
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
          try { removeFromQueue(); } catch (e) {}
          var sEl = document.getElementById("scraper-status");
          var bS = document.getElementById("btn-start");
          var bT = document.getElementById("btn-stop");
          if (sEl) { sEl.style.color = ""; sEl.innerText = "状态: 跳转未完成，可重试"; }
          if (bS) bS.disabled = false;
          if (bT) bT.disabled = true;
        }
      } catch (e) {}
    }, 15000);
  }

  // 页面入口即检查：若打开网页本身就是封禁页，立即触发切域名
  const pageBodyText = document.body
    ? document.body.innerText
    : (document.documentElement ? document.documentElement.innerText : '');
  if (isBannedPage(200, pageBodyText)) {
    triggerDomainJump('访问被拦截');
    return;
  }

  // 自愈：刚跳过来却不是 JavDB 页面（域名失效/停放页）时，记为失效并继续换域名
  try {
    if (getJumpAttempts().n >= 1 && !looksLikeJavDBPage()) {
      markDomainDead(window.location.hostname.toLowerCase(), '跳转后页面不是 JavDB 站点');
      triggerDomainJump('跳转到已失效的网址');
      return;
    }
    // 当前页面正常，清除失效标记与连续跳域计数
    clearDomainDeadMark(window.location.hostname.toLowerCase());
    clearJumpAttempts();
  } catch (e) {}

  const oldPanel = document.getElementById('javdb-scraper-panel');
  if (oldPanel) oldPanel.remove();

  const panel = document.createElement('div');
  panel.id = 'javdb-scraper-panel';
  panel.innerHTML = `
    <div id="scraper-header" style="font-weight: bold; margin-bottom: 8px; font-size: 14px; border-bottom: 1px solid #444; padding-bottom: 4px; cursor: move; user-select: none; display: flex; justify-content: space-between; align-items: center;">
      <span>🐢 JavDB 磁链提取器</span>
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

    <div id="scraper-status" style="margin-bottom: 6px; color: #aaa; font-size: 12px;">状态: 准备就绪</div>
    <div id="scraper-progress" style="margin-bottom: 8px; font-weight: bold; color: #00d26a; font-size: 13px;">进度: - / -</div>

    <div style="display: flex; gap: 8px;">
      <button id="btn-start" style="flex: 1; padding: 6px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">开始抓取</button>
      <button id="btn-stop" style="flex: 1; padding: 6px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;" disabled>停止</button>
    </div>

    <div id="scraper-log" style="margin-top: 8px; height: 90px; overflow-y: auto; background: #1e1e1e; color: #00ff66; padding: 6px; font-family: monospace; font-size: 11px; border-radius: 4px;">
      🐢 已就绪：请求间隔将根据响应速度自动调整，遇到限流会自动退避，无需手动选择速度...
    </div>
  `;

  Object.assign(panel.style, {
    position: 'fixed', bottom: '0px', right: '0px', zIndex: '999999', width: '260px',
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
  function resetStartButton() {
    btnStart.disabled = false;
    btnStart.textContent = '开始抓取';
    // 断点只在「封禁跳域」或「需要登录」时保留；其余情况清理
    if (!loginStopped && !isJumping) { try { clearResumeTask(); } catch (e) {} }
  }
  function scheduleRestartIfNeeded() {
    if (!restartRequested) return;
    restartRequested = false;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    const launch = () => {
      if (isRunning) {
        restartTimer = setTimeout(launch, 50);
        return;
      }
      restartTimer = null;
      runScraper();
    };
    restartTimer = setTimeout(launch, 0);
  }
  function requestRestart() {
    if (!isRunning) { runScraper(); return; }
    // 用户改了参数重新开始：丢弃旧的断点，按新任务抓取
    try { clearResumeTask(); } catch (e) {}
    restartRequested = true;
    shouldStop = true;
    btnStart.disabled = true;
    btnStop.disabled = false;
    statusEl.innerText = '状态: 正在停止旧任务并按新参数重新开始...';
    statusEl.style.color = '#ffcc00';
    log('🔄 已请求新任务：停止旧任务后，将按当前参数重新开始。');
  }
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
    const MAX_ATTEMPTS = 4; // 含首次请求，最多发起 4 次（失败后重试 3 次）
    let lastStatus = 0;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (shouldStop) return null;
      updateLockHeartbeat();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let res;
        const reqStart = Date.now();
        try { res = await fetch(url, { signal: controller.signal }); } finally { clearTimeout(timer); }
        const rspMs = Date.now() - reqStart;
        if (res.status === 429) { lastStatus = 429; paceOnThrottle('rate'); }
        else if (res.status >= 500 && res.status <= 599) { lastStatus = res.status; paceOnThrottle('error'); }
        else { paceOnSuccess(rspMs); return res; }
      } catch (e) {
        lastStatus = -1; paceOnThrottle('error');
        if (e && e.name === 'AbortError') log('timeout ' + label);
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = Math.min(3000 * Math.pow(2, attempt), 30000) + getRandomDelay(0, 1000);
        log(`⚠️ ${label}${lastStatus === 429 ? '触发限流' : (lastStatus >= 500 ? '服务器错误' : '网络错误')}，约 ${Math.round(delay / 1000)} 秒后重试 (${attempt + 1}/${MAX_ATTEMPTS - 1})...`);
        { const __t0 = Date.now(); let __left = delay; while (__left > 0) { if (shouldStop) return null; const __step = Math.min(5000, __left); await sleep(__step); updateLockHeartbeat(); __left = delay - (Date.now() - __t0); } }
      }
    }
    log(`⚠️ ${label}重试 ${MAX_ATTEMPTS - 1} 次（共 ${MAX_ATTEMPTS} 次请求）仍失败，已跳过`);
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

  // 时长标签：strict 用于精确匹配整块标签，loose 用于「影片时长」这类带前缀的写法
  const DUR_LABEL_STRICT_RE = /^(?:時長|时长|長度|长度|片長|片长|時間|时间|length|duration|runtime|play\s*time|time)$/i;
  // loose 也必须整体锚定：只允许「影片时长」「播放時間」这类已知前缀，
  // 否则「上次播放时间」「时间线」之类的块会被误当成时长块。
  const DUR_LABEL_LOOSE_RE = /^(?:(?:影片|片子|視頻|视频|播放)?\s*(?:時長|时长|長度|长度|片長|片长|時間|时间)|length|duration|runtime|play\s*time)$/i;
  // 「3:59」「03:59:59」这类钟表格式。
  // 小时位允许 4 位，并用负向前瞻排除「前面还是数字」的情况，
  // 避免把「1234:56」从中间截断成「234:56」。
  const DUR_CLOCK_RE = /(?<![\d:])(\d{1,4})\s*[:：]\s*(\d{1,2})(?:\s*[:：]\s*(\d{1,2}))?(?![\d])/;
  // 分类标签里的超长合集标记（JavDB 自带，例如「4小時以上作品」）
  const LONG_COMPILATION_TAG_RE = /(?:^|[^0-9])(?:4|四)\s*(?:小時|小时|时|h)\s*(?:以上|或以上)/i;

  const SUB_C_RE = /-C(?![A-Z0-9])/;
  const SIZE_RE = /([\d\.]+)\s*(TB|GB|MB|KB|B)/;
  const VR_LABEL_TRIM_RE = /[:：]\s*$/;
  const VR_CAT_RE = /^(?:類別|类别|分類|分类|categories?|genres?)$/;
  const VR_TOKEN_RE = /(?:^|[^a-z0-9])vr(?:$|[^a-z0-9])/i;
  const NBSP_RE = /\u00A0/g;
  function getCategoryTokens(doc) {
    const panel = doc.querySelector('.movie-panel-info');
    const blocks = panel ? panel.querySelectorAll('.panel-block') : doc.querySelectorAll('.panel-block');
    const tokens = [];

    for (const block of blocks) {
      const labelEl = block.querySelector('strong');
      const label = (labelEl ? labelEl.textContent : '').replace(VR_LABEL_TRIM_RE, "").trim().toLowerCase();
      if (!VR_CAT_RE.test(label)) continue;

      const categories = Array.from(block.querySelectorAll('.value a, a'));
      categories.forEach(el => tokens.push((el.textContent || '').trim()));
    }

    return tokens;
  }

  function hasVrCategory(doc) {
    return getCategoryTokens(doc).some(t => VR_TOKEN_RE.test(t));
  }

  // 分类里带「4小時以上作品」这类标记时，即使时长字段缺失也判定为超长合集
  function hasLongCompilationTag(doc) {
    try {
      return getCategoryTokens(doc).some(t => LONG_COMPILATION_TAG_RE.test(t));
    } catch (e) {
      return false;
    }
  }

  function blockValueText(block) {
    const valueEl = block.querySelector('.value');
    const raw = (valueEl ? valueEl.textContent : block.textContent) || '';
    return raw.replace(NBSP_RE, " ").replace(/\s+/g, " ").trim();
  }

  function labelOfBlock(block) {
    const labelEl = block.querySelector('strong');
    return ((labelEl ? labelEl.textContent : '') || '').replace(VR_LABEL_TRIM_RE, "").replace(/\s+/g, " ").trim();
  }

  // 精确定位「时长」那一块，只取它的值，避免把 日期 / 评分 / 类别 里的数字误当时长
  function findDurationBlockText(doc) {
    const panel = doc.querySelector('.movie-panel-info');
    const root = panel || doc.body;
    if (!root) return null;
    let blocks = [];
    try {
      blocks = Array.from(root.querySelectorAll('.panel-block'));
    } catch (e) {
      return null;
    }
    for (const block of blocks) {
      const label = labelOfBlock(block);
      if (label && DUR_LABEL_STRICT_RE.test(label)) {
        const v = blockValueText(block);
        if (v) return v;
      }
    }
    for (const block of blocks) {
      const label = labelOfBlock(block);
      if (label && DUR_LABEL_LOOSE_RE.test(label)) {
        const v = blockValueText(block);
        if (v) return v;
      }
    }
    return null;
  }

  function parseDurationFromValueText(valueText) {
    const t = String(valueText || '').replace(NBSP_RE, " ").trim();
    if (!t) return null;

    // 3:59 / 03:59:59 / 239:00
    const clock = t.match(DUR_CLOCK_RE);
    if (clock) {
      const a = parseInt(clock[1], 10);
      const b = parseInt(clock[2], 10);
      // HH:MM:SS 的秒位不足 1 分钟，对「是否超过 150 分钟」的判定没有影响，
      // 因此与两段式共用同一个换算：a 小时 b 分钟 = a*60+b。
      // 两段式在时长语境下一律按 H:MM 解释（3:59 = 3 小时 59 分 = 239 分钟）：
      // MM:SS 写法在 JavDB 及镜像站从未出现，而本函数的目的是「宁可判长也别漏掉长片」，
      // 故不取较小值，避免 3:59 被当成 3 分钟而漏过超长合集。
      return a * 60 + b;
    }

    // 3 小時 59 分鐘 / 3h59m / 3 hours 59 minutes
    const hm = t.match(/(\d+)\s*(?:小時|小时|時|时|h(?:ours?|r)?)\s*(?:(\d+)\s*(?:分鍾|分鐘|分钟|分|min(?:ute)?s?|m(?![a-z])))?/i);
    if (hm) return parseInt(hm[1], 10) * 60 + (hm[2] ? parseInt(hm[2], 10) : 0);

    // 240 分鍾 / 240 分钟 / 240 minutes
    const m = t.match(/(\d+)\s*(?:分鍾|分鐘|分钟|分|min(?:ute)?s?|m(?![a-z]))/i);
    if (m) return parseInt(m[1], 10);

    // 值本身就是纯数字（部分镜像站会省略单位）
    const bare = t.match(/^(\d+(?:\.\d+)?)$/);
    if (bare) return Math.round(parseFloat(bare[1]));

    return null;
  }

  // 返回 { minutes, raw, source }；minutes 为 null 表示页面确实没有可解析的时长
  function parseDuration(doc) {
    const blockText = findDurationBlockText(doc);
    const blockParsed = parseDurationFromValueText(blockText);
    if (blockParsed !== null) {
      return { minutes: blockParsed, raw: blockText || '', source: 'panel-block' };
    }

    // 刻意不做整块面板文本回退：那种宽松匹配会把日期/评分/类别里的数字
    // 当成时长，要么误杀正常影片，要么把长片算成几分钟而漏过超长合集。
    // 只信任上面精确定位到的时长块；定位不到就返回 null（视为时长未知，不跳过）。
    return { minutes: null, raw: blockText || '', source: 'none' };
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
  async function processDetailPage(movieHref, movieCode) {
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
        try { if (isRunning) saveResumeTask('需要登录'); } catch (e) {}
        try { shouldStop = true; loginStopped = true; statusEl.innerText = '状态: 请先登录 JavDB 后再抓取'; } catch (e) {}
        return null;
      }

      const parser = sharedParser() || new DOMParser();
      const detailDoc = parser.parseFromString(detailHtml, 'text/html');

      if (hasVrCategory(detailDoc)) {
        log(`[-] ${movieCode} 類別含 VR，跳过`);
        return null;
      }

      // 分类自带「4小時以上作品」标记时直接跳过，不依赖时长字段是否可解析
      if (hasLongCompilationTag(detailDoc)) {
        log(`[-] ${movieCode} 類別含「4小時以上作品」超长合集标记，跳过`);
        return null;
      }

      const dur = parseDuration(detailDoc);
      const durationMin = dur.minutes;
      if (durationMin !== null && durationMin > 150) {
        log(`[-] ${movieCode} 时长 ${durationMin} 分钟（${dur.raw}），超过 150 分钟(2.5 小时)，跳过`);
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
    restartRequested = false;
    paceReset(); // 每个新任务从自适应基准间隔重新起步
    btnStart.disabled = false; btnStart.textContent = '重新开始'; btnStop.disabled = false;

    const lockAcquired = await acquireLock();
    if (!lockAcquired || shouldStop) {
      document.title = origTitle;
      statusEl.innerText = '状态: 已取消';
      isRunning = false;
      resetStartButton(); btnStop.disabled = true;
      scheduleRestartIfNeeded();
      return;
    }

    document.title = `⚡[抓取中...] ${origTitle}`;
    statusEl.innerText = '状态: 正在抓取中...';
    log(`⚡ 抓取间隔已自动优化（起始约 ${Math.round(AUTO_PACE.base / 100) / 10} 秒，连续成功自动提速，遇到 429/超时会自动降速，无需手动调整）`);
    const results = [];
    const doneCodes = new Set();
    // 恢复断点：已抓磁链 + 已处理番号，results 复用同一数组引用以便自动同步
    if (resumeState && resumeState.mode === currentMode) {
      try {
        (resumeState.results || []).forEach(m => { if (m) results.push(m); });
        (resumeState.doneCodes || []).forEach(c => { if (c) doneCodes.add(c); });
        if (results.length || doneCodes.size) {
          log(`♻️ 断点续抓：已载入 ${results.length} 条磁链，跳过 ${doneCodes.size} 个已处理作品`);
        }
      } catch (e) {}
    }
    activeTask = { mode: currentMode, results: results, doneCodes: doneCodes, needsBasePath: false };
    // 运行期间每 5 秒落盘一次断点：意外关闭标签 / 封禁跳域都不丢进度
    try {
      const periodic = setInterval(() => {
        if (!isRunning || !activeTask) { clearInterval(periodic); return; }
        try { saveResumeTask('定期保存'); } catch (e) {}
      }, 5000);
    } catch (e) {}
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

      paceInit();
      const now = Date.now();
      // 起点对齐：距上次发起请求满目标间隔即可放行
      let dueAt = lastItemStartedAt + paceTargetMs();
      // 限流冷却优先于常规间隔
      if (paceState.cooldownUntil > dueAt) dueAt = paceState.cooldownUntil;
      const waitMs = dueAt - now;
      if (waitMs > 0) {
        // 降低刷屏与 DOM 开销：只在等待较久时记录
        paceState.waitLogged++;
        if (waitMs >= 1500 || paceState.waitLogged % 10 === 0) {
          log(`⏳ 等待 ${(waitMs / 1000).toFixed(1)} 秒后处理下一个...（自适应间隔 ${Math.round(Math.max(paceState.base, paceState.floor))}ms）`);
        }
        var __t1 = Date.now();
        var __left1 = waitMs;
        while (__left1 > 0) {
          if (shouldStop) return false;
          var __step1 = Math.min(250, __left1);
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
          resetStartButton(); btnStop.disabled = true; isRunning = false;
          removeFromQueue(); document.title = origTitle; return;
        }

        const rawCurrPage = Number(document.getElementById('scraper-curr-page-start')?.value);
        if (!Number.isInteger(rawCurrPage) || rawCurrPage < 1 || rawCurrPage > 500) { alert('请检查正确的起始页码！'); resetStartButton(); btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return; }
        const currPageStart = rawCurrPage;

        const totalTargets = rangeEnd - rangeStart + 1;
        let processedTargets = 0;
        let itemsBeforePage = 0;
        let currentPage = currPageStart;
        if (activeTask) activeTask.needsBasePath = true;
        log('当前列表模式: 起始页码 ' + currPageStart + '，跨页顺序抓取第 ' + rangeStart + '-' + rangeEnd + ' 个作品（共 ' + totalTargets + ' 个）');

        while (!shouldStop && !isJumping && currentPage <= 500 && processedTargets < totalTargets) {
          updateLockHeartbeat();
          const pageUrl = (() => {
            try {
              const u = new URL(window.location.href);
              u.searchParams.set('page', String(currentPage));
              return u.toString();
            } catch (e) { return window.location.href; }
          })();
          const searchRes = await fetchWithRetry(pageUrl, '当前列表 第' + currentPage + '页');
          if (shouldStop) break;
          if (!searchRes) {
            log('[-] 获取当前列表第 ' + currentPage + ' 页失败，停止继续翻页');
            break;
          }

          const searchHtml = await searchRes.text();
          if (isBannedPage(searchRes.status, searchHtml)) {
            await triggerDomainJump('当前域名已遭封禁');
            break;
          }
          if (handleLoginRedirect(searchRes.url, searchHtml, '当前列表第' + currentPage + '页')) break;

          const searchDoc = parser.parseFromString(searchHtml, 'text/html');
          const movieNodeList = searchDoc.querySelectorAll('.movie-list .item');
          const allItems = movieNodeList ? Array.from(movieNodeList) : [];
          if (allItems.length === 0) {
            log('[-] 第 ' + currentPage + ' 页没有作品，停止继续翻页');
            break;
          }

          const pageFirstPosition = itemsBeforePage + 1;
          const pageLastPosition = itemsBeforePage + allItems.length;
          const takeStart = Math.max(rangeStart, pageFirstPosition);
          const takeEnd = Math.min(rangeEnd, pageLastPosition);
          log('第 ' + currentPage + ' 页共 ' + allItems.length + ' 个作品，对应全局位置 ' + pageFirstPosition + '-' + pageLastPosition);

          if (takeStart <= takeEnd) {
            const sliceStart = takeStart - pageFirstPosition;
            const sliceEnd = takeEnd - pageFirstPosition + 1;
            const pageItems = allItems.slice(sliceStart, sliceEnd);
            for (let idx = 0; idx < pageItems.length; idx++) {
              if (shouldStop || isJumping) break;
              const absolutePosition = takeStart + idx;
              const item = pageItems[idx];
              const aTag = item.querySelector('a');
              const rawHref = aTag ? aTag.getAttribute('href') : null;
              if (!rawHref || rawHref.indexOf('/v/') < 0) {
                if (!(await waitForNextItemSlot())) break;
                processedTargets++;
                progressEl.innerText = '进度: (' + processedTargets + '/' + totalTargets + ')';
                continue;
              }

              const codeEl0 = item.querySelector('.uid') || item.querySelector('strong');
              const movieCode0 = codeEl0 ? codeEl0.textContent.trim() : ('作品' + absolutePosition);

              processedTargets++;
              progressEl.innerText = '进度: (' + processedTargets + '/' + totalTargets + ')';
              document.title = '⚡[抓取 ' + processedTargets + '/' + totalTargets + '] ' + origTitle;

              // 断点续抓：已处理过的番号直接跳过详情页请求
              if (doneCodes.has(movieCode0)) {
                log(`↩️ 已处理，跳过: ${movieCode0}`);
                continue;
              }

              if (!(await waitForNextItemSlot())) break;

              const movieHref = rawHref;
              const codeEl = item.querySelector('.uid') || item.querySelector('strong');
              const movieCode = codeEl ? codeEl.textContent.trim() : ('作品' + absolutePosition);
              log('提取中: 第' + absolutePosition + '个 ' + movieCode + '...');

              const magnet = await processDetailPage(movieHref, movieCode);
              if (magnet === 'IP_BANNED') {
                await triggerDomainJump('抓取中遭遇域名拦截');
                break;
              }
              doneCodes.add(movieCode);
              if (magnet) results.push(magnet);
            }
          }

          itemsBeforePage = pageLastPosition;
          currentPage++;
          if (processedTargets < totalTargets && !shouldStop && !isJumping) {
            log('继续翻页抓取下一个作品位置，当前累计 ' + processedTargets + '/' + totalTargets);
          }
        }

        const pageTitle = origTitle || 'JavDB_列表';
        if (!isJumping && !restartRequested && results.length > 0) downloadTXT(results, sanitizeFileName(pageTitle + '_当前列表_第' + currPageStart + '页起_' + rangeStart + '-' + rangeEnd));

      } else if (currentMode === 'code') {
        const rawPrefix = document.getElementById('scraper-prefix').value.trim().toUpperCase();
        const startNum = Number(document.getElementById('scraper-start').value);
        const endNum = Number(document.getElementById('scraper-end').value);

        if (!rawPrefix) { alert('请输入番号前缀！'); resetStartButton(); btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return; }
        const totalCount = endNum - startNum + 1;
        if (!Number.isInteger(startNum) || !Number.isInteger(endNum) || startNum < 1 || endNum < 1 || startNum > endNum || totalCount > 500) { alert('请输入有效的数字范围（单次最多 500 个番号）！'); resetStartButton(); btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return; }

        const purePrefix = rawPrefix.replace(/[-_\s]*\d+$/, '');
        const basePrefix = (purePrefix && purePrefix !== rawPrefix) ? purePrefix : rawPrefix;

        let domainJumped = false;
        for (let i = startNum; i <= endNum; i++) {
          if (shouldStop || domainJumped) break;

          const rawNumStr = String(i);
          const pad3Str = rawNumStr.padStart(3, '0');
          const unitCode = `${basePrefix}-${pad3Str}`;
          const currentIdx = i - startNum + 1;

          progressEl.innerText = `进度: ${currentIdx} / ${totalCount} (${unitCode})`;
          document.title = `⚡[抓取 ${currentIdx}/${totalCount}] ${origTitle}`;

          // 断点续抓：已处理过的番号直接跳过搜索与详情请求
          if (doneCodes.has(unitCode)) {
            log(`↩️ 已处理，跳过: ${unitCode}`);
            continue;
          }

          if (!(await waitForNextItemSlot())) break;

          const searchTerms = [...new Set([
            `${basePrefix}-${pad3Str}`,
            `${basePrefix}-${rawNumStr}`,
            `${basePrefix}${pad3Str}`
          ])];

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
            doneCodes.add(unitCode);
          } else {
            const absLink = toAbsoluteUrl(targetMovieLink);
            const magnet = await processDetailPage(absLink, unitCode);

            if (magnet === 'IP_BANNED') {
              await triggerDomainJump('抓取详情遭遇域名拦截');
              domainJumped = true;
              break;
            }

            doneCodes.add(unitCode);
            if (magnet) results.push(magnet);
          }
        }
        if (!isJumping && !restartRequested && results.length > 0) downloadTXT(results, sanitizeFileName(`${basePrefix}_${startNum}-${endNum}`));

      } else {
        const actorName = document.getElementById('scraper-actor').value.trim();
        const genreName = document.getElementById('scraper-genre').value.trim();
        let inputStartPage = Number(document.getElementById('scraper-start-page').value);
        let inputEndPage = Number(document.getElementById('scraper-end-page').value);
        const orderMode = document.getElementById('scraper-order').value;
        if (!Number.isInteger(inputStartPage) || !Number.isInteger(inputEndPage) || inputStartPage < 1 || inputEndPage < 1 || inputStartPage > 500 || inputEndPage > 500) { alert("请检查正确的页码范围！"); resetStartButton(); btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return; }

        const useCurrentList = !actorName;
        if (activeTask) activeTask.needsBasePath = modeNeedsBasePath('actor', { actorName: actorName });
        let baseCategoryUrl = null;
        if (!useCurrentList) {
          // 女优/组合模式：先进入女优主页，再进入女优页上的类型分类，最后抓取分类列表。
          // 不再先搜索全部作品、逐个进入详情页判断类型。
          const normActor = s => (s || '').replace(/\s+/g, '').replace(/[（(][^)）]*[)）]/g, '').replace(/業/g, '业').replace(/餘/g, '余').replace(/顏/g, '颜').toLowerCase();
          const wantedActor = normActor(actorName);
          let actorUrl = null;
          const currentActorMatch = location.pathname.match(/^\/actors\/([^/?#]+)/);
          const currentActorName = document.querySelector('.actor-section-name');
          const currentActorNameMatches = currentActorMatch && currentActorName &&
            (normActor(currentActorName.textContent) === wantedActor ||
             normActor(currentActorName.textContent).includes(wantedActor) ||
             wantedActor.includes(normActor(currentActorName.textContent)));
          if (currentActorNameMatches) {
            const currentActorUrl = new URL(window.location.href);
            ['page', 't', 'sort_type'].forEach(k => currentActorUrl.searchParams.delete(k));
            actorUrl = currentActorUrl;
          } else {
            const actorSearchUrl = `/search?q=${encodeURIComponent(actorName)}&f=actor`;
            const actorSearchRes = await fetchWithRetry(actorSearchUrl, '女优搜索 ');
            if (actorSearchRes) {
              const actorSearchHtml = await actorSearchRes.text();
              if (handleLoginRedirect(actorSearchRes.url, actorSearchHtml, '女优搜索')) {
                resetStartButton(); btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return;
              }
              if (isBannedPage(actorSearchRes.status, actorSearchHtml)) {
                await triggerDomainJump('女优搜索遭遇域名拦截');
                return;
              }
              const actorSearchDoc = parser.parseFromString(actorSearchHtml, 'text/html');
              const actorLinks = Array.from(actorSearchDoc.querySelectorAll('#actors a[href*="/actors/"]'));
              let actorLink = actorLinks.find(a => normActor(a.textContent) === wantedActor);
              if (!actorLink) actorLink = actorLinks.find(a => normActor(a.textContent).includes(wantedActor));
              if (actorLink) actorUrl = new URL(actorLink.getAttribute('href'), window.location.href);
            }
          }

          if (!actorUrl) {
            log(`❌ 未能找到女优「${actorName}」页面，已中止抓取。`);
            tagFailed = true; statusEl.innerText = '状态: 女优页面解析失败';
            resetStartButton(); btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return;
          }

          if (genreName) {
            const actorRes = await fetchWithRetry(actorUrl, '女优页面 ');
            if (!actorRes) {
              log(`[-] 女优页面 ${actorUrl} 请求失败`);
              resetStartButton(); btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return;
            }
            const actorHtml = await actorRes.text();
            if (isBannedPage(actorRes.status, actorHtml)) {
              await triggerDomainJump('女优页面遭遇域名拦截');
              return;
            }
            if (handleLoginRedirect(actorRes.url, actorHtml, '女优页面')) {
              resetStartButton(); btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return;
            }
            const actorDoc = parser.parseFromString(actorHtml, 'text/html');
            const wantedGenre = normActor(genreName);
            const genreLinks = Array.from(actorDoc.querySelectorAll('.actor-tags a[href*="/actors/"]'));
            let genreLink = genreLinks.find(a => normActor(a.textContent) === wantedGenre);
            if (!genreLink) genreLink = genreLinks.find(a => {
              const t = normActor(a.textContent);
              return t && (t.includes(wantedGenre) || wantedGenre.includes(t));
            });
            if (!genreLink) {
              log(`❌ 女优「${actorName}」页面未找到类型「${genreName}」，已中止抓取。`);
              tagFailed = true; statusEl.innerText = '状态: 类型分类解析失败';
              resetStartButton(); btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return;
            }
            baseCategoryUrl = new URL(genreLink.getAttribute('href'), actorUrl).toString();
            log(`已进入女优「${actorName}」的类型分类：${genreName}`);
          } else {
            baseCategoryUrl = actorUrl.toString();
            log(`已进入女优页面：${actorName}`);
          }
        } else {
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
            if (loginStopped) { resetStartButton(); btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return; }
            if (isFreshBanForCurrentHost()) {
              await triggerDomainJump("标签反查遭遇域名拦截");
              return;
            }
            if (genreName) {
              log(`❌ 未能解析标签「${genreName}」，已中止抓取（避免抓错列表）。请确认已登录，或直接打开该标签页后再点开始`);
              tagFailed = true; statusEl.innerText = '状态: 标签解析失败';
              resetStartButton(); btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle;
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
        const ITEMS_PER_PAGE = 40;
        const totalTargets = pagesToVisit.length * ITEMS_PER_PAGE;
        let processedTargets = 0;
        for (let pIdx = 0; pIdx < pagesToVisit.length; pIdx++) {
          if (shouldStop || domainJumped) break;
          const page = pagesToVisit[pIdx];
          log(useCurrentList ? `抓取当前分类 第 ${page} 页...` : `抓取女优 [${actorName}] 分类第 ${page} 页...`);

          try {
            updateLockHeartbeat();
            const listObj = new URL(baseCategoryUrl || window.location.href);
            listObj.searchParams.set('page', page);
            const searchUrl = listObj.toString();
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
              const item = movieItems[idx];
              processedTargets++;
              progressEl.innerText = `进度: 页 ${page} (${processedTargets}/${totalTargets})`;
              document.title = `⚡[抓取 ${processedTargets}/${totalTargets}] ${origTitle}`;
              const aTag = item.querySelector('a');
              if (!aTag) continue;

              const movieHref = aTag.getAttribute('href');
              if (!movieHref || movieHref.indexOf('/v/') < 0) continue;
              const codeEl = item.querySelector('.uid') || item.querySelector('strong');
              const movieCode = codeEl ? codeEl.textContent.trim() : `作品${idx + 1}`;

              // 断点续抓：已处理过的番号直接跳过详情页请求
              if (doneCodes.has(movieCode)) continue;

              if (!(await waitForNextItemSlot())) break;

              log(`检查标签中: ${movieCode}...`);

              const magnet = await processDetailPage(movieHref, movieCode);

              if (magnet === 'IP_BANNED') {
                await triggerDomainJump('抓取详情遭遇域名拦截');
                domainJumped = true;
                break;
              }

              doneCodes.add(movieCode);
              if (magnet) results.push(magnet);
            }
          } catch (e) { log(`[!] 第 ${page} 页抓取失败`); }
        }

        const orderLabel = orderMode === 'new' ? '新到旧' : '旧到新';
        const fileLabel = useCurrentList ? (genreName || (origTitle || 'JavDB_列表')) : (genreName ? `${actorName}_${genreName}` : actorName);
        if (!isJumping && !restartRequested && results.length > 0) downloadTXT(results, sanitizeFileName(`${fileLabel}_第${minPage}-${maxPage}页_${orderLabel}`));
      }
    } finally {
      document.title = origTitle;
      isRunning = false;
      activeTask = null;
      removeFromQueue();
      if (!isJumping && restartRequested) scheduleRestartIfNeeded();
    }

    if (isJumping) return; // jump pending: keep jump status, skip re-enable
    // 断点只在「封禁跳域」或「需要登录」时保留；其余情况清理
    if (!loginStopped) { try { clearResumeTask(); } catch (e) {} }
    statusEl.style.color = '';
    statusEl.innerText = banStopped ? '状态: 同域封禁广播，已停止排队' : tagFailed ? '状态: 标签解析失败' : loginStopped ? '状态: 请先登录 JavDB 后再抓取' : (shouldStop ? '状态: 已手动停止' : '状态: 完成！');
    resetStartButton(); btnStop.disabled = true;
    scheduleRestartIfNeeded();
  }

  function downloadTXT(magnets, fileNameTag) {
    const valid = [...new Set(magnets.filter(m => m && m.toLowerCase().startsWith('magnet:?')))];
    if (valid.length === 0) { log('⚠️ 未抓取到有效磁链'); return; }

    // 每满 100 条空一行分组，方便在迅雷里分段查看；
    // 只影响导出文本排版，去重结果与条数不变（迅雷导入会忽略空行）。
    const TXT_GROUP_SIZE = 100;
    const groups = [];
    for (let i = 0; i < valid.length; i += TXT_GROUP_SIZE) {
      groups.push(valid.slice(i, i + TXT_GROUP_SIZE).join("\r\n"));
    }
    const content = groups.join("\r\n\r\n");
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${fileNameTag}_迅雷专用.txt`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function() { try { URL.revokeObjectURL(url); } catch(e) {} }, 60000);
    log(`📁 导出成功：${fileNameTag}_迅雷专用.txt（共 ${valid.length} 条${groups.length > 1 ? `，按每 ${TXT_GROUP_SIZE} 条空行分组，共 ${groups.length} 组` : ''}）`);
  }

  // 面板参数与断点记录完全一致时视为「继续抓取」，否则视为新任务
  function panelMatchesResume() {
    if (!resumeState || !resumeState.inputs) return false;
    if (resumeState.mode !== currentMode) return false;
    const now = collectPanelInputs();
    for (const key in RESUME_FIELD_MAP) {
      const a = now[key] === undefined ? '' : String(now[key]);
      const b = resumeState.inputs[key] === undefined ? '' : String(resumeState.inputs[key]);
      if (a !== b) return false;
    }
    return true;
  }

  function startFromPanel() {
    if (!isRunning) {
      // 参数已改动 -> 视为新任务，丢弃旧断点
      if (!panelMatchesResume()) { try { clearResumeTask(); } catch (e) {} }
      runScraper();
    } else {
      requestRestart();
    }
  }

  btnStart.onclick = () => { startFromPanel(); };
  btnStop.onclick = () => { if (isRunning) { try { clearResumeTask(); } catch (e) {} shouldStop = true; statusEl.innerText = '状态: 正在停止...'; } };

  const handleEnterKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      startFromPanel();
    }
  };
  document.querySelectorAll('#javdb-scraper-panel input').forEach(input => {
    input.addEventListener('keydown', handleEnterKey);
  });

  // —— 页面加载后的断点自动恢复（封禁跳域 + 重新登录后续抓）——
  function applyResumeMode(mode) {
    if (!mode) return;
    currentMode = mode;
    document.querySelectorAll('input[name="scraper-mode"]').forEach(r => { r.checked = (r.value === mode); });
    const sC = document.getElementById('section-current');
    const sK = document.getElementById('section-code');
    const sA = document.getElementById('section-actor');
    if (sC) sC.style.display = mode === 'current' ? 'flex' : 'none';
    if (sK) sK.style.display = mode === 'code' ? 'flex' : 'none';
    if (sA) sA.style.display = mode === 'actor' ? 'flex' : 'none';
  }

  function isStillLoginPage() {
    try {
      return isLoginPage(window.location.href, document.documentElement ? document.documentElement.innerHTML : '');
    } catch (e) { return false; }
  }

  function beginResumeTask() {
    if (isRunning || !resumeState) return;
    // 保留 resumeState，让 runScraper 载入已抓磁链与已处理番号
    runScraper();
  }

  function scheduleResumeWatch() {
    if (resumeAutoTimer) clearInterval(resumeAutoTimer);
    let ticks = 0;
    resumeAutoTimer = setInterval(() => {
      ticks++;
      if (isRunning) { clearInterval(resumeAutoTimer); resumeAutoTimer = null; return; }
      if (ticks % 2 === 0) autoCheckRememberMe();
      if (!isStillLoginPage() || ticks > 300) {
        clearInterval(resumeAutoTimer);
        resumeAutoTimer = null;
        if (!isStillLoginPage()) {
          logHtml("<span style='color:#8fd3ff;'>✅ 登录已完成，正在恢复未完成的抓取任务...</span><br>");
          beginResumeTask();
        }
      }
    }, 1000);
  }

  function tryAutoResume() {
    let data = null;
    try { data = loadResumeTask(); } catch (e) {}
    if (!data) return;
    // 其他标签页正在抓取（锁未过期且持有者不是本标签）时，本页绝不自动续跑。
    // 典型场景：任务进行中点「番号跳转」开了新标签页，新页面不应抢跑旧任务。
    if (anotherTabIsRunning()) {
      statusEl.innerText = '状态: 其他标签页正在抓取，本页不会自动继续';
      logHtml("<br><span style='color:#8fd3ff;'>🔒 检测到另一个标签页正在抓取（已抓 " + (data.results || []).length +
        " 条磁链）。本页不会自动继续该任务，可直接关闭本页；如需在原标签页继续请回到原页面操作。" +
        "<br><span style='color:#888;'>（若原标签页其实已关闭，等待约 " + Math.ceil(LOCK_EXPIRY_MS / 1000) + " 秒后刷新本页即可自动续抓。）</span></span><br>");
      return;
    }
    if ((Date.now() - data.timestamp) > AUTO_RESUME_TTL_MS) {
      statusEl.innerText = '状态: 检测到未完成任务，可点「继续抓取」接着抓';
      btnStart.textContent = '继续抓取';
      logHtml("<br><span style='color:#ffcc00;'>♻️ 检测到未完成任务（已抓 " + (data.results || []).length + " 条磁链）。断点已超过 20 分钟，点「继续抓取」即可接着抓。</span><br>");
      return;
    }
    resumeState = data;
    applyPanelInputs(data.inputs);
    applyResumeMode(data.mode);
    btnStart.textContent = '继续抓取';

    const modeLabel = data.mode === 'current' ? '当前列表' : (data.mode === 'code' ? '番号段' : '女优/组合');
    logHtml("<br><span style='color:#ffcc00; font-weight:bold;'>♻️ 检测到未完成的抓取任务（" + escapeHtml(modeLabel) + "），已恢复参数与 " + (data.results || []).length + " 条已抓磁链 / " + (data.doneCodes || []).length + " 个已处理作品。</span><br>");

    if (isStillLoginPage()) {
      statusEl.innerText = '状态: 检测到未完成任务，请先登录 JavDB，登录后将自动继续';
      statusEl.style.color = '#ffcc00';
      logHtml("<span style='color:#ffcc00;'>🔑 当前页面需要登录，请完成登录（脚本会自动勾选「记住我」），登录后任务会自动继续。</span><br>");
      scheduleResumeWatch();
      return;
    }

    // 依赖原页面路径的模式（当前列表 / 空女优名的分类页）先回到原路径
    if (data.needsBasePath && data.basePath && currentBasePath() !== data.basePath) {
      const navCount = (typeof data.navCount === 'number') ? data.navCount : 0;
      if (navCount < 1) {
        data.navCount = navCount + 1;
        resumeState = data;
        try { lockStoreSet(TASK_RESUME_KEY, JSON.stringify(data)); } catch (e) {}
        statusEl.innerText = '状态: 正在返回原抓取页面，随后自动继续...';
        logHtml("<span style='color:#8fd3ff;'>↩️ 正在返回原抓取页面: " + escapeHtml(data.basePath) + "</span><br>");
        resumeAutoTimer = setTimeout(() => {
          try { location.href = location.origin + data.basePath; } catch (e) {}
        }, 1200);
        return;
      }
    }

    statusEl.innerText = '状态: 检测到未完成任务，3 秒后自动继续...';
    logHtml("<span style='color:#8fd3ff;'>⏳ 3 秒后自动继续未完成的抓取任务（想重新开始可直接改参数后点「重新开始」）...</span><br>");
    if (resumeAutoTimer) clearTimeout(resumeAutoTimer);
    resumeAutoTimer = setTimeout(() => { beginResumeTask(); }, 3000);
  }

  try { tryAutoResume(); } catch (e) {}
})();
