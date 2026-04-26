import { listExpensesInRange, monthRangeISO, formatMoney } from "./db.js";

function sumCents(items) {
  return items.reduce((acc, e) => acc + (e.amountCents || 0), 0);
}

function groupBy(items, keyFn) {
  /** @type {Map<string, any[]>} */
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it) || "";
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

function safeMerchant(s) {
  return String(s || "").trim() || "Unknown merchant";
}

export async function computeInsights(settings) {
  const currency = settings.currency || "USD";
  const now = new Date();
  const thisRange = monthRangeISO(now);
  const lastRange = monthRangeISO(new Date(now.getFullYear(), now.getMonth() - 1, 15));
  const [tStart, tEnd] = thisRange;
  const [lStart, lEnd] = lastRange;

  const [thisMonth, lastMonth] = await Promise.all([
    listExpensesInRange(tStart, tEnd),
    listExpensesInRange(lStart, lEnd)
  ]);

  const thisTotal = sumCents(thisMonth);
  const lastTotal = sumCents(lastMonth);

  const byCat = groupBy(thisMonth, (e) => e.category || "Uncategorized");
  const catTotals = [...byCat.entries()].map(([cat, items]) => ({ cat, total: sumCents(items), n: items.length }));
  catTotals.sort((a, b) => b.total - a.total);

  const byMerchant = groupBy(thisMonth, (e) => safeMerchant(e.merchant));
  const merchantTotals = [...byMerchant.entries()].map(([m, items]) => ({ merchant: m, total: sumCents(items), n: items.length }));
  merchantTotals.sort((a, b) => b.total - a.total);

  /** @type {{title:string, severity:"good"|"warn"|"bad", detail:string, action:string}[]} */
  const suggestions = [];

  // Budget pacing.
  const budget = settings.monthlyBudgetCents || 0;
  if (budget > 0) {
    const day = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const expected = Math.round((budget * day) / daysInMonth);
    const diff = thisTotal - expected;
    const pct = expected > 0 ? diff / expected : 0;
    if (diff > 0) {
      suggestions.push({
        title: "Spending is ahead of budget pace",
        severity: pct > 0.25 ? "bad" : "warn",
        detail: `So far this month: ${formatMoney(thisTotal, currency)}. At this point you’d expect about ${formatMoney(expected, currency)}.`,
        action: "Try a 48-hour pause on discretionary purchases and set a weekly cap on your top category."
      });
    } else {
      suggestions.push({
        title: "You’re on track vs your budget pace",
        severity: "good",
        detail: `So far this month: ${formatMoney(thisTotal, currency)} vs expected ${formatMoney(expected, currency)}.`,
        action: "Keep it up — consider moving the difference into savings."
      });
    }
  }

  // Month-over-month change.
  if (lastTotal > 0) {
    const delta = thisTotal - lastTotal;
    const pct = delta / lastTotal;
    const direction = delta >= 0 ? "up" : "down";
    suggestions.push({
      title: `Spending is ${direction} vs last month`,
      severity: pct > 0.15 ? "warn" : (pct < -0.10 ? "good" : "warn"),
      detail: `This month: ${formatMoney(thisTotal, currency)}. Last month: ${formatMoney(lastTotal, currency)}.`,
      action: "Look at your top 3 merchants and see if any recurring purchases can be reduced or canceled."
    });
  }

  // Top category.
  if (catTotals.length) {
    const top = catTotals[0];
    const share = thisTotal > 0 ? top.total / thisTotal : 0;
    suggestions.push({
      title: `Top category: ${top.cat}`,
      severity: share > 0.35 ? "warn" : "good",
      detail: `${top.cat} is ${formatMoney(top.total, currency)} across ${top.n} purchases (${Math.round(share * 100)}% of this month).`,
      action: "Set a category limit and move the “default” payment method for that category to a lower-friction option (cash/debit)."
    });
  }

  // Recurring-like merchants (simple heuristic: 2+ purchases, spread across >=14 days).
  const recurring = [];
  for (const [merchant, items] of byMerchant.entries()) {
    if (!merchant || merchant === "Unknown merchant") continue;
    if (items.length < 2) continue;
    const dates = items.map((e) => e.dateISO).sort();
    const first = new Date(dates[0]).getTime();
    const last = new Date(dates[dates.length - 1]).getTime();
    const spanDays = (last - first) / (1000 * 60 * 60 * 24);
    if (spanDays >= 14) recurring.push({ merchant, n: items.length, total: sumCents(items) });
  }
  recurring.sort((a, b) => b.total - a.total);
  if (recurring.length) {
    const top = recurring[0];
    suggestions.push({
      title: "Possible recurring spending detected",
      severity: "warn",
      detail: `${top.merchant} appears multiple times (${top.n} purchases) totaling ${formatMoney(top.total, currency)} this month.`,
      action: "If it’s a subscription, consider downgrading, pausing, or switching to an annual plan only if you consistently use it."
    });
  }

  // Quick “cut” candidates: small frequent purchases in Dining/Convenience-like categories.
  const snackCats = new Set(["Dining", "Food", "Coffee", "Convenience", "Snacks", "Takeout"]);
  const snackItems = thisMonth.filter((e) => snackCats.has(e.category));
  if (snackItems.length >= 6) {
    const snackTotal = sumCents(snackItems);
    suggestions.push({
      title: "Frequent small purchases add up",
      severity: "warn",
      detail: `${snackItems.length} purchases in common “impulse” categories total ${formatMoney(snackTotal, currency)} this month.`,
      action: "Try a rule: limit to 2 “out” coffees/meals per week, and batch grocery/snack buys once."
    });
  }

  return {
    currency,
    thisRange,
    thisTotal,
    lastTotal,
    catTotals: catTotals.slice(0, 8),
    merchantTotals: merchantTotals.slice(0, 8),
    suggestions
  };
}

