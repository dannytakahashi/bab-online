# Bot Simulation Harness

Plays full 13-hand bot-vs-bot games using the **real** `BotPlayer`/`BotStrategy`
and `rules.js`, with an orchestration loop that mirrors
`server/socket/gameHandlers.js` (team bids, bores, multipliers, redeals,
rainbows, scoring, memory notifications). Use it to tune strategy changes and
catch regressions: every chosen card is re-validated against
`rules.isLegalMove`, and illegal selections or thrown exceptions are reported.
A healthy strategy reports **zero of both**.

## Usage

```bash
npm run sim                                   # all experiments, 2000 games each (~10s)
npm run sim -- --games 8000                   # tighter confidence (~±1.1%)
npm run sim -- --exp legacy                   # current Mary vs frozen pre-tuning Mary
npm run sim -- --exp personalities            # each personality+Mary vs Mary+Mary
npm run sim -- --team mary,danny --vs legacy:mary,legacy:mary
```

Personality specs: `mary | sharon | danny | mike | zach`, optionally prefixed
with `legacy:` to use `legacyStrategy.js` — a frozen June-2026 snapshot of
`BotStrategy.js` kept as a fixed benchmark. Never edit the legacy file; its
value is that it never changes.

One caveat: the harness always feeds Zach's partner history with the CURRENT
policy (bore hands skipped), so `legacy:zach` is not a bit-perfect
reproduction of the old adaptive behavior (which recorded bores as bid 0).
Mary-pair comparisons (`legacy:mary,legacy:mary`) are exact and are the
benchmark that matters.

Matchups are seat-balanced (each pair plays both team seatings), so an even
matchup reads 50.0%. The RNG is seeded (`--seed`); identical invocations are
fully reproducible.

## Reading results

- `results[]` — win rate of `teamX` with a 95% CI, plus average score delta.
  Identical strategies should read 50% within the CI.
- `personalities{}` — per-spec bid/set/bore/accuracy stats pooled across all
  matches in the run. `legacy:` specs are tracked separately.
- `byHandSize{}` — redeal rate, combined team bid as a fraction of available
  tricks, bore frequency.
- `incidentCount` / `exceptionCount` — must be 0.

## Baseline (June 2026, pre-tuning legacy snapshot, 4000 games/match)

| Matchup | Win rate (X) |
|---|---|
| mary vs mary (control) | 50.6% ±1.6 |
| mary vs legacy:mary (identical code at snapshot time) | 50.8% ±1.6 |
| sharon+mary vs mary+mary | 49.6% ±1.6 |
| danny+mary vs mary+mary | 51.3% ±1.6 |
| zach+mary vs mary+mary | 51.5% ±1.6 |
| mike+mary vs mary+mary | 48.1% ±1.6 |

Notable legacy-snapshot facts (from the June 2026 evaluation): Danny and Zach
beat Mary because their "aggressive" modifiers partially corrected her
systematic underbidding; ~70% of 1-card deals and ~50% of 2-card deals were
all-zero-bid redeals; bots bid only ~52–68% of available tricks on hands ≥3
cards. Tuning goals are measured against these numbers.

## Head-to-head A/B against a snapshot (`--baseline`)

To measure a strategy change, copy `BotStrategy.js` from the base commit to a
file with absolute `require` paths, then play the working tree against it:

```bash
git show origin/main:server/game/bot/BotStrategy.js \
  | sed "s#require('../rules')#require('$PWD/server/game/rules')#; s#require('./personalities')#require('$PWD/server/game/bot/personalities')#" \
  > /tmp/BotStrategy.base.js
node server/game/bot/sim/simulate.js --baseline /tmp/BotStrategy.base.js \
  --team mary,mary --vs base:mary,base:mary --games 16000 --seed 11
```

At 16000 games the 95% CI is ±0.77%; identical strategies read 50% within it.
Tune on other seeds than the ones you report.

## Bore tuning, round 2 (November 2026, 16000 games/match)

Small-hand bores (1–5 cards) are now decided by `analyzeLeadSweep`, an
analytic P(sweep | we hold the lead) that weighs every possible opponent trump
holding exactly and reads opponents' bids: bore at P ≥ 0.6, or ≥ 0.9 after an
opponent bid a number (the model is badly optimistic there). Counter-bores
over an opponent need a true lock (`countLockedWinners` covers the hand); on 1
card the bot escalates partner's bore with any card. Thresholds were tuned on
seeds 201–204; the numbers below are on held-out seeds.

| Matchup (new vs `origin/main` snapshot) | Seed | Win rate (X) | Avg score delta |
|---|---|---|---|
| mary,mary vs base:mary,base:mary | 11 | 53.6% ±0.8 | +12.6 |
| mary,mary vs base:mary,base:mary | 12 | 53.3% ±0.8 | +11.5 |
| danny,zach vs base:danny,base:zach | 13 | 54.1% ±0.8 | +13.9 |

| Legacy benchmark (`--exp legacy --seed 14`) | Before | After |
|---|---|---|
| mary vs legacy mary | 58.7% ±0.8 | 62.1% ±0.8 |
| mary vs legacy danny+zach | 59.0% ±0.8 | 61.8% ±0.8 |

Mary's bore stats: attempt rate 1.4–1.5% of hands (main, mary-vs-mary
control) → 4.9–5.0% (seeds 11/12); success 91% → 82–83%; team set rate
8.6% → 8.8–8.9%. Bores fail more often
now, by design: a 2-card bore pays ±40 against roughly +10 to +20 for a plain
bid, so it stays +EV down to about a 60–65% sweep rate. A bid decision takes
at most ~1 ms (5-card hand). Zero incidents and zero exceptions in every run.

## Bid calibration (November 2026)

Players saw the bots "sandbag". Measured on 2,000 Mary self-play games
(seed 501), 65% of team-hands won more tricks than the team bid, and the
play side never sheds tricks once a contract is made (the 4th seat never
declined a winning card: 0 of 47,415 tricks lost after the contract was
made), so tricks taken are a fair "max winnable". The fix is in
`evaluateHand`, term by term: each trump-suit card value is now its measured
trick value (least-squares fit of tricks taken on the cards held), not a
pessimistic guess, and `floor()` stays the one safety margin. Biggest
corrections: low/mid trump 0.05-0.25 → 0.3-0.75, trump Queen 0.4 → 0.8,
side honours ~1.5x, side Queens counted; HI joker 1.9 → 1.2-1.5, LO 1.4 →
0.95, trump Ace 1.4 → 0.8-1.0, void bonus 0.45-1.5 → 0-0.55; a hand-size
baseline (+0.15 / +0.05 / 0 / -0.45). No-trump hands and 1-2 card hands keep
their old values.

Ablation (seed 32, 4,000 games each; new Mary vs new Mary with ONE term
reverted, so >50% means the new term helps): low/mid trump 63.7%, void
59.3%, jokers 58.7%, baseline 55.2%, side honours 54.6%, trump A/K 54.0%,
trump Queen 50.7%, trump length 50.6% (±1.5 each; control 50.5%).

| Matchup (new vs `efb189a` snapshot) | Seed | Games | Win rate (X) | Avg score delta |
|---|---|---|---|---|
| mary,mary vs base:mary,base:mary (tuning) | 31 | 4,000 | 62.9% ±1.5 | +31.5 |
| mary,mary vs base:mary,base:mary | 42 | 16,000 | 61.8% ±0.75 | +27.0 |
| mary,mary vs base:mary,base:mary | 41 | 500 | 60.4% ±4.3 | +27.7 |
| danny,zach vs base:danny,base:zach | 44 | 8,000 | 59.9% ±1.1 | +24.8 |
| mary vs legacy mary (`--exp all`) | 43 | 4,000 | 72.4% ±1.4 | +59.6 |

Mary (seed 42 pair): exact bids 42.2% → 47.2% of hands, tricks over bid
+0.56 → +0.43 per player-hand, overtricks per made team-hand 1.31 → 1.02,
team set rate 9.5% → 9.3%. Bids moved both ways: 3-4 card hands were
overbid (15-17% set) and now bid less; 8-13 card hands bid ~0.3-0.55 more.
Under this scoring a calibrated bot still wins more than it bids on most
hands: raising a bid of b by one only pays when the extra trick comes in
~77% (b=1) to ~91% (b=4) of the time.

Mike's random +1 went from 10% to 5% of bids: on calibrated bids each
overbid costs more, and at 10% his gap to Mary doubled (seed 61: -3.0pp
against the old -1.2pp; at 5%, held-out seed 62: 48.7% ±1.1). Personalities
with Mary vs Mary+Mary on the final code (`--exp all --seed 63`, 4,000 games,
±1.55): Sharon 48.3%, Danny 47.5%, Mike 49.1%, Zach 51.3%; mary vs legacy
73.3%. The late-game "behind, raise" rule was left alone:
raising its threshold from 0.4 to 0.6 / 0.75 / never scored +13 / +19 / +26
points per game but won 50.7% / 50.5% / 50.0% (±1.1), so it is a win-rate
tool, not a sandbagging fix. The bot games behind the iOS event fixtures and
`wireGolden` changed with the bids (`npm run ios:fixtures`,
`UPDATE_WIRE_GOLDEN=1`).
