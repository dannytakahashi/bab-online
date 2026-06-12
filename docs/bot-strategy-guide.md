# Back Alley Bridge — Strategy Guide

This guide describes optimal strategy for Back Alley Bridge, intended as a reference for both human players and the Mary bot implementation. It covers bidding, card play, and the strategic reasoning behind each decision.

Strategy claims here are validated empirically: `npm run sim` plays the real bot code through thousands of full games against a frozen benchmark (see `server/game/bot/sim/README.md`). This edition of the guide was rewritten after a ~250,000-game tuning campaign (June 2026), and several pieces of received wisdom from earlier editions did not survive contact with the data. Where intuition and measurement disagreed, the measurements won — those reversals are called out inline and collected at the end.

## Core Principle: The Set Penalty Asymmetry

The single most important strategic fact in Back Alley Bridge is the scoring asymmetry:

- **Making your bid** of 3 earns +30 points
- **Getting set** on a bid of 3 costs -30 points
- **Overtricks** are worth only +1 point each

Do the marginal math on raising a bid by one. If you make the higher bid, you gain +9 (a 10-point trick instead of a 1-point overtrick). If the extra trick doesn't come, you swing from roughly +20 to -30 — about **-50 points** on a bid of 2→3. That ratio means a marginal bid increase needs to succeed roughly 85% of the time just to break even.

So: **when in doubt, bid one fewer than you think you can win** — but only *one* fewer. Optimal play runs at roughly a 90% team make-rate. Below that you're donating sets; much above it you're systematically leaving 9 points per hand on the table as overtricks. Both failure modes are real:

- Tuning the bot's bids upward by about half a trick tripled its set rate and *lost* games despite "bidding closer to true strength."
- The original bot's triple-stacked conservatism (pessimistic values, floor rounding, extra first-bidder discount) made its bid only ~93% of the time — and it lost to versions of itself that simply bid more.

The equilibrium: evaluate pessimistically, round down, and **stop there**. Don't add further "safety" adjustments on top — each one double-counts uncertainty that the evaluation already priced in.

## Bidding: Hand-Size-Dependent Card Evaluation

Card values change dramatically based on hand size. This is the most important evaluation concept to internalize.

### Why Hand Size Matters

With 54 cards in the deck and 4 players:
- **12-card hand**: 48 of 54 cards dealt. Every player has nearly every suit. A non-trump Ace is almost guaranteed to win its trick.
- **6-card hand**: 24 cards dealt. Voids (having zero cards of a suit) become common. A non-trump King might lose to a trump card.
- **2-card hand**: Only 8 cards dealt. The chance an opponent is void in your non-trump suit is very high. Non-trump high cards are nearly worthless.
- **1-card hand**: Only trump matters. A non-trump card is essentially a zero bid.

### Large Hands (8-13 cards)

- **Non-trump Aces**: Strong — worth roughly 0.7-0.8 of a trick. Opponents almost certainly have the suit and must follow.
- **Non-trump Kings**: Moderate — worth roughly 0.3-0.4 of a trick. Reliable if you also hold the Ace, but risky alone since the Ace is out there and may not belong to your partner.
- **Trump cards**: Very strong when you hold many (5+). Trump length gives control over the hand.
- **Every trump card counts.** Even low trump (2-6) carries fractional value at every hand size — each one ruffs a trick or forces out a bigger trump. An earlier edition valued mid trump at zero on large hands; that produced absurd inversions (a trump Jack rated below an off-suit King) and was the single largest source of underbidding the simulation found. As a rule of thumb: mid trump (7-J) ≈ 0.15-0.25 tricks, low trump ≈ 0.05-0.1, scaling up as hands shrink.
- **Voids**: Valuable in combination with trump — each void is an opportunity to trump in on that suit.
- **Single trump risk**: One lone non-joker trump in a large hand is likely to be outdrawn. Devalue it.

### Medium Hands (4-7 cards)

- **Non-trump Aces**: Worth about half a trick. Voids are common enough that someone may trump your Ace.
- **Non-trump Kings**: Risky — worth very little unless the Ace has already been played.
- **Trump cards**: Increasingly valuable; mid trump approaches a third of a trick each.
- **Voids + trump**: The combination becomes very powerful.

### Small Hands (1-3 cards)

- **Non-trump high cards**: Nearly worthless on their own.
- **Any trump card**: Valuable because so few trump are in play. On a 1-card hand, even a trump **7** wins often enough (~70%) that bidding 1 on it is profitable — and nonzero bids avoid pointless all-zero redeals. On a 2-card hand, a trump Queen or any *pair* of trump is worth a bid of 1.
- **HI/LO jokers and trump Ace**: Near-guaranteed tricks at any hand size.

### The Flipped Card Is Out of Play

The card flipped to set trump is removed from the game, and your evaluation should use that:
- **Trump Ace flipped** → your trump King is the boss trump card after the jokers. Value it like an Ace.
- **Trump King flipped** → promote your Queen the same way.
- **HI joker flipped** (no-trump hand) → your **LO joker is unbeatable**. It's the single strongest card in the game at that point; bid and bore accordingly.

### No-Trump Hands (Joker Flipped)

When a joker is flipped, there is no trump suit — but **the other joker is still trump**, a one-card ruffing threat that most players forget:
- **Non-trump Aces become very strong** (~1.3 tricks); Kings moderate (~0.7).
- An Ace is only truly safe once the live joker is accounted for — a player void in your suit can still ruff you with it.
- Voids are nearly worthless to you unless you hold the live joker.
- On small NT hands, count sure winners directly: jokers and Aces are near-certain tricks (an A-A 2-card NT hand is a bid of 2, and a bore candidate as dealer).

## Bidding: Reading Other Players' Bids

### Bid Order Position

- **A seat that hasn't bid yet is NOT a zero bid — it's no information at all.** Several bore rules below key off "everyone signaled weakness"; that signal only exists for bids you have actually seen. The original bot treated unbid seats as zeros and bored as first bidder on garbage.
- **First bidder**: has the least information, but should *not* take an extra discount for it. A pessimistic evaluation plus floor rounding already prices in the uncertainty; a further flat -1 was measured to cost about 1.2% win rate. This is the guide's most counterintuitive reversal: more conservatism is not free.
- **Dealer (last)**: has full information. The "weak field" bore cases below are only fully confirmed from this seat.

### What Bids Tell You

- **Everyone bids 0**: all hands are weak — the key bore signal.
- **Opponents bid high**: be more conservative; the tricks you counted may be taken.
- **Partner bid high**: your team's combined bid can never usefully exceed the hand size — cap your bid at `handSize - partnerBid`. (And re-check the cap after any adjustment; the original bot applied personality tweaks *after* the cap and occasionally bid its team into mathematically unmakeable contracts.)
- **An opponent bored**: cap your own bid at 1. Either they sweep (you're set regardless of what you bid) or you take a trick and set them — your own bid only adds risk. Defense happens in the play, not the auction.

## Bore Strategy

Bore is a double-or-nothing bet to win ALL tricks. It's most valuable on **small hands**: a 2-card bore is worth 40 points against 20 for a plain bid of 2 — same requirement, double the reward — while a 12-card bore needs an extraordinary hand to be anything but a donation. In practice, well-judged bores succeed about 90% of the time, and ~85% of kept 1-card hands contain one.

### 1-Card Hands

- **HI joker** (or LO when the HI was flipped): bore **unconditionally** — the card is unbeatable, and the bore itself wins you the lead.
- **LO joker or trump Ace**: bore unless an opponent has already bored (their bore may be the HI joker). Expected value strongly favors the bore: ~94% to win doubles your payoff for a small added risk.
- **Trump King**: bore only as dealer after seeing all three others bid 0.
- **Trump Queen or lower**: don't bore; trump 7+ still bids 1.

### 2-Card Hands (after seeing at least one bid, all seen bids 0)

- **Two trump, at least one mid (7+)**: bore.
- **One top trump (joker or trump Ace) + one high off-suit card (A/K)**: bore — lead the off-suit card into the weak field first.
- **No-trump A+A** (as dealer, weak field): bore — nothing can ruff you.
- **One top trump + junk**: do NOT bore. The junk card will lose a trick.

### 3-5 Card Hands

Bore only with the HI joker plus a near-all-trump holding. The more tricks you must sweep, the faster bore equity evaporates.

### Large Hands (10+)

Only with both jokers and 7+ trump. These are once-a-season hands.

### Bore Escalation (2B/3B/4B)

Support your partner's bore with the next level up when the hand is small (≤4 cards) and you hold decent trump. Two rules the original bot got wrong:
- Escalate **above the highest bore on the table**, not blindly to "the next level" — re-boring at the same level isn't a thing.
- If an **opponent** holds the highest bore, escalating doubles the stakes on a hand someone else thinks they'll sweep. Only do it holding the unbeatable card yourself (HI joker, or LO when HI was flipped).

## Playing the Contract

Card play must know the contract state — the bids, the tricks taken so far, and any bores. Three regimes:

- **Every trick matters** (your team bored; your remaining bid equals the remaining tricks; an opponent bore is still alive; or setting the opponents requires winning out and is genuinely within reach): play raw strength. Lead the HI joker, then boss trump, then established winners. Overtake even your partner's wins if they could be beaten, and trump in to secure tricks you'd otherwise concede. One trick taken against an opposing bore sets it for a huge swing — it justifies any card in your hand.
- **Contested middle** (bids still in play): standard play, described in the sections below.
- **Only overtricks left** (both teams' bids decided): every remaining trick is worth ±1 and **cards have no value beyond this hand** — keep playing to win tricks; just never read more into them than a point. Cash established winners while you have the lead.

Two important boundaries on the first regime:

- **A bore that loses a trick is dead.** Stop sweeping; fall back to whatever objective is still alive (usually denying the opponents their bid).
- **Don't chase unrealistic sets.** "Win out to deny their bid" is only worth pursuing when the required sweep is close to what your own bid already demanded, or the opposing contract is a bore. The bot's first implementation went into sweep-everything mode whenever opponents sat one trick from a small bid — all hand long, from trick one. Denial is a finishing move, not a lifestyle.

### The Lesson Hiding in the Third Regime

Earlier thinking said: "once your bid is made, conserve your trump and honors." The simulation says that's backwards, and the reason generalizes: **within a hand, a card you "save" with no remaining objective is a card you wasted.** There is no next hand for it. Conservation is only meaningful in the middle regime, where a specific future trick (the one that makes your bid, or sets theirs) needs the card more than this trick does. Once nothing but ±1s remain, straightforward trick-maximizing play *is* optimal play. A version of the bot that ducked "worthless" overtricks measurably lost points — it was donating +1s to the opponents out of misplaced thrift.

## Card Play: Counting and the "Boss" Concept

Strong play in this game is mostly bookkeeping. Track what's been played (plus the flipped card, plus your own hand), and for any card ask: **how many cards still in unknown hands outrank it?** A card with the answer *zero* is **boss** — it cannot lose to anything except a ruff.

Boss status drives almost every follow decision:

- **Opponent winning, players still to act**: play the **cheapest boss winner** if you have one — it wins as surely as your highest card while spending less. With no boss available, fight with your highest non-joker winner. (Pure "lowest card that beats the current winner" — classical whist economy — measured worse here: at +1 per overtrick and -10×bid per set, securing tricks beats saving face cards.)
- **Opponent winning, you act last**: the lowest winner *always* holds — never spend more. (Corollary: "protecting" a King when you're last to act is meaningless; nothing plays after you.)
- **Partner winning**: count before you duck. If players still act and your partner's card can still be beaten — higher cards outstanding, or a known-void opponent who can ruff — overtake with your cheapest boss. If their card is boss, play your lowest and bank the trick. The original bot overtook its partner's winning trump Queen "just in case" even when every higher trump was accounted for; counting ends that.
- **A win is vulnerable** when higher cards remain in unknown hands, or (for non-trump winners) when a remaining opponent is known void in the suit. In no-trump, that ruff risk persists exactly until the live joker is accounted for.

## Card Play: Leading

### HI Joker

Leading HI joker wins the trick outright and forces opponents to play their highest trump while your partner plays their lowest — it strips the opponents' best trump and promotes everything your team holds. Lead it early. Held in hand, its only extra value is the forcing effect; it will win exactly one trick whenever it's played.

### Suit Selection

Score each suit and lead from the best one:

1. **Lead suits your partner is void in** — they trump in, and only one of your team's trump gets spent.
2. **Avoid suits opponents are void in** — that's a free ruff for them. (This includes no-trump hands while the live joker is unaccounted for.)
3. **Prefer suits where you hold the Ace or an established boss card** — cash sure tricks while you have the lead; jokers and boss trump can win from any seat later, but off-suit winners need the lead.
4. **Prefer shorter suits** — voids you faster and runs into opponents' voids less.
5. **Don't lead a King while the Ace is unaccounted for** (large hands). On small hands this relaxes — the Ace may simply not have been dealt.

### Leading Trump

Generally avoid leading trump (other than HI joker) — it drains your partner's trump along with the opponents'. Save trump for ruffing. Exception: in sweep mode (bores, must-win-out), lead boss trump from the top to strip the field; a borer who leads *low* trump to "feel things out" is busting their own bore — lead strength or don't bore.

## Discarding

When you can't follow and shouldn't trump:
- Discard from your **shortest non-trump suit** to create voids — but only if you hold trump to exploit them; with no trump, voids are worthless, so just dump your lowest card.
- **Protect winners, not ranks.** Don't slough a card just because it's "low" if counting says it's boss, and don't cling to a King whose suit-mates make it dead. A Queen with the A-K-J gone is a winner; a King under a live Ace is a hope.

## Game-Level Score Awareness

Shift risk tolerance with the scoreboard, late in the game only:
- **Behind by 30+ with few hands left**: bid up the close calls, take the marginal bores. Safe play locks in the loss.
- **Ahead by 30+ late**: take the discount on close calls; deny variance.
- **Early game**: play straight — there's time for the math to work.

## The 4-Card Hand (Rainbow)

A rainbow (one card of each suit) pays +10 even if you're set, and rainbow hands are structurally weak (exactly one trump, no voids). Bid the hand on its trick-taking merit and treat the bonus as found money — never bid *for* it.

## What 250,000 Games Taught Us (Counterintuitive Findings)

1. **Stacked conservatism loses.** Pessimistic evaluation + floor rounding is the right amount; every additional "to be safe" adjustment (first-bidder discounts, strong-hand trims) measurably cost win rate. One layer of safety, applied once.
2. **More aggression also loses.** Adding ~half a trick of bid aggression tripled the set rate and lost games. The make-rate sweet spot is ~90%; both directions away from it are downhill.
3. **Low trump is never worthless.** Zeroing mid/low trump value was worth several points a hand in underbids. If it can ruff, it counts.
4. **There is no card conservation without an objective.** Once both contracts are decided, "saving" a card wastes it. Play every remaining trick to win.
5. **Secure beats cheap when contesting.** Cheapest *boss* winner first; failing that, fight high. Classical lowest-that-beats economy assumes a scoring system this game doesn't have.
6. **A partner's safe win is sacred; a vulnerable one isn't.** Count, then duck or overtake — don't guess by rank.
7. **Bores are a small-hand weapon with ~90% success when properly gated** — and the gates are informational (bids actually seen), not just material.
8. **The flipped card is information.** Promote honors under it; in no-trump, know where the live joker is before calling anything safe.

---

*The bot personalities (Sharon, Danny, Mike, Zach) deliberately deviate from this guide in small, characterful ways — trimmed bids, flashy overspends, the occasional partner overtake. Those are features, not strategy: see `server/game/bot/personalities.js`. Mary plays the guide.*
