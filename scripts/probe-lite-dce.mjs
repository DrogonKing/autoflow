#!/usr/bin/env node
/**
 * Is the lite saving from REMOVING CODE, or merely from minifying?
 *
 * The distinction decides whether the flag is a real feature or a cosmetic one, and it is the difference between
 * "35% smaller because the editors are gone" and "35% smaller because nobody turned on the minifier" - the second
 * would be a claim the artifact does not support, and the full build would be just as small with one option flipped.
 *
 * Four measurements: {full, lite} x {not minified, minified}.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = path.join(root, 'src/ui/panel/panel.js');

async function size(lite, minify) {
  const r = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    target: ['chrome116'],
    define: { __LITE__: String(lite) },
    minify,
    legalComments: 'none',
    logLevel: 'silent',
  });
  return r.outputFiles[0].contents.length / 1024;
}

const full = await size(false, false);
const fullMin = await size(false, true);
const lite = await size(true, false);
const liteMin = await size(true, true);

const kb = (x) => `${x.toFixed(1)} KB`;
console.log('panel.js, four ways:');
console.log(`  full                     ${kb(full)}`);
console.log(`  full + minify            ${kb(fullMin)}`);
console.log(`  lite                     ${kb(lite)}`);
console.log(`  lite + minify            ${kb(liteMin)}`);
console.log();
console.log(`  saving from REMOVING CODE (lite vs full, same minify): ${kb(full - lite)}`);
console.log(`  saving from MINIFYING    (same variant):                ${kb(full - fullMin)}`);
console.log();
const pct = ((full - liteMin) / full) * 100;
console.log(`  end to end: ${full.toFixed(1)} KB -> ${liteMin.toFixed(1)} KB = ${pct.toFixed(0)}% smaller`);
if (full - lite < full - fullMin) {
  console.log('\n  !! most of the saving is the minifier, not the variant - say so rather than claiming the flag did it');
} else {
  console.log('\n  the saving is predominantly from the removal, which is what the flag is for');
}
