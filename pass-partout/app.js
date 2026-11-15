// Pass-partout : connexion Google, lecture Firestore (règles : seuls les comptes listés dans viewers), rendu.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut, reauthenticateWithPopup }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, collection, query, where, onSnapshot, doc, getDocs, writeBatch, setDoc, deleteDoc }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { esc, renderHome, renderTrip, defaultTrip } from "./view.js?v=14";
import { extract, normalize, buildTrips, dropKnown, htmlOf, GMAIL_QUERY } from "./importer.js?v=10";
import { readCard, matchFlight, CARD_QUERY, attachmentsOf, b64urlToBlob } from "./cards.js?v=10";
import { renderNdf, ndfLines } from "./ndf.js?v=14";

// Configuration publique du projet Firebase (protégée par les règles Firestore et les domaines autorisés).
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDxvbB-2FfRZUQTJ8Oc4WdCAa4lh-TrBnA",
  authDomain: "pass-partout-6c2c9.firebaseapp.com",
  projectId: "pass-partout-6c2c9",
  storageBucket: "pass-partout-6c2c9.firebasestorage.app",
  messagingSenderId: "919954413000",
  appId: "1:919954413000:web:a12bb4b8c4e23a82fbdcfd",
};

const $app = document.getElementById("app");
const state = { user: null, trips: [], loaded: false, docs: {}, cards: {}, live: {}, ndf: {}, unsub: [], error: null };

function screenLogin(msg) {
  $app.innerHTML = `<div class="login">
    <span class="brand">Pass-partout</span>
    <h1>Mes voyages</h1>
    <p class="muted">Horaires, cartes d'embarquement, hôtel et parking, au même endroit.</p>
    ${msg ? `<p class="err">${esc(msg)}</p>` : ""}
    <button class="btn primary big" data-action="login">Se connecter avec Google</button>
  </div>`;
}

// ---------------------------------------------------------------- installation (PWA)
let installEvt = null;
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const dismissed = () => { try { return localStorage.getItem("pp-install-dismissed") === "1"; } catch { return false; } };
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; render(); });
window.addEventListener("appinstalled", () => { installEvt = null; render(); });

function installBanner() {
  if (standalone() || dismissed()) return "";
  if (installEvt) return `<div class="install"><span>Installe Pass-partout sur ton téléphone : icône sur l'écran d'accueil, ouverture même hors ligne.</span>
    <div class="btns"><button class="btn primary" data-action="install">Installer l'appli</button><button class="linkbtn" data-action="dismiss-install">Plus tard</button></div></div>`;
  if (isIOS) return `<div class="install"><span>Pour l'installer : bouton <b>Partager</b> de Safari, puis <b>Sur l'écran d'accueil</b>.</span>
    <div class="btns"><button class="linkbtn" data-action="dismiss-install">OK</button></div></div>`;
  return "";
}

function render() {
  if (!FIREBASE_CONFIG) { $app.innerHTML = `<p class="err">Configuration Firebase manquante.</p>`; return; }
  if (!state.user) return screenLogin(state.error);
  if (!state.loaded) { $app.innerHTML = `<div class="loading">Chargement des voyages…</div>`; return; }
  const h = location.hash.replace(/^#/, "");
  const id = h.startsWith("doc-") ? (watched || "") : h;
  if (id === "voyages" || !state.trips.length) { $app.innerHTML = installBanner() + renderHome(state.trips, state.user); setScan(scanStatus); return; }
  let trip = state.trips.find((t) => t.id === id);
  if (!trip) {
    trip = defaultTrip(state.trips);
    if (trip) history.replaceState(null, "", "#" + trip.id);
  }
  if (!trip) { $app.innerHTML = renderHome(state.trips, state.user); return; }
  watchTrip(trip.id);
  const docs = { ...(state.docs[trip.id] || {}) };
  const cards = state.cards[trip.id] || {};
  const shown = { ...trip, flights: (trip.flights || []).map((f) => {
    if (!cards[f.id]) return f;
    docs["card-" + f.id] = cards[f.id]; // une carte ajoutée depuis l'appli remplace celle de trips.yaml
    return { ...f, boarding_pass: "card-" + f.id };
  }) };
  const isOwner = (trip.viewers || [])[0] === (state.user.email || "").toLowerCase();
  const ndfHtml = trip.pro && isOwner ? renderNdf(trip, state.ndf[trip.id] || {}) : "";
  const form = $app.querySelector("#ndf-form");
  const keepOpen = form?.closest("details").open;
  const typed = form ? [...form.elements].filter((x) => x.name && x.type !== "file").map((x) => [x.name, x.value]) : [];
  $app.innerHTML = installBanner() + renderTrip(shown, docs, state.live[trip.id] || {}, Date.now(), ndfHtml);
  const form2 = $app.querySelector("#ndf-form");
  if (form2) { if (keepOpen) form2.closest("details").open = true; typed.forEach(([n, v]) => { form2.elements[n].value = v; }); }
  // Garder les jours pliés/dépliés à la main lors des rafraîchissements
  $app.querySelectorAll("details.day").forEach((d) => {
    const k = trip.id + "|" + d.dataset.day;
    if (k in dayOpen) d.open = dayOpen[k];
    d.addEventListener("toggle", () => { dayOpen[k] = d.open; });
  });
  if (scrolledTo !== trip.id) { // à l'ouverture d'un voyage, amener la prochaine étape à l'écran
    scrolledTo = trip.id;
    const nx = $app.querySelector(".ev.is-next");
    if (nx && !location.hash.startsWith("#doc-")) nx.scrollIntoView({ block: "center" });
  }
}

// ---------------------------------------------------------------- Firebase

let auth, db, watched = null, liveUnsub = null, cardsUnsub = null, ndfUnsub = null, scrolledTo = null;
const dayOpen = {};

function watchTrip(id) {
  if (watched === id) return;
  watched = id;
  if (liveUnsub) liveUnsub();
  if (cardsUnsub) cardsUnsub();
  if (ndfUnsub) { ndfUnsub(); ndfUnsub = null; }
  // Note de frais (voyages pro, propriétaire seulement)
  const t = state.trips.find((x) => x.id === id);
  if (t?.pro && (t.viewers || [])[0] === (state.user.email || "").toLowerCase()) {
    ndfUnsub = onSnapshot(collection(db, "trips", id, "ndf"), (snap) => {
      state.ndf[id] = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
      render();
    }, (e) => console.warn("ndf", e));
  }
  // Cartes d'embarquement ajoutées depuis l'appli
  cardsUnsub = onSnapshot(collection(db, "trips", id, "cards"), (snap) => {
    state.cards[id] = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
    render();
  }, (e) => console.warn("cards", e));
  // Porte, retard, statut en direct
  liveUnsub = onSnapshot(collection(db, "trips", id, "live"), (snap) => {
    state.live[id] = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
    render();
  }, (e) => console.warn("live", e));
  // Cartes d'embarquement (lues une fois, gardées en cache local)
  getDocs(collection(db, "trips", id, "docs")).then((snap) => {
    state.docs[id] = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
    render();
  }).catch((e) => console.warn("docs", e));
}

function start() {
  if (!FIREBASE_CONFIG) return render();
  const app = initializeApp(FIREBASE_CONFIG);
  auth = getAuth(app);
  db = initializeFirestore(app, { localCache: persistentLocalCache() });
  onAuthStateChanged(auth, (user) => {
    state.user = user; state.loaded = false; state.trips = [];
    state.unsub.forEach((u) => u()); state.unsub = [];
    watched = null; if (liveUnsub) { liveUnsub(); liveUnsub = null; }
    if (!user) return render();
    state.error = null;
    render();
    const email = (user.email || "").toLowerCase();
    const q = query(collection(db, "trips"), where("viewers", "array-contains", email));
    state.unsub.push(onSnapshot(q, (snap) => {
      state.trips = snap.docs.map((d) => d.data());
      state.loaded = true;
      render();
    }, (e) => {
      state.loaded = true; state.trips = [];
      state.error = e.code === "permission-denied" ? `Le compte ${email} n'a accès à aucun voyage.` : `Erreur de chargement : ${e.message}`;
      $app.innerHTML = `<div class="topbar"><span class="brand">Pass-partout</span><button class="linkbtn" data-action="logout">Déconnexion</button></div><p class="err">${esc(state.error)}</p>`;
    }));
  });
}

// ---------------------------------------------------------------- interactions

const toast = document.getElementById("toast");
let tt;
function say(msg) { toast.textContent = msg; toast.classList.add("show"); clearTimeout(tt); tt = setTimeout(() => toast.classList.remove("show"), 3500); }

const scan = document.getElementById("scan");
function openScan(docId) {
  const d = docId.startsWith("card-") ? (state.cards[watched] || {})[docId.slice(5)] : (state.docs[watched] || {})[docId];
  if (!d) return;
  document.getElementById("scan-img").src = d.barcode || d.image;
  document.getElementById("scan-meta").textContent = d.meta || d.label || "";
  scan.classList.add("open");
  document.getElementById("close-scan").focus();
}
document.getElementById("close-scan").addEventListener("click", () => scan.classList.remove("open"));
scan.addEventListener("click", (e) => { if (e.target === scan) scan.classList.remove("open"); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") scan.classList.remove("open"); });

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action],[data-copy],[data-scan],[data-jump]");
  if (!el) return;
  if (el.dataset.jump) {
    const target = el.dataset.jump === "next" ? $app.querySelector(".ev.is-next") : document.getElementById(el.dataset.jump);
    if (!target) return;
    const d = target.closest("details") || target;
    if (d.tagName === "DETAILS" && !d.open) d.open = true;
    target.scrollIntoView({ block: el.dataset.jump === "next" ? "center" : "start", behavior: "smooth" });
    return;
  }
  if (el.dataset.scan) return openScan(el.dataset.scan);
  if (el.dataset.copy) {
    try { await navigator.clipboard.writeText(el.dataset.copy); say("Copié : " + el.dataset.copy.slice(0, 40)); } catch { say("Copie impossible : " + el.dataset.copy); }
    return;
  }
  if (el.dataset.action === "login") {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try { await signInWithPopup(auth, provider); }
    catch (err) {
      if (["auth/popup-blocked", "auth/operation-not-supported-in-environment"].includes(err.code)) return signInWithRedirect(auth, provider);
      if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") { state.error = `Connexion impossible : ${err.code}`; render(); }
    }
  }
  if (el.dataset.action === "install" && installEvt) { installEvt.prompt(); await installEvt.userChoice; installEvt = null; render(); return; }
  if (el.dataset.action === "dismiss-install") { try { localStorage.setItem("pp-install-dismissed", "1"); } catch {} render(); return; }
  if (el.dataset.action === "scan-gmail") { scanGmail(); return; }
  if (el.dataset.action === "add-card") { cardTarget = el.dataset.flight; fileInput.click(); return; }
  if (el.dataset.action === "del-card") {
    const m = findFlight(el.dataset.flight);
    if (m) { await deleteDoc(doc(db, "trips", m.trip.id, "cards", m.flight.id)); say("Carte supprimée"); }
    return;
  }
  if (el.dataset.action === "gmail-card") {
    try {
      const token = await gmailToken();
      showBusy("Recherche de la carte dans Gmail…");
      const r = await cardsFromGmail(token, showBusy);
      say(r.added ? `${r.added} carte(s) trouvée(s)` : "Aucune carte d'embarquement trouvée dans les mails récents");
    } catch (e) {
      const code = e.code || e.message;
      if (code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") say(String(code).includes("403") ? "Accès Gmail refusé : compte non autorisé comme testeur" : `Recherche impossible : ${code}`);
    } finally { hideBusy(); }
    return;
  }
  if (el.dataset.action?.startsWith("ndf-")) { ndfAction(el, e); return; }
  if (el.dataset.action === "logout") { await signOut(auth); history.replaceState(null, "", location.pathname); }
});

// ---------------------------------------------------------------- import Gmail (dans le navigateur, lecture seule)

let scanStatus = "";
function setScan(msg) {
  scanStatus = msg;
  const el = document.getElementById("scan-status");
  if (el) el.textContent = msg;
}

async function gmail(token, path) {
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error(`Gmail ${r.status}`);
  return r.json();
}

async function gmailToken() {
  const provider = new GoogleAuthProvider();
  provider.addScope("https://www.googleapis.com/auth/gmail.readonly");
  provider.setCustomParameters({ login_hint: state.user.email });
  const res = await reauthenticateWithPopup(state.user, provider);
  const token = GoogleAuthProvider.credentialFromResult(res)?.accessToken;
  if (!token) throw new Error("pas de jeton Gmail");
  return token;
}

// ---------------------------------------------------------------- cartes d'embarquement

const busy = document.createElement("div");
busy.className = "busy"; busy.innerHTML = "<div role=\"status\"></div>";
document.body.appendChild(busy);
const showBusy = (msg) => { busy.firstChild.textContent = msg; busy.classList.add("open"); };
const hideBusy = () => busy.classList.remove("open");

const fileInput = document.createElement("input");
fileInput.type = "file"; fileInput.accept = "application/pdf,image/*,.pkpass,application/vnd.apple.pkpass"; fileInput.hidden = true;
document.body.appendChild(fileInput);
let cardTarget = null;

function findFlight(id) {
  for (const t of state.trips) for (const f of t.flights || []) if (f.id === id) return { trip: t, flight: f };
  return null;
}

async function saveCard(card, target, source) {
  const b = card.bcbp;
  const m = (b && matchFlight(b, state.trips)) || target;
  if (!m) throw new Error("Vol introuvable pour cette carte");
  const meta = b ? [b.name, `${b.carrier}${b.flight}`, b.seat && `place ${b.seat}`, b.pnr, b.seq && `séq. ${b.seq}`].filter(Boolean).join(" · ") : "";
  await setDoc(doc(db, "trips", m.trip.id, "cards", m.flight.id), {
    uid: state.user.uid, source, added_at: new Date().toISOString(), format: card.format, text: card.text,
    barcode: card.barcode, image: card.image || null, meta, label: `${m.flight.airline} ${m.flight.display || m.flight.flight}`,
    seat: b?.seat || null, seq: b?.seq || null,
  });
  return m;
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  fileInput.value = "";
  if (!file) return;
  showBusy("Lecture de la carte d'embarquement…");
  try {
    const card = await readCard(file, file.name);
    const target = cardTarget && findFlight(cardTarget);
    const m = await saveCard(card, target, "upload");
    say(m.flight.id === cardTarget || !cardTarget ? "Carte ajoutée" : `Carte rangée sur le vol ${m.flight.display || m.flight.flight}`);
  } catch (e) {
    say(/NotFound|No MultiFormat|not found/i.test(String(e)) || e.name === "NotFoundException" ? "Code-barres illisible : essaie le PDF d'origine ou une capture plus nette" : `Ajout impossible : ${e.message || e}`);
  } finally { hideBusy(); }
});

/** Cherche les cartes d'embarquement en pièce jointe des mails récents et les range sur les vols. */
async function cardsFromGmail(token, onProgress = () => {}) {
  const r = await gmail(token, `messages?maxResults=30&q=${encodeURIComponent(CARD_QUERY)}`);
  const ids = (r.messages || []).map((m) => m.id);
  let added = 0, i = 0;
  for (const id of ids) {
    onProgress(`Cartes d'embarquement : mail ${++i} / ${ids.length}`);
    try {
      const msg = await gmail(token, `messages/${id}?format=full`);
      for (const a of attachmentsOf(msg.payload)) {
        try {
          const att = await gmail(token, `messages/${id}/attachments/${a.id}`);
          const card = await readCard(b64urlToBlob(att.data, a.type), a.name);
          if (card.bcbp && matchFlight(card.bcbp, state.trips)) { await saveCard(card, null, "gmail"); added++; }
        } catch { /* pièce jointe sans code-barres lisible */ }
      }
    } catch (e) { console.warn("carte", id, e); }
  }
  return { added, mails: ids.length };
}

let scanning = false;
async function scanGmail() {
  if (scanning) return;
  scanning = true;
  try {
    setScan("Autorisation Gmail…");
    const token = await gmailToken();

    setScan("Recherche des confirmations…");
    let ids = [], page = "";
    do {
      const r = await gmail(token, `messages?maxResults=100&q=${encodeURIComponent(GMAIL_QUERY)}${page ? "&pageToken=" + page : ""}`);
      ids = ids.concat((r.messages || []).map((m) => m.id));
      page = r.nextPageToken || "";
    } while (page && ids.length < 400);

    const items = [];
    let done = 0;
    const queue = ids.slice();
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          const m = await gmail(token, `messages/${id}?format=full`);
          const html = htmlOf(m.payload);
          if (/ld\+json|itemscope/i.test(html)) extract(html).forEach((r) => items.push(normalize(r)));
        } catch (e) { console.warn("message", id, e); }
        done++;
        if (done % 5 === 0 || done === ids.length) setScan(`Lecture des mails : ${done} / ${ids.length} · ${items.filter(Boolean).length} réservation(s) trouvée(s)`);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));

    const uid = state.user.uid, email = state.user.email.toLowerCase();
    const mine = state.trips.filter((t) => t.source === "gmail" && t.owner_uid === uid);
    const others = state.trips.filter((t) => !(t.source === "gmail" && t.owner_uid === uid));
    const fresh = dropKnown(items, others);
    const trips = buildTrips(fresh, { email, uid });

    setScan("Enregistrement…");
    const batch = writeBatch(db);
    const keep = new Set(trips.map((t) => t.id));
    mine.filter((t) => !keep.has(t.id)).forEach((t) => batch.delete(doc(db, "trips", t.id)));
    trips.forEach((t) => batch.set(doc(db, "trips", t.id), JSON.parse(JSON.stringify(t))));
    await batch.commit();

    const n = fresh.filter(Boolean).length;
    const cards = await cardsFromGmail(token, setScan).catch(() => ({ added: 0 }));
    const cardTxt = cards.added ? ` ${cards.added} carte(s) d'embarquement ajoutée(s).` : "";
    setScan((trips.length
      ? `${trips.length} voyage(s) importé(s) à partir de ${n} réservation(s) sur ${ids.length} mails lus.`
      : `Aucune nouvelle réservation reconnue dans ${ids.length} mails. Les confirmations sans données structurées ne sont pas encore lues automatiquement.`) + cardTxt);
  } catch (e) {
    const code = e.code || e.message;
    setScan(code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request" ? "Scan annulé."
      : code === "auth/popup-blocked" ? "La fenêtre Google a été bloquée : autorise les pop-ups pour ce site."
      : String(code).includes("403") ? "Accès Gmail refusé : ce compte doit être ajouté comme testeur de l'appli (demande à Antoine)."
      : `Scan impossible : ${code}`);
  } finally {
    scanning = false;
  }
}

window.addEventListener("hashchange", () => {
  if (location.hash.startsWith("#doc-")) { // ancre vers une carte d'embarquement
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
    return;
  }
  scrolledTo = null;
  render();
  if (!$app.querySelector(".ev.is-next")) window.scrollTo(0, 0);
});
setInterval(() => { if (state.user && state.loaded && !scan.classList.contains("open")) render(); }, 60000);

start();

// ---------------------------------------------------------------- note de frais

const ndfRef = (lineId) => doc(db, "trips", watched, "ndf", lineId);
const ndfSet = (lineId, data) => setDoc(ndfRef(lineId), { ...data, uid: state.user.uid, updated_at: new Date().toISOString() }, { merge: true });
const ndfLine = (lineId) => ndfLines(state.trips.find((t) => t.id === watched) || {}, state.ndf[watched] || {}).find((l) => l.id === lineId);
const parseAmount = (v) => { const n = Number(String(v || "").replace(/\s|€/g, "").replace(",", ".")); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };

// Photo compressée en JPEG (< 900 ko en data URL), PDF gardé tel quel s'il est léger
async function receiptData(file) {
  const asUrl = (blob) => new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = ko; r.readAsDataURL(blob); });
  if (file.type === "application/pdf") {
    const u = await asUrl(file);
    if (u.length > 940000) throw new Error("PDF trop lourd (900 ko max) : prends plutôt une photo");
    return u;
  }
  const bmp = await createImageBitmap(file);
  for (const [max, q] of [[1800, 0.75], [1400, 0.7], [1100, 0.65], [900, 0.6]]) {
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const u = c.toDataURL("image/jpeg", q);
    if (u.length < 900000) return u;
  }
  throw new Error("Image trop lourde");
}

const receiptInput = document.createElement("input");
receiptInput.type = "file"; receiptInput.accept = "image/*,application/pdf"; receiptInput.hidden = true;
document.body.appendChild(receiptInput);
let receiptTarget = null;
receiptInput.addEventListener("change", async () => {
  const file = receiptInput.files[0]; receiptInput.value = "";
  if (!file || !receiptTarget) return;
  showBusy("Enregistrement du justificatif…");
  try { await ndfSet(receiptTarget, { receipt_img: await receiptData(file) }); say("Justificatif ajouté"); }
  catch (err) { say(`Justificatif non enregistré : ${err.message || err.code}`); }
  finally { hideBusy(); }
});

async function ndfAction(el, e) {
  const id = el.dataset.line, a = el.dataset.action;
  try {
    if (a === "ndf-goto") { e.preventDefault(); document.querySelector(el.getAttribute("href"))?.scrollIntoView({ block: "start", behavior: "smooth" }); return; }
    if (a === "ndf-done") return ndfSet(id, { done: el.checked });
    if (a === "ndf-decide") return ndfSet(id, { decision: el.dataset.v });
    if (a === "ndf-receipt") { receiptTarget = id; receiptInput.click(); return; }
    if (a === "ndf-view") {
      const u = ndfLine(id)?.receipt_img; if (!u) return;
      const blob = await (await fetch(u)).blob();
      window.open(URL.createObjectURL(blob), "_blank");
      return;
    }
    if (a === "ndf-amount") {
      const l = ndfLine(id);
      const v = prompt("Montant TTC en € (tel que sur la facture)", l?.amount != null ? String(l.amount).replace(".", ",") : "");
      if (v === null) return;
      const n = parseAmount(v);
      if (n === null) return say("Montant invalide");
      return ndfSet(id, { amount_fixed: n });
    }
    if (a === "ndf-del") { if (confirm("Supprimer cette dépense ?")) await deleteDoc(ndfRef(id)); return; }
  } catch (err) { say(`Action impossible : ${err.code || err.message}`); }
}

document.addEventListener("submit", async (e) => {
  if (e.target.id !== "ndf-form") return;
  e.preventDefault();
  const f = new FormData(e.target);
  const amount = parseAmount(f.get("amount"));
  if (amount === null) return say("Montant invalide");
  showBusy("Ajout de la dépense…");
  try {
    const file = f.get("receipt");
    const data = { custom: true, date: f.get("date"), category: f.get("category"), amount, vendor: f.get("vendor") || "", label: f.get("label") };
    if (file && file.size) data.receipt_img = await receiptData(file);
    await ndfSet("c-" + Date.now().toString(36), data);
    e.target.reset();
    say("Dépense ajoutée");
  } catch (err) { say(`Dépense non ajoutée : ${err.code || err.message}`); }
  finally { hideBusy(); }
});
