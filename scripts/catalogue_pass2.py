#!/usr/bin/env python3
"""
Second pass of the catalogue: every string the wiring pass reported as still hardcoded.

Split from the first catalogue on purpose. The first pass covered the strings a user reads constantly - tabs,
step names, field labels, buttons. This pass covers the helper text, hints, placeholders and the schedule
explainers, which are the ones that decide whether the panel is usable in Persian at all, because they are
where the non-obvious behaviour is described.

Keys are grouped by the area they belong to. `hint.` and `ph.` prefixes keep the long explanatory text apart
from the short labels.
"""
import pathlib
import re

CAT = pathlib.Path("/root/autoflow/src/core/i18n/catalogue.js")
text = CAT.read_text()

# key -> (en, fa)
NEW = {
    # ---- schedule explainers: this is where the non-obvious behaviour is described
    'sched.monthlyDayHint': (
        '1–28, so every month has it',
        '۱ تا ۲۸، تا هر ماهی داشته باشد',
    ),
    'sched.cronPlaceholder': (
        'minute hour day month weekday',
        'دقیقه ساعت روز ماه روزهفته',
    ),
    'sched.cronHelp': (
        'Five fields, in your local time. e.g.  0 9 * * 1-5  = weekdays at 09:00',
        'پنج فیلد، به وقت محلی خودت. مثلاً  0 9 * * 1-5  = روزهای هفته ساعت ۰۹:۰۰',
    ),
    'sched.cronSecondsHelp': (
        'Six fields supported when you need an exact second:  ss mm hh day month weekday. ',
        'شش فیلد هم پشتیبانی می‌شود وقتی ثانیهٔ دقیق می‌خواهی:  ss mm hh day month weekday. ',
    ),
    'sched.willNotFire': (
        'this schedule will not fire again',
        'این برنامه دیگر اجرا نمی‌شود',
    ),

    # ---- controls whose label is a glyph
    'ui.moveUp': ('↑', '↑'),
    'ui.moveDown': ('↓', '↓'),
    'ui.close': ('✕', '✕'),
    'ui.pick': ('⌖ Pick', '⌖ انتخاب'),
    'ui.pickTitle': ('Click an element on the page', 'روی یک عنصر در صفحه کلیک کن'),
    'ui.runNow': ('▶ Run now', '▶ اجرا'),
    'ui.edit': ('✎ Edit', '✎ ویرایش'),
    'ui.duplicateGlyph': ('⧉', '⧉'),
    'ui.deleteGlyph': ('🗑', '🗑'),
    'ui.panelGlyph': ('◧', '◧'),
    'ui.gearGlyph': ('⚙', '⚙'),

    # ---- placeholders: what the field expects
    'ph.template': ('text, or ${variable} or ${row.column}', 'متن، یا ${variable} یا ${row.column}'),
    'ph.optionValue': ('option value or visible text', 'مقدار گزینه یا متن قابل‌دیدن'),
    'ph.url': ('https://... or ${row.url}', 'https://... یا ${row.url}'),
    'ph.keyChord': ('e.g. ctrl+shift+t', 'مثلاً ctrl+shift+t'),
    'ph.anyValue': ('value or ${...}', 'مقدار یا ${...}'),
    'ph.textOrVariable': ('text or ${variable}', 'متن یا ${variable}'),
    'ph.script': (
        'JavaScript run in the page. Return a value to store it.',
        'جاوااسکریپت که در صفحه اجرا می‌شود. اگر مقداری برگردانی، ذخیره می‌شود.',
    ),
    'ph.listVariable': (
        'variable holding a list (or the CSV rows)',
        'متغیری که یک لیست دارد (یا ردیف‌های CSV)',
    ),
    'ph.compareAgainst': ('compare against, or ${variable}', 'مقدار مقایسه، یا ${variable}'),
    'ph.empty': ('—', '—'),
    'ph.siteScope': (
        'leave empty to run anywhere; e.g. example.com/*',
        'خالی بگذار تا همه‌جا اجرا شود؛ مثلاً example.com/*',
    ),

    # ---- hints
    'hint.by': ('By', 'توسط'),
    'hint.ms': ('ms', 'ms'),
    'hint.msBetweenKeys': ('ms between keys', 'ms بین کلیدها'),
    'hint.scrollPx': ('px vertical (negative scrolls up)', 'پیکسل عمودی (منفی به بالا)'),
    'hint.loopIterations': (
        'iterations — required, so it cannot run forever',
        'تعداد تکرار — اجباری است تا حلقه بی‌نهایت نشود',
    ),
    'hint.loopVars': (
        'current: loop index, iteration, total, first, last',
        'مقادیر موجود: loop.index و loop.iteration و loop.total و loop.first و loop.last',
    ),
    'hint.otherwise': ('otherwise', 'وگرنه'),
    'hint.addStep': ('+ Add step', '+ افزودن گام'),
    'hint.pickTitleLong': (
        'Pick elements on the page to build steps automatically',
        'عنصرهای روی صفحه را انتخاب کن تا گام‌ها خودکار ساخته شوند',
    ),
    'hint.picking': ('Click an element on the page...', 'روی یک عنصر در صفحه کلیک کن...'),

    # ---- the data tab
    'data.csvFile': ('CSV file', 'فایل CSV'),
    'data.usage': (
        'Use ${row.column} or ${column} in any step. A loop of type "for each item in a list" over "rows" walks the file.',
        'در هر گام از ${row.column} یا ${column} استفاده کن. یک حلقهٔ «روی هر آیتم لیست» روی «rows» فایل را می‌گردد.',
    ),
    'data.explainer': (
        'Load a CSV to drive an automation with data. Rows are kept only while the browser is open.',
        'یک CSV بارگذاری کن تا اتوماسیون با داده اجرا شود. ردیف‌ها فقط تا وقتی مرورگر باز است نگه داشته می‌شوند.',
    ),
    'schedule.empty': (
        'Nothing is scheduled. Give an automation a schedule and it will appear here.',
        'چیزی زمان‌بندی نشده. به یک اتوماسیون زمان‌بندی بده تا اینجا بیاید.',
    ),

    # ---- options page
    'opt.historyLimitHint': ('run records in history', 'رکورد اجرا در تاریخچه'),
    'opt.exportAll': ('⭳ Export all automations', '⭳ خروجی همهٔ اتوماسیون‌ها'),
    'opt.importGlyph': ('⭱ Import', '⭱ ورود'),
    'opt.copyGlyph': ('⧉ Copy', '⧉ کپی'),
    'opt.diagnosticsHelp': (
        'Press Refresh to collect environment and state information. This is what to include when reporting a problem.',
        'روی بازخوانی بزن تا اطلاعات محیط و وضعیت جمع شود. این همان چیزی است که هنگام گزارش مشکل باید بفرستی.',
    ),
    'opt.noneYet': ('None yet. Create one from the side panel.', 'هنوز هیچ‌کدام. از پنل کناری یکی بساز.'),
    'opt.subtitle': (
        'Auto-click, fill and record browser automations, on a schedule.',
        'کلیک، پرکردن و ضبط اتوماسیون‌های مرورگر، روی زمان‌بندی.',
    ),

    # ---- the schedule kind the timer panel shows
    'sched.timerTitle': ('TIMER', 'زمان‌بندی'),
    'sched.nextPreviewLabel': ('Next runs', 'اجراهای بعدی'),
    'sched.once': ('once', 'یک‌بار'),
    'sched.dayOfMonth': ('day of month', 'روز ماه'),
    'sched.weekday': ('weekday', 'روز هفته'),
}


def escape_js(s):
    return s.replace("\\", "\\\\").replace("'", "\\'")


def block(name, table, order):
    lines = [f"  // ---- {name}"]
    for key in order:
        if key not in table:
            continue
        en_v, fa_v = table[key]
        lines.append(f"  '{key}': '{escape_js(en_v)}',")
    return "\n".join(lines), "\n".join(
        [f"  // ---- {name}"] + [f"  '{k}': '{escape_js(table[k][1])}'," for k in order if k in table]
    )


order = list(NEW.keys())
en_block, fa_block = block("second pass: hints, placeholders and schedule explainers", NEW, order)

# insert into both objects, before the closing brace
for name, add in (("en", en_block), ("fa", fa_block)):
    m = re.search(rf"(export const {name} = \{{.*?)(\n\}};)", text, re.S)
    if not m:
        raise SystemExit(f"could not find the {name} object")
    text = text[:m.end(1)] + "\n\n" + add + text[m.end(1):]

CAT.write_text(text)

# verify by counting keys
en_keys = len(re.findall(r"^\s*'[^']+':", re.search(r"export const en = \{(.*?)\n\};", text, re.S).group(1), re.M))
fa_keys = len(re.findall(r"^\s*'[^']+':", re.search(r"export const fa = \{(.*?)\n\};", text, re.S).group(1), re.M))
print(f"added {len(NEW)} keys")
print(f"catalogue now: en {en_keys}, fa {fa_keys}")
if en_keys != fa_keys:
    raise SystemExit("the catalogues are out of step")
