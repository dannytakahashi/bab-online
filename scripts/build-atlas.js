/**
 * Build texture atlas for card images
 * Reduces 56 HTTP requests to 2 (atlas JSON + PNG)
 */

const { packAsync } = require('free-tex-packer-core');
const fs = require('fs');
const path = require('path');

// Card key mapping: filename -> atlas frame key
const cardKeyMap = {
    'ace_spades': 'a_spades',
    'king_spades': 'k_spades',
    'queen_spades': 'q_spades',
    'jack_spades': 'j_spades',
    '10_spades': '10_spades',
    '9_spades': '9_spades',
    '8_spades': '8_spades',
    '7_spades': '7_spades',
    '6_spades': '6_spades',
    '5_spades': '5_spades',
    '4_spades': '4_spades',
    '3_spades': '3_spades',
    '2_spades': '2_spades',
    'ace_hearts': 'a_hearts',
    'king_hearts': 'k_hearts',
    'queen_hearts': 'q_hearts',
    'jack_hearts': 'j_hearts',
    '10_hearts': '10_hearts',
    '9_hearts': '9_hearts',
    '8_hearts': '8_hearts',
    '7_hearts': '7_hearts',
    '6_hearts': '6_hearts',
    '5_hearts': '5_hearts',
    '4_hearts': '4_hearts',
    '3_hearts': '3_hearts',
    '2_hearts': '2_hearts',
    'ace_clubs': 'a_clubs',
    'king_clubs': 'k_clubs',
    'queen_clubs': 'q_clubs',
    'jack_clubs': 'j_clubs',
    '10_clubs': '10_clubs',
    '9_clubs': '9_clubs',
    '8_clubs': '8_clubs',
    '7_clubs': '7_clubs',
    '6_clubs': '6_clubs',
    '5_clubs': '5_clubs',
    '4_clubs': '4_clubs',
    '3_clubs': '3_clubs',
    '2_clubs': '2_clubs',
    'ace_diamonds': 'a_diamonds',
    'king_diamonds': 'k_diamonds',
    'queen_diamonds': 'q_diamonds',
    'jack_diamonds': 'j_diamonds',
    '10_diamonds': '10_diamonds',
    '9_diamonds': '9_diamonds',
    '8_diamonds': '8_diamonds',
    '7_diamonds': '7_diamonds',
    '6_diamonds': '6_diamonds',
    '5_diamonds': '5_diamonds',
    '4_diamonds': '4_diamonds',
    '3_diamonds': '3_diamonds',
    '2_diamonds': '2_diamonds',
    'hi_joker': 'hi_joker',
    'lo_joker': 'lo_joker'
};

async function buildCardAtlas() {
    const assetsDir = path.join(__dirname, '..', 'client', 'assets');
    const outputDir = path.join(assetsDir, 'sprites');

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Read card images based on the key map
    const cardFiles = [];
    for (const [filename, key] of Object.entries(cardKeyMap)) {
        const filePath = path.join(assetsDir, `${filename}.png`);
        if (fs.existsSync(filePath)) {
            cardFiles.push({
                path: key, // Use the key as the frame name
                contents: fs.readFileSync(filePath)
            });
        } else {
            console.warn(`Warning: Missing card image: ${filename}.png`);
        }
    }

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
        console.log(`Created: ${outputPath}`);
    }

    console.log('\nCard atlas created successfully!');
    console.log(`Output: ${outputDir}/cards.png and ${outputDir}/cards.json`);
}

buildCardAtlas().catch(err => {
    console.error('Error building atlas:', err);
    process.exit(1);
});
