# Testing Strategy

## Overview
The codebase has ZERO tests. This document outlines a complete testing strategy covering unit tests, integration tests, and end-to-end tests.

## Current State

- No testing framework installed
- No test files exist
- No test scripts in package.json
- Single `rainbowTest.js` file exists but is not automated
- Code architecture makes testing difficult (global state, tight coupling)

---

## Task 1: Install Testing Dependencies

```bash
npm install --save-dev jest @types/jest supertest socket.io-client
```

**Update package.json:**
```json
{
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage",
    "test:ci": "jest --ci --coverage --reporters=default --reporters=jest-junit"
  },
  "jest": {
    "testEnvironment": "node",
    "roots": ["<rootDir>/server"],
    "testMatch": ["**/__tests__/**/*.js", "**/*.test.js"],
    "coverageDirectory": "coverage",
    "collectCoverageFrom": [
      "server/**/*.js",
      "!server/**/__tests__/**",
      "!server/node_modules/**"
    ],
    "coverageThreshold": {
      "global": {
        "branches": 70,
        "functions": 70,
        "lines": 70,
        "statements": 70
      }
    }
  }
}
```

---

## Task 2: Create Test Directory Structure

```
server/
├── game/
│   ├── __tests__/
│   │   ├── Deck.test.js
│   │   ├── rules.test.js
│   │   ├── GameState.test.js
│   │   └── GameManager.test.js
│   ├── Deck.js
│   ├── rules.js
│   └── ...
├── socket/
│   └── __tests__/
│       ├── authHandlers.test.js
│       └── gameHandlers.test.js
└── __tests__/
    └── integration/
        ├── socket.integration.test.js
        └── game.integration.test.js
```

---

## Task 3: Unit Tests for Game Rules

**Create:** `server/game/__tests__/rules.test.js`

```javascript
const {
    rotatePosition,
    getPartnerPosition,
    isSameSuit,
    isVoidInSuit,
    isRainbow,
    isLegalMove,
    determineWinner,
    calculateScore,
    RANK_VALUES
} = require('../rules');

describe('rotatePosition', () => {
    test('rotates 1 to 2', () => {
        expect(rotatePosition(1)).toBe(2);
    });

    test('rotates 2 to 3', () => {
        expect(rotatePosition(2)).toBe(3);
    });

    test('rotates 3 to 4', () => {
        expect(rotatePosition(3)).toBe(4);
    });

    test('rotates 4 to 1 (wrap around)', () => {
        expect(rotatePosition(4)).toBe(1);
    });
});

describe('getPartnerPosition', () => {
    test('position 1 partner is 3', () => {
        expect(getPartnerPosition(1)).toBe(3);
    });

    test('position 2 partner is 4', () => {
        expect(getPartnerPosition(2)).toBe(4);
    });

    test('position 3 partner is 1', () => {
        expect(getPartnerPosition(3)).toBe(1);
    });

    test('position 4 partner is 2', () => {
        expect(getPartnerPosition(4)).toBe(2);
    });
});

describe('isSameSuit', () => {
    const trump = { suit: 'hearts', rank: 'A' };

    test('same regular suits returns true', () => {
        const card1 = { suit: 'spades', rank: '2' };
        const card2 = { suit: 'spades', rank: 'K' };
        expect(isSameSuit(card1, card2, trump)).toBe(true);
    });

    test('different suits returns false', () => {
        const card1 = { suit: 'spades', rank: '2' };
        const card2 = { suit: 'hearts', rank: 'K' };
        expect(isSameSuit(card1, card2, trump)).toBe(false);
    });

    test('joker matches trump suit', () => {
        const joker = { suit: 'joker', rank: 'HI' };
        const heart = { suit: 'hearts', rank: '5' };
        expect(isSameSuit(joker, heart, trump)).toBe(true);
    });

    test('joker does not match non-trump', () => {
        const joker = { suit: 'joker', rank: 'HI' };
        const spade = { suit: 'spades', rank: '5' };
        expect(isSameSuit(joker, spade, trump)).toBe(false);
    });

    test('two jokers match each other', () => {
        const joker1 = { suit: 'joker', rank: 'HI' };
        const joker2 = { suit: 'joker', rank: 'LO' };
        expect(isSameSuit(joker1, joker2, trump)).toBe(true);
    });
});

describe('isVoidInSuit', () => {
    const trump = { suit: 'hearts', rank: 'A' };

    test('empty hand is void in all suits', () => {
        expect(isVoidInSuit([], 'spades', trump)).toBe(true);
    });

    test('hand without suit is void', () => {
        const hand = [
            { suit: 'hearts', rank: '2' },
            { suit: 'diamonds', rank: '3' }
        ];
        expect(isVoidInSuit(hand, 'spades', trump)).toBe(true);
    });

    test('hand with suit is not void', () => {
        const hand = [
            { suit: 'spades', rank: '2' },
            { suit: 'diamonds', rank: '3' }
        ];
        expect(isVoidInSuit(hand, 'spades', trump)).toBe(false);
    });

    test('joker counts as trump suit', () => {
        const hand = [
            { suit: 'joker', rank: 'HI' },
            { suit: 'spades', rank: '3' }
        ];
        expect(isVoidInSuit(hand, 'hearts', trump)).toBe(false);
    });
});

describe('isRainbow', () => {
    const trump = { suit: 'hearts', rank: 'A' };

    test('hand with all 4 suits is rainbow', () => {
        const hand = [
            { suit: 'spades', rank: '2' },
            { suit: 'hearts', rank: '3' },
            { suit: 'diamonds', rank: '4' },
            { suit: 'clubs', rank: '5' }
        ];
        expect(isRainbow(hand, trump)).toBe(true);
    });

    test('hand missing a suit is not rainbow', () => {
        const hand = [
            { suit: 'spades', rank: '2' },
            { suit: 'spades', rank: '3' },
            { suit: 'diamonds', rank: '4' },
            { suit: 'clubs', rank: '5' }
        ];
        expect(isRainbow(hand, trump)).toBe(false);
    });

    test('joker counts as trump suit for rainbow', () => {
        const hand = [
            { suit: 'spades', rank: '2' },
            { suit: 'joker', rank: 'HI' },  // Counts as hearts
            { suit: 'diamonds', rank: '4' },
            { suit: 'clubs', rank: '5' }
        ];
        expect(isRainbow(hand, trump)).toBe(true);
    });

    test('hand with 2 jokers and 2 other suits is not rainbow', () => {
        const hand = [
            { suit: 'joker', rank: 'HI' },
            { suit: 'joker', rank: 'LO' },
            { suit: 'spades', rank: '4' },
            { suit: 'clubs', rank: '5' }
        ];
        expect(isRainbow(hand, trump)).toBe(false);  // Missing diamonds
    });
});

describe('isLegalMove', () => {
    const trump = { suit: 'hearts', rank: 'A' };

    describe('when leading', () => {
        test('can lead any non-trump when trump not broken', () => {
            const hand = [
                { suit: 'spades', rank: '2' },
                { suit: 'hearts', rank: '3' }
            ];
            const card = { suit: 'spades', rank: '2' };
            expect(isLegalMove(card, hand, null, trump, false)).toBe(true);
        });

        test('cannot lead trump when not broken and have other suits', () => {
            const hand = [
                { suit: 'spades', rank: '2' },
                { suit: 'hearts', rank: '3' }
            ];
            const card = { suit: 'hearts', rank: '3' };
            expect(isLegalMove(card, hand, null, trump, false)).toBe(false);
        });

        test('can lead trump when trump is broken', () => {
            const hand = [
                { suit: 'spades', rank: '2' },
                { suit: 'hearts', rank: '3' }
            ];
            const card = { suit: 'hearts', rank: '3' };
            expect(isLegalMove(card, hand, null, trump, true)).toBe(true);
        });

        test('can lead trump when only have trump', () => {
            const hand = [
                { suit: 'hearts', rank: '2' },
                { suit: 'hearts', rank: '3' }
            ];
            const card = { suit: 'hearts', rank: '2' };
            expect(isLegalMove(card, hand, null, trump, false)).toBe(true);
        });
    });

    describe('when following', () => {
        test('must follow suit if possible', () => {
            const hand = [
                { suit: 'spades', rank: '2' },
                { suit: 'hearts', rank: '3' }
            ];
            const leadCard = { suit: 'spades', rank: 'K' };
            const card = { suit: 'hearts', rank: '3' };
            expect(isLegalMove(card, hand, leadCard, trump, false)).toBe(false);
        });

        test('can play different suit if void', () => {
            const hand = [
                { suit: 'hearts', rank: '2' },
                { suit: 'hearts', rank: '3' }
            ];
            const leadCard = { suit: 'spades', rank: 'K' };
            const card = { suit: 'hearts', rank: '2' };
            expect(isLegalMove(card, hand, leadCard, trump, false)).toBe(true);
        });

        test('following suit is always legal', () => {
            const hand = [
                { suit: 'spades', rank: '2' },
                { suit: 'hearts', rank: '3' }
            ];
            const leadCard = { suit: 'spades', rank: 'K' };
            const card = { suit: 'spades', rank: '2' };
            expect(isLegalMove(card, hand, leadCard, trump, false)).toBe(true);
        });
    });
});

describe('determineWinner', () => {
    const trump = { suit: 'hearts', rank: 'A' };

    test('highest card of led suit wins when no trump', () => {
        const trick = [
            { suit: 'spades', rank: '5' },   // Position 1 (lead)
            { suit: 'spades', rank: 'K' },   // Position 2 - wins
            { suit: 'spades', rank: '3' },   // Position 3
            { suit: 'spades', rank: '7' }    // Position 4
        ];
        expect(determineWinner(trick, 1, trump)).toBe(2);
    });

    test('trump beats non-trump regardless of rank', () => {
        const trick = [
            { suit: 'spades', rank: 'A' },   // Position 1 (lead)
            { suit: 'hearts', rank: '2' },   // Position 2 - trump wins
            { suit: 'spades', rank: 'K' },   // Position 3
            { suit: 'spades', rank: 'Q' }    // Position 4
        ];
        expect(determineWinner(trick, 1, trump)).toBe(2);
    });

    test('higher trump beats lower trump', () => {
        const trick = [
            { suit: 'hearts', rank: '5' },   // Position 1 (lead)
            { suit: 'hearts', rank: '2' },   // Position 2
            { suit: 'hearts', rank: 'K' },   // Position 3 - wins
            { suit: 'hearts', rank: '7' }    // Position 4
        ];
        expect(determineWinner(trick, 1, trump)).toBe(3);
    });

    test('HI joker beats everything', () => {
        const trick = [
            { suit: 'hearts', rank: 'A' },   // Position 1 (lead)
            { suit: 'joker', rank: 'HI' },   // Position 2 - wins
            { suit: 'hearts', rank: 'K' },   // Position 3
            { suit: 'hearts', rank: 'Q' }    // Position 4
        ];
        expect(determineWinner(trick, 1, trump)).toBe(2);
    });

    test('HI joker beats LO joker', () => {
        const trick = [
            { suit: 'joker', rank: 'LO' },   // Position 1 (lead)
            { suit: 'joker', rank: 'HI' },   // Position 2 - wins
            { suit: 'hearts', rank: 'K' },   // Position 3
            { suit: 'hearts', rank: 'Q' }    // Position 4
        ];
        expect(determineWinner(trick, 1, trump)).toBe(2);
    });

    test('off-suit card never wins', () => {
        const trick = [
            { suit: 'spades', rank: '5' },      // Position 1 (lead)
            { suit: 'diamonds', rank: 'A' },   // Position 2 - off suit
            { suit: 'spades', rank: '7' },      // Position 3 - wins
            { suit: 'clubs', rank: 'K' }        // Position 4 - off suit
        ];
        expect(determineWinner(trick, 1, trump)).toBe(3);
    });

    test('lead position wins if all others off-suit', () => {
        const trick = [
            { suit: 'spades', rank: '2' },     // Position 1 (lead) - wins
            { suit: 'diamonds', rank: 'A' },   // Position 2 - off suit
            { suit: 'clubs', rank: 'K' },      // Position 3 - off suit
            { suit: 'diamonds', rank: 'Q' }    // Position 4 - off suit
        ];
        expect(determineWinner(trick, 1, trump)).toBe(1);
    });
});

describe('calculateScore', () => {
    test('made bid exactly scores bid * 10', () => {
        expect(calculateScore(3, 3, 1, 0)).toBe(30);
    });

    test('made bid with overtricks adds overtricks', () => {
        // Bid 3, got 5 = 30 + 2 = 32
        expect(calculateScore(3, 5, 1, 0)).toBe(32);
    });

    test('missed bid is negative', () => {
        // Bid 5, got 3 = -50
        expect(calculateScore(5, 3, 1, 0)).toBe(-50);
    });

    test('rainbow bonus added to made bid', () => {
        // Bid 2, got 2, 1 rainbow = 20 + 10 = 30
        expect(calculateScore(2, 2, 1, 1)).toBe(30);
    });

    test('rainbow bonus added even to missed bid', () => {
        // Bid 5, got 3, 1 rainbow = -50 + 10 = -40
        expect(calculateScore(5, 3, 1, 1)).toBe(-40);
    });

    test('multiplier applies to bid', () => {
        // Bid 4, got 4, multiplier 2 = 4 * 10 * 2 = 80
        expect(calculateScore(4, 4, 2, 0)).toBe(80);
    });

    test('multiplier applies to negative', () => {
        // Bid 4, got 2, multiplier 2 = -4 * 10 * 2 = -80
        expect(calculateScore(4, 2, 2, 0)).toBe(-80);
    });

    test('board bid (12) with multiplier', () => {
        // Bid 12, got 12, multiplier 2 = 12 * 10 * 2 = 240
        expect(calculateScore(12, 12, 2, 0)).toBe(240);
    });

    test('zero bid made scores zero', () => {
        expect(calculateScore(0, 0, 1, 0)).toBe(0);
    });

    test('zero bid with overtricks scores overtricks only', () => {
        // Bid 0, got 3 = 0 + 3 = 3
        expect(calculateScore(0, 3, 1, 0)).toBe(3);
    });
});
```

---

## Task 4: Unit Tests for Deck

**Create:** `server/game/__tests__/Deck.test.js`

```javascript
const Deck = require('../Deck');

describe('Deck', () => {
    let deck;

    beforeEach(() => {
        deck = new Deck();
    });

    describe('initialization', () => {
        test('creates deck with 54 cards', () => {
            expect(deck.remaining).toBe(54);
        });

        test('contains all 52 standard cards', () => {
            const suits = ['spades', 'hearts', 'diamonds', 'clubs'];
            const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

            for (const suit of suits) {
                for (const rank of ranks) {
                    const found = deck.cards.some(c =>
                        c.suit === suit && c.rank === rank
                    );
                    expect(found).toBe(true);
                }
            }
        });

        test('contains HI joker', () => {
            const hiJoker = deck.cards.find(c =>
                c.suit === 'joker' && c.rank === 'HI'
            );
            expect(hiJoker).toBeDefined();
        });

        test('contains LO joker', () => {
            const loJoker = deck.cards.find(c =>
                c.suit === 'joker' && c.rank === 'LO'
            );
            expect(loJoker).toBeDefined();
        });
    });

    describe('shuffle', () => {
        test('maintains 54 cards after shuffle', () => {
            deck.shuffle();
            expect(deck.remaining).toBe(54);
        });

        test('randomizes card order', () => {
            const original = deck.cards.map(c => `${c.rank}_${c.suit}`);
            deck.shuffle();
            const shuffled = deck.cards.map(c => `${c.rank}_${c.suit}`);

            // Very unlikely to be in same order
            let samePosition = 0;
            for (let i = 0; i < 54; i++) {
                if (shuffled[i] === original[i]) samePosition++;
            }
            expect(samePosition).toBeLessThan(10);
        });
    });

    describe('draw', () => {
        test('draws correct number of cards', () => {
            const drawn = deck.draw(5);
            expect(drawn.length).toBe(5);
        });

        test('reduces deck size', () => {
            deck.draw(5);
            expect(deck.remaining).toBe(49);
        });

        test('returns valid cards', () => {
            const drawn = deck.draw(3);
            drawn.forEach(card => {
                expect(card).toHaveProperty('suit');
                expect(card).toHaveProperty('rank');
            });
        });

        test('throws error if drawing more than available', () => {
            deck.draw(50);
            expect(() => deck.draw(10)).toThrow();
        });
    });

    describe('drawOne', () => {
        test('returns single card', () => {
            const card = deck.drawOne();
            expect(card).toHaveProperty('suit');
            expect(card).toHaveProperty('rank');
        });

        test('reduces deck by one', () => {
            deck.drawOne();
            expect(deck.remaining).toBe(53);
        });

        test('throws error on empty deck', () => {
            deck.draw(54);
            expect(() => deck.drawOne()).toThrow();
        });
    });

    describe('reset', () => {
        test('restores all cards', () => {
            deck.draw(30);
            deck.reset();
            expect(deck.remaining).toBe(54);
        });

        test('can draw full deck after reset', () => {
            deck.draw(54);
            deck.reset();
            const drawn = deck.draw(54);
            expect(drawn.length).toBe(54);
        });
    });
});
```

---

## Task 5: Integration Tests for Socket Events

**Create:** `server/__tests__/integration/socket.integration.test.js`

```javascript
const { createServer } = require('http');
const { Server } = require('socket.io');
const Client = require('socket.io-client');

describe('Socket Integration', () => {
    let io, httpServer, clientSocket, serverSocket;
    const port = 3001;

    beforeAll((done) => {
        httpServer = createServer();
        io = new Server(httpServer);

        httpServer.listen(port, () => {
            clientSocket = Client(`http://localhost:${port}`);
            io.on('connection', (socket) => {
                serverSocket = socket;
            });
            clientSocket.on('connect', done);
        });
    });

    afterAll(() => {
        io.close();
        clientSocket.close();
        httpServer.close();
    });

    afterEach(() => {
        // Clean up listeners between tests
        serverSocket.removeAllListeners();
    });

    describe('connection', () => {
        test('client connects successfully', () => {
            expect(clientSocket.connected).toBe(true);
        });

        test('server receives connection', () => {
            expect(serverSocket).toBeDefined();
        });
    });

    describe('joinQueue', () => {
        test('server receives joinQueue event', (done) => {
            serverSocket.on('joinQueue', () => {
                done();
            });
            clientSocket.emit('joinQueue');
        });
    });

    describe('bidirectional communication', () => {
        test('server can emit to client', (done) => {
            clientSocket.on('testEvent', (data) => {
                expect(data.message).toBe('hello');
                done();
            });
            serverSocket.emit('testEvent', { message: 'hello' });
        });

        test('client can emit to server', (done) => {
            serverSocket.on('clientEvent', (data) => {
                expect(data.value).toBe(42);
                done();
            });
            clientSocket.emit('clientEvent', { value: 42 });
        });
    });
});
```

---

## Task 6: GameManager Tests

**Create:** `server/game/__tests__/GameManager.test.js`

```javascript
// Reset singleton between tests
let GameManager;

beforeEach(() => {
    jest.resetModules();
    GameManager = require('../GameManager');
});

describe('GameManager', () => {
    describe('joinQueue', () => {
        test('adds player to queue', () => {
            const result = GameManager.joinQueue('socket1', 'player1');
            expect(result.success).toBe(true);
            expect(result.queuePosition).toBe(1);
        });

        test('increments queue position', () => {
            GameManager.joinQueue('socket1', 'player1');
            const result = GameManager.joinQueue('socket2', 'player2');
            expect(result.queuePosition).toBe(2);
        });

        test('prevents duplicate joins', () => {
            GameManager.joinQueue('socket1', 'player1');
            const result = GameManager.joinQueue('socket1', 'player1');
            expect(result.success).toBe(false);
        });

        test('starts game when 4 players join', () => {
            GameManager.joinQueue('socket1', 'player1');
            GameManager.joinQueue('socket2', 'player2');
            GameManager.joinQueue('socket3', 'player3');
            const result = GameManager.joinQueue('socket4', 'player4');

            expect(result.gameStarted).toBe(true);
            expect(result.game).toBeDefined();
        });

        test('game has all 4 players', () => {
            GameManager.joinQueue('socket1', 'player1');
            GameManager.joinQueue('socket2', 'player2');
            GameManager.joinQueue('socket3', 'player3');
            const result = GameManager.joinQueue('socket4', 'player4');

            expect(result.game.players.size).toBe(4);
        });
    });

    describe('leaveQueue', () => {
        test('removes player from queue', () => {
            GameManager.joinQueue('socket1', 'player1');
            const result = GameManager.leaveQueue('socket1');
            expect(result.success).toBe(true);
        });

        test('returns false if not in queue', () => {
            const result = GameManager.leaveQueue('nonexistent');
            expect(result.success).toBe(false);
        });
    });

    describe('getPlayerGame', () => {
        test('returns game for player in game', () => {
            GameManager.joinQueue('socket1', 'player1');
            GameManager.joinQueue('socket2', 'player2');
            GameManager.joinQueue('socket3', 'player3');
            GameManager.joinQueue('socket4', 'player4');

            const game = GameManager.getPlayerGame('socket1');
            expect(game).toBeDefined();
        });

        test('returns null for player not in game', () => {
            const game = GameManager.getPlayerGame('nonexistent');
            expect(game).toBeNull();
        });
    });

    describe('handleDisconnect', () => {
        test('removes from queue on disconnect', () => {
            GameManager.joinQueue('socket1', 'player1');
            const result = GameManager.handleDisconnect('socket1');
            expect(result.wasInQueue).toBe(true);
        });

        test('handles in-game disconnect', () => {
            GameManager.joinQueue('socket1', 'player1');
            GameManager.joinQueue('socket2', 'player2');
            GameManager.joinQueue('socket3', 'player3');
            GameManager.joinQueue('socket4', 'player4');

            const result = GameManager.handleDisconnect('socket1');
            expect(result.wasInGame).toBe(true);
        });
    });
});
```

---

## Task 7: Running Tests

**Commands:**
```bash
# Run all tests
npm test

# Run with coverage report
npm run test:coverage

# Watch mode for development
npm run test:watch

# Run specific test file
npm test -- rules.test.js

# Run tests matching pattern
npm test -- --testNamePattern="determineWinner"

# Run with verbose output
npm test -- --verbose
```

---

## Task 8: Coverage Goals

| Module | Target | Priority |
|--------|--------|----------|
| rules.js | 95%+ | High |
| Deck.js | 95%+ | High |
| GameState.js | 85%+ | High |
| GameManager.js | 80%+ | Medium |
| Socket handlers | 70%+ | Medium |
| **Overall** | **80%+** | |

---

## Verification

1. [x] Jest installed and configured
2. [x] `npm test` runs without errors
3. [x] Game rules tests pass (58 tests)
4. [x] Deck tests pass (24 tests)
5. [ ] Integration tests connect properly (not yet implemented)
6. [x] Coverage report generates
7. [x] Coverage meets threshold for core game modules:
   - Deck.js: 100%
   - GameManager.js: ~85%
   - rules.js: ~80%
8. [ ] Tests run in CI pipeline (pending DevOps task)
