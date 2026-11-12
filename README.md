# IG Research Overlay

Local, passive Manifest V3 Chrome extension. Adds a compact overlay to public
Instagram reels/posts showing plays, likes, comments, shares/reposts, and the
exact local publish date + time to the second.

## What it does
- Reads only data Instagram already loads: the initial-HTML embedded JSON on a
  hard page load, and the `POST /api/graphql` / `/api/v1/` responses Instagram
  itself makes (observed via a passive fetch + XHR tap). Makes **no** requests
  of its own, touches no cookies/auth, sends nothing off-device.
- Shows a compact pill row for the current media (`/reel/…`, `/reels/…`,
  `/p/…`), updating on SPA navigation. **M2:** it injects inline into the post
  header next to the author's username on surfaces that have a header row
  (`/p/` posts, feed post pages), matched to the media's own author; on the
  immersive `/reels/` player, where there is no header row, it stays a floating
  top-right panel.
- Confidence-labelled: exact integers from JSON are Confirmed; a metric the
  surface does not expose shows `—` (Unavailable). Never fabricates a number.
- **M3:** compact per-thumbnail badges (plays + likes, abbreviated) read from each
  tile's own cached record, on the **posts grid and the reels-tab grid** (badge
  top-left to clear IG's own reels count); rebuilt when a tile recycles or data
  updates. The **home feed** shows the full pill inline in each post's header,
  keyed off that card's timestamp permalink. Icons are monochrome SVGs; the raw
  post ID was removed.

## Confirmed field-map (M0, 2026-09-19)
`taken_at` (epoch s → exact local datetime) · `like_count` · `comment_count` ·
`media_repost_count` (🔁) · `code` · `pk`. Plays: `play_count`/`view_count`
often absent on the single-reel surface (shows `—` until a response carries it).

## Install (Windows, about 2 minutes)
1. Open **PowerShell** (Start menu → type `PowerShell` → Enter).
2. Paste this line and press Enter:
   ```powershell
   irm https://raw.githubusercontent.com/Ahmadelmacho/ig-research-overlay/main/get.ps1 | iex
   ```
   It puts the extension in `%LOCALAPPDATA%\IG-Research-Overlay` and prints that exact
   folder. No admin rights needed.
3. In Chrome, open `chrome://extensions`.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and pick the folder the command printed.
6. Open any public reel or post on Instagram. The numbers appear under the username.

Requires Chrome 111+ (`world: "MAIN"` content scripts).

## Update
Click the extension's icon in the Chrome toolbar → **Check for updates** → **Update to
vX.Y.Z**. Then refresh your Instagram tabs. If the popup shows an install command instead,
run it in PowerShell (step 2 above), then try again.

The update is checked before it is used: the download must match the SHA-256 digest
GitHub publishes for the release, and it must be the same extension (same manifest `key`)
with a higher version. A copy that is a git checkout (has a `.git` folder) never updates
itself; use `git pull` there.

## Uninstall
1. In `chrome://extensions`, click **Remove** on the IG Research Overlay card.
2. In PowerShell, run:
   ```powershell
   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Ahmadelmacho/ig-research-overlay/main/get.ps1))) -Uninstall
   ```
   This deletes the install folder and the updater's registry entry.

## Developer: load from a git checkout
`chrome://extensions` → Developer mode → **Load unpacked** → pick this repo folder. The
extension ID is the same for every folder (fixed manifest `key`). The popup's update
button only updates the folder the installer made; a git checkout says it is another folder
(or "update with git pull"), so use `git pull` there.

## Developer: release
1. Bump `version` in `manifest.json`, commit on `main`.
2. Dry run: `powershell -ExecutionPolicy Bypass -File release.ps1 -DryRun`
   (builds `dist/ig-research-overlay.zip`, prints the steps).
3. Release: `powershell -ExecutionPolicy Bypass -File release.ps1 -Notes "what changed"`
   (tags `vX.Y.Z`, pushes `main` + tags, runs `gh release create` with the zip).

It refuses a dirty tree, a branch other than `main`, or a version that is not higher than
the newest tag. Updater self-test (no network):
`powershell -NoProfile -ExecutionPolicy Bypass -File updater\test.ps1`.

## Current limits (by design; addressed later)
- Exact plays appear only once the tap captures a response carrying `play_count`
  (e.g. the reels-tab feed). On a single-reel page and photo posts the count is
  absent, so plays show `—` (Unavailable, never fabricated).
- Grid badges show only after the profile/feed data loads; a tile with no cached
  record yet shows no badge until its data arrives.
- No on/off popup toggle yet.
- Grid scanning is a throttled poll, not an IntersectionObserver — fine for normal
  grids; an IO refactor is the perf upgrade if huge grids ever feel heavy.
