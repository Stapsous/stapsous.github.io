// Note de frais d'un voyage pro : lignes prêtes à recopier dans Unit4, champ par champ.
// Lignes : expenses de trips.yaml + dépenses ajoutées dans l'appli (trips/{id}/ndf/{ligne}, custom).
// L'état par ligne (saisi, justificatif photo, montant corrigé, arbitrage pro/perso) vit dans la même sous-collection.

import { esc, sec } from "./view.js?v=18";

export const CATEGORIES = ["Transport aérien", "Train", "Taxi / VTC", "Transports en commun", "Location de véhicule", "Carburant",
  "Péage", "Parking", "Indemnités kilométriques", "Hébergement", "Repas", "Repas d'affaires", "Autre"];

const money = (n) => n == null || n === "" ? "" : Number(n).toFixed(2).replace(".", ",");
const frDate = (iso) => { const [y, m, d] = String(iso || "").slice(0, 10).split("-"); return y && m && d ? `${d}/${m}/${y}` : ""; };

export function ndfLines(trip, st = {}) {
  const lines = (trip.expenses || []).map((e) => ({ ...e, ...(st[e.id] || {}), yaml: e, id: e.id }));
  Object.entries(st).forEach(([id, s]) => { if (s.custom) lines.push({ ...s, id }); });
  return lines.map((l) => {
    const amount = l.amount_fixed ?? l.amount;
    const decided = l.decision || (l.yaml?.status === "to_validate" ? null : "pro");
    const issues = [];
    if (decided === null) issues.push("Pro ou perso à arbitrer");
    if (amount == null || amount === "") issues.push("Montant à renseigner");
    if (l.yaml?.status === "to_complete" && !l.amount_fixed) issues.push("À compléter");
    const hasReceipt = !!(l.receipt_img || (l.yaml?.receipt && l.yaml.status !== "missing"));
    if (!hasReceipt && l.category !== "Indemnités kilométriques") issues.push("Justificatif manquant");
    return { ...l, amount, decided, issues, hasReceipt };
  }).sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function field(label, value) {
  if (!value) return "";
  return `<div class="nf"><span class="muted small">${esc(label)}</span><span class="nv">${esc(value)}</span><button class="cp" type="button" data-copy="${esc(value)}" aria-label="Copier ${esc(label)}">Copier</button></div>`;
}

function line(l) {
  const out = l.decided === "perso";
  const link = l.yaml?.receipt?.url;
  const linkLabel = l.yaml?.receipt?.label;
  return `<article class="card ndf-line${l.done ? " done" : ""}${out ? " out" : ""}" id="ndf-${esc(l.id)}">
    <div class="row"><h3>${esc(l.category || "Dépense")}</h3><span class="amt num">${l.amount != null && l.amount !== "" ? money(l.amount) + " €" : "?"}</span></div>
    ${out ? `<span class="muted small">Exclu de la note de frais (perso).</span>` : `
    <div class="nfs">
      ${field("Date", frDate(l.date))}
      ${field("Type", l.category)}
      ${field("Montant TTC", money(l.amount))}
      ${field("Fournisseur", l.vendor)}
      ${field("Description", l.label)}
    </div>`}
    ${l.note ? `<span class="muted small">${esc(l.note)}</span>` : ""}
    ${l.issues.length && !out ? `<div class="chips">${l.issues.map((i) => `<span class="chip bad">${esc(i)}</span>`).join("")}</div>` : ""}
    <div class="btns">
      ${l.yaml?.status === "to_validate" ? `<button class="btn${l.decided === "pro" ? " primary" : ""}" type="button" data-action="ndf-decide" data-line="${esc(l.id)}" data-v="pro">Pro</button><button class="btn${out ? " primary" : ""}" type="button" data-action="ndf-decide" data-line="${esc(l.id)}" data-v="perso">Perso</button>` : ""}
      ${link ? `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener">${esc(linkLabel || "Justificatif Gmail")}</a>` : ""}
      ${l.receipt_img ? `<button class="btn" type="button" data-action="ndf-view" data-line="${esc(l.id)}">Voir le justificatif</button>` : ""}
      <button class="btn" type="button" data-action="ndf-receipt" data-line="${esc(l.id)}">${l.receipt_img ? "Remplacer" : "Photo du justificatif"}</button>
      <button class="linkbtn" type="button" data-action="ndf-amount" data-line="${esc(l.id)}">Corriger le montant</button>
      ${l.custom ? `<button class="linkbtn" type="button" data-action="ndf-del" data-line="${esc(l.id)}">Supprimer</button>` : ""}
    </div>
    ${out ? "" : `<label class="saisi"><input type="checkbox" data-action="ndf-done" data-line="${esc(l.id)}"${l.done ? " checked" : ""}> Saisi dans Unit4</label>`}
  </article>`;
}

export function renderNdf(trip, st = {}) {
  const lines = ndfLines(trip, st);
  const pro = lines.filter((l) => l.decided !== "perso");
  const total = pro.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const done = pro.filter((l) => l.done);
  const todo = pro.filter((l) => l.issues.length);
  const today = new Date().toISOString().slice(0, 10);
  return `<div class="ndf">${sec("ndf", "Note de frais", `
    <article class="card">
      <div class="row"><h3>Total pro</h3><span class="amt num">${money(total)} €</span></div>
      <span class="muted small">${done.length}/${pro.length} ligne(s) saisie(s) dans Unit4${todo.length ? ` · ${todo.length} à régler avant saisie` : ""}.</span>
      ${trip.pro_note ? `<span class="muted small">${esc(trip.pro_note)}</span>` : ""}
      ${todo.length ? `<ul class="todo">${todo.map((l) => `<li><a href="#ndf-${esc(l.id)}" data-action="ndf-goto">${esc(l.label || l.category)}</a> : ${esc(l.issues.join(", "))}</li>`).join("")}</ul>` : ""}
    </article>
    ${lines.map(line).join("")}
    <details class="card ndf-add">
      <summary><h3>Ajouter une dépense</h3></summary>
      <form id="ndf-form" class="nform">
        <label>Date<input type="date" name="date" value="${today}" required></label>
        <label>Type<select name="category">${CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join("")}</select></label>
        <label>Montant TTC (€)<input type="text" name="amount" inputmode="decimal" placeholder="23,50" required></label>
        <label>Fournisseur<input type="text" name="vendor" placeholder="G7, SNCF, restaurant…"></label>
        <label>Description<input type="text" name="label" placeholder="Taxi Orly → hôtel" required></label>
        <label>Justificatif<input type="file" name="receipt" accept="image/*,application/pdf"></label>
        <button class="btn primary" type="submit">Ajouter</button>
      </form>
    </details>`)}</div>`;
}
