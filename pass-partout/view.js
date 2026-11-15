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
  const delayed = live.delay_min >= 5 && live.revised_utc;
  if (st && !(live.status === "Delayed" && delayed)) out.push(`<span class="chip ${bad ? "bad" : "live"}">${st}</span>`);
  if (delayed) out.push(`<span class="chip bad">Retard ${live.delay_min} min · ${hhmm(live.revised_utc, tz)}</span>`);
  return out;
}

export function buildEvents(trip, live = {}) {
  const tz = trip.tz || "Europe/Paris";
  const ev = [];
  const flights = trip.flights || [];
  const p = trip.parking, h = trip.hotel;
  const last = flights[flights.length - 1];

  if (p) {
    ev.push({ at: p.access_at || p.entry_at, title: p.name,
      chips: [`<span class="chip strong">${esc(p.code)}</span>`],
      text: `Accès possible dès ${hhmm(p.access_at || p.entry_at, tz)} (réservé à ${hhmm(p.entry_at, tz)}). ${p.instructions || ""}`,
      links: [{ label: "Itinéraire vers le parking", url: maps(p.place || p.name, "driving") }] });
  }

  flights.forEach((f) => {
    const l = live[f.id];
    const tzDep = tz;
    if (f.checkin_open_at) {
      ev.push({ at: f.checkin_open_at, title: `Enregistrement ${f.airline} ouvert`,
        chips: [`<span class="chip strong">${esc(f.booking_ref)}</span>`, `<span class="chip">jusqu'à 1 h avant le départ</span>`],
        links: f.checkin_url ? [{ label: `S'enregistrer chez ${f.airline}`, url: f.checkin_url }] : [] });
    }
    const boardTxt = `Embarquement vers ${hhmm(f.boarding_at, tzDep)}${f.boarding_door ? `, par l'${f.boarding_door.toLowerCase()}` : ""}.`;
    if (f.gate_close_at) {
      ev.push({ at: f.gate_close_at, title: "Fermeture de la porte", text: `${boardTxt} Porte affichée sur les écrans environ 1 h avant.` });
    }
    const chips = [];
    if (f.seat) chips.push(`<span class="chip strong">${esc(f.seat)}</span>`);
    if (f.booking_ref) chips.push(`<span class="chip">Réf. ${esc(f.booking_ref)}</span>`);
    if (f.bags) chips.push(`<span class="chip">${esc(f.bags)}</span>`);
    ev.push({ at: f.dep_at, key: true, flightId: f.id,
      title: `${f.airline} ${f.display || f.flight} · ${f.from} → ${f.to}`,
      chips: [...liveChips(l, f, tzDep), ...chips], note: f.note,
      text: f.gate_close_at ? "" : `${boardTxt} Porte connue après l'enregistrement ou sur les écrans.`,
      revised: l && l.delay_min >= 5 && l.revised_utc ? hhmm(l.revised_utc, tzDep) : null,
      links: [{ label: "Carte d'embarquement", url: `#doc-${f.id}`, primary: !!f.boarding_pass }] });

    const arrLinks = [];
    let arrText = "";
    const arrivesAtHotel = h && f !== last && f.arr_at <= h.checkin_at.slice(0, 10) + "T23:59";
    if (arrivesAtHotel) arrLinks.push({ label: "Itinéraire vers l'hôtel", url: maps(`${h.name}, ${h.address}`, "transit") });
    if (f === last && flights.length > 1) {
      if (p) arrText = `Puis ${p.name} : sortie prévue ${hhmm(p.exit_at, tz)}${p.tolerance_h ? `, tolérance de ${p.tolerance_h} h sans supplément` : ""}. Ticket d'entrée à présenter.`;
      if (trip.home) arrLinks.push({ label: "Itinéraire vers la maison", url: maps(trip.home, "driving") });
    }
    ev.push({ at: f.arr_at, title: `Arrivée ${f.to_name || f.to}${f.to_terminal ? `, terminal ${f.to_terminal}` : ""}`, text: arrText, links: arrLinks });
  });

  if (h) {
    ev.push({ at: h.checkin_at, title: `Check-in ${h.name}`, text: `${h.address}. Bagages déposables avant si besoin.` });
    const nextF = flights.find((f) => f.dep_at > h.checkout_at);
    ev.push({ at: h.checkout_at, title: `Check-out ${h.name}`, text: h.to_pay ? `À régler : ${h.to_pay}.` : "",
      links: nextF ? [{ label: `Itinéraire vers ${nextF.from_name || nextF.from}`, url: maps(`Aéroport ${nextF.from_name || nextF.from}${nextF.from_terminal ? " Terminal " + nextF.from_terminal : ""}`, "transit") }] : [] });
  }
  return ev.filter((e) => e.at).sort((a, b) => new Date(a.at) - new Date(b.at));
}

export function nextEvent(events, now = Date.now()) {
  return events.find((e) => new Date(e.at).getTime() >= now - 10 * 60000) || null;
}

function renderEvent(e, tz, now) {
  const past = new Date(e.at).getTime() < now - 30 * 60000;
  const links = (e.links || []).map((l) => `<a class="btn${l.primary ? " primary" : ""}" href="${esc(l.url)}"${l.url.startsWith("#") ? "" : ' target="_blank" rel="noopener"'}>${esc(l.label)}</a>`).join("");
  return `<li class="ev${e.key ? " key" : ""}${past ? " past" : ""}"${e.flightId ? ` data-flight="${esc(e.flightId)}"` : ""}>
    <span class="t">${e.revised ? `${e.revised}<s>${hhmm(e.at, tz)}</s>` : hhmm(e.at, tz)}</span>
    <div class="body">
      <span class="title">${esc(e.title)}</span>
      ${e.chips?.length ? `<div class="chips">${e.chips.join("")}</div>` : ""}
      ${e.note ? `<span class="note">${esc(e.note)}</span>` : ""}
      ${e.text ? `<span class="muted">${esc(e.text)}</span>` : ""}
      ${links ? `<div class="btns">${links}</div>` : ""}
    </div></li>`;
}

export function renderTrip(trip, docs = {}, live = {}, now = Date.now()) {
  const tz = trip.tz || "Europe/Paris";
  const events = buildEvents(trip, live);
  const days = [];
  events.forEach((e) => {
    const p = fmtParts(e.at, tz);
    let d = days[days.length - 1];
    if (!d || d.key !== p.dayKey) days.push(d = { key: p.dayKey, label: `${cap(p.weekday)} ${p.day}`, items: [] });
    d.items.push(e);
  });
  const nx = nextEvent(events, now);
  const nxWhen = nx ? (() => { const p = fmtParts(nx.at, tz); const t = new Date(nx.at).getTime();
    return `${cap(p.weekday)} ${p.day} ${p.month} à ${p.time} · ${t > now ? rel(t - now) : "maintenant"}`; })() : "Bon retour !";

  const flights = trip.flights || [];
  const docCards = flights.map((f) => {
    const d = f.boarding_pass && docs[f.boarding_pass];
    const head = `<div class="row"><h3>${esc(f.airline)} ${esc(f.display || f.flight)}</h3><span class="muted num">${esc(shortDate(f.dep_at, tz))} · ${hhmm(f.dep_at, tz)}</span></div>`;
    if (d && d.image) {
      return `<article class="card" id="doc-${esc(f.id)}">${head}
        <button class="bp" type="button" data-scan="${esc(f.boarding_pass)}" aria-label="Afficher le code-barres en plein écran"><img src="${d.image}" alt="Carte d'embarquement ${esc(d.label || "")}"></button>
        <span class="muted small">Touche la carte pour afficher le code-barres en grand. Monte la luminosité. L'appli de la compagnie reste la version de référence.</span></article>`;
    }
    const msg = f.checkin_open_at ? `Disponible après l'enregistrement, à partir du ${shortDate(f.checkin_open_at, tz)} à ${hhmm(f.checkin_open_at, tz)}.` : "Pas encore de carte d'embarquement.";
    return `<article class="card" id="doc-${esc(f.id)}">${head}<div class="pending">${esc(msg)}<br>Envoie-la à Claude pour l'ajouter ici.</div></article>`;
  }).join("");

  const p = trip.parking, h = trip.hotel;
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
  const hotelCard = h ? `<article class="card">
      <div class="row"><h3>${esc(h.name)}</h3></div>
      <dl class="num">
        <dt>Adresse</dt><dd>${esc(h.address)}</dd>
        <dt>Arrivée</dt><dd>${esc(shortDate(h.checkin_at, tz))} · à partir de ${hhmm(h.checkin_at, tz)}</dd>
        <dt>Départ</dt><dd>${esc(shortDate(h.checkout_at, tz))} · avant ${hhmm(h.checkout_at, tz)}</dd>
        ${h.booking_ref ? `<dt>Réservation</dt><dd><span class="code">${esc(h.booking_ref)}</span>${h.hotel_ref ? ` · hôtel n° ${esc(h.hotel_ref)}` : ""}</dd>` : ""}
        ${h.room ? `<dt>Chambre</dt><dd>${esc(h.room)}</dd>` : ""}
        ${h.to_pay ? `<dt>À payer</dt><dd>${esc(h.to_pay)}</dd>` : ""}
        ${h.phone ? `<dt>Téléphone</dt><dd>${esc(h.phone)}</dd>` : ""}
      </dl>
      <div class="btns">
        <a class="btn primary" href="${esc(maps(`${h.name}, ${h.address}`, "transit"))}" target="_blank" rel="noopener">Itinéraire vers l'hôtel</a>
        ${h.precheckin_url ? `<a class="btn" href="${esc(h.precheckin_url)}" target="_blank" rel="noopener">Pré-enregistrement</a>` : ""}
      </div>
    </article>` : "";
  const refsCard = trip.refs?.length ? `<article class="card"><h3>Références</h3><dl>${trip.refs.map((r) => `<dt>${esc(r.label)}</dt><dd class="code">${esc(r.value)}</dd>`).join("")}</dl></article>` : "";
  const polled = Object.values(live).map((l) => l.polled_at).filter(Boolean).sort().pop();

  return `
    <div class="topbar"><a class="brand" href="#voyages">Mes voyages</a><button class="linkbtn" data-action="logout">Déconnexion</button></div>
    <header class="trip">
      <div class="kicker">Pass-partout · carnet de voyage</div>
      <h1>${esc(trip.title)}, ${esc(fmtParts(trip.start_at, tz).day)} → ${esc(fmtParts(trip.end_at, tz).day)} ${esc(fmtParts(trip.end_at, tz).month)}</h1>
      ${trip.subtitle ? `<div class="muted">${esc(trip.subtitle)}</div>` : ""}
    </header>
    <section class="next" aria-live="polite">
      <span class="lbl">Prochaine étape</span>
      <span class="what">${esc(nx ? nx.title : "Voyage terminé")}</span>
      <span class="when">${esc(nxWhen)}</span>
    </section>
    ${days.map((d) => `<section class="day"><div class="day-head"><h2>${esc(d.label)}</h2></div><ol class="timeline">${d.items.map((e) => renderEvent(e, tz, now)).join("")}</ol></section>`).join("")}
    <section class="cards">
      <h2>Documents</h2>${docCards}
      ${parkingCard || hotelCard || refsCard ? `<h2>Pratique</h2>${parkingCard}${hotelCard}${refsCard}` : ""}
    </section>
    <footer>
      <span>Données mises à jour ${trip.updated_at ? `le ${esc(shortDate(trip.updated_at, tz))} à ${hhmm(trip.updated_at, tz)}` : ""}${polled ? ` · suivi des vols à ${hhmm(polled, tz)}` : ""}.</span>
      <span>Porte, retard et annulation s'affichent ici en direct et arrivent aussi par notification.</span>
    </footer>`;
}
