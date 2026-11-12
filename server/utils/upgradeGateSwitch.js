/**
 * The upgrade gate's kill switch (server/socket/upgradeGate.js), in a module
 * with no dependencies so server/game/pacing.js reads the same switch:
 * UPGRADE_GATE=off (also false / 0 / disabled / no) lets the old iOS 1.0.0
 * and 1.1.0 builds play again, and pacing then drops everything below IOS_1_0_FLOORS
 * (the solo overlay). Read on every call; never cached.
 */

'use strict';

function gateEnabled(env = process.env) {
    const v = String(env.UPGRADE_GATE || '').trim().toLowerCase();
    return !['off', 'false', '0', 'disabled', 'no'].includes(v);
}

module.exports = { gateEnabled };
