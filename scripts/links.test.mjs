#!/usr/bin/env node
/**
 * Prueft die gebaute Website auf tote Wege.
 *
 * Anlass: Booking und Shop haben eigene Seiten bekommen. Damit koennen zwei
 * Dinge schiefgehen, die man einer Seite nicht ansieht — ein Menuepunkt auf
 * eine Seite, die es (noch) nicht gibt (der Shop entsteht nur, wenn er in der
 * Verwaltung eingeschaltet ist), und ein Sprungziel wie "#booking", das nach
 * dem Umzug auf der Startseite gar nicht mehr steht.
 *
 * Zusaetzlich wird festgehalten, wohin die Formulare senden: nur an die
 * eigenen Endpunkte. Zeigt ein Formular wieder direkt auf eine Datenbank,
 * faellt es hier auf.
 *
 * Aufruf:  node scripts/build.mjs && node scripts/links.test.mjs
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* Die Vorfuehr-Fassung liegt unter /site/ — dort tragen alle Adressen dieses
   Praefix, die Dateien liegen aber gleich. Mit demselben SITE_BASE aufrufen,
   mit dem gebaut wurde, sonst sieht der Test lauter tote Wege. */
const BASE = String(process.env.SITE_BASE || "")
  .trim()
  .replace(/\/+$/, "");
const ohneBase = (p) =>
  BASE && (p === BASE || p.startsWith(BASE + "/")) ? p.slice(BASE.length) || "/" : p;
const AUS = new Set([".git", "node_modules", "scripts", "content", "assets", "img", "media", "presskit"]);

let fehler = 0;
const meckern = (t) => {
  console.error("  FEHLER: " + t);
  fehler++;
};

/** Alle gebauten Seiten einsammeln. */
async function seiten(dir = ROOT, prefix = "") {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (AUS.has(e.name) || e.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await seiten(join(dir, e.name), rel)));
    else if (e.name.endsWith(".html")) out.push(rel);
  }
  return out;
}

const dateien = await seiten();
if (!dateien.length) {
  console.error("Keine gebauten Seiten gefunden — zuerst 'node scripts/build.mjs' laufen lassen.");
  process.exit(1);
}

const html = new Map();
for (const d of dateien) html.set(d, await readFile(resolve(ROOT, d), "utf8"));

/** Welche Adresse eine Datei bedient: "de/index.html" → "/de/" */
const adresse = (d) => "/" + d.replace(/(^|\/)index\.html$/, "$1").replace(/\/$/, "/");
const adressen = new Set(dateien.map(adresse));
const idsVon = (h) => new Set([...h.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const ids = new Map([...html].map(([d, h]) => [d, idsVon(h)]));
const dateiFuer = (pfad) =>
  dateien.find((d) => adresse(d) === pfad || adresse(d) === pfad + "/");

for (const [datei, h] of html) {
  for (const m of h.matchAll(/href="([^"]+)"/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|tel:|data:)/i.test(href)) continue;

    if (href.startsWith("#")) {
      const id = href.slice(1);
      if (id && !ids.get(datei).has(id)) meckern(`${datei}: Sprungziel "${href}" gibt es auf der Seite nicht`);
      continue;
    }
    if (!href.startsWith("/")) continue;

    const [rohZiel, frag] = href.split("#");
    const ziel = ohneBase(rohZiel);
    if (ziel.startsWith("/api/")) continue; // Endpunkte, keine Seiten
    // Dateien (Bilder, Schriften, Presskit, CSS) liegen einfach da.
    if (/\.[a-z0-9]{2,12}$/i.test(ziel) && !ziel.endsWith(".html")) {
      if (!existsSync(resolve(ROOT, ziel.slice(1)))) {
        meckern(`${datei}: "${href}" — die Datei gibt es nicht`);
      }
      continue;
    }
    const zielDatei = dateiFuer(ziel);
    if (!zielDatei && !adressen.has(ziel)) {
      meckern(`${datei}: "${href}" fuehrt auf eine Seite, die nicht gebaut wurde`);
      continue;
    }
    if (frag && zielDatei && !ids.get(zielDatei).has(frag)) {
      meckern(`${datei}: "${href}" — die Marke "#${frag}" steht auf ${zielDatei} nicht`);
    }
  }

  // Formulare senden nur an die eigenen Endpunkte.
  for (const m of h.matchAll(/data-endpoint="([^"]*)"/g)) {
    if (!/^\/api\/(booking|order)$/.test(m[1])) {
      meckern(`${datei}: Formular sendet an "${m[1]}" statt an einen eigenen Endpunkt`);
    }
  }
  // Die Schreib-Adresse der Datenbank darf nirgends mehr im Quelltext stehen.
  if (/firebasedatabase\.app/.test(h)) {
    meckern(`${datei}: Datenbank-Adresse steht im Quelltext der Seite`);
  }
}

// Jedes Formular braucht eine Erfolgs- und eine Fehlermeldung — sonst bleibt
// nach dem Absenden offen, was passiert ist.
for (const [datei, h] of html) {
  for (const m of h.matchAll(/<form\b[\s\S]*?<\/form>/g)) {
    const f = m[0];
    if (!/data-endpoint=/.test(f)) continue;
    if (!/data-success="[^"]+"/.test(f)) meckern(`${datei}: Formular ohne Erfolgsmeldung`);
    if (!/data-error="[^"]+"/.test(f)) meckern(`${datei}: Formular ohne Fehlermeldung`);
    const felder = [...f.matchAll(/<(?:input|select|textarea)\b[^>]*name="([^"]+)"[^>]*>/g)];
    const ohnePflicht = felder.filter(
      (x) => !/\brequired\b/.test(x[0]) && x[1] !== "website"
    );
    if (ohnePflicht.length) {
      meckern(`${datei}: Formularfelder ohne Pflicht: ${ohnePflicht.map((x) => x[1]).join(", ")}`);
    }
  }
}

if (fehler) {
  console.error(`\n${fehler} Fehler.`);
  process.exit(1);
}
console.log(
  `Wege: ${dateien.length} gebaute Seiten, alle Menuepunkte und Sprungmarken fuehren irgendwohin.\n` +
    `Formulare: senden nur an /api/booking und /api/order, jedes Feld Pflicht,\n` +
    `           Erfolgs- und Fehlermeldung vorhanden, keine Datenbank-Adresse im Quelltext.`
);
