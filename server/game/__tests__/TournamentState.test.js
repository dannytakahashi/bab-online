/**
 * Unit tests for TournamentState — lifecycle, player distribution, scoring
 * alignment, disconnect/reattach handling, and winner determination.
 */

const TournamentState = require('../TournamentState');

function makeTournament() {
    return new TournamentState('tid-1234-5678', 'Test Tournament', 'creatorSocket', 'creator');
}

describe('TournamentState', () => {
    describe('player management', () => {
        test('addPlayer marks players connected and seeds scoreboard', () => {
            const t = makeTournament();
            t.addPlayer('s1', 'alice', null);

            const player = t.getPlayerBySocketId('s1');
            expect(player.connected).toBe(true);
            expect(t.scoreboard.alice).toEqual({
                totalScore: 0,
                roundScores: [],
                roundDetails: []
            });
        });

        test('markPlayerDisconnected keeps the entry but clears ready', () => {
            const t = makeTournament();
            t.addPlayer('s1', 'alice', null);
            t.setReady('s1');

            const player = t.markPlayerDisconnected('s1');

            expect(player.username).toBe('alice');
            expect(player.connected).toBe(false);
            expect(player.ready).toBe(false);
            expect(t.readyPlayers.has('s1')).toBe(false);
            expect(t.players.has('s1')).toBe(true);
        });

        test('reattachPlayerByUsername re-keys the entry to the new socket', () => {
            const t = makeTournament();
            t.addPlayer('s1', 'alice', null);
            t.markPlayerDisconnected('s1');

            const result = t.reattachPlayerByUsername('alice', 's2');

            expect(result).toEqual({ oldSocketId: 's1' });
            expect(t.players.has('s1')).toBe(false);
            expect(t.getPlayerBySocketId('s2').username).toBe('alice');
            expect(t.getPlayerBySocketId('s2').connected).toBe(true);
        });

        test('reattachPlayerByUsername transfers creatorship to the new socket', () => {
            const t = makeTournament();
            t.addPlayer('creatorSocket', 'creator', null);
            t.markPlayerDisconnected('creatorSocket');

            t.reattachPlayerByUsername('creator', 'newSocket');

            expect(t.createdBy).toBe('newSocket');
        });

        test('reattachPlayerByUsername returns null for unknown usernames', () => {
            const t = makeTournament();
            t.addPlayer('s1', 'alice', null);
            expect(t.reattachPlayerByUsername('mallory', 's9')).toBeNull();
        });
    });

    describe('allPlayersReady', () => {
        test('requires every connected player to be ready', () => {
            const t = makeTournament();
            t.addPlayer('s1', 'alice', null);
            t.addPlayer('s2', 'bob', null);
            t.setReady('s1');

            expect(t.allPlayersReady()).toBe(false);
            t.setReady('s2');
            expect(t.allPlayersReady()).toBe(true);
        });

        test('disconnected players do not block readiness', () => {
            const t = makeTournament();
            t.addPlayer('s1', 'alice', null);
            t.addPlayer('s2', 'bob', null);
            t.setReady('s1');
            t.markPlayerDisconnected('s2');

            expect(t.allPlayersReady()).toBe(true);
        });

        test('false when nobody is connected', () => {
            const t = makeTournament();
            t.addPlayer('s1', 'alice', null);
            t.markPlayerDisconnected('s1');
            expect(t.allPlayersReady()).toBe(false);
        });

        test('false with no players', () => {
            expect(makeTournament().allPlayersReady()).toBe(false);
        });
    });

    describe('transferCreator', () => {
        test('prefers a connected player over a disconnected one', () => {
            const t = makeTournament();
            t.addPlayer('creatorSocket', 'creator', null);
            t.addPlayer('s2', 'bob', null);
            t.addPlayer('s3', 'carol', null);
            t.markPlayerDisconnected('s2');

            const result = t.transferCreator();

            expect(result.username).toBe('carol');
            expect(t.createdBy).toBe('s3');
        });
    });

    describe('round lifecycle', () => {
        test('round completes only when every game is marked complete', () => {
            const t = makeTournament();
            t.startRound(1);
            t.addGameToRound('g1', ['alice', 'bob'], 2);
            t.addGameToRound('g2', ['carol', 'dave'], 2);

            expect(t.isRoundComplete()).toBe(false);
            t.markGameComplete('g1');
            expect(t.isRoundComplete()).toBe(false);
            t.markGameComplete('g2');
            expect(t.isRoundComplete()).toBe(true);
        });

        test('completeRound moves to between_rounds before the final round', () => {
            const t = makeTournament();
            t.addPlayer('s1', 'alice', null);
            t.setReady('s1');
            t.startRound(1);
            t.completeRound();

            expect(t.phase).toBe('between_rounds');
            expect(t.readyPlayers.size).toBe(0);
        });

        test('completeRound finishes the tournament after the last round', () => {
            const t = makeTournament();
            t.startRound(4);
            t.completeRound();

            expect(t.phase).toBe('complete');
            expect(t.isTournamentComplete()).toBe(true);
        });
    });

    describe('recordPlayerRoundScore', () => {
        test('stores scores under the round index, not append order', () => {
            const t = makeTournament();
            t.addPlayer('s1', 'alice', null);
            t.currentRound = 1;
            t.recordPlayerRoundScore('alice', { roundNumber: 1, teamScore: 120 });
            t.currentRound = 3;
            t.recordPlayerRoundScore('alice', { roundNumber: 3, teamScore: 80 });

            expect(t.scoreboard.alice.roundScores).toEqual([120, 0, 80]);
            expect(t.scoreboard.alice.totalScore).toBe(200);
        });

        test('pads missed earlier rounds with 0 for late joiners', () => {
            const t = makeTournament();
            t.recordPlayerRoundScore('latecomer', { roundNumber: 3, teamScore: 50 });

            expect(t.scoreboard.latecomer.roundScores).toEqual([0, 0, 50]);
            expect(t.scoreboard.latecomer.totalScore).toBe(50);
        });

        test('ignores duplicate recordings for the same round', () => {
            const t = makeTournament();
            t.recordPlayerRoundScore('alice', { roundNumber: 1, teamScore: 100 });
            t.recordPlayerRoundScore('alice', { roundNumber: 1, teamScore: 999 });

            expect(t.scoreboard.alice.roundScores).toEqual([100]);
            expect(t.scoreboard.alice.totalScore).toBe(100);
        });
    });

    describe('scoreboard and winners', () => {
        test('sorts by total score, then username for determinism', () => {
            const t = makeTournament();
            t.recordPlayerRoundScore('zed', { roundNumber: 1, teamScore: 100 });
            t.recordPlayerRoundScore('amy', { roundNumber: 1, teamScore: 100 });
            t.recordPlayerRoundScore('bob', { roundNumber: 1, teamScore: 200 });

            const board = t.getScoreboard();
            expect(board.map(e => e.username)).toEqual(['bob', 'amy', 'zed']);
        });

        test('getWinners returns all entrants tied at the top', () => {
            const t = makeTournament();
            t.recordPlayerRoundScore('zed', { roundNumber: 1, teamScore: 200 });
            t.recordPlayerRoundScore('amy', { roundNumber: 1, teamScore: 200 });
            t.recordPlayerRoundScore('bob', { roundNumber: 1, teamScore: 50 });

            expect(t.getWinners()).toEqual(['amy', 'zed']);
        });

        test('getWinners is empty for an empty scoreboard', () => {
            expect(makeTournament().getWinners()).toEqual([]);
        });
    });

    describe('distributePlayersIntoGames', () => {
        function totalHumans(games) {
            return games.reduce((sum, g) => sum + g.humans.length, 0);
        }

        test.each([
            [0, 0],
            [1, 1],
            [2, 1],
            [3, 1],
            [4, 1],
            [5, 2],
            [6, 2],
            [7, 2],
            [8, 2],
            [9, 3],
            [12, 3]
        ])('%i players → %i games, every game has 4 seats', (n, expectedGames) => {
            const usernames = Array.from({ length: n }, (_, i) => `p${i}`);
            const games = TournamentState.distributePlayersIntoGames(usernames);

            expect(games).toHaveLength(expectedGames);
            expect(totalHumans(games)).toBe(n);
            for (const game of games) {
                expect(game.humans.length + game.botCount).toBe(4);
            }
        });
    });

    describe('getClientState', () => {
        test('includes connected flags on players', () => {
            const t = makeTournament();
            t.addPlayer('s1', 'alice', null);
            t.addPlayer('s2', 'bob', null);
            t.markPlayerDisconnected('s2');

            const state = t.getClientState();
            const alice = state.players.find(p => p.username === 'alice');
            const bob = state.players.find(p => p.username === 'bob');

            expect(alice.connected).toBe(true);
            expect(bob.connected).toBe(false);
        });
    });
});
