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
- **One extra restore after a long background:** a connection that had already
  recovered is still replaced (`forceReconnect`, about 2 s).
