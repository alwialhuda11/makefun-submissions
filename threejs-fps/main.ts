// Operation Depository — entry build (Node 22, standard library only).
// This hands the game in: it copies game/ and screenshots/ from beside this file to /output
// and writes /output/dossier.json with the vendored make.fun library. Before it writes the
// dossier it validates the screenshots against the gate's caps so a bad capture fails loudly
// instead of silently producing an invalid (or zero-rate) entry.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The gate's screenshot caps (reference/gate.json): 3 or 4 shots, each at most 256 KiB,
// long side at most 1280 and short side at least 480 pixels. We check the byte size and
// count here; a PNG/JPEG dimension check would need a decoder we do not ship.
function checkScreenshots(dir, maxCount, maxBytes) {
  const names = readdirSync(dir).filter((n) => /\.(png|jpe?g)$/i.test(n));
  if (names.length < 3 || names.length > maxCount) {
    throw new Error(`expected 3-${maxCount} screenshots, found ${names.length}`);
  }
  for (const name of names) {
    const size = statSync(join(dir, name)).size;
    if (size > maxBytes) {
      throw new Error(`screenshot ${name} is ${size} bytes, over the ${maxBytes} cap`);
    }
  }
  return names;
}

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });

const shotsDir = join(out, 'screenshots');
mkdirSync(shotsDir, { recursive: true });
if (existsSync(join(here, 'screenshots'))) {
  cpSync(join(here, 'screenshots'), shotsDir, { recursive: true });
}
checkScreenshots(shotsDir, 4, 262144);

writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: 163840, screenshots: { max: 4, max_bytes: 262144 }, game_max_files: 993, game_max_bytes: 50331648 }),
);
