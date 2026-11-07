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

Mary's bore stats (seeds 11/12): attempt rate 1.1% → 4.9–5.0% of hands,
success 89–91% → 82–83%, team set rate 8.7% → 8.8–8.9%. Bores fail more often
now, by design: a 2-card bore pays ±40 against roughly +10 to +20 for a plain
bid, so it stays +EV down to about a 60–65% sweep rate. A bid decision takes
at most ~1 ms (5-card hand). Zero incidents and zero exceptions in every run.
