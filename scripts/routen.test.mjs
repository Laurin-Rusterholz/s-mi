#!/usr/bin/env node
/**
 * Prueft die Weiterleitungsregeln aus netlify.toml — gegen die Dateien, die
 * der Generator wirklich geschrieben hat.
 *
 * Anlass: Die Startseite soll "Coming soon" bleiben, /booking/ und /shop/
 * sollen oeffentlich benutzbar sein. Beides haengt an der REIHENFOLGE der
 * Regeln: Netlify nimmt die erste passende. Eine Regel from = "/*" an der
 * falschen Stelle — und entweder ist die ganze Website offen oder die
 * Unterseiten sind es nicht. Das sieht man einer TOML-Datei nicht an, darum
 * dieser Test.
 *
 * Was hier NICHT geprueft wird: ob der Server tatsaechlich so antwortet. Das
 * ginge nur gegen das laufende Netlify. Geprueft wird die Regelkette und ob
 * die Datei, die am Ende ausgeliefert wuerde, ueberhaupt gebaut ist.
 *
 * Aufruf:  node scripts/build.mjs && node scripts/routen.test.mjs
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let fehler = 0;
const meckern = (t) => {
  console.error("  FEHLER: " + t);
  fehler++;
};

/** Die [[redirects]]-Bloecke der Reihe nach aus netlify.toml lesen. */
function regelnLesen(toml) {
  const regeln = [];
  let cur = null;
  for (const roh of toml.split("\n")) {
    const zeile = roh.trim();
    if (zeile === "[[redirects]]") {
      cur = { status: 301, force: false };
      regeln.push(cur);
      continue;
    }
    if (zeile.startsWith("[")) {
      cur = null; // anderer Abschnitt (headers, build …)
      continue;
    }
    if (!cur || !zeile || zeile.startsWith("#")) continue;
    const m = zeile.match(/^(from|to|status|force)\s*=\s*(.+)$/);
    if (!m) continue;
    const wert = m[2].trim().replace(/^"(.*)"$/, "$1");
    cur[m[1]] = m[1] === "status" ? Number(wert) : m[1] === "force" ? wert === "true" : wert;
  }
  return regeln.filter((r) => r.from && r.to);
}

/** Netlify: erste passende Regel gewinnt; "*" am Ende ist der Rest des Pfads. */
function trifft(from, pfad) {
  if (from.endsWith("/*")) {
    const basis = from.slice(0, -1); // "/api/"
    return pfad.startsWith(basis) ? pfad.slice(basis.length) : null;
  }
  if (from === "/*") return pfad.slice(1);
  return from === pfad ? "" : null;
}

/**
 * Was Netlify auf eine Adresse antwortet.
 *
 * Ohne passende Regel liefert Netlify die statische Datei — also
 * "<pfad>/index.html" bzw. die Datei selbst. Gibt es sie nicht, 404.
 */
function antwort(regeln, pfad) {
  for (const r of regeln) {
    const splat = trifft(r.from, pfad);
    if (splat === null) continue;
    // Ohne force gewinnt eine vorhandene statische Datei gegen die Regel.
    if (!r.force && datei(pfad)) break;
    return { status: r.status, ziel: r.to.replace(":splat", splat), regel: r.from };
  }
  const d = datei(pfad);
  return d ? { status: 200, ziel: d, regel: "(statische Datei)" } : { status: 404, ziel: "/404.html", regel: "(nichts)" };
}

function datei(pfad) {
  const p = pfad.replace(/^\//, "");
  if (p && existsSync(resolve(ROOT, p)) && !p.endsWith("/")) return "/" + p;
  const idx = (p ? p.replace(/\/$/, "") + "/" : "") + "index.html";
  return existsSync(resolve(ROOT, idx)) ? "/" + idx : "";
}

const regeln = regelnLesen(await readFile(resolve(ROOT, "netlify.toml"), "utf8"));
if (!regeln.length) {
  console.error("Keine [[redirects]] in netlify.toml gefunden.");
  process.exit(1);
}

/* Die Vorgabe, Adresse fuer Adresse. */
const ERWARTET = [
  /* Die Startseiten sind seit dem Launch offen — in jeder Sprache und auch als
     Datei. Bis dahin standen hier 503-Regeln auf coming-soon.html. */
  ["/", 200, "/index.html"],
  ["/index.html", 200, "/index.html"],
  ["/de/", 200, "/de/index.html"],
  ["/de/index.html", 200, "/de/index.html"],
  ["/fr/", 200, "/fr/index.html"],
  ["/fr/index.html", 200, "/fr/index.html"],

  // Die Unterseiten sind offen.
  ["/booking/", 200, "/booking/index.html"],
  ["/de/booking/", 200, "/de/booking/index.html"],
  ["/fr/booking/", 200, "/fr/booking/index.html"],
  /* Der Shop hat seine eigene Seite — dort steht der Katalog. Auf der Startseite
     steht nur die Einladung (der helle Block) mit einem Knopf hierher; das war
     am 12.08.2026 zwischenzeitlich anders geloest und ist zurueckgedreht. */
  ["/shop/", 200, "/shop/index.html"],
  ["/de/shop/", 200, "/de/shop/index.html"],
  ["/fr/shop/", 200, "/fr/shop/index.html"],

  // Die Endpunkte.
  ["/api/booking", 200, "/.netlify/functions/booking"],
  ["/api/order", 200, "/.netlify/functions/order"],
  ["/api/stripe-webhook", 200, "/.netlify/functions/stripe-webhook"],
  // Der Zaehler fuer die Seitenaufrufe (12.08.2026) — dieselbe /api/*-Regel.
  ["/api/zaehler", 200, "/.netlify/functions/zaehler"],

  // Was die Unterseiten zum Funktionieren brauchen.
  ["/assets/site.css", 200, "/assets/site.css"],
  ["/assets/site.js", 200, "/assets/site.js"],
  ["/legal/", 200, "/legal/index.html"],
  ["/de/rechtliches/", 200, "/de/rechtliches/index.html"],
  // Das Impressum: in jeder Sprache unter derselben Adresse.
  ["/impressum/", 200, "/impressum/index.html"],
  ["/de/impressum/", 200, "/de/impressum/index.html"],
  ["/fr/impressum/", 200, "/fr/impressum/index.html"],
  ["/presskit/sam-sparking-presskit-2026.pdf", 200, "/presskit/sam-sparking-presskit-2026.pdf"],

  // Suchmaschinen.
  ["/robots.txt", 200, "/robots.txt"],
  ["/sitemap.xml", 200, "/sitemap.xml"],

  // Der Quelltext des Generators und der Inhalts-Schnappschuss bleiben zu.
  ["/scripts/build.mjs", 404, "/404.html"],
  ["/content/site.json", 404, "/404.html"],
];

for (const [pfad, status, ziel] of ERWARTET) {
  const a = antwort(regeln, pfad);
  if (a.status !== status) {
    meckern(`${pfad}: erwartet ${status}, bekommen ${a.status} (Regel ${a.regel} → ${a.ziel})`);
  } else if (ziel && a.ziel !== ziel) {
    meckern(`${pfad}: erwartet ${ziel}, bekommen ${a.ziel}`);
  }
}

/* Seit dem Launch die umgekehrte Sorge: KEINE Adresse darf noch in der
   Wartungsregel haengen. Ein uebersehener Rest waere eine Seite, die weiter
   "Coming soon" zeigt, waehrend alles andere live ist. */
const STARTSEITEN = ["/", "/index.html", "/de/", "/de/index.html", "/fr/", "/fr/index.html"];
for (const pfad of [...STARTSEITEN, "/booking/", "/shop/", "/api/booking"]) {
  const a = antwort(regeln, pfad);
  if (a.ziel === "/coming-soon.html") meckern(`${pfad} landet noch in der Wartungsregel`);
  if (a.status === 503) meckern(`${pfad} antwortet weiter mit 503`);
}

/* Die Startseiten muessen ihren eigenen Inhalt liefern — nicht den einer
   anderen Sprache und nicht die Wartungsseite. */
for (const [pfad, datei] of [
  ["/", "/index.html"],
  ["/de/", "/de/index.html"],
  ["/fr/", "/fr/index.html"],
]) {
  const a = antwort(regeln, pfad);
  if (a.ziel !== datei) meckern(`${pfad} liefert ${a.ziel} statt ${datei}`);
}

/* Die Video-Seite ist zurueckgenommen — es darf keine Route dorthin geben. */
for (const pfad of ["/videos/", "/de/videos/", "/fr/videos/"]) {
  const a = antwort(regeln, pfad);
  if (a.status === 200) meckern(`${pfad} ist wieder erreichbar — die Video-Seite sollte weg sein`);
}

/* Keine 503-Regel mehr in der ganzen Datei. */
const nochGesperrt = regeln.filter((r) => Number(r.status) === 503);
if (nochGesperrt.length)
  meckern(`${nochGesperrt.length} Regel(n) antworten noch mit 503: ${nochGesperrt.map((r) => r.from).join(", ")}`);

/* Eine Regel from = "/*" mit force wuerde alles davon zunichtemachen —
   sie darf nicht (wieder) dastehen. */
const allesSperre = regeln.find((r) => r.from === "/*" && r.force);
if (allesSperre) {
  meckern(`Regel from = "/*" (force) sperrt wieder die ganze Website → ${allesSperre.to}`);
}

if (fehler) {
  console.error(`\n${fehler} Fehler.`);
  process.exit(1);
}
console.log(
  `Routen: ${ERWARTET.length} Adressen gegen netlify.toml geprueft.\n` +
    `  offen (200):                  /, /de/, /fr/ samt index.html — die Website ist live,\n` +
    `                                /booking/ und /shop/ in allen drei Sprachen,\n` +
    `                                /api/booking, /api/order, /api/stripe-webhook,\n` +
    `                                Impressum, CSS/JS, Presskit, robots, sitemap\n` +
    `  gesperrt (404):               /scripts/*, /content/*\n` +
    `Geprueft wird die Regelkette und ob die Zieldatei gebaut ist — nicht die\n` +
    `Antwort des laufenden Servers.`
);

{
  /* Die Inhaltsquelle muss beim Bauen ANKOMMEN.

     Anlass (12.08.2026): CONTENT_API_URL stand in netlify.toml mitten im
     [images]-Block. Das ist kein Bild-Schluessel und keine Umgebungsvariable —
     Netlify gab sie nie an den Build weiter. Jeder Netlify-Build baute darum aus
     dem eingecheckten Schnappschuss statt aus der Verwaltung: "Publizieren"
     konnte nicht wirken, und ein gespeicherter Artikel war nicht zu sehen, bis
     der Zeitplan im Repo ihn eincheckte.

     Geprueft wird darum beides: sie steht in [build.environment], und sie steht
     NICHT irgendwo sonst. */
  const toml = await readFile(resolve(ROOT, "netlify.toml"), "utf8");
  const zeilen = toml.split("\n");
  let block = "";
  const treffer = [];
  for (const z of zeilen) {
    const tabelle = z.match(/^\s*\[+([^\]]+)\]+/);
    if (tabelle) block = tabelle[1].trim();
    if (/^\s*CONTENT_API_URL\s*=/.test(z)) treffer.push(block);
  }
  if (!treffer.length) meckern("netlify.toml nennt CONTENT_API_URL nicht — der Build baut aus dem Schnappschuss");
  for (const wo of treffer)
    if (wo !== "build.environment")
      meckern(`CONTENT_API_URL steht in [${wo}] — dort erreicht sie den Build nicht`);
  if (treffer.length > 1) meckern(`CONTENT_API_URL steht ${treffer.length}× in netlify.toml`);
}
