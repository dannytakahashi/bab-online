/**
 * VERBATIM copies of getLeaderboard, searchPlayers and getRecords as of
 * 3db87b1 (before projections and caches), used by realMongo.test.js to
 * prove the current handlers send identical payloads on the same data. Only
 * the module plumbing differs: the collections come from the caller. Do not
 * "fix" these: they are the reference.
 */

function makeReference({ getUsersCollection, getGameRecordsCollection }) {
    const authLogger = { debug() {}, info() {}, warn() {}, error() {} };

    async function getLeaderboard(socket, io) {
        const usersCollection = getUsersCollection();

        try {
            // Find all users with at least one game played (merged-away
            // accounts are tombstones whose stats live on the kept account)
            const users = await usersCollection.find(
                { 'stats.gamesPlayed': { $gt: 0 }, mergedInto: { $exists: false } }
            ).toArray();

            // Compute derived stats and format response
            const leaderboard = users.map(user => {
                const stats = user.stats || {};
                const gamesPlayed = stats.gamesPlayed || 0;
                const wins = stats.wins || 0;
                const totalPoints = stats.totalPoints || 0;
                const totalTricksBid = stats.totalTricksBid || 0;
                const totalTricksTaken = stats.totalTricksTaken || 0;
                const totalHands = stats.totalHands || 0;
                const totalSets = stats.totalSets || 0;
                const totalSetPoints = stats.totalSetPoints || 0;
                const totalFaults = stats.totalFaults || 0;
                const totalHSI = stats.totalHSI || 0;

                return {
                    username: user.username,
                    profilePic: user.profilePic || 1,
                    customProfilePic: user.customProfilePic || null,
                    gamesPlayed,
                    winRate: gamesPlayed > 0 ? (wins / gamesPlayed) * 100 : 0,
                    pointsPerGame: gamesPlayed > 0 ? totalPoints / gamesPlayed : 0,
                    bidsPerGame: gamesPlayed > 0 ? totalTricksBid / gamesPlayed : 0,
                    tricksPerBid: totalTricksBid > 0 ? totalTricksTaken / totalTricksBid : 0,
                    setRate: totalHands > 0 ? (totalSets / totalHands) * 100 : 0,
                    drag: gamesPlayed > 0 ? totalSetPoints / gamesPlayed : 0,
                    faultsPerGame: gamesPlayed > 0 ? totalFaults / gamesPlayed : 0,
                    avgHSI: totalHands > 0 ? totalHSI / totalHands : 0
                };
            });

            // Compute population averages
            if (leaderboard.length > 0) {
                const n = leaderboard.length;
                const sum = (key) => leaderboard.reduce((acc, p) => acc + p[key], 0);
                leaderboard.push({
                    username: 'Population',
                    isPopulation: true,
                    gamesPlayed: Math.round(sum('gamesPlayed') / n),
                    winRate: sum('winRate') / n,
                    pointsPerGame: sum('pointsPerGame') / n,
                    bidsPerGame: sum('bidsPerGame') / n,
                    tricksPerBid: sum('tricksPerBid') / n,
                    setRate: sum('setRate') / n,
                    drag: sum('drag') / n,
                    faultsPerGame: sum('faultsPerGame') / n,
                    avgHSI: sum('avgHSI') / n
                });
            }

            // Sort by win rate descending by default
            leaderboard.sort((a, b) => b.winRate - a.winRate);

            socket.emit('leaderboardResponse', {
                success: true,
                leaderboard
            });

            authLogger.debug('Leaderboard fetched', { playerCount: leaderboard.length });
        } catch (error) {
            authLogger.error('Error fetching leaderboard', { error: error.message });
            socket.emit('leaderboardResponse', {
                success: false,
                message: 'Database error'
            });
        }
    }

    async function searchPlayers(socket, io, data) {
        const usersCollection = getUsersCollection();

        const { query } = data || {};
        if (!query || typeof query !== 'string' || !query.trim()) {
            socket.emit('searchPlayersResponse', {
                success: false,
                message: 'Search query is required'
            });
            return;
        }

        try {
            // Escape regex special characters
            const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const users = await usersCollection.find(
                { username: { $regex: escaped, $options: 'i' }, mergedInto: { $exists: false } },
                { projection: { username: 1, profilePic: 1, customProfilePic: 1, stats: 1 } }
            ).limit(20).toArray();

            const players = users.map(u => ({
                username: u.username,
                profilePic: u.profilePic || 1,
                customProfilePic: u.customProfilePic || null,
                gamesPlayed: u.stats?.gamesPlayed || 0,
                wins: u.stats?.wins || 0
            }));

            socket.emit('searchPlayersResponse', { success: true, players });
            authLogger.debug('Player search', { query: query.trim(), resultCount: players.length });
        } catch (error) {
            authLogger.error('Error searching players', { query, error: error.message });
            socket.emit('searchPlayersResponse', { success: false, message: 'Database error' });
        }
    }

    async function getRecords(socket, io) {
        const gameRecordsCollection = getGameRecordsCollection();

        if (!gameRecordsCollection) {
            socket.emit('recordsResponse', { success: false, message: 'Database not available' });
            return;
        }

        try {
            const now = new Date();
            const startOfYear = new Date(now.getFullYear(), 0, 1);
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

            const filters = {
                allTime: {},
                thisYear: { completedAt: { $gte: startOfYear } },
                thisMonth: { completedAt: { $gte: startOfMonth } }
            };

            const records = {};

            for (const [period, filter] of Object.entries(filters)) {
                const games = await gameRecordsCollection.find(filter).toArray();

                if (games.length === 0) {
                    records[period] = null;
                    continue;
                }

                let highestScore = null;
                let lowestScore = null;
                let biggestWin = null;
                let mostBags = null;
                let leastBags = null;

                for (const game of games) {
                    // Check both teams for highest/lowest individual team score
                    const entries = [
                        { score: game.team1Score, players: game.team1Players },
                        { score: game.team2Score, players: game.team2Players }
                    ];

                    for (const entry of entries) {
                        if (!highestScore || entry.score > highestScore.score) {
                            highestScore = { score: entry.score, players: entry.players };
                        }
                        if (!lowestScore || entry.score < lowestScore.score) {
                            lowestScore = { score: entry.score, players: entry.players };
                        }
                    }

                    // Biggest win margin
                    const margin = Math.abs(game.team1Score - game.team2Score);
                    if (!biggestWin || margin > biggestWin.margin) {
                        const winnerIsTeam1 = game.team1Score > game.team2Score;
                        biggestWin = {
                            margin,
                            winnerScore: winnerIsTeam1 ? game.team1Score : game.team2Score,
                            loserScore: winnerIsTeam1 ? game.team2Score : game.team1Score,
                            winnerPlayers: winnerIsTeam1 ? game.team1Players : game.team2Players,
                            loserPlayers: winnerIsTeam1 ? game.team2Players : game.team1Players
                        };
                    }

                    // Most/least bags — skip legacy records without bags data
                    if (game.team1Bags != null && game.team2Bags != null) {
                        const bagsEntries = [
                            { bags: game.team1Bags, players: game.team1Players },
                            { bags: game.team2Bags, players: game.team2Players }
                        ];

                        for (const entry of bagsEntries) {
                            if (!mostBags || entry.bags > mostBags.bags) {
                                mostBags = { bags: entry.bags, players: entry.players };
                            }
                            if (!leastBags || entry.bags < leastBags.bags) {
                                leastBags = { bags: entry.bags, players: entry.players };
                            }
                        }
                    }
                }

                records[period] = { highestScore, lowestScore, biggestWin, mostBags, leastBags };
            }

            // Total games played (all time count)
            const totalGames = (await gameRecordsCollection.countDocuments({}));

            socket.emit('recordsResponse', { success: true, records, totalGames });
            authLogger.debug('Records fetched');
        } catch (error) {
            authLogger.error('Error fetching records', { error: error.message });
            socket.emit('recordsResponse', { success: false, message: 'Database error' });
        }
    }

    return { getLeaderboard, searchPlayers, getRecords };
}

module.exports = { makeReference };
