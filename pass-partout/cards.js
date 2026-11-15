// Cartes d'embarquement : lecture du code-barres (PDF, image, .pkpass), décodage du format IATA (BCBP),
// rattachement au bon vol et code-barres redessiné en net. Tout se passe sur l'appareil.

const LIBS = {
  pdfjs: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js",
  pdfWorker: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js",
  zxing: "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js",
  bwip: "https://cdn.jsdelivr.net/npm/bwip-js@4.8.0/dist/bwip-js-min.js",
  jszip: "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
};
const loaded = {};
function lib(name) {
  return loaded[name] ||= new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = LIBS[name]; s.async = true;
    s.onload = ok; s.onerror = () => ko(new Error(`Chargement de ${name} impossible`));
    document.head.appendChild(s);
  });
}

// ---------------------------------------------------------------- fichier → image

async function pdfToCanvas(buf) {
  await lib("pdfjs");
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(4, 2000 / base.width) });
  const c = document.createElement("canvas");
  c.width = vp.width; c.height = vp.height;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return c;
}

async function imageToCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  return c;
}

// ---------------------------------------------------------------- lecture du code-barres

const NATIVE = { pdf417: "pdf417", aztec: "aztec", qr_code: "qrcode", data_matrix: "datamatrix" };

function crop(c, x, y, w, h, maxW = 1400) {
  const k = Math.min(1, maxW / w);
  const o = document.createElement("canvas");
  o.width = Math.round(w * k); o.height = Math.round(h * k);
  o.getContext("2d").drawImage(c, x, y, w, h, 0, 0, o.width, o.height);
  return o;
}

/** Zones à essayer : page entière, puis bandes et tuiles qui se chevauchent (le code est souvent petit sur une page A4). */
function regions(c) {
  const W = c.width, H = c.height, out = [crop(c, 0, 0, W, H)];
  for (const [fw, fh] of [[1, 0.5], [0.6, 0.35], [0.45, 0.25]]) {
    const w = W * fw, h = H * fh;
    for (let y = 0; y + h <= H + 1; y += h / 2) for (let x = 0; x + w <= W + 1; x += w / 2) out.push(crop(c, x, y, w, h, 1200));
  }
  return out;
}

async function decodeNative(c) {
  if (!("BarcodeDetector" in window)) return null;
  try {
    const det = new window.BarcodeDetector({ formats: Object.keys(NATIVE) });
    const found = await det.detect(c);
    return found.length ? { format: NATIVE[found[0].format] || "pdf417", text: found[0].rawValue } : null;
  } catch { return null; }
}

async function decodeCanvas(c) {
  const nat = await decodeNative(c);
  if (nat) return nat;
  await lib("zxing");
  const Z = window.ZXing;
  const hints = new Map([
    [Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.PDF_417, Z.BarcodeFormat.AZTEC, Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.DATA_MATRIX]],
    [Z.DecodeHintType.TRY_HARDER, true],
  ]);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const names = { PDF_417: "pdf417", AZTEC: "aztec", QR_CODE: "qrcode", DATA_MATRIX: "datamatrix" };
  for (const r of regions(c)) {
    const { data } = r.getContext("2d").getImageData(0, 0, r.width, r.height);
    const lum = new Uint8ClampedArray(r.width * r.height);
    for (let i = 0; i < lum.length; i++) lum[i] = (data[i * 4] * 0.3 + data[i * 4 + 1] * 0.59 + data[i * 4 + 2] * 0.11) | 0;
    try {
      const res = reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(lum, r.width, r.height))));
      return { format: names[Z.BarcodeFormat[res.getBarcodeFormat()]] || "pdf417", text: res.getText() };
    } catch { /* zone suivante */ }
    await new Promise((ok) => setTimeout(ok)); // laisser respirer l'interface
  }
  throw new Error("NotFound");
}

/** Format IATA des cartes d'embarquement (Bar Coded Boarding Pass), premier segment. */
export function parseBCBP(t) {
  if (!t || t[0] !== "M" || t.length < 58) return null;
  const name = t.slice(2, 22).trim();
  const [last, first] = name.split("/");
  return {
    name: [first, last].filter(Boolean).join(" ").trim(), pnr: t.slice(23, 30).trim(),
    from: t.slice(30, 33), to: t.slice(33, 36), carrier: t.slice(36, 39).trim(),
    flight: t.slice(39, 44).trim().replace(/^0+/, ""), julian: parseInt(t.slice(44, 47), 10),
    seat: t.slice(48, 52).trim().replace(/^0+/, ""), seq: t.slice(52, 57).trim().replace(/^0+/, ""),
  };
}

const dayOfYear = (iso) => { const d = new Date(iso + "T12:00:00Z"); return Math.round((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000); };
const digits = (s) => String(s || "").replace(/^[A-Z0-9]{2}(?=\d)|^[A-Z]{3}(?=\d)/, "").replace(/\D/g, "").replace(/^0+/, "");

/** Vol correspondant à une carte : même numéro, mêmes aéroports, date la plus proche. */
export function matchFlight(b, trips) {
  let best = null;
  for (const t of trips) for (const f of t.flights || []) {
    if (digits(f.flight) !== b.flight) continue;
    if (b.from && f.from && b.from !== f.from) continue;
    const gap = Math.abs(dayOfYear(f.date) - b.julian);
    if (!best || gap < best.gap) best = { trip: t, flight: f, gap };
  }
  return best && best.gap <= 3 ? best : null;
}

async function barcodeImage(format, text) {
  await lib("bwip");
  const c = document.createElement("canvas");
  const opts = { bcid: format, text, scale: 3, padding: 6, backgroundcolor: "FFFFFF" };
  if (format === "pdf417") opts.height = 12;
  window.bwipjs.toCanvas(c, opts);
  return c.toDataURL("image/png");
}

function cardPreview(c) {
  const w = Math.min(1000, c.width), h = Math.round(c.height * w / c.width);
  const o = document.createElement("canvas");
  o.width = w; o.height = Math.min(h, 1600);
  const ctx = o.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, o.width, o.height);
  ctx.drawImage(c, 0, 0, w, h);
  return o.toDataURL("image/jpeg", 0.72);
}

async function fromPkpass(buf) {
  await lib("jszip");
  const zip = await window.JSZip.loadAsync(buf);
  const pass = JSON.parse(await zip.file("pass.json").async("string"));
  const bc = (pass.barcodes && pass.barcodes[0]) || pass.barcode;
  if (!bc) throw new Error("Pas de code-barres dans ce fichier Wallet");
  const format = { PKBarcodeFormatPDF417: "pdf417", PKBarcodeFormatAztec: "aztec", PKBarcodeFormatQR: "qrcode" }[bc.format] || "pdf417";
  return { format, text: bc.message, canvas: null };
}

/**
 * Lit une carte d'embarquement (File/Blob ou ArrayBuffer + type) et renvoie
 * { bcbp, format, text, barcode (data URL net), image (aperçu) }.
 */
export async function readCard(blob, name = "") {
  const type = blob.type || "", lower = name.toLowerCase();
  let canvas = null, code;
  if (type.includes("pkpass") || lower.endsWith(".pkpass")) {
    code = await fromPkpass(await blob.arrayBuffer());
  } else {
    canvas = type === "application/pdf" || lower.endsWith(".pdf") ? await pdfToCanvas(await blob.arrayBuffer()) : await imageToCanvas(blob);
    code = await decodeCanvas(canvas);
  }
  const bcbp = parseBCBP(code.text);
  return { bcbp, format: code.format, text: code.text, barcode: await barcodeImage(code.format, code.text), image: canvas ? cardPreview(canvas) : null };
}

// ---------------------------------------------------------------- Gmail

export const CARD_QUERY = 'newer_than:14d has:attachment (filename:pdf OR filename:pkpass OR filename:png OR filename:jpg OR filename:jpeg) ("boarding pass" OR "carte d\'embarquement" OR "carte d’embarquement" OR "boarding card" OR embarquement OR "bordkarte" OR "tarjeta de embarque")';

export function attachmentsOf(payload) {
  const out = [];
  const visit = (p) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId && /pdf|image|pkpass|octet/i.test(p.mimeType + p.filename)) out.push({ id: p.body.attachmentId, name: p.filename, type: p.mimeType });
    (p.parts || []).forEach(visit);
  };
  visit(payload);
  return out;
}

export function b64urlToBlob(s, type) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))], { type: type || "application/octet-stream" });
}
