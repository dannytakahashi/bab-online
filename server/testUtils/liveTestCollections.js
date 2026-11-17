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
 */

'use strict';

const { livePersistMode } = require('../utils/livePersistSwitch');

if (livePersistMode(process.env, { warn: () => {} }) !== 'off') {
    const { MemoryCollection } = require('./memoryDb');
    const { _setTestFallbackCollections, LIVE_GETTERS } = require('../game/persist/liveStore');
    const byGetter = Object.fromEntries(Object.entries(LIVE_GETTERS).map(([name, getter]) => [getter, name]));
    let colls = null;
    const fresh = () => {
        colls = { liveGames: new MemoryCollection(), liveTournaments: new MemoryCollection(), serverInstances: new MemoryCollection() };
    };
    fresh();
    _setTestFallbackCollections((getter) => (byGetter[getter] ? colls[byGetter[getter]] : null));
    beforeEach(fresh);
}
