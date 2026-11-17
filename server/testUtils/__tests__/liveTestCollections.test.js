/**
 * The LIVE_PERSIST=write Jest setup file (server/testUtils/liveTestCollections.js)
 * must not change what a test file's jest.mock gives it: a module the setup
 * loaded would be cached real, with its own dependencies bound, before the
 * test's mock factories exist, so a mock would hold in the off run and not in
 * the write run. Runs in both CI Jest runs; the stand-in checks apply to the
 * write run.
 */

'use strict';

const mockError = jest.fn();
jest.mock('../../utils/logger', () => {
    const log = { error: (...a) => mockError(...a), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
    return {
        logger: log,
        gameLogger: log,
        socketLogger: log,
        authLogger: log,
        dbLogger: log,
        createModuleLogger: () => log
    };
});

const { livePersistMode } = require('../../utils/livePersistSwitch');

const writing = livePersistMode(process.env, { warn: () => {} }) !== 'off';
const TEST_FALLBACK = Symbol.for('bab.liveStore.testCollections');

describe('liveTestCollections setup file', () => {
    test('a jest.mock of a module liveStore depends on still applies (safeTimer gets the mocked logger)', () => {
        const { guard } = require('../../utils/safeTimer');
        guard(() => {
            throw new Error('boom');
        }, 'probe')();
        expect(mockError).toHaveBeenCalledWith('Timer callback failed', expect.objectContaining({ timer: 'probe', error: 'boom' }));
    });

    test('its getter names are liveStore.LIVE_GETTERS', () => {
        const { COLLECTION_BY_GETTER } = require('../liveTestCollections');
        const { LIVE_GETTERS } = require('../../game/persist/liveStore');
        expect(COLLECTION_BY_GETTER).toEqual(Object.fromEntries(Object.entries(LIVE_GETTERS).map(([name, getter]) => [getter, name])));
    });

    (writing ? describe : describe.skip)('with LIVE_PERSIST=write', () => {
        let first;

        test('the stand-in gives memory collections, the same one within a test', () => {
            const fallback = globalThis[TEST_FALLBACK];
            expect(typeof fallback).toBe('function');
            const { MemoryCollection } = require('../memoryDb');
            first = fallback('getLiveGamesCollection');
            expect(first).toBeInstanceOf(MemoryCollection);
            expect(fallback('getLiveGamesCollection')).toBe(first);
            expect(fallback('getLiveTournamentsCollection')).toBeInstanceOf(MemoryCollection);
            expect(fallback('getServerInstancesCollection')).toBeInstanceOf(MemoryCollection);
            expect(fallback('getUsersCollection')).toBeNull();
        });

        test('fresh collections for each test', () => {
            expect(globalThis[TEST_FALLBACK]('getLiveGamesCollection')).not.toBe(first);
        });

        test('the store finds them through a database mock with no live getters', () => {
            const { defaultCollections } = require('../../game/persist/liveStore');
            const colls = defaultCollections({});
            expect(colls.liveGames).toBe(globalThis[TEST_FALLBACK]('getLiveGamesCollection'));
        });
    });

    (writing ? describe.skip : describe)('with LIVE_PERSIST off', () => {
        test('registers nothing', () => {
            expect(globalThis[TEST_FALLBACK]).toBeUndefined();
        });
    });
});
