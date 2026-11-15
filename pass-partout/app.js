// Pass-partout : connexion Google, lecture Firestore (règles : seuls les comptes listés dans viewers), rendu.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, collection, query, where, onSnapshot, doc, getDocs }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { esc, renderHome, renderTrip, defaultTrip } from "./view.js";

// Configuration publique du projet Firebase (protégée par les règles Firestore et les domaines autorisés).
const FIREBASE_CONFIG = null; // à remplir

const $app = document.getElementById("app");
const state = { user: null, trips: [], loaded: false, docs: {}, live: {}, unsub: [], error: null };

function screenLogin(msg) {
  $app.innerHTML = `<div class="login">
    <span class="brand">Pass-partout</span>
    <h1>Mes voyages</h1>
    <p class="muted">Horaires, cartes d'embarquement, hôtel et parking, au même endroit.</p>
    ${msg ? `<p class="err">${esc(msg)}</p>` : ""}
    <button class="btn primary big" data-action="login">Se connecter avec Google</button>
  </div>`;
}

function render() {
  if (!FIREBASE_CONFIG) { $app.innerHTML = `<p class="err">Configuration Firebase manquante.</p>`; return; }
  if (!state.user) return screenLogin(state.error);
  if (!state.loaded) { $app.innerHTML = `<div class="loading">Chargement des voyages…</div>`; return; }
  const h = location.hash.replace(/^#/, "");
  const id = h.startsWith("doc-") ? (watched || "") : h;
  if (id === "voyages" || !state.trips.length) { $app.innerHTML = renderHome(state.trips, state.user); return; }
  let trip = state.trips.find((t) => t.id === id);
  if (!trip) {
    trip = defaultTrip(state.trips);
    if (trip) history.replaceState(null, "", "#" + trip.id);
  }
  if (!trip) { $app.innerHTML = renderHome(state.trips, state.user); return; }
  watchTrip(trip.id);
  $app.innerHTML = renderTrip(trip, state.docs[trip.id] || {}, state.live[trip.id] || {});
}

// ---------------------------------------------------------------- Firebase

let auth, db, watched = null, liveUnsub = null;

function watchTrip(id) {
  if (watched === id) return;
  watched = id;
  if (liveUnsub) liveUnsub();
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
function say(msg) { toast.textContent = msg; toast.classList.add("show"); clearTimeout(tt); tt = setTimeout(() => toast.classList.remove("show"), 1800); }

const scan = document.getElementById("scan");
function openScan(docId) {
  const d = (state.docs[watched] || {})[docId];
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
  if (el.dataset.action === "logout") { await signOut(auth); history.replaceState(null, "", location.pathname); }
});

window.addEventListener("hashchange", () => {
  if (location.hash.startsWith("#doc-")) { // ancre vers une carte d'embarquement
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
    return;
  }
  render();
  window.scrollTo(0, 0);
});
setInterval(() => { if (state.user && state.loaded && !scan.classList.contains("open")) render(); }, 60000);

start();
