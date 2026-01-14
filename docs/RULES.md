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

After the deal, players bid in counter-clockwise order starting with the player to the left of the dealer. The dealer bids last.

### What is a Bid?

A bid is the number of tricks you expect to win this hand. Valid bids range from 0 to the hand size.

### Lead Determination

The player with the highest bid leads the first trick. If there's a tie, the first player to bid that amount gets the lead.

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
- Quadruple bore (4B) is very rare

### Zero Bids

- If one team bids 0 total, any tricks they win are worth 1 point each (no risk of being set)
- If BOTH teams bid 0, the hand is redealt with the same dealer

---

## Play

### Leading a Trick

- The lead player (highest bidder on first trick, trick winner thereafter) plays the first card
- You can lead any card EXCEPT trump, unless trump is "broken"
- Trump is "broken" when someone plays a trump card because they couldn't follow suit
- Exception: You can lead trump if your hand contains only trump cards

### Following a Trick

Play proceeds counter-clockwise. Each player must:

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

## Strategy Tips

1. **Bid conservatively** - Being set costs more than overtricks gain
2. **Count trump** - Track which trump cards have been played
3. **Communicate with partner** - Your plays signal information
4. **Save HI joker** - It can clear opponents' trump at a critical moment
5. **Consider bore carefully** - High risk, high reward on small hands
6. **Watch the 4-hand** - Rainbow bonus can swing close games

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
