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
  and, from 1.2.7 (41), `State/Table/GetYourBid.swift`, which an older
  build's floor never read: `SOURCES_FROM` in `contract/baseline.js`).
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
| iOS 1.2.7 (42) | `ios-1.2.7-b42.*` | 2f61394a (main, the #423 merge of ios/1.2.7-b42; frozen 2026-11-26: 1.2.7 (41) plus the cut's intro over the list as well as the ring, the list's intro cover over every row, the ring's title fading with the stage, and the badges UI tests scrolling whole tiles on the closed Duo (#423), and the a11y test's `table.seats` probe allowlist (#424); no wire change, and the decode floor reads the same sources as 41's; the schema is byte-identical to main's contract at freeze time; the `stateSnapshot.requestId` waiver holds) | uploaded to TestFlight and swapped into the 1.2.7 review for build 41 2026-11-26 (App Store review) |


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
