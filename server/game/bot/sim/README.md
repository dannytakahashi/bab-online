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

Players saw the bots "sandbag": in self-play 65% of team-hands won more
tricks than the team bid. Measured cause: `evaluateHand` valued cards wrongly
(low and mid trump 3-6x too low on big hands, too high on 3-4 card hands), so
the floor of its points was a poor trick estimate. Play was checked too: it
never sheds a trick once the contract is made (0 declined 4th-seat wins out of
~47,000 lost tricks), so tricks won are a fair "max winnable".

The fix, for trump hands of 3+ cards (no-trump and 1-2 card hands unchanged):

1. `estimateTricks`: per-card values (`TRICK_WEIGHTS`, per hand-size group
   3-4 / 5-7 / 8-10 / 11-13) from a least-squares fit of tricks won on the
   features the bidder sees (jokers, trump by rank, side A / K / Q, voids,
   singletons, trump length) over 2,000 self-play games (seed 501, ~85,000
   hands) of a prototype that already used re-weighted values, so the fit
   describes the play the new bids produce. Unbiased on held-out games;
   residual sd 0.59 / 0.76 / 0.86 / 0.91 tricks.
2. `chooseBidForMaxScore`: tricks ~ Normal(estimate + 0.1, sd), pick the bid
   with the highest expected team score (made = 10 x team bid + overtricks,
   set = -10 x team bid, a partner's bid already made counts as at stake).
   The thresholds this gives, 8-card hand, partner not yet bid: bid 1 from an
   estimate of 0.47, 2 from 2.01, 3 from 3.26, 4 from 4.42. The +0.1 and the sd
   scale were chosen on counterfactual replays (even games) and checked on
   held-out odd games: 0 to +0.2 and 0.9-1.0 x sd all score within noise; it
   beat a flat `floor(estimate + c)` per group by ~4 points per game there.

The late-game risk rules and the personality modifiers read the estimate
(`bidEval.points`) in place of the old points. Sharon's trim now applies only
when the estimate clears her bid by less than half a trick (a blanket trim on
top of the cautious big-bid rounding cost her 2.6pp).

| Matchup | Seed | Games | Win rate (X) | Avg score delta |
|---|---|---|---|---|
| mary,mary vs HEAD efb189a mary,mary | 31 | 16,000 | 64.4% ±0.7 | +37.3 |
| mary,mary vs re-weight + floor prototype | 32 | 16,000 | 51.4% ±0.8 | +0.4 |
| mary,mary vs HEAD (sanity) | 35 | 500 | 64.9% ±4.2 | +38.9 |
| `--exp legacy`: mary vs legacy mary | 36 | 4,000 | 76.3% ±1.3 | +69.4 |
| `--exp legacy`: mary vs legacy danny+zach | 36 | 4,000 | 74.6% ±1.4 | +83.2 |

Self-play, seed 34, 4,000 games (new / HEAD): points per game 286 / 262;
player tricks - bid +0.46 / +0.59; exact 45.9% / 41.8%; won more 43.5% /
47.8%; won fewer 10.6% / 10.4%; team set rate 9.4% / 8.7%; overtricks per made
team-hand 1.09 / 1.34; zero bids 26% / 40%.

Personalities vs mary+mary, seed 33, 4,000 games (new / HEAD, ±1.6):
Sharon 50.4% / 49.1%, Danny 48.4% / 49.1%, Mike 48.3% / 48.9%, Zach 49.7% /
49.7%.

Refit when play changes materially: record per-hand features and tricks won
in self-play, refit `TRICK_WEIGHTS` and `BID_CALIBRATION.sd`, and A/B on fresh
seeds.
