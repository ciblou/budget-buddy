const DB_NAME = "budget_buddy_db_v1";
const DB_VERSION = 1;

/**
 * @typedef {Object} Expense
 * @property {string} id
 * @property {number} amountCents
 * @property {string} currency
 * @property {string} dateISO
 * @property {string} category
 * @property {string} merchant
 * @property {string} note
 * @property {"manual"|"receipt"} source
 * @property {string|null} receiptId
 * @property {number} createdAt
 */

/**
 * @typedef {Object} Receipt
 * @property {string} id
 * @property {string} imageMime
 * @property {Blob} imageBlob
 * @property {string} ocrText
 * @property {Object} ocrMeta
 * @property {string|null} suggestedMerchant
 * @property {number|null} suggestedTotalCents
 * @property {string|null} suggestedCurrency
 * @property {number} createdAt
 */

/**
 * @typedef {Object} Settings
 * @property {string} currency
 * @property {number} monthlyBudgetCents
 * @property {Object.<string, string>} categoryRules
 */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const expenses = db.createObjectStore("expenses", { keyPath: "id" });
      expenses.createIndex("by_date", "dateISO");
      expenses.createIndex("by_created", "createdAt");
      expenses.createIndex("by_category", "category");
      expenses.createIndex("by_merchant", "merchant");

      const receipts = db.createObjectStore("receipts", { keyPath: "id" });
      receipts.createIndex("by_created", "createdAt");

      db.createObjectStore("settings", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const res = fn(store, tx);
    tx.oncomplete = () => resolve(res);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  }).finally(() => db.close());
}

function uuid() {
  // Good enough for local-only ids.
  return (crypto?.randomUUID?.() ?? `id_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

export function formatMoney(cents, currency) {
  const value = (cents || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function parseMoneyToCents(text) {
  // Accept "12.34" or "12,34" or "$12.34"
  const s = String(text ?? "").trim();
  const cleaned = s.replace(/[^\d.,-]/g, "");
  if (!cleaned) return null;
  const neg = cleaned.includes("-") ? -1 : 1;
  const normalized = cleaned.replace(/-/g, "");
  // If it contains both comma and dot, assume the last one is decimal sep.
  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  let decSep = null;
  if (lastComma !== -1 || lastDot !== -1) decSep = lastComma > lastDot ? "," : ".";
  let intPart = normalized;
  let fracPart = "";
  if (decSep) {
    const parts = normalized.split(decSep);
    intPart = parts.slice(0, -1).join(decSep).replace(/[.,]/g, "");
    fracPart = parts[parts.length - 1].replace(/[^\d]/g, "");
  } else {
    intPart = normalized.replace(/[^\d]/g, "");
  }
  if (!intPart) return null;
  const frac2 = (fracPart + "00").slice(0, 2);
  return neg * (Number(intPart) * 100 + Number(frac2));
}

export async function getSettings() {
  /** @type {Settings} */
  const defaults = {
    currency: "USD",
    monthlyBudgetCents: 0,
    categoryRules: {}
  };
  const stored = await withStore("settings", "readonly", (s) => {
    return new Promise((resolve) => {
      const req = s.get("settings");
      req.onsuccess = () => resolve(req.result?.value ?? null);
      req.onerror = () => resolve(null);
    });
  });
  return { ...defaults, ...(stored || {}) };
}

export async function saveSettings(settings) {
  return withStore("settings", "readwrite", (s) => s.put({ key: "settings", value: settings }));
}

export async function addExpense(partial) {
  /** @type {Expense} */
  const exp = {
    id: uuid(),
    amountCents: partial.amountCents ?? 0,
    currency: partial.currency ?? "USD",
    dateISO: partial.dateISO ?? new Date().toISOString().slice(0, 10),
    category: partial.category ?? "Uncategorized",
    merchant: (partial.merchant ?? "").trim(),
    note: (partial.note ?? "").trim(),
    source: partial.source ?? "manual",
    receiptId: partial.receiptId ?? null,
    createdAt: Date.now()
  };
  await withStore("expenses", "readwrite", (s) => s.add(exp));
  return exp;
}

export async function deleteExpense(id) {
  await withStore("expenses", "readwrite", (s) => s.delete(id));
}

export async function listExpenses({ limit = 50 } = {}) {
  return withStore("expenses", "readonly", (s) => {
    const idx = s.index("by_created");
    return new Promise((resolve, reject) => {
      /** @type {Expense[]} */
      const out = [];
      const req = idx.openCursor(null, "prev");
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || out.length >= limit) return resolve(out);
        out.push(cur.value);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  });
}

export async function listExpensesInRange(startISO, endISO) {
  return withStore("expenses", "readonly", (s) => {
    const idx = s.index("by_date");
    const range = IDBKeyRange.bound(startISO, endISO);
    return new Promise((resolve, reject) => {
      /** @type {Expense[]} */
      const out = [];
      const req = idx.openCursor(range, "next");
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve(out);
        out.push(cur.value);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  });
}

export async function addReceipt({ imageBlob, imageMime, ocrText, ocrMeta, suggestedMerchant, suggestedTotalCents, suggestedCurrency }) {
  /** @type {Receipt} */
  const rec = {
    id: uuid(),
    imageMime,
    imageBlob,
    ocrText: ocrText ?? "",
    ocrMeta: ocrMeta ?? {},
    suggestedMerchant: suggestedMerchant ?? null,
    suggestedTotalCents: suggestedTotalCents ?? null,
    suggestedCurrency: suggestedCurrency ?? null,
    createdAt: Date.now()
  };
  await withStore("receipts", "readwrite", (s) => s.add(rec));
  return rec;
}

export async function getReceipt(id) {
  return withStore("receipts", "readonly", (s) => {
    return new Promise((resolve) => {
      const req = s.get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  });
}

export async function listReceipts({ limit = 30 } = {}) {
  return withStore("receipts", "readonly", (s) => {
    const idx = s.index("by_created");
    return new Promise((resolve, reject) => {
      /** @type {Receipt[]} */
      const out = [];
      const req = idx.openCursor(null, "prev");
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || out.length >= limit) return resolve(out);
        out.push(cur.value);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  });
}

export async function deleteReceipt(id) {
  await withStore("receipts", "readwrite", (s) => s.delete(id));
}

export function ymd(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

export function monthRangeISO(date = new Date()) {
  const d = new Date(date);
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return [ymd(start), ymd(end)];
}

