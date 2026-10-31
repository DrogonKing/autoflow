import pathlib
import re
import sys

PANEL = pathlib.Path('/root/autoflow/src/ui/panel/panel.js')
s = PANEL.read_text()
before = len(s)

# ------------------------------------------------------------------------------------------------
# A BUILD-TIME FLAG THE BUNDLER CAN PROVE.
#
# `__LITE__` is substituted by esbuild's `define`, so the lite build turns `if (!__LITE__)` into
# `if (!true)` -> dead, and the dead branch and anything only it referenced are removed. A RUNTIME
# check (a stored setting, a query param) cannot do this: the code still ships and still costs the
# parse. That is the whole difference between a lite build and a lite setting.
#
# The tabs are the unit of removal rather than individual functions, because the views are
# self-contained enough for the bundler and pulling at one function tends to drag the whole editor in.
# ------------------------------------------------------------------------------------------------

# 1. the tab list itself
old_tabs = """  for (const [id, key] of [['basic', 'tab.basic'], ['automations', 'tab.automations'], ['scheduled', 'tab.scheduled'], ['data', 'tab.data'], ['history', 'tab.history'], ['log', 'tab.log']]) {"""
new_tabs = """  for (const [id, key] of TAB_LIST) {"""
assert old_tabs in s, 'the tab list was not found'
s = s.replace(old_tabs, new_tabs, 1)

# and the list, with the lite exclusion visible at the top of the file
anchor = "const state = {"
tabs_const = """/**
 * WHICH TABS EXIST.
 *
 * In a lite build only `basic` remains, and the flag is a build-time constant on purpose: writing
 * `__LITE__ ? [...] : [...]` lets esbuild evaluate it, drop the other branch, and then drop the view
 * functions that nothing references any more. A runtime check would keep every line in the bundle.
 *
 * It sits above `state` because the panels it removes are defined further down and the constant has to be
 * visible to the bundler from one place.
 */
const TAB_LIST = __LITE__
  ? [['basic', 'tab.basic']]
  : [['basic', 'tab.basic'], ['automations', 'tab.automations'], ['scheduled', 'tab.scheduled'], ['data', 'tab.data'], ['history', 'tab.history'], ['log', 'tab.log']];

const state = {"""
assert anchor in s
s = s.replace(anchor, tabs_const, 1)

# 2. the body dispatcher
old_dispatch = """  const body = el('main');
  if (state.tab === 'basic') body.append(basicView(rerender));
  else if (state.tab === 'automations') body.append(automationsView(rerender));
  else if (state.tab === 'scheduled') body.append(scheduledView());
  else if (state.tab === 'data') body.append(dataView(rerender));
  else if (state.tab === 'log') body.append(logView(rerender));
  else body.append(historyView());"""
new_dispatch = """  const body = el('main');
  if (state.tab === 'basic') body.append(basicView(rerender));
  /**
   * THE FULL-TREE BRANCH IS UNREACHABLE IN A LITE BUILD, which is what makes the removal real rather than
   * cosmetic: esbuild folds `!__LITE__` to `false` and then has no reference to these five functions from
   * anywhere, so it drops them and their private helpers.
   *
   * `body.empty()`-style fallbacks are deliberately NOT used: a lite build cannot have a second tab to fall
   * back to, and adding one would keep a reference alive and defeat the elimination.
   */
  else if (!__LITE__) {
    if (state.tab === 'automations') body.append(automationsView(rerender));
    else if (state.tab === 'scheduled') body.append(scheduledView());
    else if (state.tab === 'data') body.append(dataView(rerender));
    else if (state.tab === 'log') body.append(logView(rerender));
    else body.append(historyView());
  }"""
assert old_dispatch in s, 'the body dispatcher was not found'
s = s.replace(old_dispatch, new_dispatch, 1)

# 3. an initial tab that does not exist in lite
old_tab = "  tab: 'automations',"
new_tab = "  // 'basic' exists in BOTH builds; 'automations' does not exist in lite, so opening there would render nothing\n  tab: __LITE__ ? 'basic' : 'automations',"
assert old_tab in s
s = s.replace(old_tab, new_tab, 1)

# 4. a lite build must not be able to open a removed tab from anywhere
old_guard = """        if (id !== 'basic') state.basicStale = true;
        state.tab = id;
        render();"""
new_guard = """        if (id !== 'basic') state.basicStale = true;
        /**
         * A REMOVED TAB MUST NOT BE ENTERABLE. The nav only offers the tabs in TAB_LIST, but a stale `state.tab`
         * survives in the panel's own memory and a saved reference could still name one - and in lite that would
         * render an empty body with no explanation. Refusing the switch is the honest outcome.
         */
        if (__LITE__ && id !== 'basic') return;
        state.tab = id;
        render();"""
assert old_guard in s, 'the tab switch handler was not found'
s = s.replace(old_guard, new_guard, 1)

PANEL.write_text(s)
print(f'panel.js: {before} -> {len(s)} bytes ({len(s) - before:+d})')
print('  TAB_LIST, the body dispatcher, the initial tab and the switch guard are now lite-aware')
