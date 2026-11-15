// Rendu des écrans à partir des données Firestore (fonctions pures, testables sans navigateur).

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const maps = (dest, mode) =>
  `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=${mode}`;

function fmtParts(iso, tz) {
  const d = new Date(iso);
  const p = Object.fromEntries(new Intl.DateTimeFormat("fr-FR", {
    timeZone: tz, weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).map((x) => [x.type, x.value]));
  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return { time: `${p.hour}:${p.minute}`, weekday: p.weekday, day: p.day, month: p.month.replace(".", ""), dayKey };
}
export const hhmm = (iso, tz) => fmtParts(iso, tz).time;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const shortDate = (iso, tz) => { const p = fmtParts(iso, tz); return `${p.weekday.slice(0, 3)}. ${p.day} ${p.month}`; };

export function rel(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `dans ${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return `dans ${h} h${r ? " " + String(r).padStart(2, "0") : ""}`;
  const d = Math.round(h / 24);
  return `dans ${d} jour${d > 1 ? "s" : ""}`;
}

// ---------------------------------------------------------------- accueil

export function tripStatus(t, now = Date.now()) {
  const s = new Date(t.start_at).getTime(), e = new Date(t.end_at).getTime();
  if (now >= s && now <= e) return "now";
  return now < s ? "soon" : "past";
}

/** Voyage à ouvrir par défaut : en cours, sinon le prochain, sinon le dernier passé. */
export function defaultTrip(trips, now = Date.now()) {
  const cur = trips.find((t) => tripStatus(t, now) === "now");
  if (cur) return cur;
  const fut = trips.filter((t) => tripStatus(t, now) === "soon").sort((a, b) => a.start_at.localeCompare(b.start_at));
  if (fut.length) return fut[0];
  const past = trips.slice().sort((a, b) => b.end_at.localeCompare(a.end_at));
  return past[0] || null;
}

export function renderHome(trips, user, now = Date.now()) {
  const groups = { now: [], soon: [], past: [] };
  trips.forEach((t) => groups[tripStatus(t, now)].push(t));
  groups.soon.sort((a, b) => a.start_at.localeCompare(b.start_at));
  groups.past.sort((a, b) => b.end_at.localeCompare(a.end_at));
  const card = (t, st) => {
    const tz = t.tz || "Europe/Paris";
    const when = st === "now" ? "En cours" : st === "soon" ? rel(new Date(t.start_at) - now) : "Terminé";
    return `<a class="tripcard ${st}" href="#${esc(t.id)}">
      <span class="ttl">${esc(t.title)}</span><span class="when">${esc(when)}</span>
      <span class="dates">${esc(shortDate(t.start_at, tz))} → ${esc(shortDate(t.end_at, tz))}</span>
      ${t.subtitle ? `<span class="sub">${esc(t.subtitle)}</span>` : ""}
    </a>`;
  };
  const section = (title, list, st) => list.length ? `<section class="trips"><h2>${title}</h2>${list.map((t) => card(t, st)).join("")}</section>` : "";
  return `
    <div class="topbar"><span class="brand">Pass-partout</span><button class="linkbtn" data-action="logout">Déconnexion</button></div>
    <header class="trip"><h1>Mes voyages</h1><span class="muted small">${esc(user?.email || "")}</span></header>
    <section class="scan card">
      <div class="row"><h3>Importer depuis Gmail</h3></div>
      <span class="muted small">Cherche tes confirmations de vols, hôtels, trains et locations des 12 derniers mois et crée les voyages. Lecture seule, rien n'est conservé à part les voyages trouvés.</span>
      <div class="btns"><button class="btn primary" type="button" data-action="scan-gmail">Scanner mes mails</button></div>
      <span class="small" id="scan-status" aria-live="polite"></span>
    </section>
    ${trips.length ? "" : `<p class="empty">Aucun voyage pour ce compte pour l'instant.</p>`}
    ${section("En cours", groups.now, "now")}
    ${section("À venir", groups.soon, "soon")}
    ${section("Passés", groups.past, "past")}`;
}

// ---------------------------------------------------------------- voyage

function liveChips(live, f, tz) {
  if (!live) return [];
  const out = [];
  if (live.gate) out.push(`<span class="chip live">Porte ${esc(live.gate)}</span>`);
  if (live.terminal && !live.gate) out.push(`<span class="chip">Terminal ${esc(live.terminal)}</span>`);
  const st = { Boarding: "Embarquement", GateClosed: "Porte fermée", Departed: "Parti", EnRoute: "En vol", Arrived: "Arrivé",
    Canceled: "Annulé", Cancelled: "Annulé", CanceledUncertain: "Annulation possible", Diverted: "Dérouté", Delayed: "Retardé" }[live.status];
  const bad = ["Canceled", "Cancelled", "CanceledUncertain", "Diverted", "Delayed"].includes(live.status);
  const delayMin = live.revised_utc ? Math.round((new Date(live.revised_utc) - new Date(f.dep_at)) / 60000) : 0;
  const delayed = delayMin >= 5;
  if (st && !["Boarding", "GateClosed"].includes(live.status) && !(live.status === "Delayed" && delayed)) out.push(`<span class="chip ${bad ? "bad" : "live"}">${st}</span>`);
  if (delayed) out.push(`<span class="chip bad">Retard ${delayMin} min · ${hhmm(live.revised_utc, tz)}</span>`);
  return out;
}

export function buildEvents(trip, live = {}, docs = {}) {
  const tz = trip.tz || "Europe/Paris";
  const ev = [];
  const flights = trip.flights || [];
  const p = trip.parking;
  const hotels = trip.hotels || (trip.hotel ? [trip.hotel] : []);
  const last = flights[flights.length - 1];

  if (p) {
    ev.push({ icon: "parking", at: p.access_at || p.entry_at, title: p.name,
      chips: [`<span class="chip strong">${esc(p.code)}</span>`],
      text: `Accès possible dès ${hhmm(p.access_at || p.entry_at, tz)} (réservé à ${hhmm(p.entry_at, tz)}). ${p.instructions || ""}`,
      links: [{ label: "Itinéraire vers le parking", url: maps(p.place || p.name, "driving") }] });
  }

  flights.forEach((f) => {
    const l = live[f.id];
    const tzDep = tz;
    if (f.checkin_open_at) {
      ev.push({ icon: "checkin", at: f.checkin_open_at, title: `Enregistrement ${f.airline} ouvert`,
        chips: [`<span class="chip strong">${esc(f.booking_ref)}</span>`, `<span class="chip">jusqu'à 1 h avant le départ</span>`],
        links: f.checkin_url ? [{ label: `S'enregistrer chez ${f.airline}`, url: f.checkin_url }] : [] });
    }
    // Dépose des bagages en soute (si le vol en a)
    if (f.bagdrop_open_at) {
      const n = Number(f.checked_bags) || 1;
      ev.push({ icon: "bag", at: f.bagdrop_open_at, title: `Dépose bagages ${f.airline}`,
        chips: [`<span class="chip strong">${n} bagage${n > 1 ? "s" : ""} en soute</span>`, `<span class="chip bad">ferme à ${hhmm(f.bagdrop_close_at, tz)}</span>`],
        text: `Comptoir ${f.airline} ouvert de ${hhmm(f.bagdrop_open_at, tz)} à ${hhmm(f.bagdrop_close_at, tz)}${f.from_terminal ? `, terminal ${f.from_terminal}` : ""}. Carte d'embarquement et pièce d'identité en main.` });
    }
    // Embarquement : horaire et porte estimés tant que la compagnie ne les a pas donnés
    const shiftMs = l && l.revised_utc ? new Date(l.revised_utc) - new Date(f.dep_at) : 0;
    const boardAt = new Date(new Date(f.boarding_at).getTime() + shiftMs).toISOString();
    const gateKnown = !!(l && l.gate);
    const boarding = l && ["Boarding", "GateClosed"].includes(l.status);
    const gateAnnounce = new Date(new Date(f.dep_at).getTime() + shiftMs - 60 * 60000).toISOString();
    const bchips = [gateKnown
      ? `<span class="chip live">Porte ${esc(l.gate)}</span>`
      : `<span class="chip est">Porte à confirmer · affichée vers ${hhmm(gateAnnounce, tzDep)}</span>`];
    if (l && l.terminal) bchips.push(`<span class="chip">Terminal ${esc(l.terminal)}</span>`);
    if (boarding) bchips.unshift(`<span class="chip live">${l.status === "Boarding" ? "Embarquement en cours" : "Porte fermée"}</span>`);
    if (f.seat) bchips.push(`<span class="chip strong">${esc(f.seat)}</span>`);
    const btxt = [f.boarding_door ? `Embarquement par l'${f.boarding_door.toLowerCase()}.` : "",
      f.gate_close_at ? `Porte fermée à ${hhmm(new Date(new Date(f.gate_close_at).getTime() + shiftMs).toISOString(), tzDep)}.` : "",
      boarding ? "" : `Horaire estimé${f.boarding_before_min ? ` (${f.boarding_before_min} min avant le départ)` : ""}.`].filter(Boolean).join(" ");
    const doc = f.boarding_pass && docs[f.boarding_pass];
    const viaParking = p && f === flights[0];
    const airport = `Aéroport ${f.from_name || f.from}${f.from_terminal ? " Terminal " + f.from_terminal : ""}`;
    ev.push({ icon: "boarding", at: boardAt,
      links: viaParking ? [] : [{ label: `Itinéraire vers ${f.from_name || "l'aéroport"}`, url: maps(airport, "transit") }], estimated: !boarding, title: `Embarquement ${f.airline} ${f.display || f.flight}`,
      chips: bchips, text: btxt,
      flightRef: f.id,
      scan: doc ? { id: f.boarding_pass, img: doc.barcode || doc.image, label: doc.meta || doc.label } : null,
      pendingScan: !doc ? (f.checkin_open_at ? `Carte d'embarquement disponible après l'enregistrement (${shortDate(f.checkin_open_at, tz)} à ${hhmm(f.checkin_open_at, tz)}).` : "Pas encore de carte d'embarquement. Ajoute le PDF ou une capture depuis l'appli de la compagnie.") : null });

    const chips = [];
    if (f.seat) chips.push(`<span class="chip strong">${esc(f.seat)}</span>`);
    if (f.booking_ref) chips.push(`<span class="chip">Réf. ${esc(f.booking_ref)}</span>`);
    if (f.bags) chips.push(`<span class="chip">${esc(f.bags)}</span>`);
    ev.push({ icon: "takeoff", at: f.dep_at, key: true, flightId: f.id,
      title: `${f.airline} ${f.display || f.flight} · ${f.from} → ${f.to}`,
      chips: [...liveChips(l, f, tzDep).filter((c) => !c.includes("Porte ")), ...chips], note: f.note,
      revised: l && l.revised_utc && (new Date(l.revised_utc) - new Date(f.dep_at)) >= 5 * 60000 ? hhmm(l.revised_utc, tzDep) : null,
      links: f.boarding_pass ? [{ label: "Carte complète", url: `#doc-${f.id}` }] : [] });

    const arrLinks = [];
    let arrText = "";
    if (f === last && flights.length > 1) {
      if (p) arrText = `Puis ${p.name} : sortie prévue ${hhmm(p.exit_at, tz)}${p.tolerance_h ? `, tolérance de ${p.tolerance_h} h sans supplément` : ""}. Ticket d'entrée à présenter.`;
      if (trip.home) arrLinks.push({ label: "Itinéraire vers la maison", url: maps(trip.home, "driving") });
    }
    ev.push({ icon: "landing", at: f.arr_at, title: `Arrivée ${f.to_name || f.to}${f.to_terminal ? `, terminal ${f.to_terminal}` : ""}`, text: arrText, links: arrLinks });
  });

  hotels.forEach((h, i) => {
    const prev = hotels[i - 1], next = hotels[i + 1];
    const tag = hotels.length > 1 && h.booking_ref ? ` (résa ${h.booking_ref})` : "";
    const sameAsPrev = prev && prev.name === h.name && prev.checkout_at.slice(0, 10) === h.checkin_at.slice(0, 10);
    const sameAsNext = next && next.name === h.name && h.checkout_at.slice(0, 10) === next.checkin_at.slice(0, 10);
    ev.push({ icon: "hotel", at: h.checkin_at, title: sameAsPrev ? `Nouvelle réservation ${h.name}${tag}` : `Check-in ${h.name}${tag}`,
      text: sameAsPrev ? "Même hôtel : voir à la réception si la chambre change." : `${h.address}. Bagages déposables avant si besoin.`,
      links: sameAsPrev ? [] : [{ label: "Itinéraire vers l'hôtel", url: maps(`${h.name}, ${h.address}`, "transit") }] });
    ev.push({ icon: "hotel", at: h.checkout_at, title: sameAsNext ? `Fin de la réservation${tag}` : `Check-out ${h.name}${tag}`,
      text: h.to_pay ? `À régler : ${h.to_pay}.` : "" });
  });
  // Autres réservations importées des mails : trains, cars, locations, événements, restaurants
  (trip.extras || []).forEach((x) => {
    const ref = x.ref ? [`<span class="chip">Réf. ${esc(x.ref)}</span>`] : [];
    if (x.kind === "train" || x.kind === "bus") {
      const label = x.kind === "train" ? "Train" : "Car";
      ev.push({ icon: x.kind, at: x.at, key: true, title: `${label} ${[x.operator, x.number].filter(Boolean).join(" ")} · ${x.from_name} → ${x.to_name}`,
        chips: [...(x.seat ? [`<span class="chip strong">${x.coach ? "Voiture " + esc(x.coach) + " · " : ""}Place ${esc(x.seat)}</span>`] : []), ...ref],
        links: [{ label: `Itinéraire vers ${x.from_name}`, url: maps(x.from_name, "transit") }] });
      if (x.end && x.end !== x.at) ev.push({ icon: x.kind, at: x.end, title: `Arrivée ${x.to_name}` });
    } else if (x.kind === "car") {
      ev.push({ icon: "car", at: x.at, title: `Prise du véhicule ${x.company || ""}`.trim(), chips: ref, text: x.pickup,
        links: x.pickup ? [{ label: "Itinéraire vers l'agence", url: maps(x.pickup, "transit") }] : [] });
      if (x.end && x.end !== x.at) ev.push({ icon: "car", at: x.end, title: "Restitution du véhicule", text: x.dropoff,
        links: x.dropoff ? [{ label: "Itinéraire vers l'agence", url: maps(x.dropoff, "driving") }] : [] });
    } else if (x.kind === "note") {
      ev.push({ icon: "note", at: x.at, title: x.title || "Note", text: x.text || "" });
    } else {
      const chips = [...ref];
      if (x.people) chips.unshift(`<span class="chip strong">${esc(x.people)} pers.</span>`);
      if (x.prepaid) chips.push(`<span class="chip">${esc(x.prepaid)}</span>`);
      const text = [x.address, x.dress, x.phone && `Tél. ${x.phone}`].filter(Boolean).join(" · ");
      ev.push({ icon: x.kind === "restaurant" ? "restaurant" : "note", at: x.at, key: x.kind === "restaurant", title: (x.kind === "restaurant" ? "Dîner · " : "") + (x.name || (x.kind === "restaurant" ? "Restaurant" : "Événement")),
        chips, text, links: x.address ? [{ label: "Itinéraire", url: maps(`${x.name || ""}, ${x.address}`, "transit") }] : [] });
    }
  });
  return ev.filter((e) => e.at).sort((a, b) => new Date(a.at) - new Date(b.at));
}

/** Une étape est passée 15 min avant l'heure de la suivante (la dernière : 15 min après son heure). */
export function nextEvent(events, now = Date.now()) {
  const M = 15 * 60000;
  for (let i = 0; i < events.length; i++) {
    const limit = i + 1 < events.length ? new Date(events[i + 1].at).getTime() - M : new Date(events[i].at).getTime() + M;
    if (now < limit) return events[i];
  }
  return null;
}

const ICONS = {
  parking: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M10 17V7h3a3 3 0 0 1 0 6h-3"/>',
  checkin: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M9.5 12l2 2 3.5-4"/>',
  boarding: '<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v8a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2z"/><path d="M15 6v2m0 3v2m0 3v2"/>',
  takeoff: '<path d="M2 20h20"/><path d="M3.5 14.5l2.3 2.1c.4.3.9.4 1.4.3L21 13.4a1.6 1.6 0 0 0-.8-3.1l-4.6 1.2L9.5 6.5l-2.3.6 3.3 5.1-3.4.9-2-1.4-1.7.5z"/>',
  landing: '<path d="M2 20h20"/><path d="M3.8 6.6l.7 5.4c.1.5.4.9.9 1.1l13.6 3.6a1.6 1.6 0 0 0 .8-3.1l-4.6-1.2-2.7-7.4-2.3-.6.7 6-3.4-.9-.8-2.3z"/>',
  bag: '<rect x="5" y="7" width="14" height="13" rx="2"/><path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7M9 11v5M15 11v5"/>',
  hotel: '<path d="M3 19V6M3 15h18v4M21 15v-3a3 3 0 0 0-3-3h-7v6"/><circle cx="7" cy="11" r="2"/>',
  train: '<rect x="5" y="3" width="14" height="13" rx="3"/><path d="M5 10h14M9 20l-2 2m8-2l2 2M9 13h.01M15 13h.01"/>',
  bus: '<rect x="4" y="3" width="16" height="15" rx="2.5"/><path d="M4 11h16M7 21v-3m10 3v-3M8 14.5h.01M16 14.5h.01"/>',
  car: '<path d="M5 16V11l2-5h10l2 5v5z"/><path d="M5 11h14M6 16v3m12-3v3M8 13.5h.01M16 13.5h.01"/>',
  note: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  restaurant: '<path d="M7 3v8a2 2 0 0 0 2 2v8M5 3v5a2 2 0 0 0 2 2M11 3v5a2 2 0 0 1-2 2M17 21V3c-2 1-3 3.5-3 7v3h3"/>',
};
const icon = (k) => ICONS[k] ? `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>` : `<span class="ico"></span>`;

function renderEvent(e, tz, now, status) {
  const past = status === "past", isNext = status === "next";
  const t = new Date(e.at).getTime();
  const relTxt = isNext ? (t > now ? rel(t - now) : "maintenant") : "";
  const links = (e.links || []).map((l) => `<a class="btn${l.primary ? " primary" : ""}" href="${esc(l.url)}"${l.url.startsWith("#") ? "" : ' target="_blank" rel="noopener"'}>${esc(l.label)}</a>`).join("");
  return `<li class="ev${e.key ? " key" : ""}${past ? " past" : ""}${isNext ? " is-next" : ""}"${isNext ? ' aria-current="step"' : ""}${e.flightId ? ` data-flight="${esc(e.flightId)}"` : ""}>
    <div class="lead"><span class="t"><span class="hl">${e.revised || hhmm(e.at, tz)}</span>${e.revised ? `<s>${hhmm(e.at, tz)}</s>` : e.estimated ? `<i>estimé</i>` : ""}</span>${icon(e.icon)}</div>
    <div class="body">
      <span class="title"><span class="hl">${esc(e.title)}</span>${isNext ? `<span class="rel">${esc(relTxt)}</span>` : ""}</span>
      ${e.chips?.length ? `<div class="chips">${e.chips.join("")}</div>` : ""}
      ${e.note ? `<span class="note">${esc(e.note)}</span>` : ""}
      ${e.text ? `<span class="muted">${esc(e.text)}</span>` : ""}
      ${e.scan ? `<button class="scanbox" type="button" data-scan="${esc(e.scan.id)}" aria-label="Afficher le code-barres en plein écran"><img src="${e.scan.img}" alt="Code-barres ${esc(e.scan.label || "")}"><span>${esc(e.scan.label || "")} · toucher pour agrandir</span></button>` : ""}
      ${e.pendingScan ? `<div class="pending small">${esc(e.pendingScan)}
        <div class="btns center"><button class="btn" type="button" data-action="add-card" data-flight="${esc(e.flightRef)}">Ajouter la carte</button><button class="btn" type="button" data-action="gmail-card" data-flight="${esc(e.flightRef)}">Chercher dans Gmail</button></div></div>` : ""}
      ${links ? `<div class="btns">${links}</div>` : ""}
    </div></li>`;
}

// Section repliable (même mécanique que les jours : état gardé par app.js via data-day)
export const sec = (key, title, body, open = true) =>
  `<details class="day sec" id="sec-${key}" data-day="sec-${key}"${open ? " open" : ""}>
    <summary class="day-head"><h2>${esc(title)}</h2></summary><div class="cards">${body}</div></details>`;

export function renderTrip(trip, docs = {}, live = {}, now = Date.now(), extra = "") {
  const tz = trip.tz || "Europe/Paris";
  const events = buildEvents(trip, live, docs);
  const days = [];
  events.forEach((e) => {
    const p = fmtParts(e.at, tz);
    let d = days[days.length - 1];
    if (!d || d.key !== p.dayKey) days.push(d = { key: p.dayKey, label: `${cap(p.weekday)} ${p.day} ${p.month}`, items: [] });
    d.items.push(e);
  });
  const nx = nextEvent(events, now);
  const nxIdx = nx ? events.indexOf(nx) : events.length;
  const statusOf = (e) => { const i = events.indexOf(e); return i < nxIdx ? "past" : i === nxIdx ? "next" : "future"; };

  const flights = trip.flights || [];
  const docCards = flights.map((f) => {
    const d = f.boarding_pass && docs[f.boarding_pass];
    const head = `<div class="row"><h3>${esc(f.airline)} ${esc(f.display || f.flight)}</h3><span class="muted num">${esc(shortDate(f.dep_at, tz))} · ${hhmm(f.dep_at, tz)}</span></div>`;
    const manage = `<div class="btns"><button class="btn" type="button" data-action="add-card" data-flight="${esc(f.id)}">${d ? "Remplacer la carte" : "Ajouter la carte"}</button>${d ? (d.uid ? `<button class="linkbtn" type="button" data-action="del-card" data-flight="${esc(f.id)}">Supprimer</button>` : "") : `<button class="btn" type="button" data-action="gmail-card" data-flight="${esc(f.id)}">Chercher dans Gmail</button>`}</div>`;
    if (d && (d.image || d.barcode)) {
      return `<article class="card" id="doc-${esc(f.id)}">${head}
        <button class="bp" type="button" data-scan="${esc(f.boarding_pass)}" aria-label="Afficher le code-barres en plein écran"><img src="${d.image || d.barcode}" alt="Carte d'embarquement ${esc(d.label || "")}"></button>
        ${d.meta ? `<span class="code small">${esc(d.meta)}</span>` : ""}
        <span class="muted small">Touche la carte pour afficher le code-barres en grand. Monte la luminosité. L'appli de la compagnie reste la version de référence.</span>${manage}</article>`;
    }
    const msg = f.checkin_open_at ? `Disponible après l'enregistrement, à partir du ${shortDate(f.checkin_open_at, tz)} à ${hhmm(f.checkin_open_at, tz)}.` : "Pas encore de carte d'embarquement.";
    return `<article class="card" id="doc-${esc(f.id)}">${head}<div class="pending">${esc(msg)}</div>${manage}</article>`;
  }).join("");

  const p = trip.parking;
  const hotels = trip.hotels || (trip.hotel ? [trip.hotel] : []);
  const parkingCard = p ? `<article class="card">
      <div class="row"><h3>${esc(p.name)}</h3>${p.ticket ? `<span class="muted">e-billet ${esc(p.ticket)}</span>` : ""}</div>
      <div class="row" style="align-items:center"><span class="bigcode">${esc(p.code)}</span><button class="btn" type="button" data-copy="${esc(p.code)}">Copier</button></div>
      <dl class="num">
        <dt>Entrée</dt><dd>${esc(shortDate(p.entry_at, tz))} · ${hhmm(p.entry_at, tz)}${p.access_at && p.access_at !== p.entry_at ? ` (dès ${hhmm(p.access_at, tz)})` : ""}</dd>
        <dt>Sortie</dt><dd>${esc(shortDate(p.exit_at, tz))} · ${hhmm(p.exit_at, tz)}${p.tolerance_h ? ` (+${p.tolerance_h} h tolérées)` : ""}</dd>
        ${p.instructions ? `<dt>À la borne</dt><dd>${esc(p.instructions)}</dd>` : ""}
        ${p.phone ? `<dt>Service</dt><dd>${esc(p.phone)}</dd>` : ""}
      </dl>
      <div class="btns"><a class="btn primary" href="${esc(maps(p.place || p.name, "driving"))}" target="_blank" rel="noopener">Itinéraire vers le parking</a></div>
    </article>` : "";
  const hotelCard = hotels.map((h) => `<article class="card">
      <div class="row"><h3>${esc(h.name)}</h3></div>
      <dl class="num">
        <dt>Adresse</dt><dd>${esc(h.address)}</dd>
        <dt>Arrivée</dt><dd>${esc(shortDate(h.checkin_at, tz))} · à partir de ${hhmm(h.checkin_at, tz)}</dd>
        <dt>Départ</dt><dd>${esc(shortDate(h.checkout_at, tz))} · avant ${hhmm(h.checkout_at, tz)}</dd>
        ${h.booking_ref ? `<dt>Réservation</dt><dd><span class="code">${esc(h.booking_ref)}</span>${h.hotel_ref ? ` · hôtel n° ${esc(h.hotel_ref)}` : ""}</dd>` : ""}
        ${h.room ? `<dt>Chambre</dt><dd>${esc(h.room)}</dd>` : ""}
        ${h.to_pay ? `<dt>À payer</dt><dd>${esc(h.to_pay)}</dd>` : ""}
        ${h.phone ? `<dt>Téléphone</dt><dd>${esc(h.phone)}</dd>` : ""}
        ${h.notes ? `<dt>À savoir</dt><dd>${esc(h.notes)}</dd>` : ""}
      </dl>
      <div class="btns">
        <a class="btn primary" href="${esc(maps(`${h.name}, ${h.address}`, "transit"))}" target="_blank" rel="noopener">Itinéraire vers l'hôtel</a>
        ${h.precheckin_url ? `<a class="btn" href="${esc(h.precheckin_url)}" target="_blank" rel="noopener">Pré-enregistrement</a>` : ""}
      </div>
    </article>`).join("");
  const refsCard = trip.refs?.length ? `<article class="card"><h3>Références</h3><dl>${trip.refs.map((r) => `<dt>${esc(r.label)}</dt><dd class="code">${esc(r.value)}</dd>`).join("")}</dl></article>` : "";
  const polled = Object.values(live).map((l) => l.polled_at).filter(Boolean).sort().pop();

  return `
    <div class="topbar"><a class="brand" href="#voyages">Mes voyages</a><button class="linkbtn" data-action="logout">Déconnexion</button></div>
    <header class="trip">
      <div class="kicker">Pass-partout · carnet de voyage</div>
      <h1>${esc(trip.title)}, ${esc(fmtParts(trip.start_at, tz).day)} → ${esc(fmtParts(trip.end_at, tz).day)} ${esc(fmtParts(trip.end_at, tz).month)}</h1>
      ${trip.subtitle ? `<div class="muted">${esc(trip.subtitle)}</div>` : ""}
    </header>
    <nav class="jump" aria-label="Aller à">
      ${nx ? `<button type="button" data-jump="next">Prochaine étape</button>` : ""}
      ${flights.length ? `<button type="button" data-jump="sec-docs">Documents</button>` : ""}
      ${parkingCard || hotelCard || refsCard ? `<button type="button" data-jump="sec-pratique">Pratique</button>` : ""}
      ${extra ? `<button type="button" data-jump="sec-ndf">NDF</button>` : ""}
    </nav>
    ${days.map((d) => {
      const allPast = d.items.every((e) => statusOf(e) === "past");
      return `<details class="day" data-day="${esc(d.key)}"${allPast ? "" : " open"}>
        <summary class="day-head"><h2>${esc(d.label)}</h2><span class="d">${d.items.length} étape${d.items.length > 1 ? "s" : ""}${allPast ? " · passé" : ""}</span></summary>
        <ol class="timeline">${d.items.map((e) => renderEvent(e, tz, now, statusOf(e))).join("")}</ol></details>`;
    }).join("")}
    ${sec("docs", "Documents", docCards)}
    ${parkingCard || hotelCard || refsCard ? sec("pratique", "Infos pratiques", parkingCard + hotelCard + refsCard) : ""}
    ${extra}
    <footer>
      <span>Données mises à jour ${trip.updated_at ? `le ${esc(shortDate(trip.updated_at, tz))} à ${hhmm(trip.updated_at, tz)}` : ""}${polled ? ` · suivi des vols à ${hhmm(polled, tz)}` : ""}.</span>
      <span>Porte, retard et annulation s'affichent ici en direct et arrivent aussi par notification.</span>
    </footer>`;
}
