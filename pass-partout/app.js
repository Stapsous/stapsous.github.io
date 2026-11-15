// Pass-partout : connexion Google, lecture Firestore (règles : seuls les comptes listés dans viewers), rendu.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut, reauthenticateWithPopup }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, collection, query, where, onSnapshot, doc, getDocs, writeBatch, setDoc, deleteDoc }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { esc, renderHome, renderTrip, defaultTrip } from "./view.js?v=11";
import { extract, normalize, buildTrips, dropKnown, htmlOf, GMAIL_QUERY } from "./importer.js?v=10";
import { readCard, matchFlight, CARD_QUERY, attachmentsOf, b64urlToBlob } from "./cards.js?v=10";

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
const state = { user: null, trips: [], loaded: false, docs: {}, cards: {}, live: {}, unsub: [], error: null };

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
  $app.innerHTML = installBanner() + renderTrip(shown, docs, state.live[trip.id] || {});
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

let auth, db, watched = null, liveUnsub = null, cardsUnsub = null, scrolledTo = null;
const dayOpen = {};

function watchTrip(id) {
  if (watched === id) return;
  watched = id;
  if (liveUnsub) liveUnsub();
  if (cardsUnsub) cardsUnsub();
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
  const el = e.target.closest("[data-action],[data-copy],[data-scan]");
  if (!el) return;
  if (el.dataset.scan) return openScan(el.dataset.scan);
  if (el.dataset.copy) {
    try { await navigator.clipboard.writeText(el.dataset.copy); say("Code copié"); } catch { say("Copie impossible : " + el.dataset.copy); }
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
