/**
 * The stock avatar count is named once per side (server/avatar/stockAvatars.js,
 * client/src/constants/avatars.js); the contract's profilePic bounds and the
 * Joi schema follow it.
 */

const fs = require('fs');
const path = require('path');
const { STOCK_AVATAR_COUNT, isStockPic, randomStockPic } = require('../stockAvatars');
const { schemas } = require('../../socket/validators');
const { c2s } = require('../../../contract/src/c2s');
const { s2c } = require('../../../contract/src/s2c');

const ROOT = path.join(__dirname, '..', '..', '..');

describe('stock avatars', () => {
    test('82 pictures, every one on disk', () => {
        expect(STOCK_AVATAR_COUNT).toBe(82);
        for (let n = 1; n <= STOCK_AVATAR_COUNT; n++) {
            expect(fs.existsSync(path.join(ROOT, `client/assets/avatars/v1/profile${n}.webp`))).toBe(true);
        }
        expect(fs.existsSync(path.join(ROOT, `client/assets/avatars/v1/profile${STOCK_AVATAR_COUNT + 1}.webp`))).toBe(false);
    });

    test('isStockPic and randomStockPic stay in 1..N (one Math.random call each)', () => {
        expect([0, 1, STOCK_AVATAR_COUNT, STOCK_AVATAR_COUNT + 1, 1.5, '3', null].map(isStockPic))
            .toEqual([false, true, true, false, false, false, false]);
        const random = jest.spyOn(Math, 'random');
        try {
            random.mockReturnValueOnce(0).mockReturnValueOnce(0.999999);
            expect(randomStockPic()).toBe(1);
            expect(randomStockPic()).toBe(STOCK_AVATAR_COUNT);
            expect(random).toHaveBeenCalledTimes(2);
        } finally {
            random.mockRestore();
        }
    });

    test('the web constant, the Joi schema and the contract bounds agree', () => {
        const web = fs.readFileSync(path.join(ROOT, 'client/src/constants/avatars.js'), 'utf8');
        expect(Number(/export const STOCK_MAX = (\d+);/.exec(web)[1])).toBe(STOCK_AVATAR_COUNT);
        // iOS 1.2.2's avatar picker (ProfilePicture.swift)
        const ios = fs.readFileSync(path.join(ROOT, 'iOSClient/BABOnline/Utils/ProfilePicture.swift'), 'utf8');
        expect(Number(/static let stockCount = (\d+)/.exec(ios)[1])).toBe(STOCK_AVATAR_COUNT);

        expect(schemas.updateProfilePic.validate({ profilePic: STOCK_AVATAR_COUNT }).error).toBeUndefined();
        expect(schemas.updateProfilePic.validate({ profilePic: STOCK_AVATAR_COUNT + 1 }).error).toBeDefined();

        expect(c2s.updateProfilePic.payload.properties.profilePic.maximum).toBe(STOCK_AVATAR_COUNT);
        const reply = s2c.profilePicUpdateResponse.payload;
        expect(JSON.stringify(reply)).toContain(`"maximum":${STOCK_AVATAR_COUNT}`);
    });
});
