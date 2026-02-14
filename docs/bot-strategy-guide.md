# Back Alley Bridge — Strategy Guide

This guide describes optimal strategy for Back Alley Bridge, intended as a reference for both human players and the Mary bot implementation. It covers bidding, card play, and the strategic reasoning behind each decision.

## Core Principle: The Set Penalty Asymmetry

The single most important strategic fact in Back Alley Bridge is the scoring asymmetry:

- **Making your bid** of 3 earns +30 points
- **Getting set** on a bid of 3 costs -30 points
- **Overtricks** are worth only +1 point each

This creates a ~30:1 penalty ratio. Bidding 3 and winning 4 tricks gives you +31. Bidding 4 and winning 3 gives you -40. The cost of over-bidding by 1 trick is catastrophic compared to the cost of under-bidding by 1 trick. Therefore: **when in doubt, bid one fewer than you think you can win.** It is always preferable to slightly under-bid than over-bid.

## Bidding: Hand-Size-Dependent Card Evaluation

Card values change dramatically based on hand size. This is the most important strategic concept to internalize.

### Why Hand Size Matters

With 54 cards in the deck and 4 players:
- **12-card hand**: 48 of 54 cards dealt. Every player has nearly every suit. A non-trump Ace is almost guaranteed to win its trick.
- **6-card hand**: 24 cards dealt. Voids (having zero cards of a suit) become common. A non-trump King might lose to a trump card.
- **2-card hand**: Only 8 cards dealt. The chance an opponent is void in your non-trump suit is very high (~60-80%). Non-trump high cards are nearly worthless.
- **1-card hand**: Only trump matters. A non-trump card is essentially a zero bid.

### Large Hands (8-13 cards)

- **Non-trump Aces**: Strong — worth roughly 0.7-0.8 of a trick. Opponents almost certainly have the suit and must follow.
- **Non-trump Kings**: Moderate — worth roughly 0.3-0.4 of a trick. Reliable if you also hold the Ace, but risky alone since the Ace is out there and may not belong to your partner.
- **Trump cards**: Very strong when you hold many (5+). Trump length gives control over the hand.
- **Voids**: Valuable in combination with trump — each void is an opportunity to trump in on that suit.
- **Single trump card risk**: If you hold exactly one trump card in a large hand and it's not a joker, it's likely to be outmatched by someone with more/higher trump. Devalue it by ~30%.

### Medium Hands (4-7 cards)

- **Non-trump Aces**: Worth about half a trick. Voids are common enough that someone may trump your Ace.
- **Non-trump Kings**: Risky — worth very little unless the Ace has already been played.
- **Trump cards**: Increasingly valuable as each trump card is more likely to be the only one at the table.
- **Voids + trump**: The combination becomes very powerful. Being void in a suit with 2+ trump cards means you can control multiple tricks.

### Small Hands (1-3 cards)

- **Non-trump high cards**: Nearly worthless on their own. At 2 cards, the chance an opponent is void in your suit approaches 75%. At 1 card, a non-trump card can only win if you lead and everyone happens to have that suit.
- **Any trump card**: Valuable because fewer total trump are in play. A mid-trump card (7, 8, 9) that would be worthless in a 12-card hand can win tricks here.
- **HI/LO jokers and trump Ace**: Near-guaranteed tricks at any hand size.

### No-Trump Hands (Joker Flipped)

When a joker is flipped as trump, the game changes fundamentally:
- Only the remaining joker(s) are trump — there is no trump suit
- **Non-trump Aces become very strong** (~1.3 tricks) since nobody can trump in on your suit
- **Non-trump Kings become moderate** (~0.7 tricks)
- Long suits are powerful — you can run them without fear of being trumped
- Voids are nearly worthless (you can't trump in without trump cards)
- Bidding focuses on how many high cards you have in suits you can lead

## Bidding: Reading Other Players' Bids

### Bid Order Position

Players bid clockwise starting left of dealer. The dealer bids last with the most information.

- **First bidder**: Has the least information. Should bid slightly more conservatively (round down aggressively).
- **Middle bidders**: Can see some bids. Adjust based on what's already been bid.
- **Dealer (last)**: Has full information. Can adjust precisely and make informed bore decisions.

### What Bids Tell You

- **Everyone bids 0**: All hands are weak. This is a key signal for bore decisions (see below).
- **Opponents bid high**: They have strong hands. Be more conservative — the tricks you expected to win may be taken.
- **Partner bid high**: Be careful not to overbid as a team. If your partner bid 4 on a 6-card hand, they expect to win most tricks — bid conservatively.
- **Partner bored**: They think they can win every trick. Consider supporting with a double-bore, unless them having the lead is critical to their strategy.

### Partner Bid Coordination

Your team's combined bid should never exceed the hand size. If your partner already bid high, reduce yours. The set penalty applies to the combined bid, so both partners share the risk.

## Bore Strategy

Bore is a double-or-nothing bet to win ALL tricks. It's the most misunderstood part of the game — bore is most valuable on **small hands**, not large ones.

### Why Bore on Small Hands?

On a 2-card hand, a normal bid of 2 is worth 20 points. A bore is worth 40. The risk is the same (you need to win all tricks either way), but bore doubles the reward.

On a 12-card hand, a bore is worth 240 points but requires winning all 12 tricks — missing even one costs -240. The probability of sweeping 12 tricks is very low unless your hand is extraordinary.

### 2-Card Hand Bore Decisions

When all other players bid 0 (key signal — everyone has weak hands):

- **Two trump cards (at least one mid+ like 7 or higher)**: BORE. Two trump in a weak field will likely take both tricks.
- **One high trump (HI joker, LO joker, or trump Ace) + one high non-trump (Ace or King)**: BORE. Lead the non-trump first — opponents likely can't beat it since they signaled weakness, then win the second trick with trump.
- **One high trump + one mid/low non-trump**: Do NOT bore. The non-trump card is too likely to lose, and then you're set on a bore.
- **Two high non-trump cards (e.g., two Aces of different suits)**: Consider boring if everyone bid 0 and you're the dealer (last to bid with full info). Lead one, and if the field is weak, you may take both.

### 1-Card Hand Bore Decisions

When all others bid 0:
- **HI joker**: Always bore (guaranteed win when leading)
- **LO joker or trump Ace**: Bore (very likely to win)
- **Trump King**: Bore (likely to win when the field is weak)
- **Lower trump**: Don't bore (too uncertain)

### 3-5 Card Hands

Bore only with near-all-trump holdings + HI joker when everyone bids 0. The more tricks you need to sweep, the less likely a bore succeeds.

### Large Hands (10+)

Bore only with extraordinary holdings: both jokers, 7+ trump, 8+ evaluation points. These are very rare.

### Partner Bore Support (Double Bore)

If your partner bores, consider double-boring (2B) to support them — this quadruples the multiplier. Do this when:
- The hand is small (4 cards or fewer)
- You hold decent trump (at least half your hand)
- You don't think having the lead yourself is critical

Don't double-bore on large hands — the risk is too high.

## Card Play: Leading

### HI Joker

Leading HI joker forces opponents to play their highest trump while partner plays their lowest. This clears the opponents' best trump cards and sets up your remaining trump to run. Generally lead HI joker early in larger hands when you have other trump to follow up with.

### Suit Selection for Leads

Score each suit and lead from the best one:

1. **Lead suits your partner is void in** — Partner can trump in to win the trick for your team. This is one of the strongest plays in the game.
2. **Avoid leading suits opponents are void in** — This gifts opponents a free trump-in, which is the opposite of what you want.
3. **Prefer suits where you hold the Ace** — Guaranteed trick winner.
4. **Prefer shorter suits** — If you're long in a suit, opponents are more likely void (the cards went to you, not them). Leading from short suits also voids you faster, creating future trump-in opportunities.
5. **Avoid suits where you hold King but the Ace hasn't been played** — The Ace could come from an opponent and beat your King.

### King/Ace Timing

**On large hands (8+ cards)**, almost all cards are dealt, so if you don't have the Ace it's almost certainly in another player's hand. Don't lead or play a King until the Ace of that suit has been played (unless you also hold the Ace):
- If you lead a King and an opponent has the Ace, you lose the trick and waste your second-best card.
- Wait for the Ace to appear (either played by an opponent or by your partner), then your King becomes the highest remaining card in that suit.
- Exception: If you're the last player in a trick and no one has played the Ace, your King wins — play it.

**On small hands (4 or fewer cards)**, this rule relaxes. With only 8-16 cards dealt out of 54, there's a good chance the Ace is still in the deck and was never dealt. Leading a King becomes a reasonable risk, especially when you have few options.

### Leading Trump

- Generally avoid leading trump (other than HI joker). Leading trump forces your partner to spend their trump too, wasting team resources. You're better off saving trump to play on suited tricks where you're void — that way only your trump card is spent, not your partner's.
- Only lead trump after trump is broken (unless your hand is all trump).

## Card Play: Following

### When You Can Follow Suit

- **Partner is winning**: Play your lowest card in the suit. Don't waste high cards when your team is already winning.
- **Opponent is winning**: Play the lowest card that beats the current winner. Don't overspend — a King that barely wins is just as good as an Ace that dominates.
- **King protection**: If your King is the lowest card that can win, but the Ace of that suit hasn't been played yet and there are players still to act, consider playing a higher card or just playing low and conceding. An opponent behind you might have the Ace.
- **Can't win**: Play your lowest card in the suit.

### When You're Void (Can't Follow Suit)

- **Partner is winning**: Discard (slough) a low card from your shortest non-trump suit. Don't waste trump.
- **Opponent is winning and you have trump**: Trump in with your lowest trump that beats the current winner. If an opponent already trumped, you need to over-trump (play a higher trump).
- **Can't beat the current winner**: Discard strategically — dump cards from your shortest non-trump suit to create new voids for future tricks.

### Play Position Awareness

Your position in the trick matters:
- **4th player (last)**: You have perfect information about who's winning. Play precisely — win cheaply when you can, don't waste cards when you can't.
- **2nd player**: Two players still act after you. Be cautious about committing high cards since opponents may still beat you.

## Void and Trump Synergy

Being void in a suit is valuable **in proportion to how many trump cards you hold**:
- Void + 5 trump = extremely valuable (you can trump in on that suit multiple times)
- Void + 1 trump = modestly valuable (one trump-in opportunity, but that single trump might be needed elsewhere)
- Void + 0 trump = the void means nothing (you can't trump in)

When bidding, weight voids more heavily when you have more trump.

## Discarding to Create Voids

When you must discard (can't follow suit, partner winning or can't beat the trick):
- Discard from your **shortest non-trump suit** to create a void
- A new void means future opportunities to trump in
- Prefer discarding low cards that won't win tricks anyway

## Game-Level Score Awareness

Your overall risk tolerance should shift based on the score and how many hands remain:

- **Behind with few hands left**: You need to take bigger risks to catch up. Bid more aggressively, consider bore bids you'd normally pass on, and accept higher variance. Playing safe when you're losing is a slow way to guarantee a loss.
- **Ahead with few hands left**: Protect your lead. Bid conservatively, avoid bore bids unless they're near-certain, and prioritize not getting set over maximizing points. A safe +20 is better than a risky +40 when you're already winning.
- **Early in the game**: Score differential matters less — there are many hands left to make up ground. Play fundamentally sound strategy without adjusting for score.

## Trump Conservation

Don't waste high trump on marginal tricks:
- If your team has already made your bid, the remaining tricks are only worth +1 each. Don't spend your trump Ace to win an overtrick worth 1 point — you might need it later.
- If a low trump will win the trick, play it instead of a high trump.
- Save jokers and trump Ace for when they're needed (e.g., to overtrump an opponent's trump, or to guarantee a critical trick).

## The 4-Card Hand (Rainbow)

The 4-card hand is special because of the rainbow bonus (+10 points). A rainbow hand has one card of each suit. Key considerations:
- Rainbow hands have exactly one trump card, no voids, and three non-trump cards — generally weak for trick-taking
- The +10 bonus is awarded even if your team gets set
- Don't overbid a rainbow hand hoping the bonus saves you — bid based on your trick-winning ability, and treat the +10 as a bonus

## Summary of Key Principles

1. **Under-bid rather than over-bid** — the set penalty is devastating
2. **Card values depend on hand size** — non-trump cards lose value as hands shrink
3. **Bore on small hands, not large ones** — bore is most profitable at 1-2 cards
4. **Read the bids** — everyone bidding 0 is your signal to bore
5. **Don't play Kings until Aces are gone** — patience wins (on large hands)
6. **Lead into partner's voids, not opponent's** — enable your team to trump in
7. **Trump + voids = power** — more trump makes each void more valuable
8. **Save high cards for when they matter** — overtricks are worth 1 point, sets cost 30+
9. **Adjust risk to the scoreboard** — bid aggressively when behind late in the game, conservatively when ahead
