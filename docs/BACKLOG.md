# Backlog: known issues and ideas

Small, known, non-blocking items the owner chose to defer. Add new ones here and
remove an item in the PR that fixes it.

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

- **First bid of a game on iPhone: the corner buttons sit about 40 pt low** (live check
  2026-11-16, iOS 1.2.2). Right after Draw for Deal, Exit and the log button were placed
  below their usual spot for the first bid (`cornerButtons` pads by `chrome.topBar + 8`,
  and the score bar's first measurement is a wrapped ~109 pt: the comment at
  `GameContainerView.tablePane`); later frames are right. With the 1.2.2 card backs the
  log button then covers a few points of the right seat's fan. Cosmetic, transient.

- **Web pages iOS still lacks** (after the Stats sheet's Records tab): player search
  (web Players: search as you type, rows open a profile); other players' profiles
  (avatar, the 12-stat grid, Report / Block; web opens them from search, seat avatars
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

## Web

- **Admin Players table, Safari:** a sliver of rows can still show above the sticky
  column header at some scroll positions in the owner's Safari, even with only the
  table scrolling (#247); it did not reproduce in WebKit or Chromium here. The
  leak-proof version draws the header row outside the scroll area, which needs
  extra wiring to keep the header cells tied to the table for screen readers.
