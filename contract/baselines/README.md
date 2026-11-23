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
| iOS 1.2.3 (20) | `ios-1.2.3-b20.*` | ee85eecc (branch ios/bulb-clear-seat-row, frozen 2026-11-19 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (19) plus the play-turn lightbulb kept off my seat row; no wire change, so the contract and decodes match build 19's; still 1.2.3; the `stateSnapshot.requestId` waiver holds; archived from 5bb751f5, the #342 merge) | uploaded to TestFlight 2026-11-19 |
| iOS 1.2.3 (21) | `ios-1.2.3-b21.*` | dd4a491c (branch ios/build-21, frozen 2026-11-20 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (20) plus the tutorial and the session unmute; additive: decodes the private s2c `assistState`, `assistHint` source tutorial / kind tip (`tipId`, `actions`) and the snapshot's optional `viewer.assist.tutorial` / `auto`; sends the cap `tutorial`; still 1.2.3; the `stateSnapshot.requestId` waiver holds) archived from 3e66adbf, the #347 merge | uploaded to TestFlight 2026-11-20 |
| iOS 1.2.3 (22) | `ios-1.2.3-b22.*` | b394f499 (branch ios/build-22-hsi, frozen 2026-11-20 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (21) plus the HSI reveal and colour and the live rainbow row; no wire change, so the contract and decodes match build 21's; still 1.2.3; the `stateSnapshot.requestId` waiver holds) archived from 66c25297, the #348 merge | uploaded to TestFlight 2026-11-20 |
| iOS 1.2.3 (23) | `ios-1.2.3-b23.*` | e7666dee (branch ios/four-colour, frozen 2026-11-20 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (22) plus the four-colour deck; no wire change, so the contract and decodes match build 22's; still 1.2.3; the `stateSnapshot.requestId` waiver holds) archived from bb3cff4d, the #350 merge | uploaded to TestFlight 2026-11-20 |
| iOS 1.2.3 (24) | `ios-1.2.3-b24.*` | e537504 (branch ios/superlatives, frozen 2026-11-20 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (23) plus the Records superlatives, read by hand from `recordsResponse.records.<period>.superlatives` (#351; `recordsPeriod` is open, so the frozen decodes are unchanged); still 1.2.3; the `stateSnapshot.requestId` waiver holds) archived from 638aed6e, the #352 merge | uploaded to TestFlight 2026-11-20, submitted for review 2026-11-20 |
| iOS 1.2.3 (25) | `ios-1.2.3-b25.*` | fdb1793 (branch clients/online-left, frozen 2026-11-20 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (24) plus `mainRoomPlayerLeft` read like `mainRoomPlayerJoined` (`LobbySocketHandler.applyOnlineList`; the payload is unchanged); still 1.2.3; the `stateSnapshot.requestId` waiver holds) archived from 982cdb9e (the PR #355 head; its merge f56bc6c4 has the same `iOSClient/BABOnline`) | uploaded to TestFlight 2026-11-20, submitted for review 2026-11-20 (replaced in review by build 26) |
| iOS 1.2.3 (26) | `ios-1.2.3-b26.*` | a42fdcf (branch tutorial/welcome-once, frozen 2026-11-20 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (25) plus the tutorial's welcome shown once (no wire change); still 1.2.3; the `stateSnapshot.requestId` waiver holds) | archived from 9ccdadfd (the PR #357 head; its merge 3ce5c1eb has the same `iOSClient/BABOnline`) | uploaded to TestFlight 2026-11-20, submitted for review 2026-11-20 |
| iOS 1.2.3 (27) | `ios-1.2.3-b27.*` | 48dcbdf (branch ios/duo-tutorial-bar, frozen 2026-11-21 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (26) plus /help's lightbulb and the tutorial's switch in the iPhone Duo's vertical bar (no wire change); still 1.2.3; the `stateSnapshot.requestId` waiver holds) | archived from 7a122cb5 (the PR #359 head; its merge 9be179dd has the same `iOSClient/BABOnline`) | uploaded to TestFlight 2026-11-20 (with the App Store Connect API key), submitted for review 2026-11-20 |
| iOS 1.2.3 (28) | `ios-1.2.3-b28.*` | 9a7ee21 (branch ios/welcome-head-actions, frozen 2026-11-21 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (27) plus the welcome tip's fixes and the Duo bar's tutorial switch shown while off, which sends the existing chat line /tutorial on (no wire change); still 1.2.3; the `stateSnapshot.requestId` waiver holds) | archived from 6cfc9943 (the PR #360 head; its merge fe94f438 has the same `iOSClient/BABOnline`) | uploaded to TestFlight 2026-11-20 (with the App Store Connect API key), submitted for review 2026-11-20 |
| iOS 1.2.3 (29) | `ios-1.2.3-b29.*` | 87093dc (branch ios/tutorial-corner-button, frozen 2026-11-21 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (28) plus the tutorial's corner button on iPhone and iPad and the question before turning it on (no wire change: the existing chat lines /tutorial on and off) and the Duo's draw for deal on the table pane; the regenerated TableSnapshot.swift of #363 (additive optionals: viewer.shoulder, spectator shoulder) decodes but nothing reads it, and it sends no `shoulderView` cap; still 1.2.3; the `stateSnapshot.requestId` waiver holds) | archived from f0da692d (the PR #364 head; its merge ac52c09f has the same `iOSClient/BABOnline`) | uploaded to TestFlight 2026-11-21 (with the App Store Connect API key) |
| iOS 1.2.3 (30) | `ios-1.2.3-b30.*` | 6f29409 (branch ios/draw-without-log, frozen 2026-11-21 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (29) plus no docked log during the draw with the Duo fully open (no wire change); still 1.2.3; the `stateSnapshot.requestId` waiver holds) | archived from f1482d7b (the PR #365 head; its merge has the same `iOSClient/BABOnline`) | uploaded to TestFlight and swapped into review 2026-11-21 (with the App Store Connect API key) |
| iOS 1.2.3 (31) | `ios-1.2.3-b31.*` | 1a615c17 (branch ios/release-1.2.3-b31, frozen 2026-11-21 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (30) plus the over-the-shoulder spectator view (#368, #369, #371): sends the `shoulderView` cap and the c2s `watchHand`, reads `viewer.shoulder`, `watchHandRefused`, `gameStart.shoulder`, `assistHint.watched` and the private `spectatorsUpdated` `shoulder`; still 1.2.3; the `stateSnapshot.requestId` waiver holds) | archived from a92d7bb3 (the PR #373 head; its merge b2e6d967 has the same `iOSClient/BABOnline`) | uploaded to TestFlight 2026-11-21 (with the App Store Connect API key) |
| iOS 1.2.4 (32) | `ios-1.2.4-b32.*` | 8bc0c204 (branch ios/release-1.2.4-b32, frozen 2026-11-21 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.3 (31) plus the watched player's chat bubble above the hand and the read-only bid sheet's short line (#374; no wire change); 1.2.3 (30) was released, so 1.2.4; the `stateSnapshot.requestId` waiver holds) | uploaded to TestFlight and submitted for review 2026-11-21 (with the App Store Connect API key) |
| iOS 1.2.4 (33) | `ios-1.2.4-b33.*` | 387a7bca (branch ios/release-1.2.4-b33, frozen 2026-11-21 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.4 (32) plus the spectator's eye by the watched hand only while someone else watches it (#376, #377; no wire change); the `stateSnapshot.requestId` waiver holds) | uploaded to TestFlight and swapped into the 1.2.4 review for build 32 2026-11-22 (App Store Connect API key) |
| iOS 1.2.4 (34) | `ios-1.2.4-b34.*` | 543d3bf4 (branch ios/release-1.2.4-b34, frozen 2026-11-22 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.4 (33) plus the sound volume slider reaching 0 (#380) and the help-stats copy for the on-a-win rule (#381); no wire change; the `stateSnapshot.requestId` waiver holds) | uploaded to TestFlight and swapped into the 1.2.4 review for build 33 2026-11-22 (App Store Connect API key) |
| iOS 1.2.4 (35) | `ios-1.2.4-b35.*` | fc440d9c (branch ios/release-1.2.4-b35, frozen 2026-11-22 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.4 (34) plus the spectator badge's green speaking outline (#385) and the Duo's vertical-bar mic (#386); no wire change; the `stateSnapshot.requestId` waiver holds) | uploaded to TestFlight and swapped into the 1.2.4 review for build 34 2026-11-22 (App Store Connect API key) |
| iOS 1.2.4 (36) | `ios-1.2.4-b36.*` | 50f317a5 (branch ios/release-1.2.4-b36, frozen 2026-11-22 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.4 (35) plus the bubbles' VoiceOver frames (#389); no wire change; the `stateSnapshot.requestId` waiver holds) | uploaded to TestFlight and swapped into the 1.2.4 review for build 35 2026-11-22 (App Store Connect API key) |
| iOS 1.2.4 (37) | `ios-1.2.4-b37.*` | 5dc81d7b (branch ios/release-1.2.4-b37, frozen 2026-11-22 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.4 (36) plus the game end's fanfare and sad trombone (#391); no wire change; the `stateSnapshot.requestId` waiver holds) | uploaded to TestFlight and swapped into the 1.2.4 review for build 36 2026-11-22 (App Store Connect API key) |
| iOS 1.2.4 (38) | `ios-1.2.4-b38.*` | BUMP38 (branch ios/release-1.2.4-b38, frozen 2026-11-23 before its PR merged; main's merge has the same `iOSClient/BABOnline` and `contract/src`: 1.2.4 (37) plus the gold /help room notice (#393): the additive optional `help {position}` on gameLogEntry and snapshot log items, which this build decodes leniently; the `stateSnapshot.requestId` waiver holds) | to be uploaded to TestFlight |

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
npm run contract:baseline -- --build 38                  # HEAD must be build 38 (CURRENT_PROJECT_VERSION)
npm run contract:baseline -- --build 38 --commit <sha>   # or the archive's commit
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
