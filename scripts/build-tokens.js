#!/usr/bin/env node
/**
 * Design tokens (roadmap items 18a and 29): writes client/styles/tokens.css,
 * client/src/ui/tokens.js and iOSClient/BABOnline/Generated/Theme.swift from
 * client/tokens/tokens.json.
 *
 *   npm run tokens          write all three files
 *   npm run tokens:check    exit 1 when a committed file is stale (or a contrast pair fails)
 *
 * The generator itself is client/tokens/generate.mjs (the client test
 * tokens.test.js runs the same functions).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

async function main() {
  const { renderAll, contrastReport } = await import(path.join(ROOT, 'client/tokens/generate.mjs'));
  const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'client/tokens/tokens.json'), 'utf8'));
  const check = process.argv.includes('--check');

  const failing = contrastReport(tokens).filter((p) => !p.ok);
  for (const p of failing) console.error(`contrast ${p.fg} on ${p.bg.join(' over ')}: ${p.ratio} < ${p.min}`);

  let stale = 0;
  for (const [rel, content] of Object.entries(renderAll(tokens))) {
    const file = path.join(ROOT, rel);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current === content) continue;
    if (check) {
      console.error(`stale: ${rel} (run npm run tokens)`);
      stale++;
    } else {
      fs.writeFileSync(file, content);
      console.log(`wrote ${rel}`);
    }
  }
  if (stale || failing.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
