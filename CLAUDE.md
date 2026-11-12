# IG Research Overlay — project guide (read first)

Local, **passive**, Manifest V3 Chrome extension that overlays real public engagement
metrics on Instagram (web, logged-in). No build step, no dependencies, no network of
its own. Personal research tool.

## What it shows
Per media: plays, likes, comments, shares/reposts, and exact local publish date + time
to the **second**. Surfaces:
- **Single media** (`/p/{code}`, `/reel/{code}`, `/reels/{code}` immersive): one pill.
- **Home feed** (`instagram.com`): a pill per post card.
- **Grids** (posts tab + reels tab): a compact badge per thumbnail.

## Hard rules (do not break)
- **Passive + local only.** Never issue a new Instagram API request, never read
  cookies/tokens, never send anything off-device, no analytics. The tap only *observes*
  responses IG already makes. The extension makes no network requests; the separate
  updater helper (`updater/host.ps1`) talks only to the GitHub releases of
  `Ahmadelmacho/ig-research-overlay`. Manifest permissions are only `nativeMessaging`: no
  `host_permissions`, nothing else (static content scripts inject from `matches` alone).
- **Keep the manifest `key`.** It pins the extension ID that `updater/extension-id.txt` and
  the host's `allowed_origins` rely on; the updater refuses a release with another key.
- **Never fabricate a number.** A metric the surface does not expose shows `—`
  (Unavailable). Exact integers from JSON/network are the source of truth; abbreviated
  values are Approx.
- **Check every code change** before finishing: `node --check content.js inject.js popup.js`,
  and run `updater\test.ps1` after any updater change.

## Files (all hand-written, no build)
- `manifest.json` — MV3. Two content scripts: `inject.js` (world **MAIN**, `document_start`)
  and `content.js` (world ISOLATED, `document_start`) + `overlay.css`.
- `inject.js` — MAIN-world passive tap. Wraps `fetch` + `XMLHttpRequest` **before** IG's
  bundle grabs its references (why it MUST be `document_start`), deep-walks graphql /
  `/api/v1/` responses and the initial-HTML embedded JSON, normalizes media nodes, and
  `postMessage`s them to the content script.
- `content.js` — ISOLATED world. A shortcode→record cache (LRU 500), URL-driven current
  media, the single overlay + feed pills + grid badges, formatting, confidence labels.
- `overlay.css` — shared `.igro-pill` (single overlay + feed pills) and `.igro-badge` (grid).
- `popup.html` / `popup.js` / `popup.css` — toolbar popup: shows the version, "Check for
  updates" and "Update to vX.Y.Z" via `chrome.runtime.sendNativeMessage("com.igro.updater")`.
- `updater/host.ps1` + `host.cmd` — native messaging host (Windows PowerShell 5.1). `check`
  compares the latest release tag with the install folder's manifest; `update` downloads
  the release zip, verifies its SHA-256 digest, the manifest `key` and a higher version,
  then replaces the runtime files. Refuses to update a folder with `.git` (developer copy).
  Only framed replies may reach stdout. `extension-id.txt` = the ID from the `key`.
  `install-id.txt` (written by `get.ps1`, not in git) lets the popup confirm the helper
  updates the same folder Chrome loaded.
- `updater/test.ps1` — self-test, no network (fake release via file:// URLs):
  `powershell -NoProfile -ExecutionPolicy Bypass -File updater\test.ps1`. Not shipped.
- `get.ps1` — one-command install / update / `-Uninstall` for other people (HKCU, no admin).
- `release.ps1` — developer release: zip of runtime files, tag, push, `gh release create`
  (`-DryRun` only builds the zip). The release zip list lives here.
- `README.md` — user-facing install / update / uninstall steps + limits.

## How the data flows
1. `inject.js` observes an IG response, `harvest()` deep-walks it for **media nodes**
   (`isMediaNode`: has `code` + taken_at OR any count), `normalize()`s each, posts them.
2. `content.js` `sanitize()`s each record and `merge()`s into `cache` by shortcode
   (**non-null wins**, so a count-less duplicate never hides real numbers).
3. Renderers read `cache.get(code)`: `render()` (single overlay), `annotateFeed()` (feed),
   `badgeGrid()` (thumbnails). A throttled MutationObserver + scroll + the message handler
   all call a 150ms-coalesced `scanSurfaces()`.

## Confirmed field-map (Instagram web, verify with a live inspection if it breaks)
Media object (in embedded JSON on hard load, and in graphql responses):
`taken_at` (unix epoch **seconds** → exact local datetime), `like_count`, `comment_count`,
`media_repost_count` (the 🔁), `play_count`/`view_count`/`ig_play_count` (plays, often
absent), `code` (shortcode), `pk`, `media_type`, `product_type`, `user.username`/`owner.username`
(author). No public save count exists. Web API = single `POST /api/graphql` (no `/api/v1/`).
`reshare_count` = the paper-plane share count. When `like_and_view_counts_disabled` is true,
`like_count` is a small stand-in (seen as 3 on posts with thousands of comments/plays), so
likes show "hidden"; plays stay shown. Some SSR data arrives as a JSON *string*
(`__bbox.result.response`) that must be parsed; IG's in-memory Relay store also holds media
nodes the network tap never sees (reels/tagged listings). Reading it is still passive.

## Gotchas banked from real debugging
- **Tap MUST be `document_start` MAIN world.** A post-load `fetch`/XHR patch captures
  nothing — IG closures its fetch ref at init.
- **`MAX_DEPTH` ≥ ~20.** IG nests the media object ~17 levels deep in SSR JSON; too shallow
  = empty overlay.
- **Reels-tab tiles are not `<img>`** (CSS background) and are clickable `<div>`/`<a>` that
  show IG's own play count. `badgeGrid` gates on size only and has a DOM-count fallback
  (read the number next to a `View Count` icon) because the cache does not fill from the
  reels listing until you open a reel.
- **Home feed** `<article>` wrappers can measure 0×0 (virtualized); the real card is a
  ~470px `<div>`. Identify a card by its `<time>` permalink → `feedCard()` walks up to a
  bounded block, never the column.
- **Collab posts** ("X and 2 others") carry several media nodes for one shortcode, some
  without counts — that is why `harvest()` emits **every** node (no per-code dedup) and the
  cache merge fills counts.
- **Canonical permalinks only** (`permalinkCode`): reject comment links `/p/CODE/c/ID`.
- **`badgeGrid` skips `code === currentCode`** so an open modal does not get a duplicate badge.
- Grid badges rebuild off a signature (shortcode + values); feed pills off a full signature
  + a live-set orphan sweep. Keep these when editing or stale/duplicate numbers return.

## Placement
Single overlay + feed pills inject **under the username** via `insertUnder()` (climb to the
header row, insert after it) so they never crowd the username/follow controls. On the
immersive `/reels/` player (no header) the single overlay floats top-right.

## Making changes
- Edit the files directly. No build. To test: `node --check content.js inject.js`, then the
  unpacked extension is reloaded in `chrome://extensions`.
- IG's DOM/response shape is obfuscated and changes. If something stops matching, inspect the
  live page in Chrome before guessing selectors — do not hardcode
  IG's minified class names; anchor on `href` shape, `<time>`, aria-labels, and size.
- Prototype DOM/placement changes by injecting the logic into a live IG page first (that is
  how every surface here was validated), then write it into the file.

## After a code change, tell the tester
1. **"Reload the extension"**: `chrome://extensions` → reload icon on the IG Research Overlay
   card. Code changes do NOT hot-reload. (It needs the browser UI.)
2. Which surfaces to check after reload (single reel/post, home feed, posts grid, reels tab).
3. That exact plays on reels only appear once they browse enough for the tap to capture the
   data; grids show IG's own count immediately as a fallback.
4. Anything still `—` is genuinely not exposed by IG on that surface (by design, never faked).

