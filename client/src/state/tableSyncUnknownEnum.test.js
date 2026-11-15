// @vitest-environment node
// (reads the server fixtures from disk)
/**
 * A carrier whose snapshot has an enum value this build does not know (a
 * newer server): the v2 snapshot is used, with a logged warning, instead of
 * being refused for the v1 fields (later #17).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { tableSnapshotOf } from './tableSync.js';

const DIR = fileURLToPath(new URL('../../../contract/fixtures/v2/', import.meta.url));
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));

describe('tableSnapshotOf with an unknown enum value', () => {
  it('uses the v2 snapshot and logs what it kept', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const snapshot = load('presence-mixed').snapshot;
    snapshot.seats[2].presence = 'napping';
    const s = tableSnapshotOf({ snapshot, players: [] });
    expect(s).not.toBeNull();
    expect(s.v).toBe(2);
    expect(s.seats[2].presence).toBe('napping');
    expect(warn).toHaveBeenCalledWith('Snapshot v2: unknown values kept:', ['$.seats[2].presence: unknown value "napping"']);
    warn.mockRestore();
  });

  it('an unknown viewer role is refused: the carrier\'s v1 fields draw the table (web draws any other role as a seat)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const snapshot = load('presence-mixed').snapshot;
    snapshot.viewer.role = 'referee';
    const s = tableSnapshotOf({ snapshot, players: [], position: 1, hand: [] }, { role: 'spectator' });
    // built from the v1 fields (legacySnapshot), with a role this build knows
    expect(s.viewer.role).toBe('spectator');
    expect(s.viewer.ownerView).toBeNull();
    expect(warn).toHaveBeenCalledWith('Snapshot v2 refused, using the v1 fields:', expect.arrayContaining([expect.stringMatching(/viewer\.role/)]));
    warn.mockRestore();
  });
});
