/**
 * Unit tests for GameManager tournament lifecycle: join/reattach rules,
 * disconnect handling, and round completion via game end/abort.
 */

let gameManager;

beforeEach(() => {
    jest.resetModules();
    gameManager = require('../GameManager');
});

function createTournamentWithPlayers(usernames) {
    gameManager.registerUser('creatorSocket', usernames[0]);
    const { tournament } = gameManager.createTournament('creatorSocket', 'Test');
    for (let i = 1; i < usernames.length; i++) {
        const socketId = `socket${i}`;
        gameManager.registerUser(socketId, usernames[i]);
        gameManager.joinTournament(socketId, tournament.tournamentId);
    }
    return tournament;
}

describe('GameManager tournaments', () => {
    describe('joinTournament', () => {
        test('new players can join in the lobby phase', () => {
            const tournament = createTournamentWithPlayers(['alice']);
            gameManager.registerUser('s2', 'bob');

            const result = gameManager.joinTournament('s2', tournament.tournamentId);

            expect(result.success).toBe(true);
            expect(tournament.players.size).toBe(2);
        });

        test('new players cannot join once the tournament has started', () => {
            const tournament = createTournamentWithPlayers(['alice']);
            tournament.startRound(1);
            tournament.completeRound(); // between_rounds

            gameManager.registerUser('s2', 'bob');
            const result = gameManager.joinTournament('s2', tournament.tournamentId);

            expect(result.success).toBe(false);
        });

        test('a returning member reattaches in any phase', () => {
            const tournament = createTournamentWithPlayers(['alice', 'bob']);
            tournament.startRound(1); // round_active
            gameManager.handleTournamentDisconnect('socket1', tournament);

            gameManager.registerUser('newSocket', 'bob');
            const result = gameManager.joinTournament('newSocket', tournament.tournamentId);

            expect(result.success).toBe(true);
            expect(result.reattached).toBe(true);
            expect(tournament.getPlayerBySocketId('newSocket').username).toBe('bob');
            expect(gameManager.getPlayerTournament('newSocket')).toBe(tournament);
        });
    });

    describe('handleTournamentDisconnect', () => {
        test('lobby-phase disconnects are plain leaves', () => {
            const tournament = createTournamentWithPlayers(['alice', 'bob']);

            const result = gameManager.handleTournamentDisconnect('socket1', tournament);

            expect(result.success).toBe(true);
            expect(tournament.players.size).toBe(1);
            expect(tournament.getPlayerByUsername('bob')).toBeNull();
        });

        test('mid-tournament disconnects keep membership and scores', () => {
            const tournament = createTournamentWithPlayers(['alice', 'bob']);
            tournament.recordPlayerRoundScore('bob', { roundNumber: 1, teamScore: 100 });
            tournament.startRound(1);

            const result = gameManager.handleTournamentDisconnect('socket1', tournament);

            expect(result.disconnected).toBe(true);
            expect(tournament.getPlayerByUsername('bob')).not.toBeNull();
            expect(tournament.getPlayerByUsername('bob').connected).toBe(false);
            expect(tournament.scoreboard.bob.totalScore).toBe(100);
        });

        test('creator disconnect mid-tournament transfers creatorship', () => {
            const tournament = createTournamentWithPlayers(['alice', 'bob']);
            tournament.startRound(1);

            const result = gameManager.handleTournamentDisconnect('creatorSocket', tournament);

            expect(result.newCreator.username).toBe('bob');
            expect(tournament.createdBy).toBe('socket1');
        });

        test('deletes the tournament when nobody is connected and no games are running', () => {
            const tournament = createTournamentWithPlayers(['alice', 'bob']);
            tournament.startRound(1);
            tournament.addGameToRound('g1', ['alice', 'bob'], 2);
            tournament.markGameComplete('g1');
            tournament.completeRound(); // between_rounds, no running games

            gameManager.handleTournamentDisconnect('socket1', tournament);
            const result = gameManager.handleTournamentDisconnect('creatorSocket', tournament);

            expect(result.deleted).toBe(true);
            expect(gameManager.getTournamentById(tournament.tournamentId)).toBeNull();
        });

        test('keeps the tournament while a round game is still running', () => {
            const tournament = createTournamentWithPlayers(['alice', 'bob']);
            tournament.startRound(1);
            tournament.addGameToRound('g1', ['alice', 'bob'], 2);

            gameManager.handleTournamentDisconnect('socket1', tournament);
            const result = gameManager.handleTournamentDisconnect('creatorSocket', tournament);

            expect(result.deleted).toBeUndefined();
            expect(gameManager.getTournamentById(tournament.tournamentId)).toBe(tournament);
        });
    });

    describe('handleTournamentGameEnd', () => {
        test('marks games complete and reports round completion', () => {
            const tournament = createTournamentWithPlayers(['alice']);
            tournament.startRound(1);
            tournament.addGameToRound('g1', ['alice'], 3);
            tournament.addGameToRound('g2', ['x'], 3);
            gameManager.tournamentGames.set('g1', tournament.tournamentId);
            gameManager.tournamentGames.set('g2', tournament.tournamentId);

            const first = gameManager.handleTournamentGameEnd('g1');
            expect(first.roundComplete).toBe(false);

            const second = gameManager.handleTournamentGameEnd('g2');
            expect(second.roundComplete).toBe(true);
            expect(tournament.phase).toBe('between_rounds');
            expect(gameManager.tournamentGames.has('g1')).toBe(false);
            expect(gameManager.tournamentGames.has('g2')).toBe(false);
        });

        test('returns null for non-tournament games', () => {
            expect(gameManager.handleTournamentGameEnd('not-a-game')).toBeNull();
        });
    });

    describe('reattachTournamentPlayer', () => {
        test('finds the tournament by username and re-keys membership', () => {
            const tournament = createTournamentWithPlayers(['alice', 'bob']);
            tournament.startRound(1);
            gameManager.handleTournamentDisconnect('socket1', tournament);

            const found = gameManager.reattachTournamentPlayer('freshSocket', 'bob');

            expect(found).toBe(tournament);
            expect(gameManager.getPlayerTournament('freshSocket')).toBe(tournament);
            expect(tournament.getPlayerBySocketId('freshSocket').connected).toBe(true);
        });

        test('returns null when the user has no tournament', () => {
            expect(gameManager.reattachTournamentPlayer('s1', 'ghost')).toBeNull();
        });
    });
});
