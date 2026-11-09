# Avatars over HTTP (roadmap item 10)

Custom profile pictures used to travel inline in socket payloads as the
stored data URL (up to ~683 K base64 chars each, in every gameStart of every
deal, in positionUpdate, rejoins, the leaderboard...). Now:

- the server derives one small canonical rendition per stored picture
  (WebP, square, at most 256 px, metadata stripped; `server/avatar/image.js`,
  sharp 0.34.5) lazily, in memory (`server/avatar/avatarStore.js`);
- clients that say `clientHello {caps: ['avatarUrl']}` get URLs
  (`/avatar/<username>?v=<version>`, `server/routes/avatar.js`) and null
  custom-picture slots;
- everyone else — the App Store iOS build (cc9059f) and web bundles cached
  before this change — still gets an inline picture in the same slot, now the
  small rendition (~5-15 K chars instead of 40-683 K);
- stock art is re-encoded: `client/assets/profile1..82.png` 192 px (same
  paths) and new `client/assets/avatars/v1/*.webp` 256 px for new clients.

The stored `users.customProfilePic` values are never rewritten. New uploads
are stored as the canonical WebP data URL.

## Invariants

- **I1 Legacy sockets never see a URL in a pic slot.** A socket without the
  `avatarUrl` cap gets, in `pic`, `pics[]`, `players[].pic`,
  `playerInfo[].pic`, `customProfilePic` and `seatV2.customPic`, either a
  `data:image/...;base64,...` string the shipped app decodes (it checks the
  `data:image` prefix, takes everything after the first comma, then strict
  `Data(base64Encoded:)` + `UIImage(data:)`; the MIME text is never read),
  exactly today's stored string, or the placeholder (hostile stored values
  only). Stock pics stay integers 1-82, bot pics are unchanged.
- **I2 The wire only grows.** New optional fields only: `avatarUrls`,
  `avatarUrl`, `seatV2.avatarUrl` (`$defs.avatarUrl`,
  `avatarUrlsByPosition`, `avatarUrlsByUsername`). `additiveOnly.test.js`
  passes without baseline edits; `LEGACY_CLIENT_STATE_PROPS` is untouched.
- **I3 RNG is untouched.** `getUserProfilePic` returns what it returned and
  awaits nothing new; `handleDrawComplete` only hashes. The wire/RNG golden
  (`server/socket/__tests__/wireGolden.test.js`, captured at fcdd885) and
  the bot sim are identical.
- **I4 Off means today.** `AVATAR_PIPELINE=off` (and the default under Jest)
  gives byte-identical emits and stored uploads.
- **I5 Legacy asset URLs keep working.** `/assets/profile<N>.png` and
  `/assets/frog.png` keep their paths and are still PNG.
- **I6 Capable clients render every legacy shape** (number, data URL, null,
  URL), so a payload built before the hello was handled, a cache eviction or
  a rendition not ready yet costs bytes, never an avatar.

## Who gets what

| Payload | Delivery | Legacy socket | Capable socket |
|---|---|---|---|
| positionUpdate | room broadcast (one emit, one seq) | `pics[]` inline rendition | same payload; prefers `avatarUrls` |
| playerActiveMode | room broadcast | `pic` inline rendition | same; prefers `avatarUrl` |
| gameStart (seat, spectator) | per socket, one handSeq per deal | inline, today's keys | slot `null` + `avatarUrls` |
| rejoinSuccess / restorePlayerState | per socket | inline, today's keys | `null` + `avatarUrls` |
| spectatorJoined (full state) | per socket | inline | `null` + `avatarUrls` |
| snapshot v2 seats | per socket | `customPic` inline when asked (`customPics:true`) | + `avatarUrl` |
| leaderboard / search rows | per socket | `customProfilePic` inline | `null` + `avatarUrls {username: url}` |
| profile / playerProfile | per socket | `customProfilePic` inline | `null` + `avatarUrl` |
| profilePicUploadResponse | per socket | stored WebP data URL | + `avatarUrl` |

Room broadcasts are never split per capability (seq / seqCheck stay
simple): positionUpdate goes out once per game and playerActiveMode on
`/active`, each carrying the small inline image plus the URL.

Until a rendition exists (first sight after a restart, a full derive
queue) the slot is exactly today's value and there is no URL, for everyone.
Derivation starts when the draw looks the pictures up (`warm`), so it is
normally done (5-15 ms) inside the draw-reveal hold.

## Kill switches (no deploy)

- `AVATAR_LEGACY_INLINE=raw`: legacy sockets get today's stored bytes again;
  capable clients keep URLs.
- `AVATAR_PIPELINE=off`: everything exactly as before this change; `/avatar`
  answers 404 (clients that said hello still render inline pictures, I6).
- If `require('sharp')` fails on a host, the pipeline is off by itself
  (logged once: "avatar pipeline disabled: sharp unavailable").
- `AVATAR_CACHE_MB` (default 32): the rendition cache budget.

## HTTP endpoint

`GET/HEAD /avatar/:username[?v=<16 hex>]`. 200: `image/webp`, `ETag
"<version>"`, nosniff, `Cross-Origin-Resource-Policy: same-site`,
`Content-Security-Policy: default-src 'none'; sandbox`, `Content-Disposition:
inline`; `Cache-Control: public, max-age=31536000, immutable` only when `v`
is the current version, else `public, max-age=60, must-revalidate`. 304 on
`If-None-Match`. Every miss (unknown, deleted, merged-away, no custom
picture, invalid name, hostile/undecodable, pipeline off) is the same 404
(`text/plain`, `max-age=60`). 429 (`Retry-After: 30`) past a per-IP token
bucket of 120 burst / 2 per s (client IP by `server/utils/clientIp.js`; an
unknown IP is not bucketed); 503 (`Retry-After: 5`, `no-store`) when 8 DB
lookups are in flight, the derive queue is full or the DB is not up.

Exposure: nothing a socket cannot already read without signing in
(getLeaderboard / searchPlayers / getPlayerProfile return every custom
picture and confirm names). The body is always our own re-encode, never the
stored bytes. Stale caches: a deleted user's versioned URL stays in browser
caches (no CDN purge); the server answers 404 from then on. An account
merge (CLI, another process) is picked up within 10 minutes (owner
re-check) plus the 60 s negative cache.

## Stock art

`npm run build:avatars` (`scripts/build-avatars.js`) rebuilds everything
from the fcdd885 masters read with `git show` (reproducible after the files
were overwritten) and checks every output. `avatars/v1` is immutable once
deployed: new art goes into `avatars/v2`. The legacy `profileN.png` files
are 256-colour palette PNGs (min 40.9 dB PSNR vs lossless); they keep their
effective 1-day cache, so old 612 px copies revalidate within a day.

## Before enabling in production (owner)

1. `node scripts/avatar-report.js` against production (read-only: one
   projected find, never writes): how many custom pictures, sizes, declared
   formats, how many derive / are hostile (they will show the placeholder to
   the App Store app and old web tabs) / undecodable (keep today's bytes).
2. Deploy with `AVATAR_PIPELINE=off` first if you want a dry deploy; check
   the CI step "sharp loads" passed and the server log has no "sharp
   unavailable" line.
3. Mandatory before merge (measurement E): build the App Store source
   (cc9059f) for the simulator from a separate detached worktree (it talks
   to localhost:3000 in the simulator), point it at this branch with one
   opponent holding an old 612 px PNG picture and one holding a new WebP
   upload, and check the avatar at the seat (positionUpdate), after
   kill-and-relaunch (rejoin), on /lazy then /active, while spectating, and
   that stock avatars still appear. (Done in this PR only at the decoder
   level: the exact cc9059f decode path compiled for the iOS simulator
   decodes the inline WebP renditions and the new palette PNGs.)
4. After deploy: count `clientHello` log lines (capable sockets, app
   versions), watch `/avatar` 404/429/503 rates (logged as "Request error"),
   check the 'Sign-in client address' line once (the per-IP bucket uses the
   same IP rules).

## Measurements (this PR)

Wire bytes (JSON of the payload as received; harness = seeded real-handler
games, `AVATAR_REPORT=1 npx jest avatarPayloads profilePayloads`; "today" =
pipeline off, identical to fcdd885):

| Payload | Today | Legacy socket | Capable socket |
|---|---|---|---|
| gameStart, 1 custom 200 px pic | 154,648 | 7,305 | 1,056 |
| gameStart, 200 px + 612 px pics | 660,111 | 22,723 | 1,040 (spectator 439) |
| positionUpdate, 1 / 2 custom pics | 154,208 / 659,636 | 6,917 / 22,335 (same emit) | same |
| spectatorJoined, 2 pics | 662,031 | — | 3,050 |
| rejoinSuccess / restorePlayerState, 2 pics (deal 3, incl. game log) | 669,300 / 670,058 | — | 10,319 / 11,077 |
| playerActiveMode | 153,696 | 6,398 (same emit) | same |
| stateSnapshot, 612 px pic | — | customPics:true 19,379 | customPics:false 3,922 |
| whole game, the custom player's socket | 2,389,261 | 179,168 | 91,682 |
| leaderboard, 30 rows, 10 custom (~46 K chars) | 477,794 | 39,656 | 8,251 |
| leaderboard, 30 rows, 30 custom | 1,418,326 | 103,252 | 9,231 |
| search, 10 custom hits | 470,967 | 32,829 | 1,424 |
| getProfile (~46 K-char pic) | 47,297 | 3,546 | 335 |

Real server (scratch DB, socket.io-client): gameStart 1,038 B capable /
7,277 B legacy with a 200 px upload; playerProfile of a stored 612 px PNG
(505,518 chars) 176 B capable / 15,594 B legacy.

Assets: `client/assets` 20,100,934 B -> 2,259,675 B (profile*.png
18,537,367 -> 874,250; avatars/v1 webp 634,806 + frog 5,374; frog.png
831,278 -> 12,956).

HTTP: a 200 px upload serves 4,708 B, a stored 612 px PNG 11,584 B. 2,000
GETs of a cached versioned avatar: p50 0.76 ms, p99 3.36 ms (local), RSS
141 -> 153 MB; 500 distinct unknown names: RSS +1.4 MB.

Derive: ~6 ms for a 200 px PNG, ~15 ms for 612 px; a 12000x12000 PNG
header is refused in < 1 ms. Memory: renditions <= 32 MB (bytes-bounded
LRU); at most 2 decodes at once (worst case ~67 MB each at the 4096^2 cap);
the derive queue (at most 64) references the stored strings it will
derive (<= ~683 K chars each, already held by the caller) until each runs.
