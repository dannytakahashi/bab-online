/**
 * Bot module exports
 */

const BotPlayer = require('./BotPlayer');
const botController = require('./BotController');
const BotStrategy = require('./BotStrategy');
const personalities = require('./personalities');

module.exports = {
    BotPlayer,
    botController,
    BotStrategy,
    personalities
};
