# Back Alley Bridge - Game Rules

Back Alley Bridge is a 4-player trick-taking card game, a simplified form of contract bridge. This document describes the complete rules as played by the family tradition.

## Overview

- **Players**: 4 (2 teams of 2 partners)
- **Deck**: Standard 54-card deck (52 cards + 2 jokers: HI and LO)
- **Objective**: Score the most points across all hands by accurately bidding and winning tricks

---

## Game Setup

### Drawing for Positions

At the start of the game, each player draws a card from a shuffled deck. This determines:

1. **Dealer**: The player with the highest card deals first
2. **Partners**: The two players with the higher cards become partners (Team 1), and the two with lower cards become partners (Team 2)

Partners sit across from each other at the table (positions 1 & 3 vs positions 2 & 4).

**Tie-breaking**: If two cards have the same rank, suit order breaks the tie: clubs < diamonds < hearts < spades.

**In a tournament**, partners are set by the round's plan and shown before the draw (partners rotate from round to round); the draw decides seats and who deals first. The player with the highest card deals first and sits with their partner at positions 1 & 3; of the other team, the player with the higher card sits at position 2 (and bids first), their partner at position 4.

---

## Hand Progression

The game consists of 13 hands with varying card counts:

```
12 → 10 → 8 → 6 → 4 → 2 → 1 → 3 → 5 → 7 → 9 → 11 → 13
```

- Start with 12 cards per player
- Decrease by 2 each hand down to 2 cards
- Play the 1-card hand
- Increase by 2 through odd numbers up to 13 cards
- Game ends after the 13-card hand

---

## Trump

Before each hand, after dealing, one card is flipped from the remaining deck to determine the trump suit for that hand.

**Trump hierarchy** (highest to lowest):
1. HI joker (highest)
2. LO joker
3. Ace of trump suit
4. King of trump suit
5. ... down to 2 of trump suit

Both jokers are always considered trump suit, regardless of the flipped trump card.

### No Trump (Joker Flipped)

If a joker is flipped as the trump card, the hand is played with **no trump suit**:

- There is no trump suit for that hand
- The only trump cards are the two jokers (HI and LO)
- All other rules remain the same
- This makes bidding more difficult since you can't rely on a trump suit to win tricks
- The joker that was flipped is out of play for that hand

---

## Bidding

After the deal, players bid in clockwise order starting with the player to the left of the dealer. The dealer bids last.

### What is a Bid?

A bid is the number of tricks you expect to win this hand. Valid bids range from 0 to the hand size (so 13 is legal on the 13-card hand; it is an ordinary 1x bid, not a bore).

### Lead Determination

The player with the highest bid leads the first trick. If there's a tie, the first player to bid that amount gets the lead. Any bore outranks every number (a B beats a 13), and a higher bore beats a lower one.

### Bore (Board)

A "bore" is a double-or-nothing bet that your team will win ALL tricks.

| Bid | Multiplier | Description |
|-----|------------|-------------|
| B   | 2x         | Single bore - bet to win all tricks |
| 2B  | 4x         | Double bore - can only bid if someone already bid B |
| 3B  | 8x         | Triple bore - can only bid if someone already bid 2B |
| 4B  | 16x        | Quadruple bore - can only bid if someone already bid 3B |

**Rules for bore escalation:**
- Only players who haven't bid yet (to the left of the previous bidder) can escalate
- You cannot skip levels (e.g., can't bid 3B if no one bid 2B)
- Each level can be bid only once per hand (no second B, 2B, 3B or 4B; so no B once any bore is out)
- Quadruple bore (4B) is very rare

### Zero Bids

- If one team bids 0 total, any tricks they win are worth 1 point each (no risk of being set)
- If BOTH teams bid 0, the hand is redealt with the same dealer

### Bid Timer

- If you have not bid 10 seconds into your turn, a 30-second timer (with music) starts; when it runs out you bid 0 (which can complete an all-zero redeal)
- Running out of time twice in a row (without bidding or playing a card yourself in between) counts as idle: a bot takes over your seat as after a turn timeout (at a tournament table the others are offered to replace you instead; never in a solo game)

---

## Play

### Leading a Trick

- The lead player (highest bidder on first trick, trick winner thereafter) plays the first card
- You can lead any card EXCEPT trump, unless trump is "broken"
- Trump is "broken" when someone plays a trump card because they couldn't follow suit
- Exception: You can lead trump if your hand contains only trump cards

### Following a Trick

Play proceeds clockwise. Each player must:

1. **Follow suit** if possible - play a card of the same suit as the lead card
2. If you cannot follow suit, you may play any card including trump

**Sloughing**: When you can't follow suit and choose not to play trump (typically playing your worst card).

### Winning a Trick

The trick is won by:
1. The highest trump card played, OR
2. If no trump was played, the highest card of the lead suit

**Card rank** (high to low): A, K, Q, J, 10, 9, 8, 7, 6, 5, 4, 3, 2

The winner of the trick leads the next trick.

---

## Special Card: HI Joker

The HI joker has a special forcing ability when led:

- **Opponents** must play their HIGHEST trump card
- **Partner** may play their LOWEST trump card
- If a player has no trump, they may play any card (slough)

This makes the HI joker extremely powerful for clearing out opponents' trump cards.

---

## Scoring

### Made Bid (team wins at least their combined bid)

```
Points = (Bid × 10 × Multiplier) + Overtricks + Rainbow Bonus
```

- **Bid**: Team's combined bid (both partners)
- **Multiplier**: 1 (normal), 2 (bore), 4 (2B), 8 (3B), 16 (4B)
- **Overtricks**: +1 point for each trick won beyond the bid

### Set (team wins fewer tricks than their combined bid)

```
Points = -(Bid × 10 × Multiplier) + Rainbow Bonus
```

Being "set" means losing points equal to your bid times the multiplier.

### Rainbow Bonus

On the **4-card hand only**, if a player's hand contains one card of each suit (spades, hearts, diamonds, clubs), they have a "rainbow" and earn a **+10 point bonus** for their team.

- Jokers count as trump suit for rainbow purposes
- Rainbow bonus is awarded even if the team gets set

---

## Example Scoring

| Scenario | Calculation | Points |
|----------|-------------|--------|
| Bid 3, won 3 tricks | 3 × 10 × 1 = 30 | +30 |
| Bid 3, won 5 tricks | (3 × 10 × 1) + 2 = 32 | +32 |
| Bid 3, won 2 tricks | -(3 × 10 × 1) = -30 | -30 |
| Bore (B), won all 12 | 12 × 10 × 2 = 240 | +240 |
| Bore (B), won 11/12 | -(12 × 10 × 2) = -240 | -240 |
| Bid 2 with rainbow | (2 × 10) + 10 = 30 | +30 |
| Set with rainbow | -(bid × 10) + 10 | varies |

---

## Winning the Game

After all 13 hands are completed:
- Add up each team's cumulative score
- The team with the higher total score wins

---

## Tournaments

A tournament is a series of rounds (1 to 5; the host picks the number in the tournament lobby before it begins, 4 by default). Each round every player plays one game, with bots filling empty seats; partners rotate from round to round (see Drawing for Positions). Your round score is your team's final score in that round's game; if you miss a round you score that round's lowest score. After the last round the highest total wins (a tie gives co-winners).

### Cut for a buck

Right after the last round, everyone still in the tournament lobby plays **Cut for a buck**, a finale just for bragging rights (it does not change the tournament's winners):

- It starts about 15 seconds after the last game ends, so people can come back from their score screens. Whoever is connected then takes part; there are no bots, and spectators watch
- Every round, each player draws one card from the face-down deck. **The lowest card is out.** Suits don't count; aces are high and the jokers higher still (LO joker, then HI joker). Everyone tied on the lowest card is out together
- If everyone still in draws the same rank, nobody is out and everyone draws again
- Cards drawn stay out of the deck; when too few cards are left for everyone still in, the whole deck is shuffled back in
- You have 15 seconds to draw; after that a card is drawn for you. Players who are away, disconnected or on an older app are drawn for automatically
- The last player left wins Cut for a buck. Leaving the tournament takes you out of it; the host can end it early, which just finishes the tournament

### Tournament history

Every finished tournament is kept: your profile shows how many tournaments you finished and won (a tie for the top score counts as a win for everyone tied), your Cut for a buck wins out of the cuts you played, and your last 5 results. The Records page's **Lucky Buck** title goes to the player with the most Cut for a buck wins in the period, from 2 wins up; tied players share it.

## Get Your Bid

A second way to play, chosen when a game is created (**+ Create Game → Get Your Bid**). On the website only, in casual lobbies (not tournaments). These games are not counted in statistics, standings or records.

- **3 players, no teams.** Everyone plays for themselves. A lobby starts when three players are ready; anyone else in the lobby watches
- **The same 13 hands** (12 → 10 → 8 → 6 → 4 → 2 → 1 → 3 → 5 → 7 → 9 → 11 → 13) and **the same card play**: follow suit, trump can't be led until it is broken, and a HI joker lead makes both other players play their highest trump
- **Seats**: everyone draws a card; the highest deals first
- **Bidding**: numbers only, there is no bore. The highest bidder leads (the first of equals in bidding order)
- **The Forbidden Bid**: on hands of 5 or more cards, the bids may not add up to the number of cards. The last player to bid (the dealer) cannot bid the number that would make them add up. Example, on the 12: the first player bids 5, the second bids 4, so the third cannot bid 3 and may bid anything else. Hands of 4 cards or fewer have no Forbidden Bid, and neither does a hand where the first two bids already exceed the cards
- **All zeros is played**, not redealt: the first player to bid zero leads
- **The bid timer** works as in the main game. If it runs out it bids 0 for you, or 1 when 0 is your Forbidden Bid

### Scoring

You score only by taking **exactly** the tricks you bid.

| | Points |
| --- | --- |
| Took exactly your bid | 10 + your bid (bid 1, took 1: 11) |
| Bid 0, took 0 | 5 |
| Anything else (over or under) | 0 |
| Took exactly your Forbidden Bid | 1 |

There is no penalty for missing: a missed bid scores nothing, never less. There is no rainbow bonus. After the 13 hands the highest score wins; equal top scores share the win.

### What is different at the table

- The hand strength index (HSI) is not shown
- `/help` and the tutorial are not available
- A player who leaves, goes idle or uses `/lazy` is replaced by a bot, as in the main game. The bots here simply try to take exactly what they bid

---

## Suggestions (/help)

- On your turn, type `/help` in the game chat (in the iOS app, type `?help`, exactly that; newer versions also accept `/help`) to see the bid or card our strongest bot would choose in your seat, with a short reason. It is a strong guess, not a guarantee
- Only you see the suggestion. The table sees "<your name> used /help." each time a use counts
- Off your turn it tells you whose turn it is; it never pauses the bid timer
- Each game you get **3 free uses**. Asking again on the same turn is free, and so is a move with only one legal card. The **4th use** makes that game count as bot-assisted for you: if your team wins, it goes in your bot-game statistics, not your human ones, and the game is listed with the bot games in Records; a loss or a tie stays in your human statistics like any game (the other players' statistics stay human either way). This applies at tournament tables too
- Spectators can't use it

## Tutorial (/tutorial)

- Type `/tutorial` in the game chat to turn the tutorial on or off (`/tutorial on`, `/tutorial off`). While it is on, each of your turns shows the same suggestion /help would give (unless you have only one legal card), plus short tips on the rules, one at a time. Only you see them; the table sees "<your name> turned on the tutorial."
- After the 2-card hand the tutorial steps back: from then on it shows suggestions only for the trickier choices. /help still works any time
- A new account's first game starts with the tutorial on (in apps that support it, never at a tournament table); "Turn off" stops it
- A game where you used the tutorial counts as bot-assisted for you, like a 4th use of /help: a win goes in your bot-game statistics, a loss or a tie stays in your human ones. If you turn off a tutorial that started on its own before your first bid, it does not count
- Asking /help while the tutorial is on is never counted

---

## Strategy Tips

The most important thing to know: **the set penalty is devastating**. Bidding 3 and winning 4 gives you +31, but bidding 4 and winning 3 costs you -40. When in doubt, bid one fewer than you think you can win.

For comprehensive strategy covering bidding by hand size, bore decisions, card play, and more, see the [Strategy Guide](bot-strategy-guide.md).

---

## Terminology

| Term | Meaning |
|------|---------|
| **Bore** | Double-or-nothing bid to win all tricks |
| **Set** | Failing to make your bid |
| **Slough** | Playing an off-suit non-trump card |
| **Trump broken** | Trump has been played (can now lead trump) |
| **Void** | Having no cards of a particular suit |
| **Rainbow** | 4-card hand with all 4 suits |
| **Overtrick** | Each trick won beyond your bid |

---

## History

The name "bore" comes from a family tradition - the technically correct bridge term is "board," but this version was learned from an uncle who picked up the rules during the Vietnam War and misheard the phrase. The family has kept the "bore" pronunciation as part of the game's heritage.
