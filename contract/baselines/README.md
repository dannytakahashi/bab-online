# Frozen contract baselines, one per iOS build that can still connect

`contract/v1-baseline.schema.json` is the cc865b4 contract (iOS 1.0.0 and the
web client). It never covered anything added since (snapshot v2, `seatV2`,
`stateSnapshot`, `positionUpdate.isBot`, ...), so a PR that dropped
`trickHistory` or nulled `watching` regenerated everything and went green,
while every iOS build since 1.2.0 decodes those keys non-optionally and would
fail every rejoin, restore, spectate and resync. Each uploaded build that
`MIN_IOS_BUILD` (`server/socket/upgradeGate.js`) does not gate therefore has
two files here, and `contract/__tests__/additiveOnly.test.js` holds today's
contract to every one of them; a failure names the build it would break:

- `ios-<version>-b<build>.schema.json`: the contract at the commit the build
  was archived from, built from that commit's `contract/src` (byte for byte
  that commit's `events.schema.json`, as `v1-baseline` was produced) and then
  hand-edited only for executed removals (below). The same additive rules as
  v1, applied recursively: no event, property, required key or variant may
  go; type, const, enum, bounds, `additionalProperties` and `$ref` stay; new
  ones are fine. `description` is documentation and may change.
- `ios-<version>-b<build>.decodes.json`: the decode floor, read from that
  commit's Swift (`contract/lib/swiftDecodes.js` parses
  `ServerEvent.decode` and every type it reaches: `WirePayloads.swift`,
  `WireDecoding.swift`, the generated `TableSnapshot.swift`, `Card.swift`).
  For every event iOS decodes with JSONDecoder, each non-optional property
  must stay required and non-null in today's schema, and every property
  (optional ones too: `decodeIfPresent` throws on a wrong type) must keep a
  JSON type its Swift type decodes (`Int` integer only, a closed `Suit` /
  `Rank` enum no new values). This is the floor a schema hand edit cannot
  lower. `DECODE_WAIVED` in the test lists the mismatches that cannot reach
  iOS, with why (today: `stateSnapshot.requestId`, an echo of the asker's
  own String).

| Build | Files | Archived from | Status |
| --- | --- | --- | --- |
| iOS 1.2.0 (6) | `ios-1.2.0-b6.*` | 83a3f8f (PR #244, merged as 775a2e0; `contract/` and `iOSClient/BABOnline` are 92d0c75's, build 5's source, but for the icon assets) | App Store, live 2026-11-13 |
| iOS 1.2.1 (7) | `ios-1.2.1-b7.*` | 6f11cb1 (PR #260 "version 1.2.1 (build 7)", dac6fdc; after #255, before #261's icon, which is build 8's) | TestFlight |
| iOS 1.2.1 (8) | `ios-1.2.1-b8.*` | d3ebe76 (PR #262 merged; its iOS source is 7e73df1's, the build 8 commit, and its contract adds #263's stats `scope` echo, which build 8's Humans / Bots / All control reads) | submitted for review 2026-11-14 |

Not here: builds 3 to 5 (3 never submitted, 4 pulled from review, 5 replaced
by 6 with the same source; what TestFlight builds 3-4 read is tracked in
V1_REMOVALS #14) and 1.2.1 (9) (7177d6a, not submitted yet: freeze it when it
is, below). The three floors are identical; today's Swift differs only by
no longer declaring the optional `gameStart.players` (dropped by #6).

## Release step: freeze a build when it is uploaded

When a build is uploaded to App Store Connect (TestFlight or review), from
the commit it was archived from:

```bash
npm run contract:baseline -- --build 10                  # HEAD must be build 10 (CURRENT_PROJECT_VERSION)
npm run contract:baseline -- --build 10 --commit <sha>   # or the archive's commit
```

It refuses a commit whose project is another build, and a build already
frozen. It prints any mismatch today's contract already has with the new
build (fix those first). Add the row above, run
`npx jest contract/__tests__/additiveOnly.test.js`, and commit both files.

`npm run contract:baseline -- --check` (needs git history, so not in CI)
re-derives every frozen build from its commit: each decode floor must match
exactly, and it lists where each schema baseline was hand-edited.

## Editing a baseline: only for an executed removal

Never regenerate a frozen file. A schema baseline is hand-edited only in the
PR that executes a `contract/V1_REMOVALS.md` entry, as `v1-baseline` is
(V1_REMOVALS "How to execute one removal"), and only for the builds the
entry was re-checked against (it names what each build reads, file:line at
the build's source; build 6's source is 92d0c75). A decode floor is never
edited: if a removal touches anything a floor holds, it waits until
`MIN_IOS_BUILD` gates that build.

Hand edits made at freeze time (2026-11-15), identical for 6, 7 and 8 (the
removals merged 2026-11-13 23:11-23:57, after all three were cut, each
re-checked for build 5 = build 6's source and for 1.2.1's additions in
V1_REMOVALS "What iOS 1.2.0 unblocks"):

- #1 phase B: `s2c.error`
- #3: `s2c.lobbyJoined`, `s2c.roomFull`, `s2c.activeTournamentFound`
- #6: `s2c.gameStart|seat.players`
- #7: `s2c.playerAssigned`
- #9: the v1 table keys of `rejoinSuccess` (both variants),
  `restorePlayerState` (`isLazy` too: decoded, never read) and
  `spectatorJoined|fullState`
- #14: `playerDrew.socketId`, `positionUpdate.usernames[].socketId`,
  `$defs.playerInfoV1.socketId`
- #19 A-D, F: `$defs.pic` integer | null, `customProfilePic` null in
  `$defs.profile` and `$defs.playerSearchRow`

## Retiring a build

Once `MIN_IOS_BUILD` rises above a build (owner decision: when the build that
becomes the floor is live; README "Releasing (App Store)"), that build only
gets the update message, so delete its two files in the same PR (or right
after) and drop its row. `additiveOnly.test.js` fails while a gated build
still has a baseline ("a build MIN_IOS_BUILD gates is retired"). A build that
is replaced before anyone can install it (rejected, pulled) is retired the
same way. What only the retired builds read can then go through
V1_REMOVALS.
