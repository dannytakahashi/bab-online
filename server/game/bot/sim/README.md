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

## Play inference (November 2026)

A counterfactual study of the EV-bidding bots (every alternative card forced
once at every decision, the hand replayed by the bots; double-dummy values
on small hands) put the play leaks in ruffs and mid-hand leads: void bots
ruffed with their highest trump from 2nd and 3rd seat, never led trump
except the HI joker, and treated a void as a ruff threat (or a partner
ruff) after its owner had run out of trump. Bores, discards, over-trumps,
partner overtakes, 4th-seat play and opening leads showed no recoverable
gain.

`buildCardView` (BotStrategy.js) replays the card memory into: unseen
cards per suit, voids, who is out of trump, and a cap on each player's
highest remaining trump (certain: a failed trump follow, the card an
opponent had to play under a HI-joker lead; soft: a void player who
discarded instead of ruffing or over-ruffing an opponent's winner).
`PLAY_TUNING` holds one switch per rule:

- ruffs: 2nd seat the lowest winning trump (and a loser instead of a lone
  HI joker); 3rd seat low unless the opponent behind may over-ruff; a low
  ruff on partner's shaky (J or lower) winner;
- leads: a boss trump below the HI joker first (including one neither
  opponent can beat given the caps); the lowest of 3+ trump with no boss
  among them; neither once both opponents are out of trump; cash a safe
  boss off-suit card at normal effort; a void counts only while its owner
  has trump; avoid suits an opponent led.

Paired runs (each deal set played twice with the seats swapped, 95% CIs
over deal sets, harness outside the repo), tuned on seeds 101-109 and
reported on held-out seeds:

| Matchup (8000 deal sets each) | Seed | Win rate | Margin per game |
|---|---|---|---|
| ruffs + card view vs `origin/main` d93b08a (mary) | 301 | 56.1% ±0.4 | +19.4 ±0.7 |
| + lead rules vs ruffs only (mary) | 302 | 52.5% ±0.4 | +8.7 ±0.8 |
| + refit `bidModel` vs before the refit (mary) | 303 | 50.1% ±0.4 | +2.2 ±0.6 |
| all vs `origin/main` (mary) | 304 | 56.7% ±0.5 | +25.5 ±1.0 |
| all vs `origin/main` (danny+zach, each side) | 305 | 56.0% ±0.5 | +21.8 ±1.0 |
| all vs `origin/main` (sharon+mike, each side) | 306 | 55.9% ±0.5 | +21.3 ±1.1 |
| sharon / danny / mike / zach pair vs its own `origin/main` pair | 307-310 | 54.9% / 54.2% / 58.3% / 57.1% (±0.6) | +15.3 / +16.3 / +34.2 / +25.4 |
| sharon / danny / mike + mary vs mary + mary (all new) | 311 | 47.2% / 48.8% / 47.4% (±0.4) | −4.2 / −3.9 / −9.8 |

Mary vs `origin/main` (seed 304): tricks per team-hand 3.55 vs 3.33, team
set rate 6.9% vs 10.3%. Danny gains least: his flashy ruffs still spend
the highest trump by design, so with Mary he reads 48.8% (50.2% before).
0 illegal plays, 0 exceptions and 0 winnable 4th-seat tricks shed in every
run.

Each switch off against all on (Mary self-play, 8000 deal sets, seed 105,
points per game): soft trump-out +0.81 ±0.18, void-needs-trump lead rules
+2.13 ±0.28, opponent-led penalty +1.10 ±0.54, capped boss trump +0.56
±0.26, shaky = J rather than Q +0.36 ±0.15, lone-HI hold +0.39 ±0.14,
cash boss off-suit +0.54 ±0.64 (kept: +2.0 ±0.5 on its own in the study).
Tried and dropped (within noise or negative): ducking a winner the
opponent behind will ruff, leading low rather than an honor into a ruff,
holding the HI joker lead once opponents are out of trump, treating
partner's winner as safe from a void opponent with no trump, a bonus for
suits partner led, weighting suits by unseen cards, counting a suit with
no unseen cards as a void, picking the cheapest uncapped trump at 2nd seat
against a void opponent, low-trump leads from 2 or 4+ trump only or by
trump ratio.

`bidModel.js` was refit on the new play (three rounds, seeds 901-912).
Play never sheds a winnable 4th-seat trick (0 in every run). A play
decision takes about 10 µs (p99 under 0.1 ms).

Repo harness after the change: legacy benchmark (`--exp legacy --games 8000
--seed 14`) 82.6% / 82.0% (79.5% / 78.2% before); personalities (`--exp
personalities --games 8000 --seed 51`) sharon+mary 47.7%, danny+mary 49.0%,
mike+mary 47.2%, zach+mary 46.8% (±1.1).

## Play search (November 2026)

Card play with 7 cards or fewer in hand is searched (`../playSearch.js`):
the bot samples 64 deals of the unseen cards, solves each exactly with all
hands open, and plays the card with the best average hand score (own points
minus the opponents' under the real contract). The rule-based card stands
on an exact tie, above 7 cards, and when the bot has not seen the whole
hand. Last to play, only winners are considered when the trick can be won.

Sampled deals respect shown voids, the forced play under a HI-joker lead, a
last seat that lost a trick (it held nothing that would have won it), and
the bids: 5x the deals are drawn and the ones whose hands fit what their
owners bid (`estimateOwnTricks` within about 0.6 of bid + 0.4) are kept.

Measured with a paired harness (each deal set played twice with the seats
swapped, deals a pure function of seed/game/hand/redeal; ± is a 95% CI over
deal sets). Every run: 0 illegal plays, 0 exceptions, and no lost last-seat
trick that a legal card would have won.

| Comparison (Mary pair unless named) | Deal sets, seed | Win rate | Margin per game |
|---|---|---|---|
| search vs origin/main d93b08a | 8000, 424242 | 61.6% ±0.50 | +39.5 ±1.0 |
| core only (uniform deals) vs main | 4000, 424242 | 59.8% ±0.71 | +33.6 ±1.3 |
| + bid fit vs core | 4000, 424242 | 51.6% ±0.63 | +5.2 ±1.2 |
| + last-seat inference vs bid fit | 4000, 424242 | 50.2% ±0.29 | +0.85 ±0.49 |
| sharon pair vs its main version | 2000, 515151 | 61.8% ±1.0 | +32.9 ±1.6 |
| danny pair vs its main version | 2000, 515151 | 64.7% ±1.1 | +50.8 ±2.2 |
| mike pair vs its main version | 2000, 515151 | 64.1% ±1.1 | +52.9 ±2.7 |
| zach pair vs its main version | 2000, 515151 | 62.8% ±1.0 | +40.7 ±2.0 |

Against main the searching pair takes 3.59 tricks per hand to 3.29 and is
set on 6.9% of hands to main's 11.9%.

What was tried on the way (2000 deal sets each, seed 101, margin vs main):
- Scope (first version, 24 deals): 5 cards +19.7, 6 cards +23.1 to +23.3,
  7 cards +24.2 to +24.8. 8 cards added nothing inside the node budget.
- Leaving the rule card only for a clear gain lost points: no threshold
  +26.4, half a point and one standard error +23.1, one point and two
  standard errors +10.9. The search is trusted outright.
- Deals per decision: 12 +26.7, 24 +31.2, 40 +34.1, 64 +35.6 (with the bid
  fit). Drawing 5x instead of 3x candidates: +38.6. Node budget 200k instead
  of 100k: +40.5.
- Bid-fit tolerance, at 24 deals: none +28.2, 1.2 tricks +29.6, 0.8 +31.2,
  0.5 +32.3. At 64 deals 0.45 and 0.6 tie (+38.4, +38.6).
- Solver: canonical (rank-free) transposition keys cut nodes 2.6x on 7-card
  deals, sure-trick bounds another 1.5x; a best-lead move from the table and
  boss-first lead ordering did nothing and were dropped.

Cost. A decision is deterministic (seeded from the position, limited by
solver nodes, never by time). Per searched decision on an M-series laptop
core: p50 1.5 ms, p99 10 ms, mean about 3 ms; the hard stop (300,000
nodes) works out to about 13 ms. A full game is about 45 searched decisions
per bot. Sims are slower for it: a Mary-vs-Mary game takes about 0.5 s of CPU
instead of a few milliseconds, so `npm run sim -- --games 500` took 35
minutes here (one process, machine busy) and the refit recipe above is about
2 CPU-hours per 16000-game round (run seeds in parallel processes and
concatenate the records). That run (seed 1): mary vs legacy mary 85.8%,
vs legacy danny+zach 85.0% (±3.1; 79.5% / 78.2% before the search);
sharon+mary 45.7%, danny+mary 47.7%, mike+mary 46.1%, zach+mary 47.9%
against mary+mary (±4.4); 0 incidents, 0 exceptions. Paired, 2000 deal sets
(seed 616161, search on both sides): sharon+mary 49.3% ±0.8, danny+mary
49.4% ±0.7, mike+mary 47.2% ±0.7, where the bidding follow-ups measured
48.0%, 49.9% and 47.4%: the personalities sit where they did.

Recordings. The wire golden and the iOS event logs change with any play
change (re-record as for bidding). Tests whose point is a situation the
current bots no longer happen to produce in events-bots-s12 (an over-trump
of seat 1: web `overTrumpEffect`, `overTrumpPartner`; a B + 2B hand: web
`seatPipsRejoin`, `seatPipsSpectator`, iOS `SeatPipsTests`) read the game as
recorded before the play changes, kept by hand in
`iOSClient/BABOnlineTests/Fixtures/kept/kept-bots-s12.json` (see "Combined
play" below).

Bid tables after the play change. With all four seats searching, defence is
sharper and the team trick spread is wider (fitted `TEAM_SD` on 13 cards
1.10 -> 1.28), so teams are set more often than the tables expect: 10.4% of
team-hands in search self-play against 8.1% in main self-play (1000 deal
sets, seed 717171; team bids and overtricks are the same, 2.83 and +0.97).
A two-round refit on 6000 games per round (seeds 901-905, then 911-915)
against the unrefit tables, search on both sides: round 1 49.9% ±0.9,
+3.2 ±1.5 points per game (2000 deal sets, seed 828); round 2 51.1% ±0.7,
+2.4 ±1.2 (3000, seed 829), sets 9.7% against 10.4%. It also flipped a
Danny regression test (a worthless 2-card hand bid 1), which is what a fit
on a third of the usual data does at the margins, so the refit is NOT in
this change: run the full 16000-game, three-round recipe once the play
changes are settled.

## Combined play (November 2026)

The play-inference rules and the play search were built separately and are
combined here: the card view and its rules pick the card above 7 cards in
hand (and are the search's tie-break below), the search picks it from 7
cards down, and `bidModel.js` is the refit made on the play-inference bots.
Three things were settled on the combination:

- **Danny's flashy ruff** now sits below the low-ruff rules (he still plays
  the very top trump where the ruff has to be high). Left above them he kept
  the old high-ruff leak and drifted about 1.8 win points against Mary.
- **`holdLoneHiRuff` is off.** Holding a lone HI joker back at 2nd seat
  declines a trick that can be won; with the endings searched it was worth
  +0.09 ±0.07 points a game (4000 deal sets, seed 880101), and it made
  partner's soft out-of-trump read wrong about 4% of the time.
- **`ruffForPartnerNoTrump` is off.** In no-trump the low ruff on partner's
  shaky winner spends a joker: +0.04 ±0.04 with it off (4000, seed 880102).

The refit tables earn more next to the search than they did alone: 50.7%
±0.6, +3.3 ±1.1 against the same play on main's tables (4000, seed 880103),
team sets 9.8% against 10.5%. They were fitted on rule-only play, so a refit
on the combined play (about 2 CPU-hours per 16000-game round, see above) is
still open.

Paired harness as above (deal sets played twice, seats swapped, ± 95% CI
over deal sets; a different deal hash and seeds from every earlier run).
Every run: 0 illegal plays, 0 exceptions, 0 errors inside the search, and
no lost last-seat trick that a legal card would have won, before or after
the contract was made (over 2.5 million lost last-seat tricks checked on
the combined side).

| Comparison (Mary pair unless named) | Deal sets, seed | Win rate | Margin per game |
|---|---|---|---|
| combined vs origin/main | 8000, 990101 | 62.05% ±0.54 | +43.7 ±1.1 |
| combined vs main, danny+zach | 4000, 990102 | 62.59% ±0.77 | +43.2 ±1.5 |
| combined vs main, sharon+mike | 4000, 990106 | 62.98% ±0.77 | +46.2 ±1.7 |
| combined vs the play search alone | 8000, 990103 | 51.24% ±0.47 | +7.6 ±0.9 |
| combined vs the play inference alone | 8000, 990104 | 55.86% ±0.46 | +19.9 ±0.9 |
| combined vs the play-leak fixes alone | 8000, 990105 | 57.40% ±0.51 | +27.1 ±1.0 |
| sharon+mary vs mary+mary, all combined | 2000, 990111 | 48.65% ±0.76 | -0.3 ±1.2 |
| danny+mary vs mary+mary | 2000, 990112 | 50.06% ±0.65 | +0.7 ±1.0 |
| mike+mary vs mary+mary | 2000, 990113 | 47.55% ±0.69 | -9.5 ±1.3 |
| zach+mary vs mary+mary (partner history recorded) | 2000, 990114 | 48.08% ±0.70 | -3.8 ±1.1 |

The personalities sit where they did on main (47.8%, 50.0%, 47.4%, 48.0%).
Against main the combined pair takes 1.83 tricks per player-hand to 1.67 and
is set on 6.2% of team-hands to main's 12.2%. Every hand size from 2 cards
up gains (2 cards +0.18 ±0.12 points per game, 13 cards +8.9 ±0.5);
no-trump hands +2.6 ±0.3; hands with a bore on the table are flat.

Self-play calibration (2000 deal sets, seed 990120): team set rate 9.7%
(main 7.6%, search alone 10.2%), player tricks minus bid +0.47, exact bids
44.9%, bores 4.8% of hands and 85% made. All-bot tables see more sets than
on main because both sides defend better.

Cost per searched decision, one process on a quiet M-series laptop: p50
1.3 ms, p90 8.4 ms, p99 9.7 ms, max 23 ms (51,000 decisions); decisions
above 7 cards p99 0.04 ms. `npm run sim -- --games 500` (seed 1001): 0
incidents, 0 exceptions; mary vs legacy mary 84.4%, vs legacy danny+zach
85.6% (±3.1).

Recordings. The combined bots bore on no hand of events-bots-s12 and no
longer over-trump seat 1 there, so the tests that need a B + 2B hand or an
over-trump read `iOSClient/BABOnlineTests/Fixtures/kept/kept-bots-s12.json`
(that game as recorded before the play changes; `replay.loadKeptRecording`
on the web, `FixtureLoader.keptBots` on iOS). `npm run ios:fixtures` never
rewrites it. The pacing pins did not move (legacy 592.7 s).

### Last-seat read: a read, not a rule

The search read a last seat that lost a trick as holding nothing that
would have won it, and kept that cap for the rest of the hand. Nothing
forces a void last seat to ruff, so a player who declines one ruff and ruffs
later was still dealt no trump. The read is now kept apart from the rules
(voids, HI-joker forced plays): any later card above it lifts that player's
reads and the player is not read again that hand, and when the reads leave
a hand too few cards, or let fewer than `minSamples` deals through, the
deals come from the rules alone (before, the search gave up and the rule
card stood).

Paired harness as above (deal sets played twice, seats swapped, ± 95% CI
over deal sets). "Duckers": the opposing pair (main's bots), last to play,
void in a side-suit lead with an opponent winning, declines a winning ruff
25% of the time and throws its lowest side card (3,600 ducks in 2000 deal
sets). The gain is the per-deal-set difference between the new pair and
main's pair against the same duckers on the same deals.

| Comparison | Deal sets, seed | Win rate | Margin per game |
|---|---|---|---|
| new vs main, Mary pair | 4000, 31337 | 50.00% ±0 | 0.0 ±0 (every set identical) |
| gain against 25% duckers, Mary pair | 2000, 4242 | +0.16 ±0.17 points | +0.45 ±0.33 |
| soft read instead (deals that break a read kept at weight 0.2) vs main | 4000, 31337 | 49.93% ±0.30 | -0.38 ±0.47 |
| soft read, gain against 25% duckers | 2000, 4242 | +0.35 ±0.49 points | +0.47 ±0.81 |

The bots never break a read in the Mary pair games (no decision changed in
8000 games), so the lift costs nothing there; against duckers it changed
the result of 226 of the 2000 deal sets. The soft read moved 0.8% of the
searched decisions against bots that do play by the read, for no more gain
against duckers, so it is not used. 0 illegal plays, 0 exceptions, 0 search
errors in every run.
