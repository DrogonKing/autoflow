# بورس کالا — پیدا کردن سلکتور با Console

روش قطعی: **بدون حدس**. یک اسکریپت در Console مرورگر بزن، خروجی را بفرست.

---

## 🔴 اول یک هشدار

در اسکرینشاتی که فرستادی، **دکمههای واقعی `خرید` و `فروش`** هستند. ولی:

- در **دفتر سفارش** هم سرستون `خرید` و `فروش` هست
- در **فهرست نمادها** هم ممکن است باشد
- ستون «وضعیت» هم کلمهٔ `خرید` ممکن است داشته باشد

یعنی `text: 'خرید'` **ممکن است سرستون جدول را بگیرد**.

**رفعش را ساختم:** `isActionable` حالا فقط عناصری را ترجیح میدهد که **واقعاً کلیکشدنی** هستند
(`<button>`، `input[type=submit]`، `role=button`، `onclick`، `cursor:pointer`).
سرستون `<th>` دیگر ترجیح داده نمیشود — **ولی هنوز `css` امنتر است.**

---

## گام ۱ — این را در Console بزن

در همان تب بورس کالا، `F12` → تب **Console** → این را پیست کن و Enter:

```js
(() => {
  // هر چیزی که متنش «خرید» یا «فروش» دارد را نشان بده، با تشخیص اینکه واقعاً کلیک‌شدنی هست یا نه
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const isClickable = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return true;
    if (tag === 'a' && (el.getAttribute('href') || el.hasAttribute('onclick'))) return true;
    if (tag === 'input') return ['button','submit','reset','image','checkbox','radio'].includes((el.getAttribute('type')||'text').toLowerCase());
    if (tag === 'select' || tag === 'label' || tag === 'summary') return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (['button','link','menuitem','tab','option'].includes(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    try { if (getComputedStyle(el).cursor === 'pointer') return true; } catch {}
    return false;
  };
  const path = (el) => {
    const parts = [];
    let n = el;
    for (let i = 0; i < 6 && n && n.nodeType === 1; i++) {
      let s = n.tagName.toLowerCase();
      if (n.id) { s += '#' + n.id; parts.unshift(s); break; }
      const cls = (n.className && typeof n.className === 'string')
        ? '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
      s += cls;
      const p = n.parentElement;
      if (p) {
        const sib = [...p.children].filter((c) => c.tagName === n.tagName);
        if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(n) + 1})`;
      }
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(' > ');
  };
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const own = norm(el.textContent);
    if (own !== 'خرید' && own !== 'فروش') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out.push({
      text: own,
      tag: el.tagName,
      clickable: isClickable(el),
      id: el.id || null,
      classes: (typeof el.className === 'string' ? el.className : '') || null,
      box: `${Math.round(r.width)}x${Math.round(r.height)} @ ${Math.round(r.left)},${Math.round(r.top)}`,
      selector: path(el),
    });
  }
  // کلیک‌شدنی‌ها اول
  out.sort((a, b) => Number(b.clickable) - Number(a.clickable));
  console.log(`=== ${out.length} عنصر با متن خرید/فروش ===`);
  console.table(out);
  // و کاندیدای پیشنهادی
  const best = out.find((o) => o.clickable && o.text === 'خرید');
  if (best) console.log('%cSELECTOR پیشنهادی: ' + best.selector, 'color:#0a0;font-weight:bold');
  return out.length;
})()
```

**بعد خروجی `console.table` را کپی کن و بفرست.** (یا اسکرینشات از Console.)

---

## گام ۲ — این را هم بزن: چه چیزی بعد از کلیک ظاهر میشود

این **کلیک نمیکند** — فقط میگوید صفحه چه چیزی دارد:

```js
(() => {
  // دنبال هر چیزی که «تأیید»، «ثبت»، «موفق» یا «ارسال» دارد
  const words = ['تأیید', 'تایید', 'ثبت', 'موفق', 'ارسال', 'انجام شد', 'سفارش شما'];
  const hits = [];
  for (const el of document.querySelectorAll('*')) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length > 80) continue;                       // پرانتزهای بزرگ را رد کن
    if (!words.some((w) => t.includes(w))) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;      // نامرئی را رد کن
    hits.push({ text: t.slice(0, 60), tag: el.tagName, id: el.id || null });
  }
  console.log(`=== ${hits.length} عنصر با کلمات تأیید ===`);
  console.table(hits.slice(0, 40));
  // آیا گفتگویی باز است؟
  const dlg = document.querySelector('[role=dialog], .modal, .swal2-popup, .toast, .alert');
  console.log('گفتگو/مودال باز:', dlg ? dlg.className || dlg.tagName : 'هیچ');
  return hits.length;
})()
```

---

## گام ۳ — ساخت پروفایل

وقتی خروجیها را فرستادی، من **سلکتور دقیق** را مینویسم. ولی اگر خودت میخواهی امتحان کنی:

```
گام ۱:  CLICK
        Find:      css
        selector:  [سلکتور از Console]
        Button:    left
        Clicks:    1

گام ۲:  WAIT FOR
        Find:      css
        selector:  [سلکتور متن تأیید]
        Timeout:   15000
```

**`Find: css` انتخاب کن، نه `text`.** چون `text` روی این صفحه مبهم است.

---

## گام ۴ — پروفایل تمرینی (هیچ کلیکی نمیکند)

اگر میخواهی **بدون هیچ ریسکی** اول ببینی افزونه چه میبیند:

```
گام ۱:  WAIT      ms: 3000
گام ۲:  EXTRACT   Find: css   selector: button          Into: allButtons
گام ۳:  EXTRACT   Find: css   selector: input           Into: allInputs
گام ۴:  NOTIFY    message: بررسی تمام شد
```

بعد **History** را نگاه کن.

---

## و اگر Console را نمیتوانی باز کنی

مسیر جایگزین: در افزونه روی **⌖ Pick** بزن و روی دکمهٔ خرید کلیک کن.
افزونه **زنجیرهٔ جایگزین** میسازد (`css` + `id` + `text` + مسیرها) — که مقاومتر از یک سلکتور تنهاست.

بعد در پنل، هایلایت را ببین: اگر `+3 fallbacks` نوشت، یعنی زنجیره ساخته شد. ✅

---

## چه چیزی از این اسکرینشات فهمیدم و چه چیزی نه

| ✅ فهمیدم | ❌ نمیدانم |
|---|---|
| دکمههای عمل `خرید` و `فروش` هستند | کدام `<button>` واقعی است |
| فیلدها: `قیمت`، `تعداد`، `دارایی`، `سرمایه`، `اعتبار` | `id` یا `class` آنها |
| `روز` یک dropdown است نه input | متن تأیید بعد از سفارش |
| دفتر سفارش هم `خرید`/`فروش` دارد (خطر ابهام) | آیا تأیید دوم (کد/رمز) لازم است |
| نمادها: `فزر`، `وبملت` | صفحه چند ثانیه طول میکشد تا دکمه فعال شود |

**این جدول، دقیقاً همان چیزی است که Console پر میکند.**