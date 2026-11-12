/**
 * The admin panel's actions (adminRequest.action): one list for the Joi
 * envelope (socket/validators.js), the handlers (socket/adminHandlers.js)
 * and the contract (contract/src).
 */

'use strict';

const ADMIN_ACTIONS = Object.freeze([
    'searchPlayers', 'createResetLink', 'signOutEverywhere', 'findDuplicates',
    'planMerge', 'applyMerge', 'listReports', 'resolveReport',
    'listAdmins', 'setAdmin', 'listAudit',
    // batch 2 (owner, 2026-11-11): the Players table, delete
    'listPlayers', 'deleteAccount'
]);

module.exports = { ADMIN_ACTIONS };
