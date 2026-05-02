import {
  addExpense,
  deleteExpense,
  listExpenses,
  addReceipt,
  listReceipts,
  getReceipt,
  deleteReceipt,
  getSettings,
  saveSettings,
  formatMoney,
  parseMoneyToCents,
  monthRangeISO,
  listExpensesInRange
} from "./db.js";
import { computeInsights } from "./insights.js";

const CATEGORIES = [
  "Uncategorized",
  "Groceries",
  "Dining",
  "Transport",
  "Bills",
  "Rent/Mortgage",
  "Health",
  "Shopping",
  "Entertainment",
  "Travel",
  "Education",
  "Gifts",
  "Subscriptions",
  "Other"
];

const ROUTES = new Set(["/", "/add", "/receipts", "/insights", "/settings"]);
const root = document.getElementById("root");
const toastHost = document.getElementById("toastHost");

function $(sel) {
  return document.querySelector(sel);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === "string") el.appendChild(document.createTextNode(c));
    else el.appendChild(c);
  }
  return el;
}

function routePath() {
  const hash = location.hash || "#/";
  const path = hash.replace(/^#/, "") || "/";
  return ROUTES.has(path) ? path : "/";
}

function setActiveTab(path) {
  document.querySelectorAll(".tab").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("data-route") === path);
  });
}

function dateLabel(iso) {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(d);
  } catch {
    return iso;
  }
}

function currencyFromText(text, fallback) {
  const t = String(text || "");
  if (/[€]/.test(t)) return "EUR";
  if (/[£]/.test(t)) return "GBP";
  if (/\bCAD\b/i.test(t) || /C\$\s?/.test(t)) return "CAD";
  if (/\bAUD\b/i.test(t) || /A\$\s?/.test(t)) return "AUD";
  if (/\bUSD\b/i.test(t) || /\$\s?/.test(t)) return "USD";
  return fallback || "USD";
}

function guessMerchantFromOcr(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 12);
  // Heuristic: first non-empty line that isn’t mostly digits.
  for (const l of lines) {
    const digitShare = (l.replace(/[^\d]/g, "").length) / Math.max(1, l.length);
    if (l.length >= 3 && digitShare < 0.35 && !/total|subtotal|tax/i.test(l)) return l.slice(0, 60);
  }
  return lines[0]?.slice(0, 60) || "";
}

function extractTotalsFromOcr(text) {
  const t = String(text || "");
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  /** @type {number[]} */
  const candidates = [];

  const totalLineRe = /(grand\s*)?total\b|amount\s*due\b|balance\s*due\b/i;
  const moneyRe = /[-+]?[\$€£]?\s*\d{1,4}(?:[.,]\d{2})/g;

  for (const line of lines) {
    const matches = line.match(moneyRe) || [];
    for (const m of matches) {
      const cents = parseMoneyToCents(m);
      if (cents != null && cents > 0) {
        const scoreBoost = totalLineRe.test(line) ? 2 : 0;
        // store as cents with minor score by duplicating
        candidates.push(cents);
        if (scoreBoost) candidates.push(cents);
      }
    }
  }
  if (!candidates.length) return null;
  // Prefer the maximum value among candidates (common for receipts).
  const best = Math.max(...candidates);
  return best;
}

async function ensureServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register(new URL("./sw.js", import.meta.url), {
      scope: new URL("./", import.meta.url)
    });
  } catch {
    // ignore; app still works online.
  }
}

async function loadTesseract() {
  if (window.Tesseract) return window.Tesseract;
  // Load from a reputable CDN. Pinning version reduces supply-chain surprises.
  const src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/tesseract.min.js";
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  if (!window.Tesseract) throw new Error("OCR library failed to load.");
  return window.Tesseract;
}

async function compressImageToBlob(file, { maxDim = 1600, quality = 0.82 } = {}) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.drawImage(bmp, 0, 0, w, h);
  const mime = "image/jpeg";
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  return { blob, mime };
}

function setRoot(children) {
  root.replaceChildren(...children);
}

function card(title, hint, bodyEl) {
  return h("section", { class: "card" }, [
    h("div", { class: "cardHeader" }, [
      h("div", {}, [
        h("div", { class: "cardTitle" }, [title]),
        hint ? h("div", { class: "cardHint" }, [hint]) : null
      ])
    ]),
    bodyEl
  ]);
}

function emptyState(text) {
  return h("div", { class: "empty" }, [text]);
}

async function renderDashboard() {
  const settings = await getSettings();
  const currency = settings.currency || "USD";
  const expenses = await listExpenses({ limit: 25 });
  const [mStart, mEnd] = monthRangeISO(new Date());
  const monthItems = await listExpensesInRange(mStart, mEnd);
  const monthTotal = monthItems.reduce((a, e) => a + (e.amountCents || 0), 0);
  const budget = settings.monthlyBudgetCents || 0;
  const remaining = budget > 0 ? Math.max(0, budget - monthTotal) : 0;

  const kpis = h("div", { class: "kpis" }, [
    h("div", { class: "kpi" }, [
      h("div", { class: "kpiLabel" }, ["This month"]),
      h("div", { class: "kpiValue" }, [formatMoney(monthTotal, currency)]),
      h("div", { class: "kpiDelta" }, [budget > 0 ? `Budget: ${formatMoney(budget, currency)}` : "Set a budget in Settings"])
    ]),
    h("div", { class: "kpi" }, [
      h("div", { class: "kpiLabel" }, ["Remaining"]),
      h("div", { class: "kpiValue" }, [budget > 0 ? formatMoney(remaining, currency) : "—"]),
      h("div", { class: "kpiDelta" }, [budget > 0 ? `Used: ${Math.round((monthTotal / budget) * 100)}%` : ""])
    ]),
    h("div", { class: "kpi" }, [
      h("div", { class: "kpiLabel" }, ["Receipts"]),
      h("div", { class: "kpiValue" }, ["Scan & save"]),
      h("div", { class: "kpiDelta" }, ["Add receipts from the Add tab"])
    ]),
    h("div", { class: "kpi" }, [
      h("div", { class: "kpiLabel" }, ["Suggestions"]),
      h("div", { class: "kpiValue" }, ["Cut costs"]),
      h("div", { class: "kpiDelta" }, ["See the Suggestions tab"])
    ])
  ]);

  const list = h("div", { class: "list" }, []);
  if (!expenses.length) {
    list.appendChild(emptyState("No expenses yet. Add one manually or scan a receipt from the Add tab."));
  } else {
    for (const e of expenses) {
      list.appendChild(
        h("div", { class: "item" }, [
          h("div", { class: "itemLeft" }, [
            h("div", { class: "itemTitle" }, [e.merchant ? e.merchant : e.category]),
            h("div", { class: "itemMeta" }, [
              h("span", { class: "pill" }, [dateLabel(e.dateISO)]),
              h("span", { class: "pill" }, [e.category]),
              e.source === "receipt" ? h("span", { class: "pill" }, ["Receipt"]) : null
            ])
          ]),
          h("div", { style: "display:flex; gap:10px; align-items:center;" }, [
            h("div", { class: "amt" }, [formatMoney(e.amountCents, e.currency || currency)]),
            h("button", {
              class: "btn btnSmall btnDanger",
              onClick: async () => {
                if (!confirm("Delete this expense?")) return;
                await deleteExpense(e.id);
                toast("Deleted expense");
                render();
              }
            }, ["Delete"])
          ])
        ])
      );
    }
  }

  setRoot([
    h("div", { class: "grid" }, [
      card("Dashboard", "Quick look at your month", h("div", {}, [kpis])),
      card("Recent expenses", "Your last 25 entries", list)
    ])
  ]);
}

async function renderAdd() {
  const settings = await getSettings();
  const currency = settings.currency || "USD";

  const amount = h("input", { inputmode: "decimal", placeholder: "12.34" });
  const date = h("input", { type: "date", value: new Date().toISOString().slice(0, 10) });
  const category = h("select", {}, CATEGORIES.map((c) => h("option", { value: c }, [c])));
  const merchant = h("input", { placeholder: "Merchant (optional)" });
  const note = h("textarea", { placeholder: "Notes (optional)" });

  const manualForm = h("div", {}, [
    h("div", { class: "row tight" }, [
      h("div", { class: "field" }, [h("div", { class: "label" }, ["Amount"]), amount]),
      h("div", { class: "field" }, [h("div", { class: "label" }, ["Date"]), date])
    ]),
    h("div", { class: "row tight" }, [
      h("div", { class: "field" }, [h("div", { class: "label" }, ["Category"]), category]),
      h("div", { class: "field" }, [h("div", { class: "label" }, ["Currency"]), h("input", { value: currency, disabled: true })])
    ]),
    h("div", { class: "field" }, [h("div", { class: "label" }, ["Merchant"]), merchant]),
    h("div", { class: "field" }, [h("div", { class: "label" }, ["Note"]), note]),
    h("div", { class: "btnRow" }, [
      h("button", {
        class: "btn btnPrimary",
        onClick: async () => {
          const cents = parseMoneyToCents(amount.value);
          if (cents == null || cents <= 0) return toast("Enter a valid amount.");
          await addExpense({
            amountCents: cents,
            currency,
            dateISO: date.value || new Date().toISOString().slice(0, 10),
            category: category.value,
            merchant: merchant.value,
            note: note.value,
            source: "manual"
          });
          amount.value = "";
          merchant.value = "";
          note.value = "";
          toast("Added expense");
          location.hash = "#/";
        }
      }, ["Add expense"])
    ])
  ]);

  const file = h("input", { type: "file", accept: "image/*", capture: "environment" });
  const receiptStatus = h("div", { class: "help" }, ["Take a clear photo: good light, flat, and fill the frame."]);
  const receiptThumb = h("div", { class: "thumb" }, []);
  const ocrOut = h("div", { class: "pre mono", style: "display:none;" }, [""]);
  const suggestionRow = h("div", { class: "row tight", style: "display:none;" }, []);
  const saveReceiptBtn = h("button", { class: "btn btnPrimary", disabled: true }, ["Save as expense"]);
  const onlySaveReceiptBtn = h("button", { class: "btn", disabled: true }, ["Save receipt only"]);

  /** @type {{blob:Blob, mime:string, ocrText:string, suggestedTotalCents:number|null, suggestedMerchant:string, suggestedCurrency:string}|null} */
  let ocrState = null;

  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    receiptStatus.textContent = "Preparing image…";
    ocrOut.style.display = "none";
    suggestionRow.style.display = "none";
    saveReceiptBtn.disabled = true;
    onlySaveReceiptBtn.disabled = true;

    try {
      const { blob, mime } = await compressImageToBlob(f);
      const url = URL.createObjectURL(blob);
      receiptThumb.replaceChildren(h("img", { src: url, alt: "Receipt preview" }));

      receiptStatus.textContent = "Running OCR on-device… (first time may take a bit)";
      const Tesseract = await loadTesseract();
      const settings = await getSettings();

      const result = await Tesseract.recognize(blob, "eng", {
        logger: (m) => {
          if (m?.status && typeof m.progress === "number") {
            receiptStatus.textContent = `${m.status}… ${Math.round(m.progress * 100)}%`;
          }
        }
      });
      const text = (result?.data?.text || "").trim();
      const suggestedTotalCents = extractTotalsFromOcr(text);
      const suggestedMerchant = guessMerchantFromOcr(text);
      const suggestedCurrency = currencyFromText(text, settings.currency || currency);

      ocrState = { blob, mime, ocrText: text, suggestedTotalCents, suggestedMerchant, suggestedCurrency };

      receiptStatus.textContent = "OCR complete. Review the suggestions below.";
      ocrOut.style.display = "block";
      ocrOut.textContent = text ? text.slice(0, 6000) : "(No text detected. Try retaking the photo with better lighting.)";

      // Suggested fields
      suggestionRow.style.display = "flex";
      suggestionRow.replaceChildren(
        h("div", { class: "field" }, [
          h("div", { class: "label" }, ["Suggested total"]),
          h("input", {
            id: "suggestedTotal",
            value: suggestedTotalCents != null ? (suggestedTotalCents / 100).toFixed(2) : ""
          })
        ]),
        h("div", { class: "field" }, [
          h("div", { class: "label" }, ["Suggested merchant"]),
          h("input", { id: "suggestedMerchant", value: suggestedMerchant || "" })
        ])
      );

      onlySaveReceiptBtn.disabled = false;
      saveReceiptBtn.disabled = false;
    } catch (e) {
      console.error(e);
      receiptStatus.textContent = "OCR failed. You can still save the receipt image, or add the expense manually.";
      toast("OCR failed. Try again or enter manually.");
      onlySaveReceiptBtn.disabled = false;
    }
  });

  onlySaveReceiptBtn.addEventListener("click", async () => {
    if (!ocrState) {
      const f = file.files?.[0];
      if (!f) return toast("Pick a receipt image first.");
      const { blob, mime } = await compressImageToBlob(f);
      ocrState = { blob, mime, ocrText: "", suggestedTotalCents: null, suggestedMerchant: "", suggestedCurrency: currency };
    }
    const rec = await addReceipt({
      imageBlob: ocrState.blob,
      imageMime: ocrState.mime,
      ocrText: ocrState.ocrText,
      ocrMeta: {},
      suggestedMerchant: ocrState.suggestedMerchant,
      suggestedTotalCents: ocrState.suggestedTotalCents,
      suggestedCurrency: ocrState.suggestedCurrency
    });
    toast("Saved receipt");
    location.hash = `#/receipts?open=${encodeURIComponent(rec.id)}`;
  });

  saveReceiptBtn.addEventListener("click", async () => {
    if (!ocrState) return toast("Scan a receipt first.");
    const settings = await getSettings();
    const currency = settings.currency || "USD";
    const suggestedTotal = $("#suggestedTotal")?.value ?? "";
    const suggestedMerchant = $("#suggestedMerchant")?.value ?? "";
    const cents = parseMoneyToCents(suggestedTotal);
    if (cents == null || cents <= 0) return toast("Enter or confirm the total amount.");

    const rec = await addReceipt({
      imageBlob: ocrState.blob,
      imageMime: ocrState.mime,
      ocrText: ocrState.ocrText,
      ocrMeta: {},
      suggestedMerchant,
      suggestedTotalCents: cents,
      suggestedCurrency: ocrState.suggestedCurrency || currency
    });

    await addExpense({
      amountCents: cents,
      currency: ocrState.suggestedCurrency || currency,
      dateISO: new Date().toISOString().slice(0, 10),
      category: category.value || "Uncategorized",
      merchant: suggestedMerchant,
      note: "Added from receipt OCR",
      source: "receipt",
      receiptId: rec.id
    });

    toast("Saved receipt + expense");
    location.hash = "#/";
  });

  const receiptSection = h("div", {}, [
    h("div", { class: "field" }, [
      h("div", { class: "label" }, ["Receipt photo"]),
      file,
      receiptStatus,
      h("div", { class: "help" }, ["Tip: On Android, use the camera icon and choose the rear camera."])
    ]),
    h("div", { class: "receiptPreview" }, [
      receiptThumb,
      h("div", { style: "flex:1; min-width:0;" }, [
        suggestionRow,
        ocrOut,
        h("div", { class: "btnRow" }, [onlySaveReceiptBtn, saveReceiptBtn])
      ])
    ])
  ]);

  setRoot([
    h("div", { class: "grid two" }, [
      card("Add expense", "Manual entry", manualForm),
      card("Scan receipt", "Photo → OCR → save", receiptSection)
    ])
  ]);
}

function parseQuery() {
  const q = location.hash.split("?")[1] || "";
  const p = new URLSearchParams(q);
  return p;
}

async function renderReceipts() {
  const settings = await getSettings();
  const currency = settings.currency || "USD";
  const receipts = await listReceipts({ limit: 40 });
  const q = parseQuery();
  const openId = q.get("open");

  const list = h("div", { class: "list" }, []);
  if (!receipts.length) {
    list.appendChild(emptyState("No receipts yet. Use the Add tab to take a photo and scan it."));
  } else {
    for (const r of receipts) {
      const url = URL.createObjectURL(r.imageBlob);
      list.appendChild(
        h("div", { class: "item" }, [
          h("div", { class: "itemLeft" }, [
            h("div", { class: "receiptPreview" }, [
              h("div", { class: "thumb" }, [h("img", { src: url, alt: "Receipt thumbnail" })]),
              h("div", { style: "min-width:0;" }, [
                h("div", { class: "itemTitle" }, [r.suggestedMerchant || "Receipt"]),
                h("div", { class: "itemMeta" }, [
                  h("span", { class: "pill" }, [new Date(r.createdAt).toLocaleString()]),
                  r.suggestedTotalCents != null ? h("span", { class: "pill" }, [formatMoney(r.suggestedTotalCents, r.suggestedCurrency || currency)]) : null
                ])
              ])
            ])
          ]),
          h("div", { style: "display:flex; gap:10px; align-items:center;" }, [
            h("button", { class: "btn btnSmall", onClick: () => (location.hash = `#/receipts?open=${encodeURIComponent(r.id)}`) }, ["View"]),
            h("button", {
              class: "btn btnSmall btnDanger",
              onClick: async () => {
                if (!confirm("Delete this receipt image?")) return;
                await deleteReceipt(r.id);
                toast("Deleted receipt");
                render();
              }
            }, ["Delete"])
          ])
        ])
      );
    }
  }

  const detail = h("div", {}, []);
  if (openId) {
    const r = await getReceipt(openId);
    if (!r) {
      detail.appendChild(emptyState("Receipt not found (maybe deleted)."));
    } else {
      const url = URL.createObjectURL(r.imageBlob);
      detail.appendChild(
        h("div", {}, [
          h("div", { class: "receiptPreview" }, [
            h("div", { class: "thumb", style: "width:96px; height:96px;" }, [h("img", { src: url, alt: "Receipt image" })]),
            h("div", { style: "flex:1; min-width:0;" }, [
              h("div", { class: "itemTitle" }, [r.suggestedMerchant || "Receipt details"]),
              h("div", { class: "itemMeta" }, [
                h("span", { class: "pill" }, [new Date(r.createdAt).toLocaleString()]),
                r.suggestedTotalCents != null ? h("span", { class: "pill" }, [formatMoney(r.suggestedTotalCents, r.suggestedCurrency || currency)]) : null
              ])
            ])
          ]),
          h("div", { class: "field", style: "margin-top:10px;" }, [
            h("div", { class: "label" }, ["OCR text (truncated)"]),
            h("div", { class: "pre mono" }, [r.ocrText ? r.ocrText.slice(0, 8000) : "(No OCR text saved.)"])
          ]),
          h("div", { class: "btnRow" }, [
            h("button", { class: "btn", onClick: () => (location.hash = "#/receipts") }, ["Close"])
          ])
        ])
      );
    }
  } else {
    detail.appendChild(emptyState("Tap “View” on a receipt to see OCR text and details."));
  }

  setRoot([
    h("div", { class: "grid two" }, [
      card("Receipts", "Saved receipt images", list),
      card("Receipt details", "OCR + metadata", detail)
    ])
  ]);
}

async function renderInsights() {
  const settings = await getSettings();
  const currency = settings.currency || "USD";
  const data = await computeInsights(settings);

  const suggList = h("div", { class: "list" }, []);
  if (!data.suggestions.length) {
    suggList.appendChild(emptyState("Add a few expenses first — then you’ll see suggestions here."));
  } else {
    for (const s of data.suggestions) {
      const sevClass = s.severity === "good" ? "deltaGood" : s.severity === "bad" ? "deltaBad" : "deltaWarn";
      suggList.appendChild(
        h("div", { class: "item" }, [
          h("div", { class: "itemLeft" }, [
            h("div", { class: "itemTitle" }, [s.title]),
            h("div", { class: "itemMeta" }, [
              h("span", { class: `pill ${sevClass}` }, [s.severity.toUpperCase()]),
              h("span", { class: "pill" }, ["This month"])
            ]),
            h("div", { class: "help" }, [s.detail]),
            h("div", { class: "help" }, [h("strong", {}, ["Try: "]), s.action])
          ])
        ])
      );
    }
  }

  const cat = h("div", { class: "list" }, []);
  if (!data.catTotals.length) cat.appendChild(emptyState("No category totals yet."));
  else {
    for (const c of data.catTotals) {
      cat.appendChild(
        h("div", { class: "item" }, [
          h("div", { class: "itemLeft" }, [
            h("div", { class: "itemTitle" }, [c.cat]),
            h("div", { class: "itemMeta" }, [h("span", { class: "pill" }, [`${c.n} purchases`])])
          ]),
          h("div", { class: "amt" }, [formatMoney(c.total, currency)])
        ])
      );
    }
  }

  const merchants = h("div", { class: "list" }, []);
  if (!data.merchantTotals.length) merchants.appendChild(emptyState("No merchant totals yet."));
  else {
    for (const m of data.merchantTotals) {
      merchants.appendChild(
        h("div", { class: "item" }, [
          h("div", { class: "itemLeft" }, [
            h("div", { class: "itemTitle" }, [m.merchant]),
            h("div", { class: "itemMeta" }, [h("span", { class: "pill" }, [`${m.n} purchases`])])
          ]),
          h("div", { class: "amt" }, [formatMoney(m.total, currency)])
        ])
      );
    }
  }

  setRoot([
    h("div", { class: "grid two" }, [
      card("Suggestions", "Based on your recent spending", suggList),
      h("div", { class: "grid" }, [
        card("Top categories", "Where your money goes", cat),
        card("Top merchants", "Largest spenders", merchants)
      ])
    ])
  ]);
}

async function renderSettings() {
  const settings = await getSettings();
  const currency = h("select", {}, ["USD", "EUR", "GBP", "CAD", "AUD"].map((c) => h("option", { value: c, selected: settings.currency === c }, [c])));
  const budget = h("input", { inputmode: "decimal", placeholder: "0.00", value: settings.monthlyBudgetCents ? (settings.monthlyBudgetCents / 100).toFixed(2) : "" });

  const exportBtn = h("button", { class: "btn" }, ["Export CSV"]);
  exportBtn.addEventListener("click", async () => {
    const items = await listExpenses({ limit: 5000 });
    const rows = [
      ["id", "date", "amount", "currency", "category", "merchant", "note", "source", "receiptId"].join(",")
    ];
    for (const e of items.slice().reverse()) {
      const amount = (e.amountCents / 100).toFixed(2);
      const cols = [
        e.id,
        e.dateISO,
        amount,
        e.currency,
        (e.category || "").replaceAll('"', '""'),
        (e.merchant || "").replaceAll('"', '""'),
        (e.note || "").replaceAll('"', '""'),
        e.source,
        e.receiptId || ""
      ].map((c) => `"${String(c)}"`);
      rows.push(cols.join(","));
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `budget-buddy-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    toast("Exported CSV");
  });

  const clearBtn = h("button", { class: "btn btnDanger" }, ["Delete all data"]);
  clearBtn.addEventListener("click", async () => {
    const ok = confirm("This will permanently delete all expenses and receipts stored on this device. Continue?");
    if (!ok) return;
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase("budget_buddy_db_v1");
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
      req.onblocked = resolve;
    });
    toast("Deleted local data");
    location.hash = "#/";
    setTimeout(() => location.reload(), 250);
  });

  const saveBtn = h("button", { class: "btn btnPrimary" }, ["Save settings"]);
  saveBtn.addEventListener("click", async () => {
    const cents = parseMoneyToCents(budget.value);
    await saveSettings({
      ...settings,
      currency: currency.value,
      monthlyBudgetCents: cents != null && cents > 0 ? cents : 0
    });
    toast("Saved settings");
    render();
  });

  setRoot([
    h("div", { class: "grid two" }, [
      card("Settings", "Personalize budgeting", h("div", {}, [
        h("div", { class: "row tight" }, [
          h("div", { class: "field" }, [h("div", { class: "label" }, ["Currency"]), currency]),
          h("div", { class: "field" }, [h("div", { class: "label" }, ["Monthly budget"]), budget])
        ]),
        h("div", { class: "btnRow" }, [saveBtn])
      ])),
      card("Data", "Export or reset", h("div", {}, [
        h("div", { class: "help" }, ["All data is stored locally on your device (offline-first). Use export for backups."]),
        h("div", { class: "btnRow" }, [exportBtn, clearBtn])
      ]))
    ])
  ]);
}

async function render() {
  const path = routePath();
  setActiveTab(path);
  if (path === "/") return renderDashboard();
  if (path === "/add") return renderAdd();
  if (path === "/receipts") return renderReceipts();
  if (path === "/insights") return renderInsights();
  if (path === "/settings") return renderSettings();
  return renderDashboard();
}

window.addEventListener("hashchange", () => render());

await ensureServiceWorker();
render();

