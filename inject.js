// IG Research Overlay — MAIN-world passive tap.
//
// Runs at document_start in the MAIN world so it wraps fetch + XMLHttpRequest
// BEFORE Instagram's bundle captures its own references (M0 confirmed a
// post-load patch captures nothing). It only observes responses Instagram
// already makes; it never issues a request of its own. Extracted public media
// metrics are forwarded to the isolated content script via postMessage.
(() => {
  'use strict';
  const TAG = 'IGRO_TAP';
  const MAX_DEPTH = 30; // Instagram nests the media object ~17 levels deep in SSR JSON; 10 missed it entirely
  const ORIGIN = location.origin;

  function post(msg) {
    try { window.postMessage(Object.assign({ source: TAG }, msg), ORIGIN); } catch (_) {}
  }
  function emit(records) {
    if (records && records.length) post({ kind: 'media', records });
  }

  const num = v => (typeof v === 'number' && isFinite(v) ? v : null);

  // A media node = plain object with a shortcode plus a publish time OR any count.
  // Grid/reels listing nodes often omit taken_at but carry play/like counts, so
  // requiring taken_at would drop them and leave the cache empty for the grid.
  function isMediaNode(o) {
    return o
      && typeof o.code === 'string'
      && (typeof o.taken_at === 'number'
        || typeof o.like_count === 'number'
        || typeof o.comment_count === 'number'
        || typeof o.play_count === 'number'
        || typeof o.view_count === 'number'
        || typeof o.media_repost_count === 'number'
        || typeof o.reshare_count === 'number');
  }

  function normalize(o) {
    return {
      shortcode: o.code,
      pk: o.pk != null ? String(o.pk) : null,
      takenAt: num(o.taken_at),
      likes: num(o.like_count),
      comments: num(o.comment_count),
      reposts: num(o.media_repost_count),
      shares: num(o.reshare_count), // paper-plane (send) count; separate from reposts on IG web
      plays: num(o.play_count) != null ? num(o.play_count)
           : (num(o.view_count) != null ? num(o.view_count) : num(o.ig_play_count)),
      countsDisabled: typeof o.like_and_view_counts_disabled === 'boolean' ? o.like_and_view_counts_disabled : null,
      mediaType: num(o.media_type),
      productType: typeof o.product_type === 'string' ? o.product_type : null,
      author: (o.user && typeof o.user.username === 'string') ? o.user.username
            : (o.owner && typeof o.owner.username === 'string') ? o.owner.username : null
    };
  }

  const MAX_BYTES = 5000000; // skip pathologically large payloads before parsing
  const HAS_COUNT = /taken_at|like_count|comment_count|play_count|view_count|reshare_count|media_repost_count/;

  // Bounded deep-walk; collect every media node found in a parsed payload.
  function harvest(root) {
    const found = [];
    const stack = [[root, 0]];
    let budget = 50000; // node cap: guards against pathological payloads
    while (stack.length && budget-- > 0) {
      const [v, depth] = stack.pop();
      if (!v || typeof v !== 'object' || depth > MAX_DEPTH) continue;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) stack.push([v[i], depth + 1]);
        continue;
      }
      // emit EVERY media node (no per-code dedup): collab posts and grid listings
      // carry several nodes for one shortcode, some without counts — the content
      // script's cache merge lets non-null fields win instead of a count-less node
      // shadowing the real numbers.
      if (isMediaNode(v)) found.push(normalize(v));
      for (const k in v) {
        if (Object.prototype.hasOwnProperty.call(v, k)) {
          const val = v[k];
          if (val && typeof val === 'object') stack.push([val, depth + 1]);
          else if (k === 'response' && typeof val === 'string' && val.charCodeAt(0) === 123 && val.length < MAX_BYTES && HAS_COUNT.test(val)) {
            // Explore SSR holds the media list as a JSON string at __bbox.result.response. Only that
            // key: a caption string that looks like JSON must never become a record.
            try { stack.push([JSON.parse(val), depth + 1]); } catch (_) {}
          }
        }
      }
    }
    return found;
  }


  function tryData(data) {
    if (!data || typeof data !== 'object') return;
    try { emit(harvest(data)); } catch (_) {}
  }
  function tryText(txt) {
    // Any count field qualifies: "More posts" grids and reels listings carry counts without taken_at.
    if (typeof txt !== 'string' || txt.length < 20 || txt.length > MAX_BYTES || !HAS_COUNT.test(txt)) return;
    txt = txt.replace(/^for \(;;\);/, '');
    try { tryData(JSON.parse(txt)); return; } catch (_) {}
    // Streamed responses: one JSON document per line.
    for (const line of txt.split('\n')) {
      if (line.charCodeAt(0) !== 123) continue;
      try { tryData(JSON.parse(line)); } catch (_) {}
    }
  }

  // Only observe Instagram's own API traffic (guards against unrelated /graphql
  // requests the page might make to third parties).
  const REL_PATH = /\/graphql|\/api\/v1\//;
  function relevant(url) {
    if (!url || !REL_PATH.test(url)) return false;
    try {
      const h = new URL(url, location.href).hostname;
      return h === 'instagram.com' || h.endsWith('.instagram.com');
    } catch (_) { return false; }
  }

  // --- wrap fetch ---
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        p.then(res => {
          try {
            const url = (res && res.url) || (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url)) || '';
            if (relevant(url)) res.clone().text().then(tryText).catch(() => {});
          } catch (_) {}
        }, () => {});
      } catch (_) {}
      return p;
    };
  }

  // --- wrap XHR ---
  const XP = XMLHttpRequest.prototype;
  const origOpen = XP.open, origSend = XP.send;
  XP.open = function (method, url) { this.__igroUrl = url; return origOpen.apply(this, arguments); };
  XP.send = function () {
    try {
      this.addEventListener('load', function () {
        try {
          if (!relevant(this.__igroUrl)) return;
          const rt = this.responseType;
          if (rt === '' || rt === 'text') tryText(this.responseText);
          else if (rt === 'json') tryData(this.response);
        } catch (_) {}
      });
    } catch (_) {}
    return origSend.apply(this, arguments);
  };

  // --- initial-load embedded JSON (SSR; present on hard navigation only) ---
  // Data scripts can land after DOMContentLoaded (post-page prefetch), so rescan for new ones.
  const scannedScripts = new WeakSet();
  function scanEmbedded() {
    try {
      document.querySelectorAll('script[type="application/json"]').forEach(s => {
        if (scannedScripts.has(s) || !s.textContent) return; // empty now: retry on a later pass
        scannedScripts.add(s);
        tryText(s.textContent);
      });
    } catch (_) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanEmbedded, { once: true });
  } else {
    scanEmbedded();
  }
  window.addEventListener('load', scanEmbedded, { once: true });

  // --- feed video cards: read the media node from React's in-memory store ---
  // The home-feed timeline delivers video posts as Relay fragments with counts but
  // NO taken_at, in a streamed/normalized shape the network tap never parses into a
  // media node — so those cards get no record and no pill (photos come from the SSR
  // embedded JSON and are fine). The node still lives on the card's React fiber with
  // the SAME field names the network uses, so normalize() consumes it unchanged. This
  // is still passive+local: it only reads data IG already put in memory. plays/date
  // stay null (the feed simply doesn't carry them) → the pill shows them as "—".
  function fiberOf(el) {
    for (const k in el) if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) return el[k];
    return null;
  }
  // BFS the card's fiber for the richest object that looks like a media node.
  // Index-cursor queue (no shift) keeps the bounded walk linear.
  function findFeedMediaNode(root) {
    const f = fiberOf(root);
    if (!f) return null;
    const seen = new Set();
    let best = null;
    const scan = (v, depth) => {
      if (!v || typeof v !== 'object' || depth > 5 || seen.has(v)) return;
      seen.add(v);
      if (typeof v.code === 'string' && typeof v.like_count === 'number') {
        if (!best || Object.keys(v).length > Object.keys(best).length) best = v;
      }
      for (const k in v) { try { const val = v[k]; if (val && typeof val === 'object') scan(val, depth + 1); } catch (_) {} }
    };
    const q = [f];
    for (let head = 0, steps = 0; head < q.length && steps < 6000; head++, steps++) {
      const n = q[head];
      if (!n) continue;
      try { if (n.memoizedProps) scan(n.memoizedProps, 0); if (n.memoizedState) scan(n.memoizedState, 0); } catch (_) {}
      if (n.child) q.push(n.child);
      if (n.sibling) q.push(n.sibling);
    }
    return best;
  }
  // A card's shortcode from its own timestamp permalink — used to detect a
  // virtualized card recycled to a different post (so the cached node is stale).
  const CARD_LINK = /\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/;
  function cardCode(art) {
    const t = art.querySelector('time');
    const a = t && t.closest('a[href]');
    const m = a && (a.getAttribute('href') || '').match(CARD_LINK);
    return m ? m[1] : null;
  }
  // Reuse the found node object (a live reference into Relay's store, so its fields
  // stay current) and only re-run the BFS when the card is new or recycled. Re-emit
  // only when a normalized field actually changed.
  const nodeCache = new WeakMap(); // article -> media node
  const scrapeSig = new WeakMap(); // article -> last emitted signature
  function scrapeFeed() {
    if (document.hidden) return;
    try {
      const arts = document.querySelectorAll('article');
      if (!arts.length) return;
      const out = [];
      for (const art of arts) {
        const r = art.getBoundingClientRect();
        if (r.bottom < -800 || r.top > innerHeight + 800) continue;
        const code = cardCode(art);
        let node = nodeCache.get(art);
        if (!node || node.code !== code) { // fresh or recycled card -> walk once
          node = findFeedMediaNode(art);
          if (node) nodeCache.set(art, node);
        }
        if (!node) continue;
        const rec = normalize(node);
        const sig = [rec.likes, rec.comments, rec.reposts, rec.shares, rec.plays, rec.takenAt, rec.countsDisabled, rec.shortcode].join('|');
        if (scrapeSig.get(art) === sig) continue;
        scrapeSig.set(art, sig);
        out.push(rec);
      }
      emit(out);
    } catch (_) {}
  }
  // --- IG's in-memory Relay store: every media record IG has loaded on this page ---
  // Covers what the network tap cannot parse (streamed feed pages, reels-tab listing, late
  // post prefetch) and fields the card node lacks (reshare_count, taken_at). Read-only, local.
  let relayEnv = null;
  function findEnv() {
    for (const el of [document.querySelector('main'), document.querySelector('[role="dialog"]'), document.querySelector('video')]) {
      let f = el && fiberOf(el);
      for (let i = 0; f && i < 400; i++, f = f.return) {
        const p = f.memoizedProps;
        const env = p && ((p.value && p.value.environment) || p.environment);
        if (env && typeof env.getStore === 'function') return env;
      }
    }
    return null;
  }
  const storeSig = new Map(); // record id -> last emitted signature
  function scanStore() {
    if (document.hidden) return;
    try {
      if (!relayEnv) relayEnv = findEnv();
      if (!relayEnv) return;
      const src = relayEnv.getStore().getSource();
      const deref = x => (x && typeof x.__ref === 'string' ? src.get(x.__ref) : x);
      const out = [];
      for (const id of src.getRecordIDs()) {
        const r = src.get(id);
        if (!isMediaNode(r)) continue;
        const rec = normalize(Object.assign({}, r, { user: deref(r.user), owner: deref(r.owner) }));
        const sig = [rec.shortcode, rec.likes, rec.comments, rec.reposts, rec.shares, rec.plays, rec.takenAt, rec.countsDisabled, rec.author].join('|');
        if (storeSig.get(id) === sig) continue;
        storeSig.set(id, sig);
        out.push(rec);
      }
      if (storeSig.size > 20000) storeSig.clear(); // bound memory on very long sessions
      for (let i = 0; i < out.length; i += 200) emit(out.slice(i, i + 200)); // content script takes 200 per batch
    } catch (_) { relayEnv = null; }
  }

  let scrapeThrottle = 0;
  function scheduleScrape() {
    const now = (performance && performance.now) ? performance.now() : Date.now();
    if (now - scrapeThrottle < 250) return;
    scrapeThrottle = now;
    scrapeFeed();
  }
  window.addEventListener('scroll', scheduleScrape, { passive: true });
  const scanAll = () => { scrapeFeed(); scanStore(); scanEmbedded(); };
  [700, 1800, 3500].forEach(t => setTimeout(scanAll, t)); // cards mount async after load
  setInterval(scanAll, 1500); // safety net for data that lands without a scroll

  // --- reel on screen in the /reels/ player ---
  // Opened from Explore, the player's next/previous changes the video but not the URL, so
  // report the on-screen reel's code (from its Like button's React props) with the path.
  const SHORT = /^[A-Za-z0-9_-]{1,32}$/;
  let lastVisible = '';
  function postVisibleReel() {
    if (document.hidden || !/^\/reels\//.test(location.pathname)) return;
    try {
      // Rail Like icons only (24 px; comment hearts are smaller), nearest the screen middle first.
      const cands = [];
      for (const svg of document.querySelectorAll('svg[aria-label="Like"], svg[aria-label="Unlike"]')) {
        const r = svg.getBoundingClientRect();
        if (r.height < 20 || r.top < 0 || r.bottom > innerHeight) continue;
        cands.push([Math.abs(r.top - innerHeight / 2), svg]);
      }
      cands.sort((a, b) => a[0] - b[0]);
      let code = null;
      for (const [, svg] of cands) {
        let f = fiberOf(svg);
        for (let i = 0; f && !code && i < 40; i++, f = f.return) {
          const p = f.memoizedProps;
          if (p && typeof p === 'object') for (const k in p) {
            const v = p[k];
            if (v && typeof v === 'object' && typeof v.code === 'string' && SHORT.test(v.code)) { code = v.code; break; }
          }
        }
        if (code) break;
      }
      if (!code) return;
      const key = location.pathname + '#' + code;
      if (key === lastVisible) return;
      lastVisible = key;
      post({ kind: 'visible', code, path: location.pathname });
    } catch (_) {}
  }
  setInterval(postVisibleReel, 500);

  // --- route changes (MAIN world catches Instagram's own history calls) ---
  function emitRoute() {
    lastVisible = '';  // report the on-screen reel again for the new route
    storeSig.clear();  // re-send store records: the content cache may have evicted some
    post({ kind: 'route', path: location.pathname });
    setTimeout(scanAll, 600);
  }
  ['pushState', 'replaceState'].forEach(fn => {
    const orig = history[fn];
    if (typeof orig === 'function') {
      history[fn] = function () { const r = orig.apply(this, arguments); try { emitRoute(); } catch (_) {} return r; };
    }
  });
  window.addEventListener('popstate', emitRoute);
})();
