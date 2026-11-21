const PEOPLE = [
  { name: "Chase", short: "C", color: "var(--person-1)" },
  { name: "Michaelah", short: "M", color: "var(--person-2)" },
  { name: "Emily", short: "E", color: "var(--person-3)" },
];

const THIRD = 100 / 3;

const SPLIT_PRESETS = [
  { label: "Everyone", short: "Everyone", percents: [THIRD, THIRD, THIRD] },
  { label: "Chase", short: "Chase", percents: [100, 0, 0] },
  { label: "Michaelah", short: "Michaelah", percents: [0, 100, 0] },
  { label: "Emily", short: "Emily", percents: [0, 0, 100] },
  { label: "Chase + Michaelah", short: "C + M", percents: [50, 50, 0] },
  { label: "Chase + Emily", short: "C + E", percents: [50, 0, 50] },
  { label: "Michaelah + Emily", short: "M + E", percents: [0, 50, 50] },
];

const TAX_FLAGS = { D: 0, J: 13, Z: 5 };
const TAX_RATES = [0, 13, 5];

const RECEIPT_PROMPT = `You are reading a photo of a store receipt. Extract every purchased line item.
Return ONLY a JSON object, no other text, in exactly this shape:
{"store":"<store name, or empty string>","items":[{"name":"<item text as printed>","code":"<product number printed on that line, digits only, or empty string>","price":<number>,"flag":"<the single tax letter printed right after the price, or empty string>"}],"subtotal":<pre-tax subtotal as a number, or null>,"tax":<total tax charged as a number, or null>}
Rules:
- code is the UPC / product / item number printed on the same line as the item (often 8-13 digits before or after the name). Copy every digit exactly; use "" if there is none.
- price is the final amount charged for that line, as a plain number without $ (e.g. 4.96).
- If a line has a discount, coupon or instant savings, subtract it from that item's price. If you can't tell which item it belongs to, add it as its own item with a negative price.
- Weighed items: keep the weight detail in the name, e.g. "BANANAS (1.470 kg @ $1.50/kg)".
- An item printed on two separate lines appears twice. If one line shows a quantity (e.g. "2 @ 3.97"), give one item with the line total and keep the quantity in the name.
- Include deposits and eco/environmental fees as items.
- flag is the single capital letter printed just after the price on that line (for example D, J or Z). Copy it exactly and use "" if there is none. Never include it in the name or price.
- tax is the total tax charged on the receipt. If there are several tax lines (HST, GST, PST, QST), add them together. Use null if no tax is printed. Read it from the tax line itself; do not calculate it.
- Do NOT include subtotal, tax (HST/GST/PST), total, payment, change, points or savings-summary lines as items.
- If part of the receipt is unreadable, include only what you can read.`;

const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"];

const STORAGE_KEYS = {
  state: "roommate-split-app-v1",
  settings: "roommate-gemini-v1",
  products: "off-cache-v2",
};

function readStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function emptyState() {
  return { step: 1, receipts: [], cur: 0, paid: ["", "", ""], paidBy: {} };
}

function loadState() {
  const saved = readStorage(STORAGE_KEYS.state, null);
  if (!saved || !Array.isArray(saved.receipts)) return emptyState();
  saved.paidBy = saved.paidBy || {};
  delete saved.tax;
  saved.receipts.forEach((receipt) => {
    receipt.tax = receipt.tax == null || receipt.tax === "" ? null : toNumber(receipt.tax);
    receipt.items.forEach((item) => {
      if (item.offs === "pending") delete item.offs;
    });
  });
  return saved;
}

let state = loadState();
let settings = { key: "", ...readStorage(STORAGE_KEYS.settings, {}) };
let productCache = readStorage(STORAGE_KEYS.products, {});
try {
  localStorage.removeItem("off-cache-v1");
} catch {}

let lastId = Math.max(0, ...state.receipts.flatMap((receipt) => [receipt.id, ...receipt.items.map((item) => item.id)]));
const newId = () => ++lastId;

const saveState = () => writeStorage(STORAGE_KEYS.state, state);
const saveSettings = () => writeStorage(STORAGE_KEYS.settings, settings);
const saveProductCache = () => writeStorage(STORAGE_KEYS.products, productCache);

const byId = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function toNumber(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

const toCents = (value) => Math.round(toNumber(value) * 100);

function formatMoney(cents) {
  return (cents < 0 ? "-" : "") + "$" + (Math.abs(cents) / 100).toFixed(2);
}

function formatPercent(percent) {
  const rounded = Math.round(percent * 100) / 100;
  return (Math.abs(rounded - THIRD) < 0.01 ? "33.3" : String(rounded)) + "%";
}

function escapeHtml(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return String(value ?? "").replace(/[&<>"]/g, (c) => entities[c]);
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function allItems() {
  return state.receipts.flatMap((receipt) => receipt.items.map((item) => ({ ...item, receipt })));
}

function findItem(id) {
  for (const receipt of state.receipts) {
    const item = receipt.items.find((i) => i.id == id);
    if (item) return [receipt, item];
  }
  return [];
}

function sameSplit(a, b) {
  return a && b && a.every((value, i) => Math.abs(value - b[i]) < 0.01);
}

function presetIndex(percents) {
  return SPLIT_PRESETS.findIndex((preset) => sameSplit(preset.percents, percents));
}

const receiptSubtotal = (receipt) => receipt.items.reduce((sum, item) => sum + toCents(item.price), 0);
const itemRate = (item) => toNumber(item.taxRate);

function itemsTax(items) {
  const taxable = {};
  for (const item of items) {
    const rate = itemRate(item);
    if (rate > 0) taxable[rate] = (taxable[rate] || 0) + toCents(item.price);
  }
  return Object.entries(taxable).reduce((sum, [rate, cents]) => sum + Math.round((cents * rate) / 100), 0);
}

const receiptTax = (receipt) => itemsTax(receipt.items);
const receiptTotal = (receipt) => receiptSubtotal(receipt) + receiptTax(receipt);

function distribute(total, exact) {
  const shares = exact.map(Math.floor);
  const order = exact.map((_, i) => i).sort((a, b) => exact[b] - shares[b] - (exact[a] - shares[a]));
  let diff = total - shares.reduce((a, b) => a + b, 0);
  for (let k = 0; diff !== 0 && k < 1000; k++) {
    if (diff > 0) {
      shares[order[k % order.length]]++;
      diff--;
    } else {
      shares[order[order.length - 1 - (k % order.length)]]--;
      diff++;
    }
  }
  return shares;
}

function itemTaxCents(receipt) {
  const groups = {};
  for (const item of receipt.items) {
    const rate = itemRate(item);
    if (rate > 0) (groups[rate] ||= []).push(item);
  }
  const result = {};
  for (const [rate, items] of Object.entries(groups)) {
    const exact = items.map((item) => (toCents(item.price) * rate) / 100);
    const total = Math.round(exact.reduce((a, b) => a + b, 0));
    distribute(total, exact).forEach((cents, k) => (result[items[k].id] = cents));
  }
  return result;
}

function itemTax(item) {
  const [receipt] = findItem(item.id);
  return receipt ? itemTaxCents(receipt)[item.id] || 0 : 0;
}

const slipTaxHtml = (item) => {
  const tax = itemTax(item);
  return tax > 0 ? `<span class="slip-tax">+${formatMoney(tax)} tax</span>` : "";
};

function splitCents(cents, percents) {
  if (!percents) return [0, 0, 0];
  const exact = percents.map((p) => (cents * p) / 100);
  const shares = exact.map(Math.floor);
  let leftover = cents - shares.reduce((a, b) => a + b, 0);
  const order = [0, 1, 2].sort((a, b) => exact[b] - shares[b] - (exact[a] - shares[a]));
  for (let k = 0; leftover > 0; k = (k + 1) % 3, leftover--) shares[order[k]]++;
  return shares;
}

function totals() {
  const subtotal = [0, 0, 0];
  const exactTax = [0, 0, 0];
  let itemsTotal = 0;
  let unsplitTotal = 0;
  let unsplitCount = 0;

  for (const item of allItems()) {
    const price = toCents(item.price);
    itemsTotal += price;
    if (!item.pct) {
      unsplitTotal += price;
      unsplitCount++;
      continue;
    }
    splitCents(price, item.pct).forEach((share, i) => {
      subtotal[i] += share;
      exactTax[i] += (share * itemRate(item)) / 100;
    });
  }

  const taxTotal = state.receipts.reduce((sum, receipt) => sum + receiptTax(receipt), 0);
  const splitTax = state.receipts.reduce((sum, receipt) => sum + itemsTax(receipt.items.filter((i) => i.pct)), 0);
  const tax = distribute(splitTax, exactTax);
  const owes = subtotal.map((v, i) => v + tax[i]);
  const paid = state.paid.map(toCents);
  const balance = paid.map((p, i) => p - owes[i]);

  return {
    subtotal,
    tax,
    owes,
    paid,
    balance,
    itemsTotal,
    taxTotal,
    total: itemsTotal + taxTotal,
    unsplitTotal,
    unsplitCount,
  };
}

function settleUp(balance) {
  const creditors = balance.map((b, i) => [i, b]).filter(([, b]) => b > 0);
  const debtors = balance.map((b, i) => [i, -b]).filter(([, b]) => b > 0);
  const transfers = [];
  let c = 0;
  let d = 0;
  while (c < creditors.length && d < debtors.length) {
    const amount = Math.min(creditors[c][1], debtors[d][1]);
    if (amount > 0) transfers.push({ from: debtors[d][0], to: creditors[c][0], amount });
    creditors[c][1] -= amount;
    debtors[d][1] -= amount;
    if (creditors[c][1] <= 0) c++;
    if (debtors[d][1] <= 0) d++;
  }
  return transfers;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Couldn't read the photo"));
    reader.readAsDataURL(blob);
  });
}

class ReadError extends Error {
  constructor(message, code, hint = "") {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

function failureFor(status, message) {
  if (status === 429) return new ReadError("Free limit reached", "rate_limited", "Wait a minute, then retry.");
  if (status === 503 || /high demand|overloaded|unavailable/i.test(message)) {
    return new ReadError("Google is busy", "busy", "Try again in a minute.");
  }
  if (status === 404) return new ReadError("Model unavailable", "unavailable", "Try again later.");
  if (status >= 500) return new ReadError("Google had a problem", "busy", "Try again in a minute.");
  return new ReadError("Google returned an error", undefined, message.slice(0, 140) || `Error ${status}`);
}

async function readReceiptWithGemini(image) {
  const body = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          { text: RECEIPT_PROMPT },
          { inline_data: { mime_type: image.type || "image/jpeg", data: await blobToBase64(image) } },
        ],
      },
    ],
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  });

  let lastError = new ReadError("No answer from Google", undefined, "Try again.");
  let rateLimited = false;
  let busy = false;

  for (const model of GEMINI_MODELS) {
    let response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": settings.key },
        body,
      });
    } catch {
      throw new ReadError("Can't reach Google", "offline", "Check your connection.");
    }

    const json = await response.json().catch(() => null);
    const errorMessage = json?.error?.message ?? "";

    if (response.ok) {
      const text = (json?.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
      if (text) return text;
      lastError = json?.promptFeedback?.blockReason
        ? new ReadError("Google blocked this photo", undefined, "Try a clearer photo.")
        : new ReadError("No answer from Google", undefined, "Try again.");
      continue;
    }

    const badKey =
      response.status === 401 || response.status === 403 || (response.status === 400 && /api key/i.test(errorMessage));
    if (badKey) throw new ReadError("Key rejected", "bad_key", "Check your Gemini key.");

    const failure = failureFor(response.status, errorMessage);
    if (failure.code === "rate_limited") rateLimited = true;
    else if (failure.code === "busy") busy = true;
    else if (failure.code === undefined) throw failure;
    lastError = failure;
  }

  if (rateLimited) throw failureFor(429, "");
  if (busy) throw failureFor(503, "");
  throw lastError;
}

function parseReceipt(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const unreadable = new ReadError("Couldn't read Google's answer", undefined, "Try again.");
  if (start < 0 || end < start) throw unreadable;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw unreadable;
  }
}

async function shrinkImage(file, maxSide = 1400) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob || file), "image/jpeg", 0.72));
  } catch {
    return file;
  }
}

async function makeThumbnail(file, width = 208, height = 224) {
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const scale = Math.max(width / bitmap.width, height / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    canvas.getContext("2d").drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
    return canvas.toDataURL("image/png");
  } catch {
    return URL.createObjectURL(file);
  }
}

let photos = [];
let reading = false;

const canReadPhotos = () => Boolean(settings.key);

function addPhotos(files) {
  const images = [...files].filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
  for (const file of images) {
    const photo = { id: newId(), file, url: "", status: "new" };
    photos.push(photo);
    makeThumbnail(file).then((url) => {
      photo.url = url;
      if (state.step === 1) render();
    });
  }
  render();
}

async function readPhoto(photo) {
  photo.status = "reading";
  photo.message = "";
  photo.hint = "";
  render();

  try {
    const receipt = parseReceipt(await readReceiptWithGemini(await shrinkImage(photo.file)));
    const items = (Array.isArray(receipt.items) ? receipt.items : []).map((item) => ({
      id: newId(),
      name: String(item.name || "Item").trim(),
      code: String(item.code ?? "").replace(/\D/g, ""),
      price: (Math.round(toNumber(item.price) * 100) / 100).toFixed(2),
      taxRate:
        TAX_FLAGS[
          String(item.flag ?? "")
            .trim()
            .toUpperCase()
        ] ?? 0,
      pct: null,
    }));
    if (!items.length) {
      throw new ReadError("No items found", undefined, "Get the whole receipt in frame.");
    }

    const added = {
      id: newId(),
      name: String(receipt.store || "").trim() || `Receipt ${state.receipts.length + 1}`,
      items,
      subtotal: receipt.subtotal == null || receipt.subtotal === "" ? null : toNumber(receipt.subtotal),
      tax: receipt.tax == null || receipt.tax === "" ? null : toNumber(receipt.tax),
    };
    state.receipts.push(added);
    photo.status = "done";
    photo.receiptId = added.id;
    saveState();
    queueProductLookups();
  } catch (error) {
    const failure =
      error instanceof ReadError
        ? error
        : new ReadError("Couldn't read this receipt", undefined, "Try again or enter it by hand.");
    photo.status = "error";
    photo.message = failure.message;
    photo.hint = failure.hint;
    render();
    return failure.code;
  }
  render();
}

async function readAllPhotos() {
  if (reading || !canReadPhotos()) return;
  reading = true;
  for (const photo of photos.filter((p) => p.status === "new" || p.status === "error")) {
    const code = await readPhoto(photo);
    if (["rate_limited", "busy", "offline", "bad_key"].includes(code)) break;
  }
  reading = false;
  render();
}

const PRODUCT_FIELDS =
  "code,product_name,product_name_en,generic_name,brands,quantity,image_front_small_url,image_small_url";

function checkDigit(digits) {
  let sum = 0;
  for (let i = digits.length - 1, weight = 3; i >= 0; i--, weight = 4 - weight) sum += Number(digits[i]) * weight;
  return (10 - (sum % 10)) % 10;
}

const isValidBarcode = (code) => code.length >= 8 && checkDigit(code.slice(0, -1)) === Number(code.slice(-1));

function barcodeCandidates(code) {
  if (code.length === 14 && code[0] === "0") code = code.slice(1);
  const out = [];
  const add = (c) => c && !out.includes(c) && out.push(c);
  if (isValidBarcode(code)) {
    add(code);
    if (code.length < 13) add(code.padStart(13, "0"));
  } else if (code.length === 11) {
    add(code + checkDigit(code));
  } else {
    const body = code.slice(0, -1);
    add(body + checkDigit(body));
  }
  return out.slice(0, 3);
}

const stripLeadingZeros = (code) => String(code || "").replace(/^0+/, "");

function safeImageUrl(url) {
  return typeof url === "string" && /^https:\/\/(images|static)\.openfoodfacts\.org\//.test(url) ? url : "";
}

function toProduct(raw, code) {
  const name = String(raw.product_name_en || raw.product_name || raw.generic_name || "").trim();
  const image = safeImageUrl(raw.image_front_small_url || raw.image_small_url);
  if (!name && !image) return null;
  return {
    name: name.slice(0, 80),
    brand: String(raw.brands || "")
      .split(",")[0]
      .trim()
      .slice(0, 40),
    qty: String(raw.quantity || "").slice(0, 20),
    img: image,
    code: String(code),
  };
}

const lookup = {
  busy: false,
  waitUntil: 0,
  timer: null,
  failures: 0,
  rateLimits: 0,
  lastSearchAt: 0,
  message: "",
};

function setLookupMessage(message) {
  lookup.message = message;
  const el = byId("lookup-status");
  if (el) el.textContent = message;
}

function setProduct(item, product) {
  item.off = product;
  item.offs = "found";
  productCache[item.code] = product;
  updateProductViews(item);
}

function setNoProduct(item) {
  delete item.off;
  item.offs = "none";
  productCache[item.code] = 0;
  updateProductViews(item);
}

const hasLookupCode = (item) => item.code && item.code.length >= 8;

function itemsNeedingLookup() {
  return state.receipts
    .flatMap((receipt) => receipt.items)
    .filter((item) => hasLookupCode(item) && (!item.offs || item.offs === "pending"));
}

function queueProductLookups() {
  for (const receipt of state.receipts) {
    for (const item of receipt.items) {
      if (!hasLookupCode(item)) continue;
      if (productCache[item.code] === undefined) {
        if (item.offs === "none") delete item.offs;
        continue;
      }
      if (item.offs) continue;
      if (productCache[item.code]) setProduct(item, productCache[item.code]);
      else setNoProduct(item);
    }
  }
  saveState();
  runLookups();
}

function pauseLookups(seconds, reason) {
  lookup.waitUntil = Date.now() + seconds * 1000;
  for (const item of itemsNeedingLookup()) {
    if (item.offs === "pending") {
      delete item.offs;
      updateProductViews(item);
    }
  }
  clearInterval(lookup.timer);
  lookup.timer = setInterval(() => {
    const left = Math.ceil((lookup.waitUntil - Date.now()) / 1000);
    if (left > 0) return setLookupMessage(`${reason}, trying again in ${left}s`);
    clearInterval(lookup.timer);
    lookup.timer = null;
    runLookups();
  }, 1000);
}

async function fetchProducts(url) {
  try {
    const response = await fetch(url);
    lookup.failures = 0;
    return response;
  } catch {
    lookup.failures++;
    const offlineHint =
      location.protocol === "file:"
        ? " (if you opened this file from Files or a download preview, open it in Safari or Chrome instead)"
        : "";
    pauseLookups(
      Math.min(300, 15 * 2 ** (lookup.failures - 1)),
      lookup.failures >= 3 ? `Can't reach Open Food Facts${offlineHint}` : "Open Food Facts didn't answer",
    );
    return null;
  }
}

async function runLookups() {
  if (lookup.busy || lookup.waitUntil > Date.now()) return;
  const batch = itemsNeedingLookup().slice(0, 30);
  if (!batch.length) return setLookupMessage("");

  lookup.busy = true;
  try {
    batch.forEach((item) => {
      item.offs = "pending";
      updateProductViews(item);
    });

    const itemsByCode = {};
    const codes = new Set();
    for (const item of batch) {
      for (const candidate of barcodeCandidates(item.code)) {
        codes.add(candidate);
        if (candidate.length < 13) codes.add(candidate.padStart(13, "0"));
        const key = stripLeadingZeros(candidate);
        (itemsByCode[key] ||= []).push(item);
      }
    }

    const wait = 7000 - (Date.now() - lookup.lastSearchAt);
    if (wait > 0) {
      setLookupMessage("Waiting to look up products");
      await sleep(wait);
    }
    setLookupMessage(`Looking up ${plural(batch.length, "product")} on Open Food Facts`);
    lookup.lastSearchAt = Date.now();

    const response = await fetchProducts(
      `https://world.openfoodfacts.org/api/v2/search?code=${[...codes].join(",")}&fields=${PRODUCT_FIELDS}&page_size=100`,
    );
    if (!response) return;

    if (response.status === 429 || response.status === 503) {
      const retryAfter = parseInt(response.headers.get("Retry-After"), 10);
      lookup.rateLimits++;
      const backoff = 30 * 2 ** (lookup.rateLimits - 1);
      pauseLookups(
        Math.min(300, Math.max(retryAfter > 0 ? retryAfter : 60, backoff)),
        "Open Food Facts asked us to slow down",
      );
      return;
    }
    lookup.rateLimits = 0;

    const json = response.ok ? await response.json().catch(() => null) : null;
    if (!json) {
      batch.forEach((item) => {
        if (item.offs === "pending") {
          delete item.offs;
          updateProductViews(item);
        }
      });
      setLookupMessage("Product lookup failed. Edit a code to try again");
      return;
    }

    for (const raw of json.products ?? []) {
      const product = toProduct(raw, raw.code);
      if (!product) continue;
      for (const item of itemsByCode[stripLeadingZeros(raw.code)] ?? []) {
        if (item.offs === "pending") setProduct(item, product);
      }
    }
    batch.forEach((item) => item.offs === "pending" && setNoProduct(item));
    saveState();
    saveProductCache();
  } finally {
    lookup.busy = false;
  }

  if (itemsNeedingLookup().some((item) => !item.offs)) runLookups();
  else setLookupMessage("");
}

const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  left: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  right: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  camera:
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  barcode: '<path d="M3 5v14"/><path d="M8 5v14"/><path d="M12 5v14"/><path d="M17 5v14"/><path d="M21 5v14"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  found: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  missing: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6"/><path d="m15 9-6 6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  sparkle: '<path d="M12 3c.5 4.6 4.4 8.5 9 9-4.6.5-8.5 4.4-9 9-.5-4.6-4.4-8.5-9-9 4.6-.5 8.5-4.4 9-9z"/>',
};

function icon(name, size = 16) {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

const avatar = (i, size = "") =>
  `<span class="avatar ${size}" style="background:${PEOPLE[i].color}" aria-hidden="true">${PEOPLE[i].short}</span>`;

function avatarStack(percents) {
  const people = percents.map((p, i) => (p > 0 ? i : -1)).filter((i) => i >= 0);
  return `<span class="avatars">${people.map((i) => avatar(i)).join("")}</span>`;
}

const personDot = (i) => `<span class="dot" style="background:${PEOPLE[i].color}"></span>`;

function shareBar(weights, size = "") {
  const total = weights ? weights.reduce((sum, w) => sum + Math.max(0, w), 0) : 0;
  if (!total) return `<span class="share-bar empty ${size}"></span>`;
  const segments = weights
    .map((w, i) => (w > 0 ? `<i style="flex:${w};background:${PEOPLE[i].color}"></i>` : ""))
    .join("");
  return `<span class="share-bar ${size}">${segments}</span>`;
}

const notice = (text) => `<p class="notice">${icon("alert")}<span>${text}</span></p>`;

function productImage(url, size, fit = "cover", fallback = "") {
  const style = `width:${size * 2}px;height:${size * 2}px`;
  if (!url) return `<span class="product-image placeholder" style="${style}"></span>`;
  return `<canvas class="product-image loading" width="${size * 4}" height="${size * 4}" data-img="${escapeHtml(url)}" data-fit="${fit}"${fallback && fallback !== url ? ` data-fallback="${escapeHtml(fallback)}"` : ""} style="${style}"></canvas>`;
}

const largeImage = (url) => url.replace(/\.(100|200)\.jpg$/, ".400.jpg");

function productHtml(item, mode) {
  const product = item.off;
  const detail = product ? [product.brand, product.qty].filter(Boolean).join(" · ") : "";
  const name = escapeHtml(product?.name || "Unnamed product");

  if (mode === "row") {
    if (item.offs === "pending") return '<span class="spinner" title="Looking up"></span>';
    if (product) return `<span class="lookup found" title="${name}">${icon("found", 16)}</span>`;
    if (item.offs === "none")
      return `<span class="lookup missing" title="Not in Open Food Facts">${icon("missing", 16)}</span>`;
    return "";
  }

  if (mode === "slip") {
    const price = formatMoney(toCents(item.price));
    if (product) {
      return `<div class="slip-hero">
        ${productImage(product.img ? largeImage(product.img) : "", 56, "contain", product.img)}
        <div class="slip-hero-text">
          <div class="slip-hero-name">${name}</div>
          ${detail ? `<div class="slip-hero-detail">${escapeHtml(detail)}</div>` : ""}
          <div class="slip-hero-price"><span>${price}</span>${slipTaxHtml(item)}</div>
        </div>
      </div>`;
    }
    return `<div class="slip-line"><span class="slip-name">${escapeHtml(item.name)}</span>${slipTaxHtml(item)}<span class="slip-price">${price}</span></div>
      ${item.code ? `<div class="slip-code">${escapeHtml(item.code)}</div>` : ""}
      ${item.offs === "pending" ? '<div class="slip-looking"><span class="spinner"></span>Looking up product</div>' : ""}`;
  }
}

function updateProductViews(item) {
  document.querySelectorAll(`[data-product="${item.id}"]`).forEach((el) => {
    el.innerHTML = productHtml(item, el.dataset.mode);
  });
  drawProductImages();
}

const loadedImages = {};

function drawProductImages() {
  document.querySelectorAll("canvas.product-image[data-img]:not([data-drawn])").forEach((canvas) => {
    canvas.dataset.drawn = "1";
    const url = canvas.dataset.img;

    const draw = (img) => {
      const size = canvas.width;
      const ctx = canvas.getContext("2d");
      const fit = canvas.dataset.fit === "contain" ? Math.min : Math.max;
      const scale = fit(size / img.naturalWidth, size / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      canvas.classList.remove("loading");
    };

    let entry = loadedImages[url];
    if (!entry) {
      entry = loadedImages[url] = { img: new Image(), ready: false, waiting: [] };
      entry.img.onload = () => {
        entry.ready = true;
        entry.waiting.forEach((fn) => fn());
        entry.waiting = [];
      };
      entry.img.onerror = () => {
        entry.failed = true;
        entry.waiting.forEach((fn) => fn());
        entry.waiting = [];
      };
      entry.img.src = url;
    }
    const finish = () => {
      if (!entry.failed) return draw(entry.img);
      if (canvas.dataset.fallback) {
        canvas.dataset.img = canvas.dataset.fallback;
        delete canvas.dataset.fallback;
        delete canvas.dataset.drawn;
        return drawProductImages();
      }
      canvas.classList.replace("loading", "failed");
    };
    if (entry.ready || entry.failed) finish();
    else entry.waiting.push(() => canvas.isConnected && finish());
  });
}

const STEP_TITLES = { 1: "Bill Splitter", 2: "Split items", 3: "Who paid", 4: "Summary" };

function renderHeader() {
  const back = byId("back");
  back.innerHTML = icon("left", 20);
  back.dataset.go = Math.max(1, state.step - 1);
  back.classList.toggle("hidden", state.step === 1);
  byId("title").textContent = STEP_TITLES[state.step] || STEP_TITLES[1];
  byId("header-action").innerHTML =
    state.step === 4
      ? `<button class="icon-button" id="copy-summary" aria-label="Copy summary" title="Copy summary">${icon("copy", 20)}</button>`
      : "";
}

function render() {
  const views = { 1: receiptsView, 2: splitView, 3: paidView, 4: summaryView };
  renderHeader();
  byId("main").innerHTML = (views[state.step] || receiptsView)();
  drawProductImages();
  if (state.step === 2 && split.customOpen) updateCustomSplit();
}

function goToStep(step) {
  cancelAdvance();
  state.step = step;
  saveState();
  render();
  window.scrollTo(0, 0);
}

function receiptFooter(receipt) {
  const subtotal = receiptSubtotal(receipt);
  const tax = receiptTax(receipt);

  const line = (label, cents, printed, extra = "") => {
    const checked = printed != null;
    const wrong = checked && Math.abs(cents - printed) > 1;
    return `<div class="total-line${extra}"><span>${label}</span><b class="num${wrong ? " bad" : ""}">${formatMoney(cents)}</b><span class="total-status">${checked && !wrong ? '<span class="ok"></span>' : ""}</span></div>${wrong ? `<div class="total-note bad">Receipt says ${formatMoney(printed)}</div>` : ""}`;
  };

  const printedSubtotal = receipt.subtotal == null ? null : Math.round(receipt.subtotal * 100);
  const printedTax = receipt.tax == null ? null : toCents(receipt.tax);

  return `<div class="total-lines">
      ${line("Subtotal", subtotal, printedSubtotal)}
      ${line("Tax", tax, printedTax, " tax")}
      ${line("Total", subtotal + tax, null, " sum")}
    </div>
    <div class="footer-actions"><span class="muted">${plural(receipt.items.length, "item")}</span><span class="spacer"></span><button class="dashed" data-add-item="${receipt.id}">${icon("plus")}Add item</button></div>`;
}

let keyOpen = false;

function keyPanelHtml() {
  if (!keyOpen && canReadPhotos()) return "";
  return `<div class="key-panel">
    <label for="gemini-key">Google AI Studio API key</label>
    <input id="gemini-key" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your key" value="${escapeHtml(settings.key)}">
    <p class="small muted">${canReadPhotos() ? "" : "Needed to read receipt photos. Without it, enter items by hand. "}Get a free key at aistudio.google.com/apikey. It's stored only in this browser. Receipt photos are sent to Google, and on the free tier Google may use them to improve its products.</p>
  </div>`;
}

function photoHtml(photo) {
  const failed = photo.status === "error";
  const title = {
    new: "Not read yet",
    reading: '<span class="spinner"></span>Reading',
    done: "Read",
  }[photo.status];

  return `<div class="photo${failed ? " failed" : ""}">
    ${photo.url ? `<img src="${photo.url}" alt="">` : '<div class="photo-placeholder"></div>'}
    <div class="photo-body">
      <div class="photo-title">${failed ? `${icon("alert")}${escapeHtml(photo.message)}` : title}</div>
      ${failed && photo.hint ? `<div class="photo-hint">${escapeHtml(photo.hint)}</div>` : ""}
    </div>
    ${failed ? `<button class="link" data-retry="${photo.id}" ${reading ? "disabled" : ""}>Retry</button>` : ""}
    ${photo.status !== "reading" ? `<button class="remove" data-remove-photo="${photo.id}" aria-label="Remove photo">${icon("x")}</button>` : ""}
  </div>`;
}

const taxLabel = (rate) => (rate > 0 ? `${rate}% tax` : "No tax");

function taxChipHtml(item) {
  const rate = itemRate(item);
  return `<button class="tax-chip${rate > 0 ? " taxed" : ""}" data-tax-cycle="${item.id}" aria-label="Tax rate, tap to change">${taxLabel(rate)}</button>`;
}

function itemRowHtml(item) {
  return `<div class="item" data-item="${item.id}">
    <div class="item-main">
      <span class="product" data-product="${item.id}" data-mode="row">${productHtml(item, "row")}</span>
      <input class="item-name num" data-field="name" value="${escapeHtml(item.name)}" placeholder="Item name" aria-label="Item name">
      <span class="price-field"><i>$</i><input class="item-price num" data-field="price" type="number" inputmode="decimal" step="0.01" value="${escapeHtml(item.price)}" placeholder="0.00" aria-label="Price"></span>
      <button class="remove" data-remove-item="${item.id}" aria-label="Remove item">${icon("x")}</button>
    </div>
    <div class="item-meta">
      ${icon("barcode", 14)}
      <input class="item-code num" data-field="code" inputmode="numeric" placeholder="Product code" value="${escapeHtml(item.code || "")}" aria-label="Product code">
      ${taxChipHtml(item)}
    </div>
  </div>`;
}

function receiptHtml(receipt) {
  return `<div class="receipt-wrap"><div class="receipt" data-receipt="${receipt.id}">
    <div class="receipt-header">
      <input data-receipt-name value="${escapeHtml(receipt.name)}" aria-label="Store">
      <button class="link quiet" data-remove-receipt="${receipt.id}">Remove</button>
    </div>
    ${receipt.items.map(itemRowHtml).join("")}
    <div class="receipt-footer" id="receipt-footer-${receipt.id}">${receiptFooter(receipt)}</div>
  </div></div>`;
}

function receiptsView() {
  const itemCount = allItems().length;
  const unread = photos.filter((p) => p.status === "new" || p.status === "error").length;

  const keyLabel = canReadPhotos() ? "Gemini key" : "Add a Gemini key";
  let html = `<div class="add-row">
    <label class="dropzone" id="dropzone">
      <input type="file" id="file" accept="image/*" multiple>
      ${icon("camera", 18)}
      <b>Add receipt photos</b>
    </label>
    <button class="key-button${canReadPhotos() ? "" : " needs-key"}${keyOpen ? " on" : ""}" id="toggle-key" aria-label="${keyLabel}" title="${keyLabel}" aria-expanded="${keyOpen || !canReadPhotos()}">${icon("sparkle", 14)}<span>Gemini</span></button>
  </div>`;

  html += keyPanelHtml();
  if (photos.length) html += `<div class="photos">${photos.map(photoHtml).join("")}</div>`;

  if (unread && canReadPhotos()) {
    html += `<div class="row spaced">
      <button class="primary" id="read-all" ${reading ? "disabled" : ""}>${reading ? "Reading" : `Read ${plural(unread, "receipt")}`}</button>
      <span class="muted small">Check what it finds against the paper receipt</span>
    </div>`;
  }

  if (state.receipts.length) {
    html += `<div class="section-head"><h2>Items</h2><span class="muted small" id="lookup-status">${escapeHtml(lookup.message)}</span></div>`;
    html += state.receipts.map(receiptHtml).join("");
  }

  html += `<p class="small muted center">No photo? <button class="link" id="add-manual">Enter a receipt by hand</button>${state.receipts.length ? ' · <button id="start-over" class="link quiet">Start over</button>' : ""}</p>`;
  html += `<div class="footer-bar">
    <button class="primary" data-go="2" ${itemCount ? "" : "disabled"}>Split ${plural(itemCount, "item")}</button>
  </div>`;
  return html;
}

const split = {
  customOpen: false,
  customFor: null,
  advancing: false,
  timer: null,
  justChosen: false,
  enterDirection: 0,
};

function slipShareHtml(item, animate) {
  const price = toCents(item.price);
  const percents = item.pct;

  if (split.customOpen) {
    const values =
      percents && presetIndex(percents) < 0 ? percents.map((p) => String(Math.round(p * 100) / 100)) : ["", "", ""];
    const rows = PEOPLE.map(
      (person, i) => `<label class="custom-row">
        ${personDot(i)}<span>${person.name}</span>
        <span class="suffix-field"><input type="number" class="num" inputmode="decimal" min="0" max="100" step="any" data-custom-percent="${i}" value="${values[i]}"><span>%</span></span>
        <b class="num" id="custom-amount-${i}"></b>
      </label>`,
    ).join("");
    return `<span id="custom-bar">${shareBar(null, "thick")}</span>
      <div class="custom-split">${rows}</div>
      <div class="custom-hint" id="custom-hint">Leave a box empty to share what's left</div>`;
  }

  const shares = splitCents(price, percents);
  const who = percents
    ? PEOPLE.map((person, i) =>
        percents[i] > 0 ? `<span>${personDot(i)}${person.name}<b>${formatMoney(shares[i])}</b></span>` : "",
      ).join("")
    : '<span class="muted">Not split yet</span>';
  return `${shareBar(percents, "thick" + (animate ? " grow" : ""))}<div class="slip-who">${who}</div>`;
}

function splitView() {
  const items = allItems();
  if (!items.length) return "";

  state.cur = Math.max(0, Math.min(state.cur, items.length - 1));
  const item = items[state.cur];
  const doneCount = items.filter((i) => i.pct).length;
  const price = toCents(item.price);
  const t = totals();
  const preset = presetIndex(item.pct);
  const isLast = state.cur === items.length - 1;

  if (split.customFor !== item.id) {
    split.customFor = item.id;
    split.customOpen = Boolean(item.pct) && preset < 0;
  }

  const enterClass =
    split.enterDirection && !prefersReducedMotion() ? (split.enterDirection > 0 ? " enter-right" : " enter-left") : "";
  split.enterDirection = 0;
  const animate = split.justChosen;
  split.justChosen = false;

  const position = (n) => String(n).padStart(2, "0");
  const presetsHtml = split.customOpen
    ? ""
    : `<div class="presets">${SPLIT_PRESETS.map(
        (p, i) => `<button data-preset="${i}" class="${preset === i ? "on" : ""}" aria-label="${p.label}">
          ${avatarStack(p.percents)}
          <span class="preset-label">${p.short}</span>
          <kbd>${i + 1}</kbd>
        </button>`,
      ).join("")}
        <button data-custom-toggle class="${item.pct && preset < 0 ? "on" : ""}">
          <span class="avatars"><span class="avatar ghost">${icon("plus", 14)}</span></span>
          <span class="preset-label">Custom</span>
          <kbd>8</kbd>
        </button>
      </div>`;

  const forwardLabel = isLast ? "Finish" : item.pct ? "Next" : "Skip";
  const forwardButton = split.customOpen
    ? `<button class="primary" id="save-custom">Save split${icon("right")}</button>`
    : `<button data-move="1">${forwardLabel}${icon("right")}</button>`;
  const customButton = split.customOpen ? "<button data-custom-toggle>Cancel</button>" : "";

  const progress = (doneCount / items.length).toFixed(4);
  const left = items.length - doneCount;

  return `<div class="progress-label"><span>Item ${state.cur + 1} of ${items.length}</span><span>${left ? `${left} left` : "All split"}</span></div>
    <div class="progress"><i style="transform:scaleX(${progress})"></i></div>

    <div class="slip-wrap${enterClass}" id="slip-wrap">
      <div class="slip${split.customOpen ? " editing" : ""}">
        <div class="slip-header"><span>${escapeHtml(item.receipt.name)}</span><span>${position(state.cur + 1)}/${position(items.length)}</span></div>
        <div data-product="${item.id}" data-mode="slip">${productHtml(item, "slip")}</div>
        <div class="slip-share">${slipShareHtml(item, animate)}</div>
      </div>
    </div>

    ${presetsHtml}

    <div class="item-nav">
      <button data-move="-1" ${state.cur ? "" : "disabled"} aria-label="Previous item">${icon("left")}</button>
      ${customButton}
      <span class="spacer"></span>
      ${forwardButton}
    </div>

    <div class="running-total">
      <div class="row"><span class="muted small">Split so far, with tax</span></div>
      ${shareBar(t.owes, "medium")}
      <div class="running-names">${PEOPLE.map((p, i) => `<span>${personDot(i)}${p.name}<b class="num">${formatMoney(t.owes[i])}</b></span>`).join("")}</div>
    </div>

    <div class="footer-bar">
      <button class="${split.customOpen ? "" : "primary"}" data-go="3">Who paid</button>
    </div>`;
}

function readCustomSplit() {
  const typed = [0, 1, 2].map((i) => {
    const value = document.querySelector(`[data-custom-percent="${i}"]`)?.value.trim() ?? "";
    return value === "" ? null : Math.max(0, toNumber(value));
  });
  const used = typed.reduce((sum, v) => sum + (v || 0), 0);
  const blanks = typed.filter((v) => v === null).length;
  const remaining = 100 - used;
  const percents = typed.map((v) => (v === null ? (blanks ? Math.max(0, remaining) / blanks : 0) : v));
  const valid = blanks ? remaining >= -0.005 : Math.abs(used - 100) < 0.01;
  return { percents, typed, valid, used, blanks };
}

function updateCustomSplit() {
  if (!byId("custom-hint")) return;
  const item = allItems()[state.cur];
  const price = toCents(item.price);
  const custom = readCustomSplit();
  const shares = custom.valid
    ? splitCents(price, custom.percents)
    : custom.percents.map((p) => Math.round((price * p) / 100));

  custom.percents.forEach((p, i) => {
    const input = document.querySelector(`[data-custom-percent="${i}"]`);
    if (input) input.placeholder = custom.typed[i] === null ? String(Math.round(p * 10) / 10) : "0";
    byId(`custom-amount-${i}`).textContent = formatMoney(shares[i]);
  });

  byId("custom-bar").innerHTML = shareBar(custom.valid ? custom.percents : null, "thick");
  const used = Math.round(custom.used * 100) / 100;
  byId("custom-hint").innerHTML = custom.valid
    ? "Leave a box empty to share what's left"
    : `<span class="bad">${custom.blanks ? `That's ${used}%, over 100%` : `Adds up to ${used}%, needs 100%`}</span>`;

  const save = byId("save-custom");
  if (save) save.disabled = !custom.valid;
}

function chooseSplit(percents) {
  if (split.advancing) return;
  const items = allItems();
  const [, item] = findItem(items[state.cur].id);
  item.pct = percents;
  split.customOpen = false;
  saveState();

  split.justChosen = true;
  render();
  split.advancing = true;

  const isLast = state.cur >= items.length - 1;
  const reduced = prefersReducedMotion();
  split.timer = setTimeout(
    () => {
      if (!reduced) byId("slip-wrap")?.classList.add("leave");
      split.timer = setTimeout(
        () => {
          split.advancing = false;
          split.timer = null;
          if (isLast) return goToStep(3);
          state.cur++;
          split.enterDirection = 1;
          saveState();
          render();
        },
        reduced ? 0 : 160,
      );
    },
    reduced ? 250 : 650,
  );
}

function cancelAdvance() {
  clearTimeout(split.timer);
  split.timer = null;
  split.advancing = false;
}

function paidView() {
  const t = totals();
  const entered = t.paid.reduce((a, b) => a + b, 0);

  const receiptRows = state.receipts
    .map((receipt) => {
      const total = receiptTotal(receipt);
      const choices = PEOPLE.map(
        (person, i) =>
          `<button data-paid-by="${receipt.id}:${i}" class="${state.paidBy[receipt.id] === i ? "on" : ""}">${personDot(i)}${person.name}</button>`,
      ).join("");
      return `<div class="payer-row"><span class="payer-store">${escapeHtml(receipt.name)}</span><span class="num muted">${formatMoney(total)}</span><span class="segmented">${choices}</span></div>`;
    })
    .join("");

  const fields = PEOPLE.map(
    (person, i) => `<label class="paid-field">
      <span>${personDot(i)}${person.name} paid</span>
      <span class="money-field"><i>$</i><input type="number" class="num" step="0.01" min="0" placeholder="0.00" data-paid="${i}" value="${escapeHtml(state.paid[i])}"></span>
    </label>`,
  ).join("");

  setTimeout(updatePaidCheck, 0);

  return `<p class="lead">What each person paid at the till, tax included. Pick who paid each receipt to fill it in</p>
    <div class="panel">${receiptRows}</div>
    <div class="paid-fields">${fields}</div>
    <div class="tally">
      <span class="muted">Total with tax</span><b class="num">${formatMoney(t.total)}</b>
      <span class="muted">Entered</span><b class="num" id="entered">${formatMoney(entered)}</b>
      <span id="paid-check"></span>
    </div>
    <div class="footer-bar">
      <button class="primary" data-go="4">Summary</button>
    </div>`;
}

function updatePaidCheck() {
  if (!byId("paid-check")) return;
  const t = totals();
  const entered = t.paid.reduce((a, b) => a + b, 0);
  const diff = t.total - entered;
  byId("entered").textContent = formatMoney(entered);
  byId("paid-check").innerHTML =
    entered === 0
      ? ""
      : Math.abs(diff) <= 2
        ? '<span class="ok">Matches</span>'
        : `<span class="bad">${formatMoney(Math.abs(diff))} ${diff > 0 ? "short" : "over"}</span>`;
}

function fillPaidFromReceipts() {
  const sums = [0, 0, 0];
  for (const receipt of state.receipts) {
    const payer = state.paidBy[receipt.id];
    if (payer !== undefined) sums[payer] += receiptTotal(receipt);
  }
  state.paid = sums.map((c) => (c ? (c / 100).toFixed(2) : ""));
}

function summaryView() {
  const t = totals();
  const transfers = settleUp(t.balance);
  const paidTotal = t.paid.reduce((a, b) => a + b, 0);
  const owedTotal = t.owes.reduce((a, b) => a + b, 0);

  let settleLines;
  if (!paidTotal) {
    settleLines =
      '<div class="transfer muted">No payments entered yet<button class="link" data-go="3">Add who paid</button></div>';
  } else if (!transfers.length) {
    settleLines = '<div class="transfer muted">Everyone is settled up</div>';
  } else {
    settleLines = transfers
      .map(
        ({ from, to, amount }) =>
          `<div class="transfer"><span>${avatar(from, "sm")}${PEOPLE[from].name}</span><span class="muted">pays</span><span>${avatar(to, "sm")}${PEOPLE[to].name}</span><b class="num">${formatMoney(amount)}</b></div>`,
      )
      .join("");
  }

  let html = "";
  if (t.unsplitCount) {
    html += `<p class="notice">${icon("alert")}<span>${plural(t.unsplitCount, "item")} (${formatMoney(t.unsplitTotal)}) not split yet</span><button class="link" data-first-unsplit>Split ${t.unsplitCount > 1 ? "them" : "it"}</button></p>`;
  }

  if (paidTotal && Math.abs(paidTotal - owedTotal) > 2) {
    html += notice(`Paid ${formatMoney(paidTotal)} but the shares add up to ${formatMoney(owedTotal)}`);
  }

  const items = allItems();

  const personSection = (person, i) => {
    const balance = t.balance[i];
    const standing =
      paidTotal && balance
        ? `<div class="detail-row"><span>Balance</span><span class="${balance > 0 ? "positive" : "negative"}">${balance > 0 ? "Gets back" : "Owes"} ${formatMoney(Math.abs(balance))}</span></div>`
        : "";
    const lines = items
      .filter((item) => item.pct && item.pct[i] > 0)
      .map((item) => {
        const share = splitCents(toCents(item.price), item.pct)[i];
        return `<div class="person-item" data-jump="${items.indexOf(item)}" title="Change split">
          <span class="item-share">${formatPercent(item.pct[i])}</span>
          <span class="detail-name">${escapeHtml(item.off?.name || item.name || "Item")}</span>
          <span class="num">${formatMoney(share)}</span>
        </div>`;
      })
      .join("");
    return `<section class="person-section">
      <div class="person-top">
        ${avatar(i, "lg")}
        <b class="person-name">${person.name}'s Total</b>
        <span class="person-amount num">${formatMoney(t.owes[i])}</span>
      </div>
      ${lines ? `<div class="person-items">${lines}</div>` : '<p class="small muted person-empty">Nothing split to them yet</p>'}
      <details class="bill-details">
        <summary><span>Bill Details</span><span class="chevron">${icon("chevron", 16)}</span></summary>
        <div class="detail-row"><span>Items</span><span class="num">${formatMoney(t.subtotal[i])}</span></div>
        <div class="detail-row tax"><span>Tax</span><span class="num">${formatMoney(t.tax[i])}</span></div>
        <div class="detail-row sum"><span>Total</span><span class="num">${formatMoney(t.owes[i])}</span></div>
        <div class="detail-row"><span>Paid</span><span class="num">${formatMoney(t.paid[i])}</span></div>
        ${standing}
      </details>
    </section>`;
  };

  const stores = state.receipts.map((receipt) => escapeHtml(receipt.name)).join(" · ");
  const date = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  html += `<div class="receipt-wrap">
    <div class="receipt summary-card">
      <div class="summary-head"><h2>${stores}</h2><span class="muted">${date}</span></div>
      <section class="settle-section">
        <h3>Settle up</h3>
        <div class="transfers">${settleLines}</div>
      </section>
      ${PEOPLE.map(personSection).join("")}
    </div>
  </div>
  <div class="footer-bar">
    <button class="outline" id="start-over">Start over</button>
  </div>`;
  return html;
}

function summaryText() {
  const t = totals();
  const people = PEOPLE.map(
    (person, i) =>
      `${person.name}: share ${formatMoney(t.owes[i])} (items ${formatMoney(t.subtotal[i])} + tax ${formatMoney(t.tax[i])}), paid ${formatMoney(t.paid[i])}`,
  ).join("\n");
  const transfers = settleUp(t.balance);
  const settle = transfers.length
    ? transfers
        .map(({ from, to, amount }) => `${PEOPLE[from].name} pays ${PEOPLE[to].name} ${formatMoney(amount)}`)
        .join("\n")
    : "Everyone is settled up";
  return `${people}\n\n${settle}`;
}

function confirmTwice(button, prompt, label, action) {
  if (button.dataset.armed) return action();
  button.dataset.armed = "1";
  button.textContent = prompt;
  setTimeout(() => {
    if (!button.isConnected) return;
    delete button.dataset.armed;
    button.textContent = label;
  }, 3000);
}

const blankItem = () => ({ id: newId(), name: "", code: "", price: "", taxRate: 0, pct: null });

const clickHandlers = {
  go: (btn) => {
    const step = Number(btn.dataset.go);
    if (step === 2) {
      state.cur = 0;
      split.customFor = null;
    }
    goToStep(step);
  },

  retry: async (btn) => {
    const photo = photos.find((p) => p.id == btn.dataset.retry);
    if (!photo || reading) return;
    reading = true;
    await readPhoto(photo);
    reading = false;
    render();
  },

  removePhoto: (btn) => {
    photos = photos.filter((p) => p.id != btn.dataset.removePhoto);
    render();
  },

  taxCycle: (btn) => {
    const [receipt, item] = findItem(btn.dataset.taxCycle);
    item.taxRate = TAX_RATES[(TAX_RATES.indexOf(itemRate(item)) + 1) % TAX_RATES.length];
    saveState();
    btn.outerHTML = taxChipHtml(item);
    byId(`receipt-footer-${receipt.id}`).innerHTML = receiptFooter(receipt);
  },

  removeItem: (btn) => {
    for (const receipt of state.receipts) receipt.items = receipt.items.filter((i) => i.id != btn.dataset.removeItem);
    saveState();
    render();
  },

  addItem: (btn) => {
    const receipt = state.receipts.find((r) => r.id == btn.dataset.addItem);
    receipt.items.push(blankItem());
    saveState();
    render();
    const names = document.querySelectorAll(`[data-receipt="${receipt.id}"] .item-name`);
    names[names.length - 1]?.focus();
  },

  removeReceipt: (btn) =>
    confirmTwice(btn, "Tap again to remove", "Remove", () => {
      const id = btn.dataset.removeReceipt;
      state.receipts = state.receipts.filter((r) => r.id != id);
      photos = photos.filter((p) => p.receiptId != id);
      saveState();
      render();
    }),

  preset: (btn) => {
    split.customOpen = false;
    chooseSplit(SPLIT_PRESETS[Number(btn.dataset.preset)].percents.slice());
  },

  customToggle: () => {
    if (split.advancing) return;
    split.customOpen = !split.customOpen;
    render();
    if (split.customOpen) document.querySelector('[data-custom-percent="0"]')?.focus();
  },

  move: (btn) => {
    cancelAdvance();
    const step = Number(btn.dataset.move);
    const next = state.cur + step;
    if (next >= allItems().length) return goToStep(3);
    if (next < 0) return;
    state.cur = next;
    split.enterDirection = step;
    saveState();
    render();
  },

  paidBy: (btn) => {
    const [receiptId, person] = btn.dataset.paidBy.split(":").map(Number);
    if (state.paidBy[receiptId] === person) delete state.paidBy[receiptId];
    else state.paidBy[receiptId] = person;
    fillPaidFromReceipts();
    saveState();
    render();
  },

  jump: (row) => {
    state.cur = Number(row.dataset.jump);
    split.customFor = null;
    goToStep(2);
  },

  firstUnsplit: () => {
    state.cur = Math.max(
      0,
      allItems().findIndex((i) => !i.pct),
    );
    goToStep(2);
  },
};

const clickById = {
  "read-all": () => readAllPhotos(),

  "toggle-key": () => {
    keyOpen = !keyOpen;
    render();
    if (keyOpen) byId("gemini-key")?.focus();
  },

  "add-manual": () => {
    state.receipts.push({
      id: newId(),
      name: `Receipt ${state.receipts.length + 1}`,
      items: [blankItem()],
      subtotal: null,
      tax: null,
    });
    saveState();
    render();
  },

  "start-over": (btn) =>
    confirmTwice(btn, "Tap again to clear everything", "Start over", () => {
      state = emptyState();
      photos = [];
      saveState();
      render();
      window.scrollTo(0, 0);
    }),

  "save-custom": () => {
    const custom = readCustomSplit();
    if (!custom.valid) return;
    const preset = presetIndex(custom.percents);
    split.customOpen = false;
    chooseSplit(preset >= 0 ? SPLIT_PRESETS[preset].percents.slice() : custom.percents);
  },

  "copy-summary": async (btn) => {
    const original = btn.innerHTML;
    try {
      await navigator.clipboard.writeText(summaryText());
      btn.innerHTML = icon("check", 20);
    } catch {
      btn.innerHTML = icon("alert", 20);
    }
    setTimeout(() => (btn.innerHTML = original), 1500);
  },
};

document.addEventListener("click", (event) => {
  const target = event.target.closest("button, [data-jump]");
  if (!target) return;
  if (clickById[target.id]) return clickById[target.id](target);
  const action = Object.keys(clickHandlers).find((key) => key in target.dataset);
  if (action) clickHandlers[action](target);
});

document.addEventListener("input", (event) => {
  const el = event.target;
  const data = el.dataset;

  if (el.id === "gemini-key") {
    settings.key = el.value.trim();
    saveSettings();
    return;
  }
  if (el.id === "file") {
    addPhotos(el.files);
    el.value = "";
    return;
  }
  if (data.field) {
    const [receipt, item] = findItem(el.closest("[data-item]").dataset.item);
    if (data.field === "code") {
      item.code = el.value.replace(/\D/g, "");
      delete item.off;
      delete item.offs;
    } else {
      item[data.field] = el.value;
      byId(`receipt-footer-${receipt.id}`).innerHTML = receiptFooter(receipt);
    }
    saveState();
    return;
  }
  if ("receiptName" in data) {
    state.receipts.find((r) => r.id == el.closest("[data-receipt]").dataset.receipt).name = el.value;
    saveState();
    return;
  }
  if ("customPercent" in data) return updateCustomSplit();
  if ("paid" in data) {
    state.paid[Number(data.paid)] = el.value;
    saveState();
    updatePaidCheck();
    return;
  }
});

document.addEventListener("change", (event) => {
  const el = event.target;
  if (el.id === "gemini-key") render();
  if (el.dataset.field === "code") {
    const [, item] = findItem(el.closest("[data-item]").dataset.item);
    updateProductViews(item);
    queueProductLookups();
  }
});

document.addEventListener("keydown", (event) => {
  if (state.step !== 2) return;
  const el = event.target;

  if (el.matches("input")) {
    if (!("customPercent" in el.dataset)) return;
    if (event.key === "Enter") byId("save-custom")?.click();
    if (event.key === "Escape") {
      split.customOpen = false;
      render();
    }
    return;
  }

  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (/^[1-7]$/.test(event.key)) {
    event.preventDefault();
    split.customOpen = false;
    chooseSplit(SPLIT_PRESETS[Number(event.key) - 1].percents.slice());
  } else if (event.key === "8") {
    event.preventDefault();
    document.querySelector("[data-custom-toggle]")?.click();
  } else if (event.key === "ArrowRight") {
    document.querySelector('[data-move="1"]')?.click();
  } else if (event.key === "ArrowLeft" && state.cur > 0) {
    document.querySelector('[data-move="-1"]')?.click();
  }
});

for (const type of ["dragover", "dragenter"]) {
  document.addEventListener(type, (event) => {
    const zone = event.target.closest?.("#dropzone");
    if (!zone) return;
    event.preventDefault();
    zone.classList.add("over");
  });
}

document.addEventListener("dragleave", (event) => event.target.closest?.("#dropzone")?.classList.remove("over"));

document.addEventListener("drop", (event) => {
  if (!event.target.closest?.("#dropzone")) return;
  event.preventDefault();
  addPhotos(event.dataTransfer.files);
});

render();
queueProductLookups();
