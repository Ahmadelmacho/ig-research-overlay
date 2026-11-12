// IG Research Overlay — isolated-world orchestrator + renderer.
//
// Receives public media metrics from the MAIN-world tap (inject.js), tracks the
// current media by URL, and renders one compact overlay per media. Local-only:
// it reads data and writes nothing off-device.
(() => {
  'use strict';
  const TAG = 'IGRO_TAP';
  const cache = new Map();     // shortcode -> record (insertion-ordered, used as an LRU)
  const CACHE_MAX = 2000;      // only the current media is ever rendered; cap growth
  const SHORT = /^[A-Za-z0-9_-]{1,32}$/;
  let currentCode = null;
  let renderTimer = null;
  let overlayEl = null;
  let visibleReel = null; // { code, path }: reel on screen in the /reels/ player, from the tap

  // ---------- data in ----------
  window.addEventListener('message', ev => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.source !== TAG) return;
    if (d.kind === 'route') { visibleReel = null; onRoute(); return; }
    if (d.kind === 'visible') {
      visibleReel = typeof d.code === 'string' && SHORT.test(d.code) && typeof d.path === 'string' ? { code: d.code, path: d.path } : null;
      onRoute();
      return;
    }
    if (d.kind !== 'media' || !Array.isArray(d.records)) return;
    // The postMessage transport is same-origin readable/writable, so treat every
    // record as untrusted: validate + coerce types and cap the batch.
    let touchedCurrent = false;
    for (const raw of d.records.slice(0, 200)) {
      const r = sanitize(raw);
      if (!r) continue;
      const merged = merge(cache.get(r.shortcode), r);
      cache.delete(r.shortcode);           // move to newest
      cache.set(r.shortcode, merged);
      evict();
      if (r.shortcode === currentCode) touchedCurrent = true;
    }
    if (touchedCurrent) scheduleRender();
    scheduleBadge(); // fresh feed data may fill in visible grid badges
  });

  const int = v => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : null);

  // Accept only a well-formed record; coerce fields, drop anything malformed.
  function sanitize(r) {
    if (!r || typeof r.shortcode !== 'string' || !SHORT.test(r.shortcode)) return null;
    return {
      shortcode: r.shortcode,
      pk: typeof r.pk === 'string' && r.pk.length <= 32 ? r.pk : null,
      takenAt: int(r.takenAt),
      likes: int(r.likes),
      comments: int(r.comments),
      reposts: int(r.reposts),
      shares: int(r.shares),
      plays: int(r.plays),
      countsDisabled: r.countsDisabled === true ? true : (r.countsDisabled === false ? false : null),
      sharesHidden: r.sharesHidden === true ? true : (r.sharesHidden === false ? false : null),
      mediaType: int(r.mediaType),
      productType: typeof r.productType === 'string' ? r.productType.slice(0, 32) : null,
      author: typeof r.author === 'string' && /^[A-Za-z0-9._]{1,40}$/.test(r.author) ? r.author : null
    };
  }

  // Evict oldest entries past the cap, but never the media currently on screen.
  function evict() {
    while (cache.size > CACHE_MAX) {
      const it = cache.keys();
      let oldest = it.next().value;
      if (oldest === currentCode) oldest = it.next().value; // skip the hot entry
      if (oldest == null) break;
      cache.delete(oldest);
    }
  }

  // Merge: freshest non-null field wins; keep an earlier value if the new one is null.
  function merge(a, b) {
    if (!a) return b;
    const out = Object.assign({}, a);
    for (const k of ['takenAt', 'likes', 'comments', 'reposts', 'shares', 'plays', 'mediaType', 'productType', 'author']) {
      if (b[k] != null) out[k] = b[k];
    }
    if (b.sharesHidden != null) out.sharesHidden = b.sharesHidden;
    if (b.countsDisabled != null) out.countsDisabled = b.countsDisabled; // only a present report wins (a count-less duplicate keeps the prior flag)
    if (b.pk != null) out.pk = b.pk;
    return out;
  }

  // ---------- current media from URL ----------
  const ROUTE = /\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/;
  function codeFromUrl() {
    // The /reels/ player can change reels without changing the URL; trust the on-screen
    // reel the tap reported for this exact path.
    if (visibleReel && visibleReel.path === location.pathname && /^\/reels\//.test(location.pathname)) return visibleReel.code;
    const m = location.pathname.match(ROUTE);
    return m ? m[1] : null;
  }

  // ---------- formatting ----------
  const fmtInt = v => (v == null ? null : v.toLocaleString());
  const fmtDate = ts => new Date(ts * 1000).toLocaleDateString();
  const fmtTime = ts => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  // Monochrome inline SVGs (feather-style), static constants — no untrusted input.
  const S = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
  const ICONS = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg>',
    heart: S + '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 1 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/></svg>',
    comment: S + '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-4-1L3 20l1.1-4A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/></svg>',
    share: S + '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    repost: S + '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    calendar: S + '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    clock: S + '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
  };

  function metric(iconName, value, conf, title) {
    const el = document.createElement('span');
    el.className = 'igro-m igro-' + conf;
    if (title) el.title = title;
    const i = document.createElement('span');
    i.className = 'igro-i igro-i--' + iconName;
    i.innerHTML = ICONS[iconName] || ''; // static constant markup, safe
    const v = document.createElement('span');
    v.className = 'igro-v';
    v.textContent = value == null ? '—' : value;
    el.appendChild(i);
    el.appendChild(v);
    return el;
  }

  // ---------- render ----------
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 60);
  }

  // Fill a pill element with the full metric row. Shared by the single-media
  // overlay and each home-feed card's inline pill.
  function fillMetrics(host, rec) {
    host.textContent = '';
    const disabled = rec.countsDisabled;
    // A present integer is the source of truth — show it even when the author flagged
    // counts hidden (IG still returns and renders the number). countsDisabled only
    // explains an ABSENT value; it must never blank one IG actually exposed.
    const countCell = (icon, val) => val != null
      ? metric(icon, fmtInt(val), 'confirmed', '')
      : metric(icon, '—', 'unavailable', disabled ? 'Counts hidden by the author' : 'Not exposed on this surface');
    host.appendChild(countCell('play', rec.plays));
    // Exception: when the author hid likes, IG sends a small stand-in like_count (seen: 3 on
    // posts with 67+ comments and 160+ reposts) and renders no number, so it is not the total.
    host.appendChild(disabled === true
      ? metric('heart', 'hidden', 'unavailable', 'Like count hidden by the author')
      : countCell('heart', rec.likes));
    host.appendChild(countCell('comment', rec.comments));
    host.appendChild(countCell('repost', rec.reposts));
    host.appendChild(rec.sharesHidden === true
      ? metric('share', 'hidden', 'unavailable', 'Share count hidden by the author')
      : countCell('share', rec.shares));
    if (rec.takenAt != null) {
      host.appendChild(metric('calendar', fmtDate(rec.takenAt), 'confirmed'));
      host.appendChild(metric('clock', fmtTime(rec.takenAt), 'confirmed', new Date(rec.takenAt * 1000).toString()));
    } else {
      host.appendChild(metric('clock', '—', 'unavailable'));
    }
  }

  // Is the URL's media actually shown? The /reels/ player always is; a /p/ or /reel/ URL can
  // sit over a plain profile grid after back/forward, with no post open. A post page or modal
  // shows a visible <time> inside a permalink to this code.
  function mediaShown(code) {
    if (/^\/reels\//.test(location.pathname)) return true;
    for (const t of document.querySelectorAll('time')) {
      const a = t.closest('a[href]');
      if (a && permalinkCode(a.getAttribute('href')) === code && t.getBoundingClientRect().width > 0) return true;
    }
    return false;
  }

  function render() {
    const code = currentCode;
    if (!code || !mediaShown(code)) { removeOverlay(); scheduleBadge(); return; }
    const host = ensureOverlay();
    host.dataset.igroCode = code;
    const rec = cache.get(code);
    if (!rec) { host.textContent = ''; host.appendChild(pending(code)); place(host, null); return; }
    fillMetrics(host, rec);
    place(host, rec);
  }

  function pending(code) {
    const s = document.createElement('span');
    s.className = 'igro-m igro-pending';
    s.textContent = '… ' + code;
    return s;
  }
  // Private node reference (never getElementById, so a page element sharing the
  // id can't be adopted). Created detached; place() decides where it lives.
  function ensureOverlay() {
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.id = 'igro-overlay';
      overlayEl.className = 'igro-pill';
    }
    return overlayEl;
  }
  function removeOverlay() {
    if (overlayEl) overlayEl.remove();
  }

  // Author username link in the post header (top region, right of the left nav).
  // Restricted to the media's own author when known, so it never grabs a tagged
  // user or a "more posts" link. Returns null on surfaces with no header row
  // (the immersive /reels/ player), where the overlay then stays floating.
  function findHeaderAnchor(rec) {
    if (!rec || !rec.author) return null; // only inline when we can match the media's own author
    const wanted = '/' + rec.author + '/'; // rec.author is validated [A-Za-z0-9._], safe to interpolate
    let best = null;
    const scope = document.querySelector('[role="dialog"]') || document;
    for (const a of scope.querySelectorAll('a[href="' + wanted + '"]')) {
      if (!a.textContent.trim()) continue;
      const r = a.getBoundingClientRect();
      if (!(r.width > 0 && r.x > 200 && r.y >= 0 && r.y < 400)) continue;
      if (!best || r.y < best.y || (r.y === best.y && r.x < best.x)) best = { a, x: r.x, y: r.y };
    }
    return best ? best.a : null;
  }

  // Drop the pill onto its own line UNDER the author(s). Climb from the username while the
  // ancestors stay header-sized (<=700 wide, <=260 tall) and remember the OUTERMOST vertical
  // column (flex-direction:column, >=200 wide); insert the pill right after the block that
  // holds the byline inside it. That block holds the WHOLE header row (name, check, Follow,
  // "X and Y", "and 4 others"), so nothing gets split or squeezed. Children are not counted:
  // a one-line header's column has a single child. Probe-verified live on the home feed,
  // full post pages (one-line header, 335 px panel) and collab bylines.
  // Returns false (inserts nothing) if no column is found, so callers can fall back.
  function insertUnder(anchor, pill) {
    let row = anchor, best = null;
    // Measure ancestors without our own pill, so a re-place never moves it (and loops).
    const ph = pill.isConnected ? pill.getBoundingClientRect().height + 6 : 0;
    for (let i = 0; i < 18 && row.parentElement; i++) {
      const p = row.parentElement;
      const pr = p.getBoundingClientRect();
      if (pr.width > 700 || pr.height - (ph && p.contains(pill) ? ph : 0) > 260) break; // left the header
      const cs = getComputedStyle(p);
      if (cs.display.indexOf('flex') >= 0 && cs.flexDirection === 'column' && pr.width >= 200) best = row;
      row = p;
    }
    if (!best) return false;
    if (best.nextElementSibling !== pill) best.insertAdjacentElement('afterend', pill);
    return true;
  }

  // Inline under the header when an anchor exists and a column was found; otherwise float top-right.
  function place(host, rec) {
    const anchor = findHeaderAnchor(rec);
    if (anchor && insertUnder(anchor, host)) {
      host.classList.add('igro-inline');
    } else {
      host.classList.remove('igro-inline');
      const root = document.body || document.documentElement;
      if (host.parentElement !== root) root.appendChild(host);
    }
  }

  // ---------- profile/grid thumbnail badges ----------
  // Canonical permalink only: optional /{user}/ prefix, optional trailing query.
  // Rejects comment permalinks (/p/CODE/c/ID/) and other nested/non-canonical paths.
  const PERMALINK = /^\/(?:[A-Za-z0-9._]+\/)?(?:reel|reels|p)\/([A-Za-z0-9_-]+)\/?(?:\?.*)?$/;
  function permalinkCode(href) { const m = (href || '').match(PERMALINK); return m ? m[1] : null; }

  function abbrev(n) {
    if (n == null) return null;
    const a = Math.abs(n);
    if (a < 1000) return String(n);
    // Truncate like IG does (15,693 -> 15.6K, 538,676 -> 538K), never round up.
    const cut = v => String(v < 100 ? Math.floor(v * 10) / 10 : Math.floor(v));
    return a < 1e6 ? cut(n / 1e3) + 'K' : cut(n / 1e6) + 'M';
  }

  // d = { rec } (full cache record → vertical stack of every metric it exposes) or
  // { domPlays } (IG's own rendered count string, used when the cache has no record
  // for this tile yet — reels-tab tiles before the tap fills the cache).
  function buildBadge(d) {
    const items = [];
    if (d.rec) {
      const r = d.rec;
      if (r.plays != null) items.push(['play', abbrev(r.plays)]);
      else if (d.domPlays) items.push(['play', d.domPlays]); // exact plays not cached yet → IG's own rendered count
      if (r.countsDisabled === true) items.push(['heart', 'hidden', 'unavailable']); // stand-in like_count, see fillMetrics
      else if (r.likes != null) items.push(['heart', abbrev(r.likes)]);
      if (r.comments != null) items.push(['comment', abbrev(r.comments)]);
      if (r.reposts != null) items.push(['repost', abbrev(r.reposts)]);
      if (r.sharesHidden === true) items.push(['share', 'hidden', 'unavailable']);
      else if (r.shares != null) items.push(['share', abbrev(r.shares)]);
      if (r.takenAt != null) {
        items.push(['calendar', fmtDate(r.takenAt)]);
        items.push(['clock', fmtTime(r.takenAt)]);
      }
    } else if (d.domPlays) {
      items.push(['play', d.domPlays]);
    }
    if (!items.length) return null;
    const b = document.createElement('div');
    b.className = 'igro-badge';
    for (const it of items) b.appendChild(metric(it[0], it[1], it[2] || 'confirmed'));
    return b;
  }

  // Badge near-viewport thumbnails with their OWN cached metrics. A signature
  // (shortcode + values) drives rebuilds: when a virtualized tile is recycled to a
  // new shortcode, or fresher data arrives for the same one, the badge is rebuilt;
  // when a tile no longer maps to cached data, its stale badge is removed.
  function tileSig(rec) { return rec ? [rec.plays, rec.likes, rec.comments, rec.reposts, rec.shares, rec.takenAt, rec.countsDisabled ? 1 : 0, rec.sharesHidden ? 1 : 0].join('|') : ''; }
  function clearBadge(a) {
    const ex = a.querySelector(':scope > .igro-badge');
    if (ex) ex.remove();
    if (a.dataset.igroPos === '1') { a.style.position = ''; delete a.dataset.igroPos; }
    delete a.dataset.igroBadged;
    delete a.dataset.igroSig;
  }
  function badgeGrid() {
    let n = 0, capped = false;
    for (const a of document.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"]')) {
      const code = permalinkCode(a.getAttribute('href'));
      // skip non-permalinks, the open media, feed-card links (a <time> inside, or the
      // anchor sits in a feed <article> — those get the inline pill via annotateFeed,
      // never a grid badge, so a feed card never shows both).
      if (!code || (code === currentCode && overlayEl && overlayEl.isConnected) || a.querySelector('time') || a.closest('article')) { if (a.dataset.igroBadged) clearBadge(a); continue; }
      const r = a.getBoundingClientRect();
      // size-only gate: reels-tab tiles paint via CSS background (no <img>), so a
      // media-element check would miss them; 100px excludes inline caption links.
      if (r.width < 100 || r.height < 100) { if (a.dataset.igroBadged) clearBadge(a); continue; }
      if (r.top > innerHeight + 300 || r.bottom < -300) continue; // offscreen: revisit on scroll
      const rec = cache.get(code);
      const hasCacheMetric = !!rec && (rec.plays != null || rec.likes != null || rec.comments != null || rec.reposts != null || rec.shares != null || rec.sharesHidden === true || rec.takenAt != null);
      // DOM fallback: reels-tab tiles show IG's own play count (beside a view-count
      // icon). Gate on that icon so we never mistake a caption or comment number for
      // the count. Used whenever our cache lacks exact plays — so a tile that cached
      // likes/comments but no play_count still shows a plays row (fills exact later).
      let domPlays = null;
      const icon = (!rec || rec.plays == null) && a.querySelector('svg[aria-label*="View Count"], svg[aria-label*="Play"], svg[aria-label*="view"]');
      // Read the number in the icon's own small container: the tile's first number is the
      // like count while IG's hover overlay shows, and the tile also holds our badge.
      for (let n = icon && icon.parentElement, i = 0; n && n !== a && i < 4; n = n.parentElement, i++) {
        const dm = (n.textContent || '').match(/[\d.,]+[KMB]?/); if (dm) { domPlays = dm[0]; break; }
      }
      const domPart = 'dom:' + (domPlays || '');
      const sig = code + '#' + (hasCacheMetric ? tileSig(rec) + '|' + domPart : domPart);
      const ex = a.querySelector(':scope > .igro-badge');
      if (a.dataset.igroSig === sig && ((hasCacheMetric || domPlays) ? !!ex : true)) continue; // unchanged
      if (n >= 80) { capped = true; break; } // budget counts only CHANGED tiles; rest finish next pass
      n++;
      if (ex) ex.remove();
      const badge = buildBadge(hasCacheMetric ? { rec, domPlays } : { domPlays });
      if (badge) {
        if (a.dataset.igroPos !== '1' && a.style.position === '' && getComputedStyle(a).position === 'static') {
          a.style.position = 'relative'; a.dataset.igroPos = '1';
        }
        a.appendChild(badge);
      } else if (a.dataset.igroPos === '1') {
        a.style.position = ''; delete a.dataset.igroPos;
      }
      a.dataset.igroBadged = code;
      a.dataset.igroSig = sig; // empty-data sig changes once rec arrives -> triggers rebuild
    }
    if (capped) scheduleBadge(); // more changed tiles than the per-pass budget; continue next pass
  }

  // ---------- home-feed per-card inline pill ----------
  // Feed cards don't wrap media in a sized link, but each <article> carries a
  // timestamp permalink (a > time) giving its shortcode. Inject the full pill
  // into the card header next to the author, keyed off that shortcode.
  // Full signature for a feed pill (rebuild on any visible field changing).
  function feedSig(rec) {
    return rec ? [rec.plays, rec.likes, rec.comments, rec.reposts, rec.shares, rec.takenAt, rec.countsDisabled ? 1 : 0, rec.sharesHidden ? 1 : 0, rec.author].join('|') : '';
  }
  // The post card: nearest <article>, or a bounded block (300–750px wide, ≥300 tall).
  // Never body/html/the feed column, so two posts can't share one card.
  function feedCard(el) {
    let n = el;
    for (let i = 0; i < 16 && n && n !== document.body && n !== document.documentElement; i++) {
      if (n.tagName === 'ARTICLE') return n;
      const r = n.getBoundingClientRect();
      if (r.height >= 300 && r.width >= 300 && r.width <= 750) return n;
      n = n.parentElement;
    }
    return null;
  }
  // Each feed card carries a <time> inside its canonical permalink anchor. Key off
  // visible timestamps, find the card, inject the pill next to the author. Cards
  // are obfuscated divs, so state lives on the card; a live-set sweep removes pills
  // whose card scrolled off or was recycled to a different post.
  function annotateFeed() {
    const live = new Set();
    const seen = new Set();
    for (const t of document.querySelectorAll('time')) {
      const link = t.closest('a[href]');
      const code = link && permalinkCode(link.getAttribute('href'));
      if (!code || code === currentCode || seen.has(code)) continue; // current permalink handled by the overlay
      const tr = t.getBoundingClientRect();
      if (tr.width === 0 || tr.bottom < -300 || tr.top > innerHeight + 300) continue; // near-viewport only
      seen.add(code);
      const card = feedCard(t);
      if (!card) continue;
      const rec = cache.get(code);
      const sig = code + '#' + feedSig(rec);
      let pill = card.querySelector(':scope .igro-pill.igro-feed');
      if (card.dataset.igroFeedSig === sig && (!rec || pill)) { if (pill) live.add(pill); continue; }
      if (pill) pill.remove();
      if (rec) {
        pill = document.createElement('div');
        pill.className = 'igro-pill igro-inline igro-feed';
        fillMetrics(pill, rec);
        let anchor = null;
        if (rec.author) {
          for (const a of card.querySelectorAll('a[href="/' + rec.author + '/"]')) {
            if (a.textContent.trim()) { anchor = a; break; }
          }
        }
        if (!(anchor && insertUnder(anchor, pill))) card.insertBefore(pill, card.firstChild);
        live.add(pill);
      }
      card.dataset.igroFeed = code;
      card.dataset.igroFeedSig = sig;
    }
    // sweep orphans: remove an unaffirmed pill only if it is itself offscreen, so a
    // visible pill whose timestamp scrolled past the ±300 margin is kept, not dropped.
    for (const p of document.querySelectorAll('.igro-pill.igro-feed')) {
      if (live.has(p)) continue;
      const r = p.getBoundingClientRect();
      if (r.width === 0 || r.bottom < -300 || r.top > innerHeight + 300) p.remove();
    }
  }

  function scanSurfaces() { badgeGrid(); annotateFeed(); }

  let badgeTimer = null;
  function scheduleBadge() {
    if (badgeTimer) return;
    badgeTimer = setTimeout(() => { badgeTimer = null; scanSurfaces(); }, 150);
  }

  function tick() {
    if (currentCode) scheduleRender();
    scheduleBadge();
  }

  // Re-run when Instagram re-renders (React can drop our injected node), when the
  // header anchor appears late, or when new grid tiles mount. Throttled to stay cheap.
  let moThrottle = 0, moTrail = null;
  try {
    const isOurs = (n) => {
      if (!n) return false;
      if (overlayEl && (overlayEl === n || overlayEl.contains(n))) return true;
      return n.nodeType === 1 && !!n.closest && !!n.closest('.igro-pill, .igro-badge');
    };
    new MutationObserver((records) => {
      // Ignore mutations we caused inside our own overlay / pills / badges.
      if (records.every(m => isOurs(m.target))) return;
      // Throttle with a trailing run: a mount burst inside the 300 ms window (a modal header,
      // new grid rows) must still get one scan after it settles.
      const now = performance.now();
      clearTimeout(moTrail);
      if (now - moThrottle < 300) { moTrail = setTimeout(() => { moThrottle = performance.now(); tick(); }, 300); return; }
      moThrottle = now;
      tick();
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  window.addEventListener('scroll', scheduleBadge, { passive: true });

  // ---------- SPA route tracking ----------
  function onRoute() {
    const code = codeFromUrl();
    if (code === currentCode) return;
    currentCode = code;
    scheduleRender();
  }
  window.addEventListener('popstate', onRoute);
  // URL poll fallback: compares the derived media code against the authoritative
  // currentCode, so it self-corrects no matter which route mechanism fired (or missed).
  setInterval(() => { if (codeFromUrl() !== currentCode) onRoute(); }, 400);

  function start() { onRoute(); badgeGrid(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
