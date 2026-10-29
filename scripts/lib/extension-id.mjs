/**
 * Find an unpacked extension's id the way a fresh install can be observed.
 *
 * WHY NOT `chrome://extensions`. That page works in the desktop Chrome on this machine and FAILS on the
 * Chromium that Playwright installs on a CI runner:
 *
 *     page.goto: net::ERR_INVALID_URL at chrome://extensions
 *
 * So CI could not read the id, and the check that found the real toolbar bug could not run there. Reading the
 * profile is version-independent: Chromium writes `extensions.settings` into the profile as JSON, and an
 * unpacked extension appears there with its path, which is how it can be identified without asking the UI.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Look for an unpacked extension whose folder is `buildDir`, in whichever profile directory has one.
 * Returns the 32-character extension id, or null.
 */
export function findUnpackedExtensionId(profileDir, buildDir) {
  const wanted = path.resolve(buildDir);
  const candidates = [];

  if (existsSync(profileDir)) {
    for (const entry of readdirSync(profileDir, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(profileDir, entry.name, 'Preferences'));
    }
    candidates.push(path.join(profileDir, 'Preferences'));
  }

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let prefs;
    try {
      prefs = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // a half-written Preferences is normal during startup
    }
    const settings = prefs?.extensions?.settings;
    if (!settings) continue;
    for (const [id, value] of Object.entries(settings)) {
      const p = value?.path;
      if (typeof p !== 'string') continue;
      if (path.resolve(p) === wanted) {
        return { id, name: value?.manifest?.name ?? null };
      }
    }
  }
  return null;
}

/** Poll until the id appears, because the profile is written during startup. */
export async function waitForUnpackedExtensionId(profileDir, buildDir, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = findUnpackedExtensionId(profileDir, buildDir);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}
