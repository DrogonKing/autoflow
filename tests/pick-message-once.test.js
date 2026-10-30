/**
 * ONE CLICK ON THE PAGE MUST PRODUCE EXACTLY ONE `element-picked` AT THE PANEL.
 *
 * The report, 1.23.0: "the error is gone only for the first pick; for the rest it still comes, but it still works and
 * does not affect the function." A selector that lands AND a complaint that appears means the message arrived twice: the
 * first copy finds the step and consumes `pickTarget`, every later copy finds nothing and takes the `else` branch that
 * prints "but no point was waiting for it".
 *
 * Two senders existed for one event:
 *   1. the content script broadcasts `element-picked` with `runtime.sendMessage`, which reaches EVERY extension context
 *      that listens - including the panel;
 *   2. the worker received that broadcast and sent the same message again as a forward.
 *
 * MEASURED with three picks in the editor, before the fix: 2 messages each, one `from=content-script` and one
 * `from=extension-page`. After: 1 each.
 *
 * A unit test cannot observe message fan-out, so this pins the SOURCE: the worker has no `sendMessage` for this type, and
 * the content script still sends it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('element-picked is sent once per click', () => {
  it('the content script broadcasts it, because that is the context that knows the page', () => {
    const content = read('src/content/content.js');
    expect(content).toMatch(/type: 'element-picked'/);
  });

  it('the worker does NOT forward it, because a broadcast already reaches the panel', () => {
    const worker = read('src/background/service-worker.js');
    /**
     * The case block handles the message to record the page, then must stop. A `sendMessage` for this type inside the
     * worker is the duplicate - matched loosely so a rename of the local variable cannot hide it.
     */
    const caseStart = worker.indexOf("case 'element-picked'");
    expect(caseStart).toBeGreaterThan(-1);
    const caseEnd = worker.indexOf('case ', caseStart + 10);
    const block = worker.slice(caseStart, caseEnd > 0 ? caseEnd : caseStart + 2000);
    expect(block, 'the worker still forwards element-picked, so the panel sees two per click')
      .not.toMatch(/sendMessage\(\s*\{\s*type:\s*'element-picked'/);
  });

  it('and the panel ignores a repeat rather than complaining about it', () => {
    const panel = read('src/ui/panel/panel.js');
    /**
     * Defence in depth: whatever else may broadcast this type, a second copy must not produce a message. A pick that
     * cannot find a step is only worth reporting when nothing took it - not when something already did a millisecond
     * earlier.
     */
    expect(panel).toMatch(/state\.pickSavedAt/);
    expect(panel, 'no guard against a repeated pick message').toMatch(/alreadySettled|pickSavedFor === step\.id|msg\.at/);
  });
});
