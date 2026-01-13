# Asset Management and Optimization

## Overview
The current asset loading is extremely inefficient, requiring 149 individual HTTP requests for images. This significantly impacts initial load time and user experience.

## Current Problems

- 54 card images loaded individually
- 82 profile images loaded individually
- 13 other assets (background, card back, etc.)
- Total: **149 separate HTTP requests**
- No lazy loading
- No asset compression or optimization
- No loading progress indicator

---

## Task 1: Audit Current Asset Loading

**Current (game.js lines 174-319):**
```javascript
preload() {
    // Each card is a separate load call
    this.load.image("a_spades", "assets/ace_spades.png");
    this.load.image("k_spades", "assets/king_spades.png");
    this.load.image("q_spades", "assets/queen_spades.png");
    // ... 54 cards total

    // Each profile is separate
    this.load.image("profile1", "assets/profile1.png");
    this.load.image("profile2", "assets/profile2.png");
    // ... 82 profiles total
}
```

**Problems:**
- Each `load.image()` = 1 HTTP request
- Browser limits concurrent requests (typically 6)
- Sequential loading creates waterfall effect
- Large total download size with overhead per request

---

## Task 2: Create Texture Atlas for Cards

Use a texture atlas (sprite sheet) to combine all card images into one file.

**Option A: Using TexturePacker (recommended)**
1. Install TexturePacker: https://www.codeandweb.com/texturepacker
2. Add all card images to a project
3. Export as JSON (hash) + PNG

**Option B: Using free-tex-packer-core (free)**
```bash
npm install --save-dev free-tex-packer-core
```

**Create:** `scripts/build-atlas.js`
```javascript
const { packAsync } = require('free-tex-packer-core');
const fs = require('fs');
const path = require('path');

async function buildCardAtlas() {
    const assetsDir = path.join(__dirname, '..', 'client', 'assets');
    const outputDir = path.join(assetsDir, 'sprites');

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Read all card images
    const cardFiles = fs.readdirSync(assetsDir)
        .filter(f => f.endsWith('.png') && !f.startsWith('profile'))
        .map(f => ({
            path: f.replace('.png', ''),
            contents: fs.readFileSync(path.join(assetsDir, f))
        }));

    console.log(`Packing ${cardFiles.length} card images...`);

    const result = await packAsync(cardFiles, {
        textureName: 'cards',
        width: 2048,
        height: 2048,
        fixedSize: false,
        padding: 2,
        allowRotation: false,
        detectIdentical: true,
        allowTrim: false,
        exporter: 'Phaser3'
    });

    // Write output files
    for (const item of result) {
        const outputPath = path.join(outputDir, item.name);
        fs.writeFileSync(outputPath, item.buffer);
        console.log(`Created: ${item.name}`);
    }

    console.log('Card atlas created successfully!');
}

buildCardAtlas().catch(console.error);
```

**Add to package.json:**
```json
{
    "scripts": {
        "build:atlas": "node scripts/build-atlas.js"
    }
}
```

**Expected output:**
- `client/assets/sprites/cards.png` - Combined sprite sheet
- `client/assets/sprites/cards.json` - Atlas metadata

---

## Task 3: Update Phaser Preload

**After creating atlas:**
```javascript
preload() {
    // Load card atlas (1 request instead of 54)
    this.load.atlas(
        'cards',
        'assets/sprites/cards.png',
        'assets/sprites/cards.json'
    );

    // Other essential assets
    this.load.image('cardBack', 'assets/card_back.png');
    this.load.image('background', 'assets/background.png');
}
```

**Update card creation:**
```javascript
// BEFORE (individual images)
const sprite = this.add.image(x, y, 'ace_spades');

// AFTER (from atlas)
const sprite = this.add.image(x, y, 'cards', 'ace_spades');
```

---

## Task 4: Lazy Load Profile Images

Profile images are only needed when a game starts, not during initial load.

**Create:** `client/js/utils/assetLoader.js`
```javascript
class AssetLoader {
    constructor(scene) {
        this.scene = scene;
        this.loadedProfiles = new Set();
    }

    /**
     * Load profile images on demand
     * @param {number[]} profileIds - Array of profile IDs to load
     * @returns {Promise} - Resolves when all profiles are loaded
     */
    loadProfiles(profileIds) {
        return new Promise((resolve) => {
            const toLoad = profileIds.filter(id => !this.loadedProfiles.has(id));

            if (toLoad.length === 0) {
                resolve();
                return;
            }

            // Add to load queue
            toLoad.forEach(id => {
                const key = `profile${id}`;
                if (!this.scene.textures.exists(key)) {
                    this.scene.load.image(key, `assets/profile${id}.png`);
                }
            });

            // Handle completion
            this.scene.load.once('complete', () => {
                toLoad.forEach(id => this.loadedProfiles.add(id));
                resolve();
            });

            // Start loading
            this.scene.load.start();
        });
    }

    /**
     * Check if profile is loaded
     */
    isProfileLoaded(id) {
        return this.loadedProfiles.has(id);
    }
}

export default AssetLoader;
```

**Usage in game:**
```javascript
import AssetLoader from './utils/assetLoader.js';

class GameScene extends Phaser.Scene {
    create() {
        this.assetLoader = new AssetLoader(this);
    }

    async handleGameStart(data) {
        // Load only the profiles for players in this game
        const profileIds = data.players.map(p => p.pic);
        await this.assetLoader.loadProfiles(profileIds);

        // Now safe to display player profiles
        this.displayPlayers(data.players);
    }
}
```

---

## Task 5: Optimize Image Sizes

**Current issues:**
- Card images may be larger than display size
- No compression applied
- PNG format may not be optimal for all images

**Optimization script:**
```bash
#!/bin/bash
# scripts/optimize-images.sh

# Install required tools
# brew install imagemagick pngquant

ASSETS_DIR="client/assets"

# Resize cards to optimal display size (100x140 works well at 1.5x scale)
echo "Resizing card images..."
for f in $ASSETS_DIR/*_*.png; do
    if [[ -f "$f" ]]; then
        convert "$f" -resize 100x140 "$f"
    fi
done

# Resize profile images
echo "Resizing profile images..."
for f in $ASSETS_DIR/profile*.png; do
    if [[ -f "$f" ]]; then
        convert "$f" -resize 100x100 "$f"
    fi
done

# Compress all PNGs
echo "Compressing PNGs..."
find $ASSETS_DIR -name "*.png" -exec pngquant --force --quality=80-100 --ext .png {} \;

echo "Image optimization complete!"
```

**Recommended sizes:**
| Asset Type | Current | Recommended | Savings |
|------------|---------|-------------|---------|
| Cards | ~200x280 | 100x140 | ~75% |
| Profiles | ~200x200 | 100x100 | ~75% |
| Background | varies | 1920x1080 | - |

---

## Task 6: Add Loading Progress Indicator

**Create:** `client/js/scenes/BootScene.js`
```javascript
export default class BootScene extends Phaser.Scene {
    constructor() {
        super({ key: 'BootScene' });
    }

    preload() {
        this.createLoadingUI();

        // Track progress
        this.load.on('progress', this.updateProgress, this);
        this.load.on('complete', this.loadComplete, this);

        // Load essential assets
        this.load.atlas('cards', 'assets/sprites/cards.png', 'assets/sprites/cards.json');
        this.load.image('cardBack', 'assets/card_back.png');
        this.load.image('background', 'assets/background.png');
    }

    createLoadingUI() {
        const { width, height } = this.scale;

        // Background
        this.add.rectangle(width / 2, height / 2, width, height, 0x1a1a2e);

        // Title
        this.add.text(width / 2, height / 2 - 100, 'BAB Online', {
            fontSize: '48px',
            fontFamily: 'Arial',
            color: '#ffffff'
        }).setOrigin(0.5);

        // Progress bar background
        this.progressBox = this.add.rectangle(
            width / 2, height / 2,
            400, 30,
            0x333333
        );

        // Progress bar fill
        this.progressBar = this.add.rectangle(
            width / 2 - 195, height / 2,
            0, 20,
            0x4a90d9
        ).setOrigin(0, 0.5);

        // Percentage text
        this.progressText = this.add.text(width / 2, height / 2 + 40, '0%', {
            fontSize: '24px',
            fontFamily: 'Arial',
            color: '#ffffff'
        }).setOrigin(0.5);

        // Loading status
        this.statusText = this.add.text(width / 2, height / 2 + 80, 'Loading assets...', {
            fontSize: '16px',
            fontFamily: 'Arial',
            color: '#888888'
        }).setOrigin(0.5);
    }

    updateProgress(progress) {
        // Update progress bar
        this.progressBar.width = 390 * progress;

        // Update percentage
        this.progressText.setText(`${Math.round(progress * 100)}%`);
    }

    loadComplete() {
        this.statusText.setText('Ready!');

        // Transition to game scene
        this.time.delayedCall(500, () => {
            this.scene.start('GameScene');
        });
    }
}
```

**Register scene:**
```javascript
const config = {
    // ...
    scene: [BootScene, GameScene]
};
```

---

## Task 7: Implement Asset Preloading Strategy

**Create:** `client/js/config/assets.js`
```javascript
export const AssetConfig = {
    // Critical assets - load immediately
    critical: {
        atlas: [
            { key: 'cards', image: 'assets/sprites/cards.png', json: 'assets/sprites/cards.json' }
        ],
        images: [
            { key: 'cardBack', path: 'assets/card_back.png' },
            { key: 'background', path: 'assets/background.png' }
        ]
    },

    // Deferred assets - load when needed
    deferred: {
        profiles: {
            path: 'assets/profile{id}.png',
            count: 82
        }
    },

    // Optional assets - load if bandwidth allows
    optional: {
        audio: [
            // Future: sound effects
        ]
    }
};
```

---

## Task 8: Add Cache Headers

**Server-side (Express):**
```javascript
const express = require('express');
const path = require('path');

// Serve static files with caching
app.use('/assets', express.static(path.join(__dirname, '..', 'client', 'assets'), {
    maxAge: '1y',  // Cache for 1 year
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        // Set immutable for versioned assets
        if (filePath.includes('sprites/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));
```

**Consider versioning atlas files:**
```javascript
// In build script, add hash to filename
const hash = crypto.createHash('md5')
    .update(fs.readFileSync(atlasPath))
    .digest('hex')
    .slice(0, 8);

// Output: cards.a1b2c3d4.png
```

---

## Task 9: Measure Improvements

**Before optimization:**
```
Total requests: 149
Total size: ~15MB
Load time: ~8-12s on slow connection
```

**After optimization (target):**
```
Total requests: ~5-10
Total size: ~3-5MB
Load time: ~2-3s on slow connection
```

**How to measure:**
1. Open Chrome DevTools → Network tab
2. Disable cache (checkbox)
3. Throttle to "Slow 3G"
4. Reload page
5. Check "requests" and "transferred" values

---

## Implementation Order

1. **Create texture atlas for cards** (biggest impact)
   - Reduces 54 requests to 1
   - Update all card references

2. **Implement lazy loading for profiles**
   - Removes 82 requests from initial load
   - Load only when game starts

3. **Add loading progress indicator**
   - Improves perceived performance
   - User feedback during load

4. **Optimize image sizes**
   - Reduce total download size
   - Run optimization script

5. **Add caching headers**
   - Improve repeat visit performance
   - Browser caches assets

---

## Verification

1. [ ] Texture atlas created and working
2. [ ] Card rendering unchanged (visual regression test)
3. [ ] Profile images load on demand
4. [ ] Loading progress shows correctly
5. [ ] Network requests reduced to < 15
6. [ ] Total transfer size reduced by > 50%
7. [ ] Load time improved (measure with throttling)
8. [ ] Cache headers set correctly
9. [ ] No broken images in any game state
