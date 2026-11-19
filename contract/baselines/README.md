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
  `WireDecoding.swift`, the generated `TableSnapshot.swift`, `Card.swift`).
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
  were not optional (required, non-null). Today: `positionUpdate.isBot` for
  6, 7 and 8. They read it first and the `bot:` prefix of
  `positionUpdate.sockets` only as the fallback, and V1_REMOVALS #14 drops
  `sockets` next. It reached main (b1304c1) after all three were cut, so no
  schema baseline here has it. Drop a build from an entry when it is
  retired.

| Build | Files | Archived from | Status |
| --- | --- | --- | --- |
| iOS 1.2.0 (6) | `ios-1.2.0-b6.*` | 83a3f8f (PR #244, merged as 775a2e0; `contract/` and `iOSClient/BABOnline` are 92d0c75's, build 5's source, but for the icon assets) | App Store, live 2026-11-13 |
| iOS 1.2.1 (7) | `ios-1.2.1-b7.*` | 6f11cb1 (PR #260 "version 1.2.1 (build 7)", dac6fdc; after #255, before #261's icon, which is build 8's) | TestFlight |
| iOS 1.2.1 (8) | `ios-1.2.1-b8.*` | d3ebe76 (PR #262 merged; its iOS source is 7e73df1's, the build 8 commit, and its contract adds #263's stats `scope` echo, which build 8's Humans / Bots / All control reads) | submitted for review 2026-11-14 |
| iOS 1.2.1 (9) | `ios-1.2.1-b9.*` | ae9a95c (PR #279 "ios/build-9" merged; every main commit through 8bf93ad has the same `iOSClient/BABOnline` and `contract/src`, so the baseline is the same whichever of them was archived; frozen 2026-11-16) | 1.2.1 released |
| iOS 1.2.2 (10) | `ios-1.2.2-b10.*` | a805147 (branch ios/1.2.2, frozen 2026-11-16 before its PR merged; archived from main 3f9863a, which adds only the first-deal corner-button fix and the AdminApi warnings fix, no file the floor or schema reads; iOS sends string requestIds, so the `stateSnapshot.requestId` waiver holds) | TestFlight 2026-11-16, not submitted |
| iOS 1.2.2 (11) | `ios-1.2.2-b11.*` | cd9e11c (branch ios/build-11, frozen 2026-11-16 before its PR merged; the merge commit on main has the same `iOSClient/BABOnline` and `contract/src`; the schema is byte-identical to build 10's and the floor differs only in its build and commit; the `stateSnapshot.requestId` waiver holds as for 10) | submitted for review 2026-11-16, pulled from review the same day for build 12 |
| iOS 1.2.2 (12) | `ios-1.2.2-b12.*` | eb46746 (branch nits/family-nits, frozen 2026-11-16 before PR #310 merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: family lobbies, spectator voice, play again with members[].onResults, polish, the lobby-header and spectator-label fixes; build 12 replaces 1.2.2 (11), pulled from review, so it stays 1.2.2; the `stateSnapshot.requestId` waiver holds) | submitted for review, pulled from review 2026-11-17 for build 13 |
| iOS 1.2.2 (13) | `ios-1.2.2-b13.*` | 523a1f9 (branch release/ios-1.2.2-b13, frozen 2026-11-17 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: build 12 plus the 390 pt card-back fans fix (#313), the voice-test hardening (#312) and the refreshed boot splash with the sign-in / register in the web's style (#314); no wire change, so the contract and decodes match build 12's; still 1.2.2, it replaced build 12 in review; the `stateSnapshot.requestId` waiver holds) | submitted for review 2026-11-17, released 2026-11-17 |
| iOS 1.2.3 (14) | `ios-1.2.3-b14.*` | 28356eb (branch release/ios-1.2.3-b14, frozen 2026-11-18 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.2 (13) plus teams labelled by player names (#318), voice on the loudspeaker (#320) and the one-time voice panel tip (#322); no wire change, so the contract and decodes match build 13's; 1.2.2 (13) was released 2026-11-17, so build 14 is 1.2.3; the `stateSnapshot.requestId` waiver holds) | uploaded to TestFlight 2026-11-18, not submitted |
| iOS 1.2.3 (15) | `ios-1.2.3-b15.*` | a41dd0eb (branch release/ios-1.2.3-b15, frozen 2026-11-18 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (14) plus the bid clock (#330: decodes the unsequenced s2c `bidClock` and the snapshot's optional `bidClock`), the voice panel long press (#326) and the paced loudspeaker safety net (#327); build 14 went only to TestFlight, so build 15 is still 1.2.3; the `stateSnapshot.requestId` waiver holds) | uploaded to TestFlight 2026-11-18 |
| iOS 1.2.3 (16) | `ios-1.2.3-b16.*` | 741b8794 (branch ios/sound-off-main, frozen 2026-11-19 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (15) plus table sounds off the main thread; no wire change, so the contract and decodes match build 15's; still 1.2.3; the `stateSnapshot.requestId` waiver holds) | uploaded to TestFlight 2026-11-18 |
| iOS 1.2.3 (17) | `ios-1.2.3-b17.*` | 24aa004c (branch voice/defaults, frozen 2026-11-18 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (16) plus the voice defaults (mic muted to start, spectators always may talk, no voice while the only human, lobby header Ready n/4); additive: decodes the new unsequenced s2c `seatLeft`; still 1.2.3; the `stateSnapshot.requestId` waiver holds) | never uploaded: the TestFlight build named 1.2.3 (17) (2026-11-19) is build 16's archive renumbered by Organizer (its code and decodes are build 16's, held by `ios-1.2.3-b16.*`); a real 17 was then refused as a duplicate, and its code went up as build 18 (709238a8, only the build number raised). Kept: still the frozen floor of the 17 source |
| iOS 1.2.3 (18) | `ios-1.2.3-b18.*` | 709238a8 (branch release/ios-1.2.3-b18-voice, frozen 2026-11-19: the build 17 source (94ca3de5, the #335 merge) with only CURRENT_PROJECT_VERSION raised to 18, uploaded so the voice defaults reach TestFlight (its "17" is build 16's code); the same decodes as 1.2.3 (17); still 1.2.3; the `stateSnapshot.requestId` waiver holds) | uploaded to TestFlight 2026-11-19 |
| iOS 1.2.3 (19) | `ios-1.2.3-b19.*` | f5c0a9f1 (branch ios/build-18, frozen 2026-11-19 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (18) plus /help at the table and the toast follow-ups; additive: decodes the new private, unsequenced s2c `assistHint` (every field optional), `gameLogEntry.fault` and the snapshot's optional `log[].fault` and `viewer.assist`; the two lenient decoders read through a local `opt(T.self, .key)` helper, which contract/lib/swiftDecodes.js now reads as optional; still 1.2.3; the `stateSnapshot.requestId` waiver holds; archived from cde1e467, the #339 merge) | uploaded to TestFlight 2026-11-19 |
| iOS 1.2.3 (20) | `ios-1.2.3-b20.*` | ee85eecc (branch ios/bulb-clear-seat-row, frozen 2026-11-19 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (19) plus the play-turn lightbulb kept off my seat row; no wire change, so the contract and decodes match build 19's; still 1.2.3; the `stateSnapshot.requestId` waiver holds) | to be uploaded to TestFlight |

Not here: builds 3 to 5. Build 5 was replaced by 6 with the
same source. TestFlight builds 3 (29f3536, uploaded, never submitted) and 4
(0acc10a, pulled from review) are not gated (MIN_IOS_BUILD 3) and may still
be installed by testers, but the guard does NOT protect them: the removals
of 2026-11-12/13 were re-checked against build 5, not against them, so a
frozen schema for them could not be hand-edited honestly. What they rely on
beyond build 5 is held in prose only (V1_REMOVALS #14: they tell a bot only
by the `bot:` prefix of `positionUpdate.sockets`, so it stays until the
owner accepts that for TestFlight or MIN_IOS_BUILD is 5). For the record,
their decode floors, read from 29f3536 and 0acc10a on 2026-11-15, pass
today's schema except the waived `stateSnapshot.requestId`. (1.2.1 (9) is now frozen, above.) The three floors are identical; today's Swift differs only by
no longer declaring the optional `gameStart.players` (dropped by #6).

## Release step: freeze a build when it is uploaded

When a build is uploaded to App Store Connect (TestFlight or review), from
the commit it was archived from:

```bash
npm run contract:baseline -- --build 20                  # HEAD must be build 20 (CURRENT_PROJECT_VERSION)
npm run contract:baseline -- --build 20 --commit <sha>   # or the archive's commit
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
after), drop its row and take it out of `DECODE_RELIED` (decodeRules.js).
`additiveOnly.test.js` fails while a gated build still has a baseline ("a
build MIN_IOS_BUILD gates is retired"). A build no one can install (rejected
before TestFlight, expired) is retired the same way; a TestFlight build stays
installable for testers, so retiring one early is an owner decision. What
only the retired builds read can then go through V1_REMOVALS.
