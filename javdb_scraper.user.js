// ==UserScript==
// @name         JavDB 万能磁链提取器
// @namespace    http://tampermonkey.net/
// @version      5.13.4
// @description  JavDB 磁链批量提取：支持按当前列表、番号段、女优/组合三种模式抓取磁力链接；当前列表支持作品范围与起始页码；自动优先字幕版并选择最小体积，去重后导出迅雷专用 TXT；内置 429/封禁重试、备用域名自动切换与多标签排队保护；每6小时定期自动同步最新备用网址(javdb.com/TG/官方App)并本地缓存；自动跳过 登录图形验证码自动识别+VR 及时长超过 2.5 小时的作品。
// @author       Assistant
// @license      MIT
// @match        *://*.javdb575.com/*
// @match        *://javdb575.com/*
// @match        *://*.javdb*.*/*
// @match        *://javdb*.*/*
// @include      /^https?:\/\/(www\.)?javdb\d*\.(com|org|net)\/.*$/
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      t.me
// @connect      javdb.com
// @connect      javdb575.com
// @connect      app.javdb575.com
// @connect      cdn.jsdelivr.net
// @connect      unpkg.com
// @updateURL    https://raw.githubusercontent.com/lijianbin2/javdb/main/javdb_scraper.user.js
// @downloadURL  https://raw.githubusercontent.com/lijianbin2/javdb/main/javdb_scraper.user.js
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const origTitle = document.title;

  let isRunning = false;
  let shouldStop = false;
  let currentMode = 'current';
  let fetchedCount = 0;
  const ITEM_INTERVAL_MS = 2000;

  function autoCheckRememberMe() {
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => {
      const parentText = cb.closest('label')?.textContent || cb.parentElement?.textContent || '';
      if (
        parentText.includes('七天') ||
        parentText.includes('保持') ||
        cb.name?.includes('remember') ||
        cb.id?.includes('remember')
      ) {
        if (!cb.checked) cb.checked = true;
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoCheckRememberMe);
  } else {
    autoCheckRememberMe();
  }

  // ==================== 登录图形验证码自动输入 (rucaptcha) ====================
  // 针对 https://javdb.com/login 的 5位字母图形验证码 /rucaptcha/ 自动OCR填入
  // 使用 Tesseract.js CDN 懒加载，canvas 预处理（放大2倍+灰度二值化），失败可手动重试
  function getTesseractGlobal() {
    try { if (typeof Tesseract !== "undefined" && Tesseract) return Tesseract; } catch (e) {}
    try { if (typeof self !== "undefined" && self.Tesseract) return self.Tesseract; } catch (e) {}
    try { if (typeof window !== "undefined" && window.Tesseract) return window.Tesseract; } catch (e) {}
    try { if (typeof globalThis !== "undefined" && globalThis.Tesseract) return globalThis.Tesseract; } catch (e) {}
    try { if (typeof unsafeWindow !== "undefined" && unsafeWindow.Tesseract) return unsafeWindow.Tesseract; } catch (e) {}
    return null;
  }
  let tesseractLoading = null;
  function loadTesseractViaGM(url) {
    return new Promise((resolve, reject) => {
      try {
        const gm = (typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : (typeof GM !== "undefined" && GM.xmlHttpRequest ? GM.xmlHttpRequest : null));
        if (!gm) return reject(new Error("GM_xmlhttpRequest not available"));
        gm({
          method: "GET",
          url: url,
          onload: res => {
            try {
              if (res.status >= 200 && res.status < 300) {
                (function(){ eval(res.responseText); })();
                const T = getTesseractGlobal();
                if (T) resolve(T); else reject(new Error("Tesseract not found after GM eval"));
              } else reject(new Error("GM fetch status " + res.status));
            } catch (e) { reject(e); }
          },
          onerror: () => reject(new Error("GM fetch failed")),
          ontimeout: () => reject(new Error("GM fetch timeout"))
        });
      } catch (e) { reject(e); }
    });
  }
  function loadTesseractViaScriptTag(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload = () => {
        const T = getTesseractGlobal();
        if (T) resolve(T); else reject(new Error("Tesseract not found after load"));
      };
      s.onerror = () => reject(new Error("Tesseract CDN load failed: " + url));
      (document.head || document.documentElement).appendChild(s);
    });
  }
  function ensureTesseract() {
    const cached = getTesseractGlobal();
    if (cached) return Promise.resolve(cached);
    if (tesseractLoading) return tesseractLoading;
    const urls = [
      "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js",
      "https://unpkg.com/tesseract.js@5.0.4/dist/tesseract.min.js"
    ];
    tesseractLoading = (async () => {
      let lastErr = null;
      for (const u of urls) {
        try { return await loadTesseractViaGM(u); } catch (e) { lastErr = e; console.warn("[JavDB captcha] GM load failed " + u, e); }
        try { return await loadTesseractViaScriptTag(u); } catch (e) { lastErr = e; console.warn("[JavDB captcha] tag load failed " + u, e); }
      }
      throw lastErr || new Error("Tesseract load failed");
    })();
    tesseractLoading.catch(() => { tesseractLoading = null; });
    return tesseractLoading;
  }

  function preprocessImageToCanvas(img, opts = {}) {
      const scale = opts.scale || 3;
      const threshold = opts.threshold != null ? opts.threshold : 155;
      const doBinarize = opts.binarize !== false;
      const pad = opts.pad != null ? opts.pad : 10; // 内边距避免边缘字符被裁切(like ayruh 的 a)
      const canvas = document.createElement("canvas");
      const w = img.naturalWidth || 200;
      const h = img.naturalHeight || 70;
      canvas.width = Math.round(w * scale + pad * 2);
      canvas.height = Math.round(h * scale + pad * 2);
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, pad, pad, Math.round(w * scale), Math.round(h * scale));
      try {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imageData.data;
        let min = 255, max = 0;
        const grays = new Uint8Array(canvas.width * canvas.height);
        for (let i = 0, j = 0; i < d.length; i += 4, j++) {
          const g = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
          grays[j] = g;
          if (g < min) min = g;
          if (g > max) max = g;
        }
        const range = max - min || 1;
        for (let i = 0, j = 0; i < d.length; i += 4, j++) {
          let g = (grays[j] - min) * 255 / range;
          if (doBinarize) {
            const bw = g > threshold ? 255 : 0;
            d[i] = d[i+1] = d[i+2] = bw;
          } else {
            g = Math.max(0, Math.min(255, g));
            d[i] = d[i+1] = d[i+2] = g;
          }
          d[i+3] = 255;
        }
        ctx.putImageData(imageData, 0, 0);
      } catch (e) {
        console.warn("[JavDB captcha] canvas preprocess failed", e);
      }
      return canvas;
    }

  async function recognizeAndFillCaptcha(img, input, statusEl) {
      if (!img || !input) return;
      if (statusEl) { statusEl.textContent = "⏳ 正在识别验证码..."; statusEl.style.color = "#666"; }
      try {
        const T = await ensureTesseract();
        const variants = [
          { scale: 3, threshold: 150, binarize: true, pad: 10 },
          { scale: 3, threshold: 135, binarize: true, pad: 10 },
          { scale: 3, threshold: 115, binarize: true, pad: 10 },
          { scale: 3, threshold: 128, binarize: true, pad: 10 },
          { scale: 3, threshold: 175, binarize: true, pad: 10 },
          { scale: 2.8, threshold: 155, binarize: true, pad: 12 },
          { scale: 3.2, threshold: 145, binarize: true, pad: 10 },
          { scale: 3, binarize: false, pad: 10 }
        ];
        let best = { clean: "", conf: 0, raw: "" };
        for (const v of variants) {
          try {
            const canvas = preprocessImageToCanvas(img, v);
            const result = await T.recognize(canvas, "eng", { tessedit_char_whitelist: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", tessedit_pageseg_mode: "7" });
            const raw = (result && result.data && result.data.text) ? result.data.text : "";
            const conf = (result && result.data && typeof result.data.confidence === "number") ? result.data.confidence : 0;
            let clean = raw.replace(/[^a-zA-Z]/g, "").trim().slice(0, 5).toLowerCase();
            if (clean.length > best.clean.length || (clean.length === best.clean.length && conf > best.conf)) best = { clean, conf, raw };
            if (best.clean.length >= 5 && best.conf > 65) break;
            if (best.clean.length >= 4 && best.conf > 75) break;
          } catch (e) { console.warn("[JavDB captcha] variant failed", v, e); }
        }
        const clean = best.clean; const conf = best.conf;
        const shouldAutoFill = clean && clean.length >= 4 && conf >= 30;
        const uncertainFill = clean && clean.length === 3 && conf >= 50;
        if (statusEl) {
          if (shouldAutoFill || uncertainFill) { statusEl.textContent = "✅ 识别: " + clean + " (置信度 " + Math.round(conf) + "%) 已自动填入，提交前请核对"; statusEl.style.color = "#0a7a0a"; }
          else if (clean && clean.length >= 4) { statusEl.textContent = "⚠️ 识别: \"" + clean + "\" (置信度 " + Math.round(conf) + "% 偏低，未自动填入，请手动输入或点\"重新识别\" / 点图刷新)"; statusEl.style.color = "#b77900"; }
          else if (clean) { statusEl.textContent = "⚠️ 识别: \"" + clean + "\" 不确定，请手动核对或点图片重试 (置信度 " + Math.round(conf) + "%)"; statusEl.style.color = "#b77900"; }
          else { statusEl.textContent = "⚠️ 未能识别，请手动输入或点击图片刷新后重试"; statusEl.style.color = "#b77900"; }
        }
        if (shouldAutoFill || uncertainFill) { input.value = clean; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); try { input.focus(); } catch (e) {} }
        return clean;
      } catch (e) {
        console.error("[JavDB captcha] recognize failed", e);
        if (statusEl) { statusEl.textContent = "❌ 识别失败: " + (e.message || e) + "，请手动输入或点图片重试"; statusEl.style.color = "#d00"; }
      }
    }

  function setupRuCaptchaAutoInput() {
    const img = document.querySelector('img.rucaptcha-image');
    const input = document.querySelector('input.rucaptcha-input, input[name="_rucaptcha"]');
    if (!img || !input) return;
    if (img.dataset.captchaAutoBound === '1') return;
    img.dataset.captchaAutoBound = '1';

    let statusEl = document.getElementById('captcha-auto-status');
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.id = 'captcha-auto-status';
      statusEl.style.cssText = 'font-size:12px;margin-top:6px;line-height:1.5;color:#666;word-break:break-all;';
      const p = input.closest('p.control') || input.parentElement;
      if (p && p.parentElement) {
        p.parentElement.insertBefore(statusEl, p.nextSibling);
      } else {
        input.insertAdjacentElement('afterend', statusEl);
      }
      const tip = document.createElement('div');
      tip.textContent = '提示: 自动识别仅作辅助，提交前请核对；点击图片可刷新验证码';
      tip.style.cssText = 'font-size:11px;color:#999;margin-top:2px;';
      statusEl.insertAdjacentElement('afterend', tip);
    }

    let retryBtn = document.getElementById('captcha-retry-btn');
    if (!retryBtn) {
      retryBtn = document.createElement('button');
      retryBtn.id = 'captcha-retry-btn';
      retryBtn.type = 'button';
      retryBtn.textContent = '🔄 重新识别';
      retryBtn.style.cssText = 'margin-top:6px;font-size:12px;padding:3px 10px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer;';
      retryBtn.addEventListener('click', () => recognizeAndFillCaptcha(img, input, statusEl));
      statusEl.insertAdjacentElement('afterend', retryBtn);
    }

    statusEl.textContent = '🤖 检测到图形验证码，准备自动识别...';

    const doOCR = () => setTimeout(() => recognizeAndFillCaptcha(img, input, statusEl), 450);

    if (img.complete && img.naturalWidth > 0) {
      doOCR();
    } else {
      img.addEventListener('load', doOCR, { once: true });
    }

    img.style.cursor = 'pointer';
    img.title = '点击刷新验证码';

    img.addEventListener('click', () => {
      statusEl.textContent = '🔄 已刷新验证码，重新识别中...';
      statusEl.style.color = '#666';
      // 图片 src 会被 onclick 换成 /rucaptcha/?t=Date.now()，监听 load
      const onLoad = () => {
        img.removeEventListener('load', onLoad);
        setTimeout(() => recognizeAndFillCaptcha(img, input, statusEl), 500);
      };
      img.addEventListener('load', onLoad);
      // 兜底：若 load 未触发
      setTimeout(() => {
        if (statusEl.textContent.includes('重新识别中')) {
          recognizeAndFillCaptcha(img, input, statusEl);
        }
      }, 1500);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupRuCaptchaAutoInput);
  } else {
    setupRuCaptchaAutoInput();
  }

  // 监听 DOM 变化（SPA/刷新后重建）
  try {
    new MutationObserver(() => {
      const img = document.querySelector('img.rucaptcha-image');
      if (img && img.dataset.captchaAutoBound !== '1') {
        setupRuCaptchaAutoInput();
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  // ==================== end rucaptcha ====================


  // 🔒 独立时间戳分布式并发排队锁
  const QUEUE_PREFIX = 'javdb_q_';
  const LOCK_KEY = 'javdb_scraper_active_tab';
  const LOCK_TIME_KEY = LOCK_KEY + '_time';
  const LOCK_EXPIRY_MS = 20000; // 超过这个时间视为锁失效（20s）
  const TAB_ID = Math.random().toString(36).substring(2, 9);
  const MY_Q_KEY = QUEUE_PREFIX + TAB_ID;

  function registerInQueue() {
    try {
      if (!localStorage.getItem(MY_Q_KEY)) {
        localStorage.setItem(MY_Q_KEY, Date.now().toString());
      }
      localStorage.setItem(MY_Q_KEY + '_time', Date.now().toString());
    } catch (e) {
      // ignore storage errors
    }
  }

  function removeFromQueue() {
    try {
      localStorage.removeItem(MY_Q_KEY);
      localStorage.removeItem(MY_Q_KEY + '_time');
      if (localStorage.getItem(LOCK_KEY) === TAB_ID) {
        localStorage.removeItem(LOCK_KEY);
        localStorage.removeItem(LOCK_TIME_KEY);
      }
    } catch (e) {}
  }

  function isLockExpired() {
    try {
      const t = parseInt(localStorage.getItem(LOCK_TIME_KEY) || '0', 10);
      if (!t) return true;
      return (Date.now() - t) > LOCK_EXPIRY_MS;
    } catch (e) {
      return true;
    }
  }

  function getQueuePosition() {
    registerInQueue();
    const now = Date.now();
    const entries = [];

    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(QUEUE_PREFIX)) keys.push(key);
    }

    for (const key of keys) {
      if (key.endsWith('_time')) continue;
      const id = key.replace(QUEUE_PREFIX, '');
      const lastTime = parseInt(localStorage.getItem(key + '_time') || '0', 10);

      if (now - lastTime < 12000) {
        const regTime = parseInt(localStorage.getItem(key) || '0', 10);
        entries.push({ id, regTime });
      } else {
        // 清理过期队列项
        try {
          localStorage.removeItem(key);
          localStorage.removeItem(key + '_time');
        } catch (e) {}
      }
    }

    entries.sort((a, b) => a.regTime - b.regTime);
    const myIdx = entries.findIndex(e => e.id === TAB_ID);
    if (myIdx === -1) return { pos: 1, total: entries.length + 1 };
    return { pos: myIdx + 1, total: entries.length };
  }

  async function acquireLock() {
    const statusEl = document.getElementById('scraper-status');
    const logEl = document.getElementById('scraper-log');

    while (true) {
      if (shouldStop) {
        removeFromQueue();
        return false;
      }

      // 如果已有锁但超过过期时间，则回收它
      const currentLock = localStorage.getItem(LOCK_KEY);
      if (currentLock && currentLock !== TAB_ID && isLockExpired()) {
        try {
          localStorage.removeItem(LOCK_KEY);
          localStorage.removeItem(LOCK_TIME_KEY);
          if (logEl) {
            logEl.innerHTML += `🔧 发现过期锁（${escapeHtml(currentLock)}），已回收。<br>`;
            logEl.scrollTop = logEl.scrollHeight;
          }
        } catch (e) {}
      }

      const { pos } = getQueuePosition();

      if (pos === 1) {
        try {
          localStorage.setItem(LOCK_KEY, TAB_ID);
          localStorage.setItem(LOCK_TIME_KEY, Date.now().toString());
        } catch (e) {}

        await sleep(100);

        if (localStorage.getItem(LOCK_KEY) === TAB_ID) return true;
      }

      const aheadCount = pos - 1;
      if (statusEl) statusEl.innerText = `⏳ 排队中 (前面还有 ${aheadCount} 个任务)...`;
      document.title = `⏳[排队第${pos}位] ${origTitle}`;

      if (logEl && !logEl.innerText.includes('排队等待')) {
        logEl.innerHTML += `⏳ 前方有 ${aheadCount} 个任务正在抓取，排队等待中...<br>`;
        logEl.scrollTop = logEl.scrollHeight;
      }

      await sleep(1500);
    }
  }

  function updateLockHeartbeat() {
    registerInQueue();
    try {
      if (localStorage.getItem(LOCK_KEY) === TAB_ID) {
        localStorage.setItem(LOCK_TIME_KEY, Date.now().toString());
      }
    } catch (e) {}
  }

  window.addEventListener('beforeunload', (e) => {
    if (isRunning) {
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
  let domainAutoTimer = null;

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
      const ls = localStorage.getItem(key);
      if (ls !== null) return ls;
    } catch (e) {}
    return defVal;
  }
  function gmSetValueCompat(key, val) {
    try { if (typeof GM_setValue !== 'undefined') GM_setValue(key, val); } catch (e) {}
    try { localStorage.setItem(key, String(val)); } catch (e) {}
  }

  function gmGet(url) {
    return new Promise((resolve) => {
      const request = (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) ||
        (typeof GM !== 'undefined' && GM.xmlHttpRequest) || null;
      if (!request) {
        resolve(null);
        return;
      }
      try {
        request({
          method: 'GET',
          url: url,
          timeout: 8000,
          onload: function (response) { resolve(response); },
          onerror: function () { resolve(null); },
          ontimeout: function () { resolve(null); }
        });
      } catch (e) {
        resolve(null);
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
    list.sort((a, b) => b.num - a.num);
    return list[0].num > 0 ? list[0].domain : null;
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
  async function fetchLatestDomainFromApp() {
    // 官方 App 关于页常见域名：app.javdb575.com / app.javdb575.com
    const urls = ['https://app.javdb575.com/', 'https://app.javdb575.com/', 'https://app.javdb.com/'];
    for (const u of urls) {
      const r = await gmGet(u);
      if (r && r.status === 200 && r.responseText) {
        const d = parseMaxJavdbDomain(r.responseText);
        if (d) return d;
      }
    }
    return null;
  }
  async function fetchLatestDomainMultiSource() {
    // 按优先级：javdb.com > TG > App
    const sources = [
      { name: 'javdb.com', fn: fetchLatestDomainFromJavdb },
      { name: 'telegram', fn: fetchLatestDomainFromTG },
      { name: 'app', fn: fetchLatestDomainFromApp },
    ];
    for (const s of sources) {
      try {
        const d = await s.fn();
        if (d) return { domain: d, source: s.name };
      } catch (e) {}
    }
    return null;
  }

  function updateDomainStatusUI() {
    const el = document.getElementById('scraper-domain-status');
    if (!el) return;
    const cached = getCachedDomain();
    if (cached) {
      const ageH = ((Date.now() - cached.time) / 3600000).toFixed(1);
      el.innerHTML = `最新域名: <b style="color:#00d26a;">${escapeHtml(cached.domain)}</b> <span style="color:#888;">(${escapeHtml(cached.source||'缓存')} · ${ageH}h前)</span>`;
    } else {
      el.innerHTML = `最新域名: <span style="color:#888;">未缓存（将按 574→569 兜底）</span>`;
    }
  }

  async function refreshLatestDomain(manual = false) {
    const statusEl = document.getElementById('scraper-status');
    const logEl = document.getElementById('scraper-log');
    if (manual && statusEl) { statusEl.innerText = '状态: 正在同步最新域名...'; statusEl.style.color = '#ffcc00'; }
    if (logEl) { logEl.innerHTML += `[${escapeHtml(new Date().toLocaleTimeString())}] 🔄 同步最新备用网址中...<br>`; logEl.scrollTop = logEl.scrollHeight; }
    const res = await fetchLatestDomainMultiSource();
    if (res && res.domain) {
      setCachedDomain(res.domain, res.source);
      updateDomainStatusUI();
      if (logEl) { logEl.innerHTML += `[${escapeHtml(new Date().toLocaleTimeString())}] ✅ 已更新: <b>${escapeHtml(res.domain)}</b>（来源 ${escapeHtml(res.source)}）<br>`; logEl.scrollTop = logEl.scrollHeight; }
      if (statusEl && manual) { statusEl.innerText = `✅ 已同步: ${res.domain}`; statusEl.style.color = '#00d26a'; }
      return res.domain;
    } else {
      updateDomainStatusUI();
      if (logEl) { logEl.innerHTML += `[${escapeHtml(new Date().toLocaleTimeString())}] ⚠️ 同步失败，使用本地缓存/兜底列表<br>`; logEl.scrollTop = logEl.scrollHeight; }
      if (statusEl && manual) { statusEl.innerText = '⚠️ 同步失败，已保留缓存'; statusEl.style.color = '#ff6b6b'; }
      return null;
    }
  }

  function scheduleDomainAutoUpdate() {
    if (domainAutoTimer) clearInterval(domainAutoTimer);
    // 启动时：若超过 6h 或无缓存则立即同步，否则仅更新 UI
    const cached = getCachedDomain();
    if (!cached || (Date.now() - cached.time) > DOMAIN_AUTO_UPDATE_INTERVAL_MS) {
      refreshLatestDomain(false);
    } else {
      updateDomainStatusUI();
    }
    domainAutoTimer = setInterval(() => {
      // 页面可见时才请求，避免后台空转
      if (document.visibilityState === 'visible') refreshLatestDomain(false);
      else updateDomainStatusUI();
    }, DOMAIN_AUTO_UPDATE_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
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
    const statusEl = document.getElementById('scraper-status');
    const logEl = document.getElementById('scraper-log');

    if (logEl) {
      logEl.innerHTML += `<br><span style="color:#ffcc00; font-weight:bold;">🚨 [${escapeHtml(reason)}] 触发封禁，立即自动切域名...</span><br>`;
      logEl.scrollTop = logEl.scrollHeight;
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

    if (logEl) {
      logEl.innerHTML += `✅ 锁定新域名: <b>${escapeHtml(targetDomain)}</b> <span style="color:#888;">(${escapeHtml(source)})</span>，3秒后自动跳转复活...<br>`;
      logEl.scrollTop = logEl.scrollHeight;
    }
    if (statusEl) {
      statusEl.innerText = `🔄 3秒后跳转至: ${targetDomain}`;
    }

    setTimeout(() => {
      try {
        const url = new URL(window.location.href);
        url.hostname = targetDomain;
        window.location.href = url.toString();
      } catch (e) {
        window.location.href = `${window.location.protocol}//${targetDomain}${window.location.pathname}${window.location.search}${window.location.hash}`;
      }
    }, 2500);
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
      <span>🐢 JavDB 磁链提取器 v5.12.5 (自动更新域名版)</span>
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
          <input id="scraper-curr-start" type="number" value="0" min="0" step="1" placeholder="0" style="width: 48px; background: #333; color: #fff; border: 1px solid #555; padding: 2px 4px; border-radius: 3px;">
          <span>~</span>
          <input id="scraper-curr-end" type="number" value="20" min="0" step="1" placeholder="20" style="width: 48px; background: #333; color: #fff; border: 1px solid #555; padding: 2px 4px; border-radius: 3px;">
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
        <input id="scraper-prefix" type="text" value="" style="width: 110px; background: #333; color: #fff; border: 1px solid #555; padding: 2px 5px; border-radius: 3px;">
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
          <input id="scraper-start-page" type="number" value="1" min="1" style="width: 48px; background: #333; color: #fff; border: 1px solid #555; padding: 2px 4px; border-radius: 3px;">
          <span>~</span>
          <input id="scraper-end-page" type="number" value="1" min="1" style="width: 48px; background: #333; color: #fff; border: 1px solid #555; padding: 2px 4px; border-radius: 3px;">
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
      <div id="scraper-domain-status" style="color:#aaa; word-break:break-all;">最新域名: 检测中...</div>
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

  function log(msg) {
    const time = new Date().toLocaleTimeString();
    logEl.innerHTML += `[${escapeHtml(time)}] ${escapeHtml(msg)}<br>`;
    logEl.scrollTop = logEl.scrollHeight;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
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
        if (res.status !== 429) return res;
        lastStatus = 429;
      } catch (e) {
        lastStatus = -1;
        if (e && e.name === 'AbortError') log('timeout ' + label);
      }
      if (attempt < 3) {
        const delay = Math.min(3000 * Math.pow(2, attempt), 30000) + getRandomDelay(0, 1000);
        log(`⚠️ ${label}${lastStatus === 429 ? '触发限流' : '网络错误'}，约 ${Math.round(delay / 1000)} 秒后重试 (${attempt + 1}/3)...`);
        await sleep(delay);
      }
    }
    log(`⚠️ ${label}重试 3 次仍失败，已跳过`);
    return null;
  }

  function parseSizeToMB(sizeStr) {
    if (!sizeStr) return Infinity;
    const match = sizeStr.toUpperCase().match(/([\d\.]+)\s*(GB|MB|KB)/);
    if (!match) return Infinity;
    const num = parseFloat(match[1]);
    const unit = match[2];
    if (unit === 'GB') return num * 1024;
    if (unit === 'MB') return num;
    if (unit === 'KB') return num / 1024;
    return Infinity;
  }

  function parseDurationMin(doc) {
    const panel = doc.querySelector('.movie-panel-info') || doc.body;
    const text = (panel.textContent || '').replace(/\u00A0/g, ' ');
    const labels = '(?:時長|时长|長度|长度|片長|片长|時間|时间|Length|Duration|Time)';
    const hm = text.match(new RegExp(labels + '[\\s\\S]{0,40}?(\\d+)\\s*(?:小時|小时|時|时)\\s*(?:(\\d+)\\s*(?:分鍾|分鐘|分钟|分))?', 'i'));
    if (hm) return parseInt(hm[1], 10) * 60 + (hm[2] ? parseInt(hm[2], 10) : 0);
    const m = text.match(new RegExp(labels + '[\\s\\S]{0,40}?(\\d+)\\s*(?:分鍾|分鐘|分钟|分)', 'i'));
    if (m) return parseInt(m[1], 10);
    const bareHm = text.match(/(\d+)\s*(?:小時|小时|時|时)\s*(?:(\d+)\s*(?:分鍾|分鐘|分钟|分))?/);
    if (bareHm) return parseInt(bareHm[1], 10) * 60 + (bareHm[2] ? parseInt(bareHm[2], 10) : 0);
    const bareM = text.match(/(\d+)\s*(?:分鍾|分鐘|分钟|分)/);
    if (bareM) return parseInt(bareM[1], 10);
    return null;
  }

  function hasVrCategory(doc) {
    const panel = doc.querySelector('.movie-panel-info');
    const blocks = panel ? panel.querySelectorAll('.panel-block') : doc.querySelectorAll('.panel-block');

    for (const block of blocks) {
      const labelEl = block.querySelector('strong');
      const label = (labelEl ? labelEl.textContent : '').replace(/[:：]\s*$/, '').trim().toLowerCase();
      if (!/^(?:類別|类别|分類|分类|categories?|genres?)$/.test(label)) continue;

      const categories = Array.from(block.querySelectorAll('.value a, a'));
      const hasVr = categories.some(el => /(?:^|[^a-z0-9])vr(?:$|[^a-z0-9])/i.test((el.textContent || '').trim()));
      if (hasVr) return true;
    }

    return false;
  }

  // resolve relative hrefs to absolute
  function toAbsoluteUrl(href) {
    try {
      return new URL(href, window.location.origin).toString();
    } catch (e) {
      return href;
    }
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

      const parser = new DOMParser();
      const detailDoc = parser.parseFromString(detailHtml, 'text/html');

      if (hasVrCategory(detailDoc)) {
        log(`[-] ${movieCode} 類別含 VR，跳过`);
        return null;
      }

      if (genreTarget) {
        const genreLower = genreTarget.toLowerCase();
        const tagElements = detailDoc.querySelectorAll('a[href*="/tags/"], a[href*="/genres/"], .tags .button, .meta-value a, .panel-block a');
        let matched = false;
        tagElements.forEach(el => {
          const tagText = (el.textContent || '').trim().toLowerCase();
          if (tagText === genreLower || tagText.includes(genreLower)) matched = true;
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
        const linkTag = mItem.querySelector('a[href^="magnet:?"]');
        if (!linkTag) return;

        const sizeTag = mItem.querySelector('.meta, .size') || mItem;
        const sizeText = sizeTag.textContent.trim();
        const fullText = (mItem.textContent || '').toUpperCase();

        const isSubbed = fullText.includes('字幕') || fullText.includes('-C.') || fullText.includes('-C-') || fullText.includes('中文');

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
        const withinLimit = magnetsData.filter(m => m.sizeMB === Infinity || m.sizeMB <= 10240);
        if (withinLimit.length === 0) {
          log(`[-] ${movieCode} 磁链全部超过 10GB，跳过`);
          return null;
        }
        const subbedList = withinLimit.filter(m => m.isSubbed);
        let targetList = subbedList.length > 0 ? subbedList : withinLimit;
        targetList.sort((a, b) => a.sizeMB - b.sizeMB);
        const chosen = targetList[0];

        if (subbedList.length > 0) {
          log(`[✓] ${movieCode} | 字幕版: ${chosen.sizeText}`);
        } else {
          log(`[✓] ${movieCode} | 无字幕: ${chosen.sizeText}`);
        }
        return chosen.magnet;
      }
    } catch (err) {
      log(`[!] ${movieCode} 详情页读取失败`);
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
    isRunning = true; shouldStop = false;
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
      if (!lastItemStartedAt) {
        lastItemStartedAt = Date.now();
        return;
      }

      const elapsed = Date.now() - lastItemStartedAt;
      const waitMs = ITEM_INTERVAL_MS - elapsed;
      if (waitMs > 0) {
        log(`⏳ 等待 ${(waitMs / 1000).toFixed(1)} 秒后处理下一个...`);
        await sleep(waitMs);
      }
      lastItemStartedAt = Date.now();
    }


    try {
      if (currentMode === 'current') {
        const rawStart = parseInt(document.getElementById('scraper-curr-start').value, 10);
        const rawEnd = parseInt(document.getElementById('scraper-curr-end').value, 10);
        const rangeStart = Number.isInteger(rawStart) && rawStart >= 0 ? rawStart : -1;
        const rangeEnd = Number.isInteger(rawEnd) && rawEnd >= 0 ? rawEnd : -1;

        if (rangeStart < 0 || rangeEnd < 0 || rangeStart >= rangeEnd) {
          alert('请输入有效的作品范围（起始小于结束，且不小于0）！');
          btnStart.disabled = false; btnStop.disabled = true; isRunning = false;
          removeFromQueue(); document.title = origTitle; return;
        }

        const rawCurrPage = parseInt(document.getElementById('scraper-curr-page-start')?.value, 10);
        const currPageStart = Number.isInteger(rawCurrPage) && rawCurrPage >= 1 ? rawCurrPage : 1;

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
            } else {
              const searchDoc = parser.parseFromString(searchHtml, 'text/html');
              const movieNodeList = searchDoc.querySelectorAll('.movie-list .item');
              const allItems = movieNodeList ? Array.from(movieNodeList) : [];

              if (allItems.length === 0) {
                log('[-] 当前页面没有可抓取的作品');
              } else {
                const items = allItems.slice(rangeStart, rangeEnd);
                log('第 ' + currPageStart + ' 页共 ' + allItems.length + ' 个作品，本次抓取范围 ' + rangeStart + '-' + (rangeStart + items.length) + '，共 ' + items.length + ' 个');

                for (let idx = 0; idx < items.length; idx++) {
                  if (shouldStop) break;
                  await waitForNextItemSlot();
                  const item = items[idx];
                  const aTag = item.querySelector('a');
                  if (!aTag) continue;

                  const movieHref = aTag.getAttribute('href');
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
                  fetchedCount++;
                }
              }
            }
          }
        } catch (e) {
          log('[!] 当前页面提取失败');
        }

        const pageTitle = sanitizeFileName(origTitle || 'JavDB_列表');
        if (results.length > 0) downloadTXT(results, sanitizeFileName(pageTitle + '_当前页面_第' + currPageStart + '页_' + rangeStart + '-' + rangeEnd));

      } else if (currentMode === 'code') {
        const rawPrefix = document.getElementById('scraper-prefix').value.trim().toUpperCase();
        const startNum = parseInt(document.getElementById('scraper-start').value, 10);
        const endNum = parseInt(document.getElementById('scraper-end').value, 10);

        if (!rawPrefix) { alert('请输入番号前缀！'); btnStart.disabled = false; btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return; }
        if (isNaN(startNum) || isNaN(endNum) || startNum > endNum) { alert('请检查正确的数字范围！'); btnStart.disabled = false; btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return; }

        const totalCount = endNum - startNum + 1;
        const purePrefix = rawPrefix.replace(/^\d+/, '');

        let domainJumped = false;
        for (let i = startNum; i <= endNum; i++) {
          if (shouldStop || domainJumped) break;
          await waitForNextItemSlot();

          const rawNumStr = String(i);
          const pad3Str = rawNumStr.padStart(3, '0');

          const searchTerms = [
            `${rawPrefix}-${pad3Str}`,
            `${rawPrefix}-${rawNumStr}`,
            `${rawPrefix}${pad3Str}`
          ];
          if (purePrefix && purePrefix !== rawPrefix) {
            searchTerms.push(`${purePrefix}-${pad3Str}`);
            searchTerms.push(`${purePrefix}-${rawNumStr}`);
          }

          const currentIdx = i - startNum + 1;
          progressEl.innerText = `进度: ${currentIdx} / ${totalCount} (${rawPrefix}-${pad3Str})`;
          document.title = `⚡[抓取 ${currentIdx}/${totalCount}] ${origTitle}`;
          log(`检索中: ${rawPrefix}-${pad3Str}...`);

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

              const searchDoc = parser.parseFromString(searchHtml, 'text/html');
              const movieItems = searchDoc.querySelectorAll('.movie-list .item a');

              if (movieItems && movieItems.length > 0) {
                for (const item of movieItems) {
                  const text = ((item.textContent || '') + ' ' + (item.getAttribute('title') || '')).toUpperCase();
                  if (text.includes(term.toUpperCase()) || text.includes(`${rawPrefix}-${pad3Str}`)) {
                    targetMovieLink = item.getAttribute('href');
                    break;
                  }
                }
              }

              if (targetMovieLink ) break;
            } catch (e) {}
          }

          if (shouldStop || domainJumped) break;


          if (!targetMovieLink) {
            log(`[-] ${rawPrefix}-${pad3Str} 不存在/未录入`);
          } else {
            const absLink = toAbsoluteUrl(targetMovieLink);
            const magnet = await processDetailPage(absLink, `${rawPrefix}-${pad3Str}`);

            if (magnet === 'IP_BANNED') {
              await triggerDomainJump('抓取详情遭遇域名拦截');
              domainJumped = true;
              break;
            }

            if (magnet) results.push(magnet);
            fetchedCount++;
          }
        }
        if (results.length > 0) downloadTXT(results, sanitizeFileName(`${rawPrefix}_${startNum}-${endNum}`));

      } else {
        const actorName = document.getElementById('scraper-actor').value.trim();
        const genreName = document.getElementById('scraper-genre').value.trim();
        let inputStartPage = parseInt(document.getElementById('scraper-start-page').value, 10);
        let inputEndPage = parseInt(document.getElementById('scraper-end-page').value, 10);
        const orderMode = document.getElementById('scraper-order').value;

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
                  new URL(src, window.location.origin).searchParams.forEach((v, k) => {
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
              if (isBannedPage(tagRes.status, tagHtml)) continue;
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
              if (hit) baseCategoryUrl = inheritCParams(new URL(hit.getAttribute('href'), window.location.origin), idxUrl, window.location.href).toString();
            }
            if (!baseCategoryUrl && !shouldStop) {
              log('索引页未命中，尝试通过搜索结果详情页反查标签链接...');
              const sRes = await fetchWithRetry(`/search?q=${encodeURIComponent(genreName)}&f=all`, '搜索 ');
              if (sRes) {
                const sHtml = await sRes.text();
                if (!isBannedPage(sRes.status, sHtml)) {
                  const sDoc = parser.parseFromString(sHtml, 'text/html');
                  const candidates = Array.from(sDoc.querySelectorAll('.movie-list .item a[href^="/v/"]')).slice(0, 5);
                  for (const a of candidates) {
                    if (baseCategoryUrl || shouldStop) break;
                    const dRes = await fetchWithRetry(a.getAttribute('href'), '详情反查 ');
                    if (!dRes) continue;
                    const dHtml = await dRes.text();
                    if (isBannedPage(dRes.status, dHtml)) continue;
                    const dDoc = parser.parseFromString(dHtml, 'text/html');
                    const { hit } = matchTagLinks(dDoc);
                    if (hit) {
                      baseCategoryUrl = inheritCParams(new URL(hit.getAttribute('href'), window.location.origin), window.location.href).toString();
                      break;
                    }
                  }
                }
              }
            }
            if (baseCategoryUrl) log(`标签「${genreName}」解析为: ${baseCategoryUrl}`);
          }
          if (!baseCategoryUrl) {
            if (genreName) {
              log(`❌ 未能解析标签「${genreName}」，已中止抓取（避免抓错列表）。请确认已登录，或直接打开该标签页后再点开始`);
              statusEl.innerText = '状态: 标签解析失败';
              btnStart.disabled = false; btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle;
              return;
            }
            baseCategoryUrl = window.location.href;
          }
          log(`抓取分类列表：${baseCategoryUrl}`);
        }
        if (isNaN(inputStartPage) || isNaN(inputEndPage)) { alert('请检查正确的页码范围！'); btnStart.disabled = false; btnStop.disabled = true; isRunning = false; removeFromQueue(); document.title = origTitle; return; }

        const minPage = Math.min(inputStartPage, inputEndPage);
        const maxPage = Math.max(inputStartPage, inputEndPage);

        const pagesToVisit = [];
        if (orderMode === 'new') {
          for (let p = minPage; p <= maxPage; p++) pagesToVisit.push(p);
        } else {
          for (let p = maxPage; p >= minPage; p--) pagesToVisit.push(p);
        }

        let domainJumped = false;
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

            const searchDoc = parser.parseFromString(searchHtml, 'text/html');
            const movieNodeList = searchDoc.querySelectorAll('.movie-list .item');

            if (!movieNodeList || movieNodeList.length === 0) { log(`[-] 第 ${page} 页无作品，跳过`); continue; }

            let movieItems = Array.from(movieNodeList);
            if (orderMode === 'old') movieItems.reverse();

            for (let idx = 0; idx < movieItems.length; idx++) {
              if (shouldStop) break;
              await waitForNextItemSlot();
              const item = movieItems[idx];
              const aTag = item.querySelector('a');
              if (!aTag) continue;

              const movieHref = aTag.getAttribute('href');
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
              fetchedCount++;
            }
          } catch (e) { log(`[!] 第 ${page} 页抓取失败`); }
        }

        const orderLabel = orderMode === 'new' ? '新到旧' : '旧到新';
        const fileLabel = useCurrentList ? (genreName || sanitizeFileName(origTitle || 'JavDB_列表')) : (genreName ? `${actorName}_${genreName}` : actorName);
        if (results.length > 0) downloadTXT(results, sanitizeFileName(`${fileLabel}_第${minPage}-${maxPage}页_${orderLabel}`));
      }
    } finally {
      document.title = origTitle;
      isRunning = false;
      removeFromQueue();
    }

    statusEl.style.color = '';
    statusEl.innerText = shouldStop ? '状态: 已手动停止' : '状态: 完成！';
    btnStart.disabled = false; btnStop.disabled = true;
  }

  function downloadTXT(magnets, fileNameTag) {
    const valid = [...new Set(magnets.filter(m => m && m.startsWith('magnet:?')))];
    if (valid.length === 0) { log('⚠️ 未抓取到有效磁链'); return; }

    const blob = new Blob([valid.join('\n')], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `${fileNameTag}_迅雷专用.txt`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log(`📁 导出成功：${fileNameTag}_迅雷专用.txt`);
  }

  btnStart.onclick = () => { if (!isRunning) runScraper(); };
  btnStop.onclick = () => { if (isRunning) { shouldStop = true; statusEl.innerText = '状态: 正在停止...'; } };

  const handleEnterKey = (e) => { if (e.key === 'Enter' && !isRunning) { e.preventDefault(); runScraper(); } };
  document.querySelectorAll('#javdb-scraper-panel input').forEach(input => {
    input.addEventListener('keydown', handleEnterKey);
  });
})();

