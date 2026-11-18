/**
 * The reason taxonomy (plan §3.4): one template per code the bot's decision
 * trace can end on. explain.js picks the codes; this table holds the words.
 *
 * Each template is (facts, x) => string | string[] (variants, longest
 * first: explain keeps the first that fits the length cap). `facts` are the
 * trace's own facts for that code; `x` is explain's context (names, card and
 * suit words, what the seat has seen). A template may only name a card the
 * seat can see: one in its own hand, one already played, or the flipped
 * trump card (copy.test.js checks every rendered string), and may only say
 * of another seat what its bid or its played cards showed.
 *
 * Unless noted the examples assume hearts are trump.
 */

'use strict';

const { cardText, suitWord, capital, listText, numWord } = require('./copy');

// ---------------------------------------------------------------- contract

/** C.*: the contract line that opens every play explanation. */
const CONTRACT = {
    // "You and Bob bored: you must win every trick."
    'C.boreUs': (f, x) => `${capital(x.us())} bored: you must win every trick.`,
    // "Carol bored. One trick for you or Bob sets the bore."
    'C.boreThem': (f, x) => (f.myTricks > 0
        ? `${x.borer()} bored, and you or ${x.partnerName()} already took a trick: the bore is set.`
        : `${x.borer()} bored. One trick for you or ${x.partnerName()} sets the bore.`),
    // "You and Bob need every trick left (3 of 3)."
    'C.max': (f, x) => `${capital(x.us())} need every trick left (${f.needed} of ${f.left}).`,
    // "Carol and Dan need 3 of the last 4. Two more for you or Bob sets them."
    'C.setThem': (f, x) => `${x.them()} need ${f.oppNeeded} of the last ${f.left}. ${capital(numWord(f.toSet))} more for you or ${x.partnerName()} sets them.`,
    // "You and Bob need 2 more of the last 5 tricks."
    'C.normal': (f, x) => `${capital(x.us())} need ${f.needed} more of the last ${f.left} tricks.`,
    // "You and Bob have made your bid. Extra tricks are worth 1 point each, so save strong cards."
    'C.made': (f, x) => (f.myBid === 0
        ? `${capital(x.us())} bid 0, so each trick is worth 1 point: no need to spend strong cards.`
        : `${capital(x.us())} have made your bid. Extra tricks are worth 1 point each, so save strong cards.`),
    // "You and Bob can't make your bid now. Keep your good cards rather than spend them."
    'C.dead': (f, x) => `${capital(x.us())} can't make your bid now. Keep your good cards rather than spend them.`
};

// ---------------------------------------------------------------- leads

const LEAD = {
    'L.only': () => 'It\'s the only card you may lead (trump can\'t be led until it\'s broken).',
    // Lead the HI joker. "Nothing beats it, and Carol and Dan must each play their highest trump."
    'L.maxHi': (f, x) => `Nothing beats it, and ${x.them()} must each play their highest trump.`,
    'L.maxBossTrump': (f, x) => `No one else holds a higher trump${x.higherPlayed(x.card)}: a sure trick.`,
    'L.maxCashBoss': (f, x) => [
        `No one else holds a higher ${suitWord(x.card.suit, 1)}${x.higherPlayed(x.card)}, and nobody has shown they can trump it.`,
        `No one else holds a higher ${suitWord(x.card.suit, 1)}, and nobody has shown they can trump it.`
    ],
    'L.maxTrump': () => 'Every trick counts now: lead your highest trump.',
    'L.maxHigh': () => 'Every trick counts now: lead your highest card.',
    // Lead Q♥. "No one else holds a higher trump (A♥ and K♥ are played): a sure trick that also pulls trump from Carol and Dan."
    'L.bossTrump': (f, x) => (f && f.higherUnseen > 0
        ? [
            `From what ${x.them()} have played, neither can beat it: a sure trick that also pulls their trump.`,
            'From what they have played, neither can beat it: a sure trick that pulls their trump.'
        ]
        : [
            `No one else holds a higher trump${x.higherPlayed(x.card)}: a sure trick that also pulls trump from ${x.them()}.`,
            `No one else holds a higher trump: a sure trick that also pulls trump from ${x.them()}.`
        ]),
    // Lead A♣. "No one else holds a higher club, and neither Carol nor Dan has shown they can trump clubs: take it while you can."
    'L.cashBoss': (f, x) => {
        const s = x.card.suit;
        const top = `No one else holds a higher ${suitWord(s, 1)}${x.higherPlayed(x.card)}`;
        if (f && f.cheap) return [`${top}: cash it while you have the lead.`, `No one else holds a higher ${suitWord(s, 1)}: cash it while you can.`];
        if (x.noTrump) return [`${top}, and with no trump suit this hand only a joker can beat it: take it while you can.`, `${top}: take it while you can.`];
        return [
            `${top}, and neither ${x.nameOf(x.view.others[0])} nor ${x.nameOf(x.view.others[1])} has shown they can trump ${suitWord(s)}: take it while you can.`,
            `${top}, and nobody has shown they can trump it: take it while you can.`
        ];
    },
    // Lead the HI joker. "It wins, and Carol and Dan must give up their highest trump."
    'L.hiJoker': (f, x) => `It wins, and ${x.them()} must give up their highest trump.`,
    // Lead 4♥. "You have 5 trumps but not the top one. Leading low draws Carol's and Dan's trump, and yours last longer."
    'L.lowTrump': (f, x) => [
        `You have ${f.trumps} trumps but not the top one. Leading low draws ${x.themPossessive()} trump, and yours last longer.`,
        `You have ${f.trumps} trumps but not the top one: leading low draws theirs, and yours last longer.`
    ],
    'L.suitAce': (f, x) => `An ace is the likeliest winner in ${suitWord(x.card.suit)}.`,
    'L.suitKing': (f, x) => (f && f.acePlayed
        ? `The ${cardText({ suit: x.card.suit, rank: 'A' })} is played, so your ${cardText(x.card)} is the highest ${suitWord(x.card.suit, 1)} left.`
        : `On a small hand the ace may not even have been dealt, so your ${cardText(x.card)} has a good chance.`),
    'L.suitLow': (f, x) => (x.ownInSuit(x.card.suit) > 1
        ? `Lead low and save your higher ${suitWord(x.card.suit)}.`
        : `It's your only ${suitWord(x.card.suit, 1)}.`),
    'L.onlyTrump': () => 'You only have trump left: lead your lowest.',
    'L.fallback': () => 'Lead your lowest card.'
};

// ---------------------------------------------------------------- follows

const FOLLOW = {
    'F.only': (f, x) => x.forcedText(),
    'F.erraticOvertake': (f, x) => `It beats ${x.partnerPoss()} ${cardText(x.winner.card)}.`,
    // Play A♣. "Bob's J♣ could be beaten by Dan, who plays after you. Take it with your A♣, which is sure to hold."
    'F.overtake': (f, x) => [
        `${x.partnerPoss()} ${cardText(x.winner.card)} could still be beaten by ${x.behindText()}. Take it with your ${cardText(x.card)}: no one else holds a higher ${x.suitOrTrump(x.card)}.`,
        `${x.partnerPoss()} ${cardText(x.winner.card)} could still be beaten. Take it with your ${cardText(x.card)}: no one else holds a higher one.`
    ],
    'F.overtakeFight': (f, x) => [
        `${x.partnerPoss()} ${cardText(x.winner.card)} could still be beaten by ${x.behindText()}. Your ${cardText(x.card)} gives the trick the best chance.`,
        `${x.partnerPoss()} ${cardText(x.winner.card)} could still be beaten: your ${cardText(x.card)} gives the best chance.`
    ],
    // Play 2♣. "Bob is winning with the K♣ and only Dan plays after you. Play low and keep the rest."
    'F.partnerWinsLow': (f, x) => {
        const p = x.partnerName();
        const pc = cardText(f.partnerCard);
        if (!f.opponentsRemain) return `${p} is winning with the ${pc} and nobody plays after you. Play low and keep the rest.`;
        if (f.partnerVulnerable) return `${p} is winning with the ${pc}. You can't make it safer, so play low and keep the rest.`;
        return [
            `${p} is winning with the ${pc}, and no one else holds a higher ${x.suitOrTrump(f.partnerCard)}. Play low and keep the rest.`,
            `${p} is winning with the ${pc}. Play low and keep the rest.`
        ];
    },
    'F.hoardDuck': () => 'Play low: none of your cards is sure to win this one.',
    'F.flashyWin': (f, x) => `It beats the ${cardText(x.winner.card)}.`,
    // Play K♠. "No one else holds a higher spade (A♠ is played): the cheapest card likely to win."
    'F.winSure': (f, x) => (x.trumpCard(x.card)
        ? `No one else holds a higher trump${x.higherPlayed(x.card)}, so it wins the trick.`
        : [
            `No one else holds a higher ${suitWord(x.card.suit, 1)}${x.higherPlayed(x.card)}: the cheapest card likely to win.`,
            `No one else holds a higher ${suitWord(x.card.suit, 1)}: the cheapest card likely to win.`
        ]),
    // Play Q♠. "None of your spades is sure to win; Q♠ gives the best chance."
    'F.winFight': (f, x) => `None of your ${x.trumpCard(x.card) ? 'trumps' : suitWord(x.card.suit)} is sure to win; the ${cardText(x.card)} gives the best chance.`,
    // Play 10♠. "You play last, so the lowest card that beats the 9♠ is enough."
    'F.lastLowestWin': (f, x) => `You play last, so the lowest card that beats the ${cardText(f.winningCard)} is enough.`,
    // Play 3♠. "You can't beat Carol's A♠, so play your lowest spade."
    'F.cantWin': (f, x) => `You can't beat ${x.nameOf(f.winnerPosition)}'s ${cardText(f.winningCard)}, so play your lowest ${x.trumpCard(x.card) ? 'trump' : suitWord(x.card.suit, 1)}.`,
    'F.ruffMaxPartner': (f, x) => [
        `Every trick counts, and ${x.partnerPoss()} ${cardText(f.partnerCard)} could still lose. Trumping makes sure of it.`,
        `${x.partnerPoss()} ${cardText(f.partnerCard)} could still lose, and you need every trick: trump it.`
    ],
    // Trump with 6♥. "Bob's J♦ could still lose, and nobody after you has shown they're out of diamonds. A low trump makes sure of it."
    'F.ruffForPartner': (f, x) => [
        `${x.partnerPoss()} ${cardText(f.partnerCard)} could still lose, and nobody after you has shown they're out of ${suitWord(x.leadSuit)}. A low trump makes sure of it.`,
        `${x.partnerPoss()} ${cardText(f.partnerCard)} could still lose: a low trump makes sure of it.`
    ],
    'F.onlyTrumpLeft': (f, x) => `${x.partnerName()} is winning, but you only have trumps left: play the lowest.`,
    'F.holdHi': () => 'Keep your HI joker for a lead of its own: throw a losing card here.',
    // Trump with 5♥. "You're out of diamonds; 5♥ is the lowest trump nobody after you can beat."
    'F.ruffLowSafe': (f, x) => (f && f.oppsBehind && f.oppsBehind.length
        ? [
            `You're out of ${suitWord(x.leadSuit)}, and from what's been played ${x.namesOr(f.oppsBehind)} can't beat your ${cardText(x.card)}: the cheapest safe trump.`,
            `You're out of ${suitWord(x.leadSuit)}, and from what's been played your ${cardText(x.card)} is the cheapest safe trump.`
        ]
        : `You're out of ${suitWord(x.leadSuit)}: the lowest trump that wins is enough.`),
    // Trump with 3♥. "You're out of diamonds and Bob plays after you, so a low trump is enough."
    'F.ruffLow2nd': (f, x) => `You're out of ${suitWord(x.leadSuit)} and ${x.partnerName()} plays after you, so a low trump is enough.`,
    'F.ruffLow3rd': (f, x) => [
        `You're out of ${suitWord(x.leadSuit)}, and ${x.nameOf(f.oppBehind)}, last to play, hasn't shown they're out of them: a low trump is enough.`,
        `You're out of ${suitWord(x.leadSuit)} and the last player hasn't shown they're out: a low trump is enough.`
    ],
    'F.flashyRuff': () => 'Trump high to make sure of the trick.',
    // Trump with J♥. "Nothing left can beat the J♥."
    'F.ruffSecure': (f, x) => `Nothing left can beat your ${cardText(x.card)}, so the trick is yours.`,
    'F.ruffFight': (f, x) => `${capital(x.behindText())} could still beat a low trump: your ${cardText(x.card)} gives the best chance.`,
    'F.ruffLast': () => 'You play last: the lowest trump that wins is enough.',
    'F.underTrump': (f, x) => `You can't beat the ${cardText(f.winningCard)}, and you only have trumps left: play the lowest.`
};

// ---------------------------------------------------------------- throws

/** Why the follow threw (context entry noted before selectDiscard). */
const THROW_CONTEXT = {
    // Throw 3♦. "Bob is winning, so keep your trumps for later."
    'D.partnerWins': (f, x) => (x.hasTrump()
        ? `${x.partnerName()} is winning with the ${cardText(f.partnerCard)}, so keep your trumps for later.`
        : `${x.partnerName()} is winning with the ${cardText(f.partnerCard)}, so throw a card.`),
    'D.cantOvertrump': (f, x) => `You can't beat ${x.nameOf(f.winnerPosition)}'s ${cardText(f.winningCard)}, so throw a card instead of wasting a trump.`,
    'D.noTrump': (f, x) => `You have no ${suitWord(x.leadSuit)} and no trump, so you can't win this one.`
};

const THROW = {
    // Throw 4♣. "Your last club: after it you can trump club leads."
    'D.voidShortest': (f, x) => (f.length === 1
        ? `It's your last ${suitWord(f.suit, 1)}: after it you can trump ${suitWord(f.suit, 1)} leads.`
        : `${capital(suitWord(f.suit))} is your shortest suit: throwing from it gets you closer to trumping ${suitWord(f.suit, 1)} leads.`),
    // Throw 6♦. "Keep your A♠: no one else holds a higher spade."
    'D.keepWinner': (f, x) => `Keep your ${cardText(f.kept)}: no one else holds a higher ${suitWord(f.kept.suit, 1)}.`,
    // Throw 4♣. "You can't win this one: drop your least useful card."
    'D.lowest': (f, x) => (f && f.noTrump
        ? 'Keep your winners and suits covered: throw your lowest card.'
        : 'Throw your least useful card.'),
    'D.allWinners': () => 'All your cards could win later: throw the lowest.'
};

// ---------------------------------------------------------------- other

const OTHER = {
    'P.generic': () => 'This is the card our strongest bot would play here.'
};

const TABLE = Object.freeze({ ...CONTRACT, ...LEAD, ...FOLLOW, ...THROW_CONTEXT, ...THROW, ...OTHER });

/** Codes that read as a sure thing on their own (plan §3.2, confidence). */
const SURE_CODES = new Set(['L.cashBoss', 'L.maxHi', 'F.winSure', 'F.lastLowestWin', 'F.cantWin']);
/** A locked winner: the trick is won whatever anyone holds. */
const CERTAIN_CODES = new Set(['L.hiJoker', 'L.maxHi', 'F.lastLowestWin', 'F.ruffLast', 'F.ruffSecure']);

/** "A, B and C" over card texts. */
function cardList(cards) {
    return listText(cards.map(cardText));
}

module.exports = { TABLE, CONTRACT, LEAD, FOLLOW, THROW_CONTEXT, THROW, OTHER, SURE_CODES, CERTAIN_CODES, cardList };
