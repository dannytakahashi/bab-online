# Backlog: known issues and ideas

Small, known, non-blocking items the owner chose to defer. Add new ones here and
remove an item in the PR that fixes it.

## Get Your Bid (web, 2026-11-24)

First version; each of these was left out on purpose (`server/CLAUDE.md` "Get Your Bid").

- **Rainbow bonus: none.** The owner's scoring lists no rainbow, so the mode has
  none. If the 4-card hand's +10 should apply per player, it is a rule change in
  `gameHandlers.handlePostBid` / `scoreGybHand` and one line in docs/RULES.md.
- **No statistics, standings or game records.** A finished game writes nothing.
  Counting them needs a record shape for three solo players first (the
  `gameRecords` doc and the 12 stats are all per team).
- **Not saved across a deploy.** `gameCodec` refuses the mode, so a table in
  progress ends with the usual "interrupted by a server update" notice even
  with `LIVE_PERSIST=on`.
- **The bots are simple.** `gybStrategy.js` bids the hand's expected tricks and
  then takes or ducks trick by trick; it keeps no card memory and never plays
  to make an opponent miss.
- **No iOS.** An app is refused with "Get Your Bid is not available in this app
  yet"; such lobbies and tables are not listed for it.
- **Not checked by eye:** three humans in three browsers, a spectator's and the
  over-the-shoulder view of such a table, voice, Safari / Firefox, window sizes
  other than 1600 x 900.

## iOS: iPad (since 1.2.0 build 5, PR #241)

- **Draw for Deal cards don't grow on iPad** (the owner's top pick of the three).
  The table is drawn at `textureZoom` 1.4 on iPad, but `DrawPhaseView`'s cards keep
  their phone size, so they look small beside the bigger table.
- **The table still shrinks mid-hand when the disconnect banner gets tall.** The
  iPad table keeps one size through a game, except when the disconnect banner
  is taller than about 60 pt: two disconnected players, or one plus the
  Replace-with-Bot row. Then the zoom steps down to keep the banner clear of the cards.
- **11-inch iPad, landscape, with a timeout row: the banner covers the partner.**
  Even the smallest zoom leaves no room for it there (the same as before #241).

## iOS: other

- **Web pages iOS still lacks** (after the Stats sheet's Records tab): other players' profiles
  (avatar, the 12-stat grid, Report / Block; web opens them from seat avatars
  and opponent plates); my own profile (the same stats, choose a stock avatar or
  upload a picture, sign out and delete are already in Account settings). iOS also
  never shows a custom picture sent inline to a cap-less socket (it sends the cap).

- **Duo inner App Store screenshots** were last shot with build 4: the table shots
  show the old Leave icon and two exits when spectating. Re-shoot them with
  Device Hub's Open posture for the next release.
- **The Leave alert can show stale words for up to ~1.5 s** after the other human
  leaves while it is open (`LeaveAlertFlow`, `leaveCheck`).

## Server

- **An entrant whose socket is rebuilt during a game's DRAWING stage is not
  rejoined:** `restoreSession` (and sign-in) read the user's `activeGameId`, which
  `setActiveGame` writes only at seating (`gameHandlers.js`, after the draw;
  `tournamentHandlers.js` the same), so the restore answers with no
  `activeGameId` and the app goes to the main room while the game is dealt
  without them (their seat then waits on the disconnect / bot timers). Seen in
  review of the iOS foreground keep (2026-11-14); any rebuild in the draw does it
  (a foreground probe that times out, a deploy, a network change). Fix: when the
  database has no `activeGameId`, fall back to the in-memory
  `gameManager.findLiveActivity(username)` (which already counts draw-phase
  entrants, as the admin merge check uses it) and answer with that game so the
  client rejoins it (`rejoinGame` must then accept an entrant in the draw and send
  the draw snapshot); or write `activeGameId` when the game is created, at the
  start of DRAWING, instead of at seating. A jest case: restore an entrant's
  session mid-draw and expect `activeGameId` and a draw-stage rejoin.
- **Play again: no "Don't wait" for someone still on the results** (web review
  of PR E, finding 5; 2026-11-16). Their row now says "Still on the results"
  on both clients (`members[].onResults`, 2026-11-16), but in a lobby of 4 the
  others still wait for that person's Ready (voice runs through the results,
  so they can call them back; a lobby of more than 4 leaves them out at the
  next start, `playAgain.leftOnResults`). If that wait turns out to matter:
  the host's "Don't wait" for such a row, a leave that keeps the ready flags
  (leftLobby to them; their Return then goes to the main room), on both
  clients. Not done because they are present and connected.

## Web

- **Admin Players table, Safari:** a sliver of rows can still show above the sticky
  column header at some scroll positions in the owner's Safari, even with only the
  table scrolling (#247); it did not reproduce in WebKit or Chromium here. The
  leak-proof version draws the header row outside the scroll area, which needs
  extra wiring to keep the header cells tied to the table for screen readers.
