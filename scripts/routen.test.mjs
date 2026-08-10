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
  // Die Startseiten bleiben zu — in jeder Sprache und auch als Datei.
  ["/", 503, "/coming-soon.html"],
  ["/index.html", 503, "/coming-soon.html"],
  ["/de/", 503, "/coming-soon.html"],
  ["/de/index.html", 503, "/coming-soon.html"],
  ["/fr/", 503, "/coming-soon.html"],
  ["/fr/index.html", 503, "/coming-soon.html"],

  // Die Unterseiten sind offen.
  ["/booking/", 200, "/booking/index.html"],
  ["/de/booking/", 200, "/de/booking/index.html"],
  ["/fr/booking/", 200, "/fr/booking/index.html"],
  ["/shop/", 200, "/shop/index.html"],
  ["/de/shop/", 200, "/de/shop/index.html"],
  ["/fr/shop/", 200, "/fr/shop/index.html"],

  // Die Endpunkte.
  ["/api/booking", 200, "/.netlify/functions/booking"],
  ["/api/order", 200, "/.netlify/functions/order"],
  ["/api/stripe-webhook", 200, "/.netlify/functions/stripe-webhook"],

  // Was die Unterseiten zum Funktionieren brauchen.
  ["/assets/site.css", 200, "/assets/site.css"],
  ["/assets/site.js", 200, "/assets/site.js"],
  ["/legal/", 200, "/legal/index.html"],
  ["/de/rechtliches/", 200, "/de/rechtliches/index.html"],
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

/* Die eigentliche Sorge: Der Inhalt der Startseite darf nirgends
   durchscheinen. Alles, was mit 200 erreichbar ist, wird darauf geprueft. */
const HEIKEL = ["/", "/index.html", "/de/", "/de/index.html", "/fr/", "/fr/index.html"];
for (const pfad of HEIKEL) {
  const a = antwort(regeln, pfad);
  if (a.status === 200) meckern(`${pfad} ist offen erreichbar — die Website liegt damit frei`);
  if (a.ziel !== "/coming-soon.html") meckern(`${pfad} liefert ${a.ziel} statt der Wartungsseite`);
}

/* Und umgekehrt: was offen sein soll, darf nicht versehentlich in der
   Wartungsregel haengen. */
for (const pfad of ["/booking/", "/shop/", "/api/booking"]) {
  const a = antwort(regeln, pfad);
  if (a.ziel === "/coming-soon.html") meckern(`${pfad} landet in der Wartungsregel`);
}

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
    `  zu (503 → coming-soon.html):  /, /de/, /fr/ samt index.html\n` +
    `  offen (200):                  /booking/, /shop/ in allen drei Sprachen,\n` +
    `                                /api/booking, /api/order, /api/stripe-webhook,\n` +
    `                                Impressum, CSS/JS, Presskit, robots, sitemap\n` +
    `  gesperrt (404):               /scripts/*, /content/*\n` +
    `Geprueft wird die Regelkette und ob die Zieldatei gebaut ist — nicht die\n` +
    `Antwort des laufenden Servers.`
);
