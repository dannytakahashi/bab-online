/**
 * The stock avatar set: client/assets/profile1..N.png (+ avatars/v1 WebP,
 * scripts/build-avatars.js). The one server copy of N; the web's is
 * client/src/utils/avatar.js STOCK_MAX and the contract's the profilePic
 * maximum in contract/src/s2c.js (stockAvatars.test.js holds both to it).
 * Pure, no requires: spectatorWire.js uses it.
 */

'use strict';

const STOCK_AVATAR_COUNT = 82;

/** A stock avatar number, 1..STOCK_AVATAR_COUNT. */
const isStockPic = (p) => Number.isInteger(p) && p >= 1 && p <= STOCK_AVATAR_COUNT;

/** A random stock avatar number (one Math.random call, as every call site always made). */
const randomStockPic = () => Math.floor(Math.random() * STOCK_AVATAR_COUNT) + 1;

module.exports = { STOCK_AVATAR_COUNT, isStockPic, randomStockPic };
