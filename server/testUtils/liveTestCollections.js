/**
 * Jest setupFilesAfterEnv: with LIVE_PERSIST=write (or on) in the
 * environment (CI's second Jest run, `npm run test:race` / `test:contract`
 * with it), every test file gets in-memory live collections (liveGames,
 * liveTournaments, serverInstances: memoryDb's MemoryCollection, fresh for
 * each test) behind the persist store's default lookup whenever its
 * jest.mock('../database') has no live getters. So the whole suite, not
 * only the persist tests, runs with the store writing, claiming and
 * tombstoning (server/game/persist/liveStore.js defaultCollections).
 *
 * A mock that does define the getters (persistHarness.databaseMock,
 * dbOutage's outage) keeps its own. With LIVE_PERSIST unset or off this
 * file does nothing.
 *
 * Setup files share the test file's module registry, and run before its
 * jest.mock factories are registered: a module loaded here would be the
 * real one, with its own dependencies bound, in write runs only. So this
 * file loads nothing but the dependency-free mode switch. It registers the
 * stand-in under liveStore's global symbol itself (the getter names are
 * written out here; liveTestCollections.test.js checks they match
 * liveStore.LIVE_GETTERS), and loads memoryDb only when a test first asks
 * the stand-in for a collection, after that test's mocks are in place.
 */

'use strict';

const { livePersistMode } = require('../utils/livePersistSwitch');

const TEST_FALLBACK = Symbol.for('bab.liveStore.testCollections');
const COLLECTION_BY_GETTER = Object.freeze({
    getLiveGamesCollection: 'liveGames',
    getLiveTournamentsCollection: 'liveTournaments',
    getServerInstancesCollection: 'serverInstances'
});

if (livePersistMode(process.env, { warn: () => {} }) !== 'off') {
    let colls = null;
    globalThis[TEST_FALLBACK] = (getter) => {
        const name = COLLECTION_BY_GETTER[getter];
        if (!name) return null;
        if (!colls) {
            const { MemoryCollection } = require('./memoryDb');
            colls = { liveGames: new MemoryCollection(), liveTournaments: new MemoryCollection(), serverInstances: new MemoryCollection() };
        }
        return colls[name];
    };
    beforeEach(() => {
        colls = null;
    });
}

module.exports = { TEST_FALLBACK, COLLECTION_BY_GETTER };
