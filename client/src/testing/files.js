/**
 * Test helper: read a file of the client (styles, tokens) whatever the
 * working directory (the repo root for npm run test:client, or client/).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** The client/ directory. */
export const CLIENT_ROOT = existsSync(resolve(process.cwd(), 'client')) ? resolve(process.cwd(), 'client') : process.cwd();
/** The repo root. */
export const REPO_ROOT = resolve(CLIENT_ROOT, '..');

/** A file under client/ as text. */
export function readClientFile(rel) {
  return readFileSync(resolve(CLIENT_ROOT, rel), 'utf8');
}
