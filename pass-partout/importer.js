// Import des réservations depuis les mails : lecture des données structurées schema.org
// (JSON-LD et microdata, celles que Gmail utilise pour ses cartes de voyage), puis regroupement en voyages.
// Fonctions pures, testables sans navigateur (la microdata demande DOMParser, présent dans le navigateur).

const TYPES = ["FlightReservation", "LodgingReservation", "TrainReservation", "BusReservation", "RentalCarReservation", "EventReservation", "FoodEstablishmentReservation"];

// ---------------------------------------------------------------- extraction

const typeOf = (o) => {
  const t = o && (o["@type"] || o.type);
  const s = Array.isArray(t) ? t[0] : t;
  return typeof s === "string" ? s.replace(/^https?:\/\/schema\.org\//, "") : "";
};

function walk(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return; }
  if (TYPES.includes(typeOf(node))) out.push(node);
  if (node["@graph"]) walk(node["@graph"], out);
  // certaines confirmations imbriquent les réservations (Order > acceptedOffer, subReservation...)
  for (const k of ["subReservation", "acceptedOffer", "itemOffered", "reservation", "mainEntity"]) if (node[k]) walk(node[k], out);
}

export function fromJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].replace(/<!--|-->/g, "").trim();
    try { walk(JSON.parse(raw), out); } catch { /* bloc invalide : ignoré */ }
  }
  return out;
}

/** Microdata (itemscope/itemprop) → objets au format JSON-LD. Navigateur uniquement. */
export function fromMicrodata(html) {
  if (typeof DOMParser === "undefined" || !/itemscope/i.test(html)) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const read = (el) => {
    const o = { "@type": (el.getAttribute("itemtype") || "").split("/").pop() };
    const props = [...el.querySelectorAll("[itemprop]")].filter((p) => p.parentElement.closest("[itemscope]") === el);
    for (const p of props) {
      const name = p.getAttribute("itemprop");
      const v = p.hasAttribute("itemscope") ? read(p)
        : p.getAttribute("content") ?? p.getAttribute("datetime") ?? p.getAttribute("href") ?? p.textContent.trim();
      o[name] = v;
    }
    return o;
  };
  const out = [];
  doc.querySelectorAll("[itemscope]").forEach((el) => {
    if (el.parentElement && el.parentElement.closest("[itemscope]")) return; // racines seulement
    walk(read(el), out);
  });
  return out;
}

export const extract = (html) => [...fromJsonLd(html), ...fromMicrodata(html)];

// ---------------------------------------------------------------- normalisation

const str = (v) => (v == null ? "" : typeof v === "object" ? (v.name || v["@id"] || "") : String(v)).trim();
const addr = (a) => {
  if (!a) return "";
  if (typeof a === "string") return a;
  return [a.streetAddress, [a.postalCode, a.addressLocality].filter(Boolean).join(" "), a.addressCountry && typeof a.addressCountry === "string" && a.addressCountry.length > 2 ? a.addressCountry : ""]
    .filter(Boolean).join(", ");
};
const city = (a) => (a && typeof a === "object" ? str(a.addressLocality) : "");
const iso = (v) => { const d = v ? new Date(str(v)) : null; return d && !isNaN(d) ? d.toISOString() : null; };

/** Une réservation schema.org → élément normalisé {kind, at, end, ...}. */
export function normalize(r) {
  const t = typeOf(r);
  const ref = str(r.reservationNumber) || str(r.confirmationNumber);
  const f = r.reservationFor || {};
  if (t === "FlightReservation") {
    const al = f.airline || {};
    const code = str(al.iataCode) || "";
    const num = str(f.flightNumber).replace(/\s+/g, "");
    const flight = /^\d+$/.test(num) ? code + num : num;
    const dep = f.departureAirport || {}, arr = f.arrivalAirport || {};
    const at = iso(f.departureTime), end = iso(f.arrivalTime);
    if (!at) return null;
    return { kind: "flight", at, end: end || at, ref,
      flight, airline: str(al.name) || code, from: str(dep.iataCode), from_name: str(dep.name) || str(dep.iataCode),
      to: str(arr.iataCode), to_name: str(arr.name) || str(arr.iataCode), city: city(arr.address) || str(arr.name),
      seat: str(r.airplaneSeat), from_terminal: str(f.departureTerminal), to_terminal: str(f.arrivalTerminal),
      gate: str(f.departureGate), boarding_at: iso(f.boardingTime), checkin_url: str(r.checkinUrl) || str(r.url) };
  }
  if (t === "LodgingReservation") {
    const at = iso(r.checkinTime || r.checkinDate), end = iso(r.checkoutTime || r.checkoutDate);
    if (!at) return null;
    return { kind: "hotel", at, end: end || at, ref, name: str(f.name), address: addr(f.address), city: city(f.address),
      phone: str(f.telephone), url: str(r.url) };
  }
  if (t === "TrainReservation" || t === "BusReservation") {
    const at = iso(f.departureTime), end = iso(f.arrivalTime);
    if (!at) return null;
    const dep = f.departureStation || f.departureBusStop || {}, arr = f.arrivalStation || f.arrivalBusStop || {};
    return { kind: t === "TrainReservation" ? "train" : "bus", at, end: end || at, ref,
      number: str(f.trainNumber || f.busNumber), operator: str(f.provider) || str(r.provider) || str(f.busCompany),
      from_name: str(dep.name), to_name: str(arr.name), city: city(arr.address) || str(arr.name),
      seat: str(r.reservedTicket?.ticketedSeat?.seatNumber), coach: str(r.reservedTicket?.ticketedSeat?.seatSection) };
  }
  if (t === "RentalCarReservation") {
    const at = iso(r.pickupTime), end = iso(r.dropoffTime);
    if (!at) return null;
    return { kind: "car", at, end: end || at, ref, company: str(f.rentalCompany) || str(r.provider),
      pickup: str(r.pickupLocation) + (r.pickupLocation?.address ? ", " + addr(r.pickupLocation.address) : ""),
      dropoff: str(r.dropoffLocation) + (r.dropoffLocation?.address ? ", " + addr(r.dropoffLocation.address) : ""),
      city: city(r.pickupLocation?.address) };
  }
  if (t === "EventReservation" || t === "FoodEstablishmentReservation") {
    const at = iso(f.startDate || r.startTime || r.startDate);
    if (!at) return null;
    const loc = f.location || f;
    return { kind: t === "EventReservation" ? "event" : "restaurant", at, end: iso(f.endDate) || at, ref,
      name: str(f.name), address: addr(loc.address), city: city(loc.address) };
  }
  return null;
}

// ---------------------------------------------------------------- regroupement en voyages

const DAY = 86400000;
const keyOf = (x) => `${x.kind}|${x.ref}|${x.at}|${x.flight || x.number || x.name || ""}`;

/**
 * Regroupe les réservations en voyages : un trou de plus de 2 jours entre deux réservations
 * ouvre un nouveau voyage. Renvoie des documents au format de Firestore (comme trips.yaml synchronisé).
 */
export function buildTrips(items, { email, uid, tz = "Europe/Paris", home = null, now = Date.now() } = {}) {
  const uniq = [...new Map(items.filter(Boolean).map((x) => [keyOf(x), x])).values()]
    .sort((a, b) => a.at.localeCompare(b.at));
  const groups = [];
  for (const x of uniq) {
    const g = groups[groups.length - 1];
    if (g && new Date(x.at) - new Date(g.end) <= 2 * DAY) { g.items.push(x); if (x.end > g.end) g.end = x.end; }
    else groups.push({ items: [x], end: x.end });
  }
  return groups.map((g) => toTrip(g.items, { email, uid, tz, home, now }));
}

const localDate = (isoStr, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(isoStr));

function toTrip(items, { email, uid, tz, home, now }) {
  const flights = items.filter((x) => x.kind === "flight");
  const hotels = items.filter((x) => x.kind === "hotel");
  const others = items.filter((x) => !["flight", "hotel"].includes(x.kind));
  const start = items[0].at, end = items.reduce((m, x) => (x.end > m ? x.end : m), items[0].end);
  // Destination : ville de l'hôtel, sinon arrivée du premier vol ou train
  const cleanAirport = (n) => (n || "").replace(/\b(a[ée]roport|airport|international)\b/gi, "").trim().split(/[-–(]| {2}/)[0].split(" ")[0];
  const dest = hotels[0]?.city || flights[0]?.city && cleanAirport(flights[0].city) || others[0]?.city || cleanAirport(flights[0]?.to_name) || "Voyage";
  const id = "g-" + localDate(start, tz) + "-" + (dest || "voyage").toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  const nights = hotels.length ? Math.round((new Date(hotels[0].end) - new Date(hotels[0].at)) / DAY) : 0;
  const sub = [
    flights.length ? [...new Set(flights.map((f) => f.from_name))].slice(0, 1).concat(flights.length > 1 ? " ⇄ " : " → ", flights[0].to_name).join("") : "",
    hotels[0]?.name || "", nights ? `${nights} nuit${nights > 1 ? "s" : ""}` : "",
  ].filter(Boolean).join(" · ");
  const trip = {
    id, title: dest, subtitle: sub, tz, home, viewers: [email.toLowerCase()], owner_uid: uid, source: "gmail",
    start_at: start, end_at: end, imported_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
    flights: flights.map((f, i) => ({
      id: `${localDate(f.at, tz)}-${f.flight}`, flight: f.flight, airline: f.airline, date: localDate(f.at, tz),
      from: f.from, from_name: f.from_name, to: f.to, to_name: f.to_name,
      from_terminal: f.from_terminal || null, to_terminal: f.to_terminal || null,
      dep_at: f.at, arr_at: f.end, booking_ref: f.ref || null, seat: f.seat || null,
      boarding_at: f.boarding_at || new Date(new Date(f.at) - 35 * 60000).toISOString(),
      boarding_before_min: f.boarding_at ? Math.round((new Date(f.at) - new Date(f.boarding_at)) / 60000) : 35,
      checkin_url: f.checkin_url || null,
    })),
    refs: [...new Map(items.filter((x) => x.ref).map((x) => [x.ref, {
      label: x.kind === "flight" ? x.airline : x.kind === "hotel" ? x.name : x.operator || x.company || x.name || x.kind,
      value: x.ref }])).values()],
    extras: others.map((x) => ({ ...x })),
  };
  if (hotels[0]) {
    const h = hotels[0];
    trip.hotel = { name: h.name, address: h.address, checkin_at: h.at, checkout_at: h.end, booking_ref: h.ref || null, phone: h.phone || null };
  }
  return trip;
}

/** Retire les réservations déjà présentes dans des voyages existants (même référence ou même vol le même jour). */
export function dropKnown(items, existingTrips) {
  const refs = new Set(), flights = new Set();
  for (const t of existingTrips) {
    (t.refs || []).forEach((r) => refs.add(String(r.value).toUpperCase()));
    (t.flights || []).forEach((f) => { if (f.booking_ref) refs.add(String(f.booking_ref).toUpperCase()); flights.add(`${f.date}|${f.flight}`); });
    if (t.hotel?.booking_ref) refs.add(String(t.hotel.booking_ref).toUpperCase());
  }
  return items.filter((x) => x && !(x.ref && refs.has(x.ref.toUpperCase())) && !(x.kind === "flight" && (flights.has(`${x.at.slice(0, 10)}|${x.flight}`) || flights.has(`${localDate(x.at, "Europe/Paris")}|${x.flight}`))));
}

// ---------------------------------------------------------------- Gmail

/** Requête Gmail : confirmations des 12 derniers mois (les voyages passés servent d'historique). */
export const GMAIL_QUERY = "newer_than:12m (réservation OR reservation OR booking OR confirmation OR billet OR \"e-ticket\" OR itinéraire OR itinerary OR \"carte d'embarquement\" OR \"boarding pass\" OR check-in) -category:promotions";

export function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

/** Corps HTML d'un message Gmail (format=full). */
export function htmlOf(payload) {
  const parts = [];
  const visit = (p) => {
    if (!p) return;
    if (p.mimeType === "text/html" && p.body?.data) parts.push(b64urlDecode(p.body.data));
    (p.parts || []).forEach(visit);
  };
  visit(payload);
  return parts.join("\n");
}
