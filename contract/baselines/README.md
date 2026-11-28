# Frozen contract baselines, one per iOS build that can still connect

`contract/v1-baseline.schema.json` is the cc865b4 contract (iOS 1.0.0 and the
web client). It never covered anything added since (snapshot v2, `seatV2`,
`stateSnapshot`, ...), so a PR that dropped
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
  `WireDecoding.swift`, the generated `TableSnapshot.swift`, `Card.swift`
  and, from 1.2.7 (41), `State/Table/GetYourBid.swift` and, from 1.2.8
  (52), `State/Table/Scorecard.swift`, which an older build's floor never
  read: `SOURCES_FROM` in `contract/baseline.js`, which `additiveOnly.test.js`
  holds to every frozen floor's `sources`).
  For every event iOS decodes with JSONDecoder, each non-optional property
  must stay required and non-null in today's schema, and every property
  (optional ones too: `decodeIfPresent` throws on a wrong type) must keep a
  JSON type its Swift type decodes (`Int` integer only, a closed `Suit` /
  `Rank` enum no new values). For the table events this is the floor a
  schema hand edit cannot lower. It covers `ServerEvent.decode` only: the
  lobby, main room, auth, tournament, leaderboard, voice and safety handlers
  (`Networking/Handlers`) read `[String: Any]` by hand (`guard let ... as?`
  drops the event when a key is missing), and only the schema baselines
  hold those.

`contract/lib/decodeRules.js` holds the floors' two named exceptions, used by
the test and the release step alike:

- `DECODE_WAIVED`: mismatches that cannot reach iOS, with why (today:
  `stateSnapshot.requestId`, an echo of the asker's own String). It applies
  to every build that has the mismatch; the test fails a waiver no frozen
  build needs any more.
- `DECODE_RELIED`: properties a build decodes as optional but needs once a
  planned removal takes its fallback, held for the listed builds as if they
  were not optional (required, non-null). Empty since `MIN_IOS_BUILD` 41: its
  one entry, `positionUpdate.isBot` for 6, 7 and 8 (they read it first and
  the `bot:` prefix of `positionUpdate.sockets` only as the fallback, and
  V1_REMOVALS #14 drops `sockets`), went with those builds. Drop a build
  from an entry when it is retired.

| Build | Files | Archived from | Status |
| --- | --- | --- | --- |
| iOS 1.2.7 (41) | `ios-1.2.7-b41.*` | 34014b99 (main, the #420 merge of ios/1.2.7 with #421's Get Your Bid; frozen 2026-11-25: 1.2.6 (40) plus the tournament pairings and the draw for first deal (cap `tournamentPairings`, decodes the optional `startDraw.teams` and snapshot `draw.teams`, `startDraw` itself decoded with `try?`), the update screen (`updateRequired`), badges (cap `badges`, `badgesAwarded`), Cut for a buck (cap `cutForABuck`), the host's round count (`setTournamentRounds`), the tournament voice status (cap `tournamentVoiceStatus`) and Get Your Bid (sends the cap `getYourBid`; decodes the optional `gyb` on gameStart, doneBidding, handComplete and the snapshot carriers through `GetYourBid.swift`'s lenient decoders, which contract/lib/swiftDecodes.js now reads: `try? decoder.container` with `c.flatMap { try? $0.decode(...) }`, every such read optional); the schema is byte-identical to main's contract at freeze time; the `stateSnapshot.requestId` waiver holds: `GameEmitter.requestSnapshot(requestId: String)`) | submitted for App Store review 2026-11-25, replaced in that review by build 42 on 2026-11-26 (App Store review) |
| iOS 1.2.7 (42) | `ios-1.2.7-b42.*` | 2f61394a (main, the #423 merge of ios/1.2.7-b42; frozen 2026-11-26: 1.2.7 (41) plus the cut's intro over the list as well as the ring, the list's intro cover over every row, the ring's title fading with the stage, and the badges UI tests scrolling whole tiles on the closed Duo (#423), and the a11y test's `table.seats` probe allowlist (#424); no wire change, and the decode floor reads the same sources as 41's; the schema is byte-identical to main's contract at freeze time; the `stateSnapshot.requestId` waiver holds) | uploaded to TestFlight and swapped into the 1.2.7 review for build 41 2026-11-26; released (1.2.7 is live) |
| iOS 1.2.8 (43) | `ios-1.2.8-b43.*` | 751e40e1 (branch release/ios-1.2.8-b43: PR #430's first commit e24201e8 with only MARKETING_VERSION 1.2.8 and CURRENT_PROJECT_VERSION 43 set; frozen 2026-11-26 in the 1.2.8 release PR: 1.2.7 (42) plus the simpler tournament lobby, the native New Game menu and the turn haptic (#430, no wire change), and from main the additive optional `positionUpdate.owners` (#429), which this build decodes leniently (`WirePayload.Owners`); the schema is that commit's contract (it differs from today's only in the `notes` of `startDraw` and `clientHello`, #417's honest draw); the `stateSnapshot.requestId` waiver holds: `GameEmitter.requestSnapshot(requestId: String)`) | uploaded to TestFlight 2026-11-26 (App Store Connect API key), not submitted |
| iOS 1.2.8 (44) | `ios-1.2.8-b44.*` | bae8f71a (branch release/ios-1.2.8-b44: PR #430's merge commit 27b2b16c (the in-menu confirms of ios/lobby-confirm-in-menu) with only the version set to 1.2.8 (44); frozen 2026-11-26 in the 1.2.8 release PR: 1.2.8 (43) plus the lobby's confirms inside the "…" menu and Leave worded as the server behaves; no wire change: the decode floor equals 43's but for its build and commit, and the schema is byte-identical to 43's; the `stateSnapshot.requestId` waiver holds) | uploaded to TestFlight 2026-11-26 (App Store Connect API key), not submitted |
| iOS 1.2.8 (45) | `ios-1.2.8-b45.*` | ba335324 (main's merge commit of the 1.2.8 release PR #431, which build 45 is archived from; frozen 2026-11-26 in a follow-up PR as #426 did for 42: 1.2.8 (44) plus the review nits (the restored and between-round Leave wording, menu rows without icons, "1 player"); no wire change; the `stateSnapshot.requestId` waiver holds) | submitted for review 2026-11-26 (App Store Connect API key); replaced in review by 46 on 2026-11-27, never released |
| iOS 1.2.8 (46) | `ios-1.2.8-b46.*` | 1a947d83 (main's merge commit of the 1.2.8 (46) release PR #439, which build 46 is archived from; frozen 2026-11-27 in a follow-up PR: 1.2.8 (45) plus the one-level tournament lobby controls with centred alerts (#437) and the host's Leave and End Tournament icons, Tournament in New Game and the trophy opening the leaderboard (#438); no iOS wire change: the decode floor equals 45's but for its build and commit; the schema is 45's plus the additive SFU voice wire main gained since (#433 server, #434 web: `$defs.sfu*`, the cap `sfuVoice`, c2s sfu* `sentBy` web, s2c sfuReply / sfuRoster / sfuMember), none of which this build sends or reads; the `stateSnapshot.requestId` waiver holds) | uploaded 2026-11-27 (App Store Connect API key), on TestFlight (internal) and swapped into the 1.2.8 review for build 45; replaced in review by 47 the same day |
| iOS 1.2.8 (47) | `ios-1.2.8-b47.*` | a4fa0d27 (branch release/ios-1.2.8-b47, which build 47 is archived from: 46's commit 1a947d83 plus a cherry-pick of the host-ended toast's words (#441) and the version 47, so it carries none of main's iOS SFU voice code (#435); frozen 2026-11-27 in a follow-up PR; no wire change: the schema is byte-identical to 46's and the decode floor equals 46's but for its build and commit; the `stateSnapshot.requestId` waiver holds) | uploaded 2026-11-27 (App Store Connect API key), on TestFlight (internal) and swapped into the 1.2.8 review for build 46; replaced in review by 48 the same day |
| iOS 1.2.8 (48) | `ios-1.2.8-b48.*` | 12b75d51 (branch release/ios-1.2.8-b48, which build 48 is archived from: 47's commit a4fa0d27 plus a cherry-pick of the gold trophy (#444) and the version 48; no SFU code; frozen 2026-11-27 in a follow-up PR; no wire change: the schema is byte-identical to 47's and the decode floor equals 47's but for its build and commit; the `stateSnapshot.requestId` waiver holds) | uploaded 2026-11-27 (App Store Connect API key), on TestFlight (internal) and swapped into the 1.2.8 review for build 47; replaced in review by 49 the same day |
| iOS 1.2.8 (49) | `ios-1.2.8-b49.*` | fb55650b (branch release/ios-1.2.8-b49, which build 49 is archived from: 48's commit 12b75d51 plus cherry-picks of #447 (the tournament lobby's bar like the game's) and #448 (the trophy in the bar's bottom pill, white) and the version 49; no SFU code; frozen 2026-11-27 in a follow-up PR; no wire change: the schema is byte-identical to 48's and the decode floor equals 48's but for its build and commit; the `stateSnapshot.requestId` waiver holds) | uploaded 2026-11-27 (App Store Connect API key), on TestFlight (internal) and swapped into the 1.2.8 review for build 48; replaced in review by 50 the same day |
| iOS 1.2.8 (50) | `ios-1.2.8-b50.*` | 426563e2 (branch release/ios-1.2.8-b50, which build 50 is archived from: 49's commit fb55650b plus #451 (Players search) and #453 (the restore-answer wait) and the version 50, plus a UI-test-only fix; no SFU code; frozen 2026-11-27 in its release PR; wire: iOS now sends searchPlayers and reads searchPlayersResponse, both already served (the schema differs from 49's only in those entries); the decode floor equals 49's but for its build and commit; the `stateSnapshot.requestId` waiver holds) | uploaded 2026-11-27 (App Store Connect API key), on TestFlight (internal) and swapped into the 1.2.8 review for build 49; replaced in review by 51 the next day |
| iOS 1.2.8 (51) | `ios-1.2.8-b51.*` | e43fb1ca (branch release/ios-1.2.8-b51, which build 51 is archived from: 50's commit 426563e2 plus #454 (the online list's pictures: playerCards / playerCardsResponse) and #452 (the lobby's back chevron) and the version 51; no SFU code; frozen 2026-11-28 in its release PR; the `stateSnapshot.requestId` waiver holds) | uploaded 2026-11-28 (App Store Connect API key), on TestFlight (internal) and swapped into the 1.2.8 review for build 50; replaced in review by 52 the same day |
| iOS 1.2.8 (52) | `ios-1.2.8-b52.*` | 914e622a (branch release/ios-1.2.8-b52, which build 52 is archived from: 51's commit e43fb1ca plus #455 (the scorecard: handComplete.scorecardRow, gameStart.scorecardRows, snapshot scorecard, gameEnd.scorecard; Scorecard.swift read from this build) and the version 52; no SFU code; frozen 2026-11-28 in its release PR; the `stateSnapshot.requestId` waiver holds) | uploaded 2026-11-28 (App Store Connect API key), on TestFlight (internal) and swapped into the 1.2.8 review for build 51 |


Retired 2026-11-25 (PR "[after 1.2.7 is live] Upgrade gate: require iOS
build 41 (1.2.7)", merged once 1.2.7 was READY_FOR_SALE; owner decision
2026-11-25: hard-block the old versions): 1.2.0 (6), 1.2.1 (7, 8, 9), 1.2.2
(10 to 13), 1.2.3 (14 to 31), 1.2.4 (32 to 38), 1.2.5 (39) and 1.2.6 (40).
`MIN_IOS_BUILD` 41 gates them, so they only get the update message
(`server/socket/upgradeGate.js`). Their files and rows, with each build's
archive commit (build 6: 83a3f8f; build 40: 51463a5), are in git history
at the commit before the retirement; `npm run contract:baseline -- --check`
needs them only for frozen builds.

Never here: builds 3 to 5 (build 5 was replaced by 6 with the same source;
TestFlight builds 3, 29f3536, and 4, 0acc10a, were never frozen: the
removals of 2026-11-12/13 were re-checked against build 5, not them). What
they relied on beyond build 5 was held in prose only (V1_REMOVALS #14: the
`bot:` prefix of `positionUpdate.sockets`). `MIN_IOS_BUILD` 41 gates them
too, so that prose no longer holds anything back.

## Release step: freeze a build when it is uploaded

When a build is uploaded to App Store Connect (TestFlight or review), from
the commit it was archived from:

```bash
npm run contract:baseline -- --build 40                  # HEAD must be build 40 (CURRENT_PROJECT_VERSION)
npm run contract:baseline -- --build 40 --commit <sha>   # or the archive's commit
```

It refuses a commit whose project is another build, and a build already
frozen. It prints any mismatch today's contract already has with the new
build (fix those first), and apart from them the ones `DECODE_WAIVED`
covers (check each reason holds for the new build). Add the row above, run
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

Hand edits made at freeze time (2026-11-15; history: builds 6 to 8 are
retired), identical for 6, 7 and 8 (the
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
after), drop its row and take it out of `DECODE_RELIED` (decodeRules.js).
`additiveOnly.test.js` fails while a gated build still has a baseline ("a
build MIN_IOS_BUILD gates is retired"), and while no build at or above
`MIN_IOS_BUILD` is frozen ("the floor build is frozen": freeze the floor
first, at its upload). Tests that read a named build's baseline must read
the frozen set instead (`restoreWire.test.js` and `cutForABuck.test.js` take
the oldest frozen build / every frozen build). A build no one can install (rejected
before TestFlight, expired) is retired the same way; a TestFlight build stays
installable for testers, so retiring one early is an owner decision. What
only the retired builds read can then go through V1_REMOVALS.
