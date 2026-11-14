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

## Expected-value bidding (November 2026, 16000 games/match)

Players saw the bots "sandbag". Measured on Mary self-play before this change
(2000 games, seed 601): 65% of team-hands won more tricks than the team bid
(mean +1.19 tricks), and players hit their own bid exactly 42% of the time.
Play never throws tricks to match a bid: in 4th seat, where the check is
exact, no lost trick could have been won with another legal card (0 of
~68,000 after the contract was made, 0 of ~118,000 before), before and after
this change. So the gap was in the bid, and mostly in the hand evaluation
behind it (mid / low trump valued at 0.15 / 0.05 tricks on big hands against
~0.6 / ~0.35 in actual play).

On 3+ card hands with no bore on the table, `calculateOptimalBid` now
estimates a distribution of team tricks and bids the number that maximizes
expected team score (`BotStrategy.js`, "Expected-value bidding"):

- own tricks: fitted per-card values in `../bidModel.js` (by hand-size
  group), shifted by numeric opponent bids already made;
- partner: their bid plus their mean overtricks if they bid first, else an
  average over what a second-of-team partner bids;
- team tricks ~ Normal(mean, TEAM_SD, or the wider TEAM_SD_NO_TRUMP when a
  joker was flipped) discretized to 0..handSize, each bid
  scored with the real contract scoring (team bid capped at the hand size; an
  all-zero table's last 0 counts as a redeal).

Late game (progress >= 0.7, score difference > 30) leans to the highest
(behind) or lowest (ahead) bid within 2 points of the best. Danny / Sharon
lean up / down within 1.5 points; Zach swaps the population
partner-overtrick figure for his partner's observed one (shrunk toward it);
Mike keeps his 10% +1. 1-2 card hands and hands with a bore out keep the
previous rules (2-card hands moved to EV in the follow-ups below). The old evaluation-based rules (floor rounding, small-hand
caps, opponents-bid-60% and partner-bid-half trims) no longer apply to the
EV hands: the model reads those bids directly.

Refit recipe (the tables describe how the current bots play, so refit after
any bidding or card-play change; two or three rounds settle):

```bash
node server/game/bot/sim/simulate.js --exp baseline --games 4000 --seed 604 --records /tmp/bids.jsonl
node server/game/bot/sim/fitBidModel.js /tmp/bids.jsonl --note "..." > server/game/bot/bidModel.js
```

Tuned on seeds 31-51 and 601-604; the numbers below are on held-out seeds.

| Matchup (new vs `efb189a` snapshot) | Seed | Win rate (X) | Avg score delta |
|---|---|---|---|
| mary,mary vs base:mary,base:mary | 61 | 68.1% ±0.7 | +65.5 |
| mary,mary vs base:mary,base:mary | 62 | 68.2% ±0.7 | +66.1 |
| danny,zach vs base:danny,base:zach | 13 | 66.2% ±0.7 | +66.1 |

| Legacy benchmark (`--exp legacy --seed 14`) | Before | After |
|---|---|---|
| mary vs legacy mary | 62.1% ±0.8 | 79.1% ±0.6 |
| mary vs legacy danny+zach | 61.8% ±0.8 | 77.2% ±0.7 |

Calibration, Mary self-play (seed 601 before, seed 605 after; 2000 / 4000
games): player tricks minus bid +0.59 → +0.47, exact 41.9% → 46.9%; team
tricks minus bid +1.19 → +0.95, exact 26.3% → 30.7%, set 8.8% → 6.8%; points
per team-hand 19.3 → 24.4. The remaining ~1 trick of team overage is the
scoring's optimum, not sandbagging: raising from team bid B to B+1 must make
(20B+10)/(20B+19) of the time (77% at B=1, 89% at B=3).

Knob checks against the fitted model (8000-16000 games each): spread ×0.85 /
×1.15 → 50.3% / 47.7%; mean +0.15 / −0.15 → 50.0% / 46.7%; late-game
tolerance 0 / 2 / 6 / 8 against 4 → 49.6% / 50.4% / 49.8% / 46.9%, and 2
against 4 again on seeds 65 / 66 → 49.7% / 49.7% (+4.4 / +4.8 points): win
rate is flat there, 2 kept for the points. Personalities (`--exp
personalities --games 8000 --seed 51`): sharon+mary 47.5%, danny+mary 50.1%,
mike+mary 47.8%, zach+mary 48.8% (±1.1). A bid decision takes ~0.05 ms.
Zero incidents and zero exceptions in every run.

## EV follow-ups (November 2026)

Paired ("duplicate") runs: every deal set is played twice with the seats
swapped, so both pairs play the same cards; 95% CIs over deal sets.

**No-trump spread.** No-trump hands were already on the EV path, with their
own fitted card values, but they shared the trump hands' spread. Their team
tricks spread far wider (residual SD 1.10 vs 0.79 on 3-4 cards, 1.47 vs 1.13
on 11-13), so the bidder treated them as safer than they are: team set rate
13.4% on no-trump vs 6.5% on trump (Mary self-play, seed 701). Richer
no-trump features (guarded kings / queens, long suits, voids) cut the
residual by under 2%, so the fix is the spread: `fitBidModel.js` now fits
`TEAM_SD_NO_TRUMP` (by hand size) from no-trump rows and `TEAM_SD` from
trump rows only. Refit three rounds on seeds 701-724 (16000 games per round).
Against the previous tables (8000 deal sets, seed 811): no-trump team sets
14.7% → 10.4%, +0.37 ±0.35 points per no-trump hand, game win rate 50.3%
±0.3, margin +0.7 ±0.5; danny+zach (4000, seed 812) 50.2% ±0.5.


**Locked-winner floor.** `countLockedWinners` (top jokers, then trump in an
unbroken run from the HI joker) are certain tricks, but the fitted values
average the LO joker and trump A over hands without the cards above them, so
EV sometimes bid one under a lock. Mary self-play (4000 games, seed 731):
57 of 175,332 3+ card bot-hands bid below their lock (33 bidding first,
e.g. both jokers on 3 cards bid 1; 6 with the team bid below it), and 53 of
10,892 2-card hands (all partner-first trims; team bid never below). Every
one of those hands took at least its locked tricks. The floor is our own
bid when we bid first and the team bid when partner already bid (a
player-level floor there raised 2-card sets 4.84% → 5.03%, margin −0.01
±0.02, because partners' winners can share a trick). Paired runs against
the previous commit: mary 49.99% ±0.02, margin +0.01 ±0.02 (8000 deal sets,
seed 823); sharon+mike +0.04 ±0.06 (4000, seed 824); danny+zach +0.00 ±0.05
(4000, seed 825). Neutral, as a 0.02%-of-hands change must be; kept so that
a bot never visibly bids under cards that cannot lose.

**2-card hands on the EV path.** The old 2-card rules (count jokers and trump
Q+, trim under a partner's bid) were very cautious: team set 2.1%, but team
overtricks +0.40 on a 2-trick hand, and many all-zero tables that ended in a
redeal or a bore. `EV_MIN_HAND_SIZE` is now 2 (fitted group `XS`); 1-card
hands keep the rules (every kept 1-card deal has a bore on the table, so
there is nothing to fit), as does any hand with a bore out. Bore logic is
unchanged; 2-card bores fall from 10.2% to 5.2% of bot-hands (success
83.4% → 83.2%) because numeric bids now come earlier and fewer tables reach
the all-zero spots where bores fire. Mary self-play (seed 791): 2-card team
overtricks +0.40 → +0.18, team set 2.1% → 9.3%. Paired runs against the
previous commit, tables refit three rounds (seeds 761-784): mary 50.6% ±0.3,
margin +2.1 ±0.5 per game (8000 deal sets, seed 841; +0.9 ±0.2 per 2-card
hand); danny+zach 51.1% ±0.5, +3.1 ±0.6 (4000, seed 842); sharon+mike
50.7% ±0.5, +2.1 ±0.7 (4000, seed 843). The whole follow-up branch against
`bots/bidcal-ev`: mary 51.3% ±0.4, +2.5 ±0.5 (8000, seed 851); danny+zach
51.2% ±0.5, +3.0 ±0.8 (4000, seed 852). Legacy benchmark (`--exp legacy
--games 8000 --seed 14`): 79.5% / 78.2%. Personalities (`--exp personalities
--games 8000 --seed 51`): sharon+mary 46.9%, danny+mary 50.2%, mike+mary
47.1%, zach+mary 47.6% (±1.1). Zero incidents and exceptions throughout.

Refit recipe unchanged (2-card rows are now included automatically).
