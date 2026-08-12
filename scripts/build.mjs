#!/usr/bin/env node
/**
 * Sam Sparking — Website-Generator
 *
 * Baut `index.html`, `sitemap.xml` und `robots.txt` aus dem Inhalt.
 *
 * Inhaltsquelle (in dieser Reihenfolge):
 *   1. CONTENT_API_URL  — Endpoint der Verwaltung (JSON), z. B.
 *      https://<verwaltung>.netlify.app/api/content
 *      Optional mit CONTENT_API_TOKEN als Bearer-Token.
 *   2. content/site.json — im Repo eingecheckter Stand (Fallback).
 *
 * Aufruf:  node scripts/build.mjs
 */

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_CONTENT = resolve(ROOT, "content/site.json");
/** Schnappschuss der Bildmasse aus der Medienbibliothek (siehe ladeBildmasse). */
const LOCAL_MASSE = resolve(ROOT, "content/bildmasse.json");

/** Verzeichnisse, die der Generator nie anfasst. */
const KEEP_DIRS = new Set(["assets", "img", "media", "content", "scripts", "presskit", "node_modules"]);

/* ------------------------------------------------------------------ utils */

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Sicheres href: nur http(s), mailto, tel, relative Pfade und #anker. */
const safeUrl = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return ""; // javascript:, data:, …
  /* Freier Text ist keine Adresse. In der Verwaltung stand am 12.08.2026 in
     einem Ticket-Feld "DM for friendlist" — daraus wurde der Link
     "/DM for friendlist", der auf allen drei Startseiten ins Leere fuehrte.

     Durchgelassen wird nur, was eine Adresse sein KANN: ein Sprungziel (#…),
     ein Pfad (mit /) oder ein Dateiname (mit .). Leerzeichen schliessen es aus —
     die kommen in einer Adresse nicht unkodiert vor. Relative Pfade wie
     "img/hero.jpg" bleiben damit gueltig. */
  if (/\s/.test(s)) return "";
  if (s.startsWith("#") || s.includes("/") || s.includes(".")) return s;
  return "";
};

const href = (v) => esc(rooted(v));

/** Mini-Markdown im Fliesstext: **fett** und [Label](url). */
const inline = (v) =>
  esc(v)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
      const u = safeUrl(url.replace(/&amp;/g, "&"));
      if (!u) return label;
      const ext = /^https?:/i.test(u) ? ' target="_blank" rel="noopener noreferrer"' : "";
      return `<a href="${esc(u)}"${ext}>${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

const jsonScript = (obj) =>
  JSON.stringify(obj, null, 2).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

const list = (v) => (Array.isArray(v) ? v : []);
const str = (v, fallback = "") => (typeof v === "string" && v.trim() ? v : fallback);
const num = (n) => String(n).padStart(2, "0");

/** Absolute URL für og:image & Co. */
const absolute = (base, path) => {
  const p = String(path ?? "").trim();
  if (!p) return "";
  if (/^https?:/i.test(p)) return p;
  return `${base.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`;
};

/** Farbe für CSS/Meta absichern (nur Hex oder rgb/hsl-Funktionen). */
const color = (v, fallback) => {
  const s = String(v ?? "").trim();
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
  if (/^(rgb|hsl)a?\([0-9,.%\s/]+\)$/i.test(s)) return s;
  return fallback;
};

const isoDate = (v) => {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
};

/**
 * Das heutige Datum in der Zeitzone der Website: Europe/Zurich.
 *
 * Vorher stand hier die UTC-Zeit. In der Schweiz ist es im Sommer zwei Stunden
 * spaeter, im Winter eine — zwischen 00:00 und 02:00 Ortszeit war "heute" damit
 * noch der Vortag. Ein Termin galt dann fuer zwei Stunden als kommend, obwohl er
 * vorbei war. `sv-SE` liefert das Datum von sich aus als JJJJ-MM-TT.
 */
const ZEITZONE = "Europe/Zurich";
const today = () =>
  process.env.BUILD_DATE
    ? String(process.env.BUILD_DATE).slice(0, 10)
    : new Intl.DateTimeFormat("sv-SE", { timeZone: ZEITZONE }).format(new Date());

/**
 * Unterverzeichnis, in dem die fertige Website ausgeliefert wird.
 * Leer (Normalfall) = direkt an der Wurzel der Domain. Gesetzt (SITE_BASE=/site)
 * wandern alle seiteninternen Adressen — Bilder, CSS, Sprachwechsel, Menü —
 * unter dieses Verzeichnis. Gebraucht wird das von der Präsentations-Fassung
 * (Repo Beispiel-Sami), die Website und Verwaltung nebeneinander ausliefert.
 * Die absoluten Adressen für Suchmaschinen (canonical, hreflang, sitemap)
 * bleiben bewusst unberührt — sie zeigen weiter auf die echte Website.
 */
const BASE = String(process.env.SITE_BASE || "")
  .trim()
  .replace(/\/+$/, "")
  .replace(/^(?!$|\/)/, "/");

/* ------------------------------------------------------------------ laden */

/* ----------------------------------------------------------- Release-Sperre */

/**
 * Wann genau ist der Release? Aus Datum, Uhrzeit und Zeitzone der Verwaltung
 * wird EIN fester Zeitpunkt in Millisekunden seit 1970 (UTC).
 *
 * Warum als Zeitpunkt und nicht als Text: der Browser des Besuchers steht in
 * irgendeiner Zeitzone, vielleicht in Tokio. Vergleicht er einen Text wie
 * "18:00", schaltet die Seite dort acht Stunden zu frueh oder zu spaet um.
 * Ein Zeitpunkt ist ueberall derselbe Moment — auch ueber die Sommerzeit
 * hinweg, denn die steckt schon in der Umrechnung.
 *
 * Die Umrechnung geht ueber Intl: die gewuenschte Ortszeit wird zuerst als UTC
 * gelesen, dann wird geprueft, welche Ortszeit dabei wirklich herauskaeme, und
 * die Differenz abgezogen. Zwei Durchgaenge genuegen auch an den beiden Tagen
 * im Jahr, an denen die Uhr umgestellt wird.
 */
export function releaseZeitpunkt(datum, zeit, zone = ZEITZONE) {
  const d = isoDate(datum);
  if (!d) return 0;
  const m = String(zeit ?? "").match(/^(\d{1,2}):(\d{2})/);
  const stunde = m ? Number(m[1]) : 0;
  const minute = m ? Number(m[2]) : 0;
  const [jahr, monat, tag] = d.split("-").map(Number);
  const alsUtc = Date.UTC(jahr, monat - 1, tag, stunde, minute, 0);
  const abstand = (ms) => {
    // Was zeigt eine Uhr in `zone` zu diesem Zeitpunkt?
    const teile = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const w = Object.fromEntries(teile.map((t) => [t.type, t.value]));
    const dortAlsUtc = Date.UTC(
      Number(w.year), Number(w.month) - 1, Number(w.day),
      Number(w.hour), Number(w.minute), Number(w.second)
    );
    return dortAlsUtc - ms;
  };
  let ms = alsUtc - abstand(alsUtc);
  ms = alsUtc - abstand(ms);
  return ms;
}

/**
 * Der Vorhang vor dem Release — Markup und das kleine Skript im Kopf.
 *
 * Es sind zwei Teile:
 *
 *   releaseKopf()    ein winziges Skript ganz oben im <head>. Es setzt die
 *                    Klasse "vor-release" auf <html>, BEVOR der Browser etwas
 *                    zeichnet. Das CSS blendet damit alles ausser dem Vorhang
 *                    aus — ohne dieses Skript blitzte die Website kurz auf.
 *   releaseVorhang() der Vorhang selbst: Kicker, Ueberschrift, Text und der
 *                    Zaehler, der jede Sekunde weiterlaeuft.
 *
 * Umgeschaltet wird im Browser, nicht auf dem Server: der Zeitpunkt steht als
 * Zahl in der Seite, assets/site.js zaehlt herunter und nimmt bei null die
 * Klasse wieder weg. Es braucht also weder einen neuen Deploy noch einen
 * Cache-Griff, und eine Seite, die offen liegen bleibt, schaltet von selbst um.
 *
 * EINSCHRAENKUNG, die man kennen muss: der Inhalt der Seite steht waehrend der
 * Sperre trotzdem im Quelltext. Wer "Seitenquelltext anzeigen" waehlt oder die
 * Seite mit curl abruft, kann ihn lesen. Wirklich unsichtbar waere er nur mit
 * einer Sperre auf dem Server — die braeuchte aber genau das, was hier
 * ausgeschlossen ist: einen Deploy zum Zielzeitpunkt.
 *
 * Die Vorfuehr-Fassung unter /site/ (SITE_BASE gesetzt) bekommt keinen Vorhang:
 * dort wird gearbeitet.
 */
function releaseKopf(rel) {
  if (!rel.an || BASE) return "";
  return `
  <script>/* Vorhang setzen, bevor gezeichnet wird — sonst blitzt die Seite auf. */
  (function(){try{if(Date.now()<${rel.ms})document.documentElement.className+=" vor-release";}catch(e){}})();
  </script>`;
}

function releaseVorhang(rel, ui, lang, master) {
  if (!rel.an || BASE) return "";
  const stueck = (id, label) =>
    `<div class="rl-teil"><span class="rl-zahl" id="${id}">--</span><span class="mono">${esc(
      label
    )}</span></div>`;
  return `
  <section class="release" id="release" data-ziel="${rel.ms}" aria-live="polite">
    <div class="rl-in">
      ${rel.kicker ? `<span class="mono rl-kicker">${esc(rel.kicker)}</span>` : ""}
      <h1 class="rl-head">${esc(rel.headline || "Coming soon")}</h1>
      ${rel.text ? `<p class="rl-text">${esc(rel.text)}</p>` : ""}
      <div class="rl-uhr" role="timer">
        ${stueck("rl-t", ui.rlDays)}
        ${stueck("rl-h", ui.rlHours)}
        ${stueck("rl-m", ui.rlMinutes)}
        ${stueck("rl-s", ui.rlSeconds)}
      </div>
      <p class="rl-fuss mono">${esc(ui.rlNote)}</p>
      <p class="rl-ways">
        <a href="${esc(navPrefix(lang, master) + "/" + IMPRESSUM_SLUG + "/")}">${esc(
    (IMPRESSUM_TEXT[lang] || IMPRESSUM_TEXT.de).titel
  )}</a>
        <a href="${esc(navPrefix(lang, master) + "/" + (LEGAL_SLUG[lang] || "legal") + "/")}">${esc(
    LEGAL_FUSS[lang] || LEGAL_FUSS.de
  )}</a>
      </p>
    </div>
  </section>`;
}

/**
 * Die Angaben zur Release-Sperre, fertig ausgerechnet.
 *
 * Ein VERGANGENER Zeitpunkt sperrt nichts mehr. Bis zum 12.08.2026, 18:00 stand
 * der Vorhang in jeder gebauten Seite und wurde im Browser beim Erreichen der
 * Zeit weggenommen — richtig fuer eine Seite, die offen liegen bleibt, aber
 * falsch fuer jeden Build danach: der Vorhang lag dann weiter im Quelltext und
 * verschwand erst, wenn JavaScript lief. Ist der Zeitpunkt herum, wird gar kein
 * Vorhang mehr gebaut. Der Schalter in der Verwaltung bleibt, wie er ist — ein
 * naechster Release braucht nur ein neues Datum.
 */
function releaseStand(c, jetzt = Date.now()) {
  const r = c?.release || {};
  const an = r.enabled !== false && !!isoDate(r.date);
  const ms = an ? releaseZeitpunkt(r.date, r.time, str(r.zone, ZEITZONE)) : 0;
  return {
    an: an && ms > 0 && ms > jetzt,
    ms,
    zone: str(r.zone, ZEITZONE),
    kicker: str(r.kicker),
    headline: str(r.headline),
    text: str(r.text),
  };
}

/* --------------------------------------------- vergangene Shows nachziehen */

/** Vergleichbar machen: Gross/Klein, Leerzeichen und Bindestriche zaehlen nicht. */
const refSchluessel = (name, city) =>
  `${String(name ?? "").trim().toLowerCase()}|${String(city ?? "").trim().toLowerCase()}`
    .replace(/[\s–—-]+/g, " ")
    .replace(/\s+/g, " ");

/**
 * Ist dieser Termin vorbei?
 *
 * "Vorbei" heisst: der Tag des Termins ist ganz herum. Ein Termin am heutigen
 * Tag gilt bis Mitternacht als kommend — auch ohne Uhrzeit, und auch wenn er
 * am Abend laeuft, denn eine Show endet nach Mitternacht und soll nicht
 * mittendrin aus der Liste fallen. Gerechnet wird in Europe/Zurich (`heute`
 * kommt aus today()). Ein Termin ohne Datum ist nie vorbei.
 */
export const showVorbei = (show, heute) => {
  const d = isoDate(show?.date);
  return !!d && d < String(heute);
};

/**
 * Vergangene Shows werden zu Referenzen — Name und Ort wandern hinueber.
 *
 * Der Kunde pflegt einen Termin einmal unter "Shows". Ist er vorbei, gehoert er
 * nicht mehr unter "kommende Shows", sondern zu den Orten, an denen Sam schon
 * gespielt hat. Das passiert von selbst, ohne Nachpflege.
 *
 * Regeln, die dabei gelten:
 *   - Keine Dubletten: gibt es die Referenz schon (Name und Ort, unabhaengig
 *     von Gross/Klein und Bindestrichen), passiert nichts.
 *   - Nie automatisch gross: ein uebernommener Eintrag traegt kein `highlight`.
 *   - Bestehende Referenzen bleiben unberuehrt — Reihenfolge, Schreibweise und
 *     "Gross zeigen" aendert diese Funktion nie. Neues kommt hinten dran, in
 *     der Reihenfolge der Termine (das Aelteste zuerst).
 *   - Der Termin selbst bleibt in der Liste stehen. Er zaehlt weiter zum
 *     Rueckblick ("schon gespielt"), er ist nur nicht mehr kommend.
 *
 * Gibt die Namen der uebernommenen Termine zurueck.
 */
export function showsNachReferenzen(content, heute) {
  const shows = content?.sections?.shows;
  const refs = content?.sections?.references;
  if (!refs || !Array.isArray(shows?.items)) return [];
  if (!Array.isArray(refs.items)) refs.items = [];

  const bekannt = new Set(refs.items.map((r) => refSchluessel(r?.name, r?.city)));
  const uebernommen = [];
  const vorbei = shows.items
    .filter((i) => str(i?.name) && showVorbei(i, heute))
    .sort((a, b) => (isoDate(a.date) < isoDate(b.date) ? -1 : 1));

  for (const show of vorbei) {
    const name = str(show.name).trim();
    const city = str(show.city).trim();
    const key = refSchluessel(name, city);
    if (bekannt.has(key)) continue;
    // Ohne highlight: automatisch uebernommene Eintraege stehen unten mit den
    // anderen. Was gross steht, entscheidet der Kunde in der Verwaltung.
    refs.items.push(city ? { name, city } : { name });
    bekannt.add(key);
    uebernommen.push(city ? `${name} — ${city}` : name);
  }
  return uebernommen;
}

/**
 * Fehlendes aus der Vorlage ergänzen — der Stand aus der Verwaltung gewinnt,
 * aber Felder, die es dort noch gar nicht gibt (neu dazugekommene Bausteine
 * wie Sprachen, Oberflächentexte oder das Hintergrundbild), kommen aus der
 * eingecheckten content/site.json. Sonst müsste nach jeder Erweiterung erst
 * jemand in der Verwaltung speichern, bevor sie auf der Website ankommt.
 */
function withDefaults(target, defaults, pfad = "") {
  if (Array.isArray(defaults)) return Array.isArray(target) ? target : defaults;
  if (defaults && typeof defaults === "object") {
    const out = target && typeof target === "object" && !Array.isArray(target) ? target : {};
    for (const [k, v] of Object.entries(defaults))
      out[k] = withDefaults(out[k], v, pfad ? `${pfad}.${k}` : k);
    return out;
  }
  return target === undefined ? defaults : target;
}

/* Listen, die allein die Verwaltung pflegt. Fehlt eine im Stand aus der
   Datenbank, ist sie LEER — nicht "wie beim letzten Build".

   Warum das eine eigene Regel braucht: die Realtime Database speichert keine
   leeren Listen. Loescht der Kunde den letzten Artikel im Shop und publiziert,
   kommt aus der Datenbank gar kein `items` mehr zurueck. withDefaults hielt das
   fuer "fehlt noch" und ergaenzte die Liste aus dem eingecheckten
   content/site.json — also aus dem VORHERIGEN Build. Die geloeschten Artikel
   standen danach wieder im Shop, und im Bau-Protokoll stand nichts davon.
   Genau das ist die Meldung "nach Publizieren werden im Shop nicht alle
   Aenderungen aktualisiert".

   Muss mit `normalize()` in der Verwaltung uebereinstimmen
   (verwaltung/public/js/store.js) — dort wird beim Laden dieselbe Liste zu
   echten Arrays gemacht. */
const VERWALTETE_LISTEN = [
  "site.keywords",
  "hero.stats",
  "ticker.items",
  "layout",
  "pages",
  "sections.about.paragraphs",
  "sections.about.words",
  "sections.about.facts",
  "sections.shows.items",
  "sections.references.items",
  "sections.gallery.items",
  "sections.shop.items",
  "sections.booking.available",
  "sections.contact.socials",
];

/**
 * Setzt jede verwaltete Liste, die im Stand aus der Datenbank fehlt, auf eine
 * leere Liste — damit withDefaults sie nicht aus dem alten Schnappschuss
 * nachfuellt. Gibt die Pfade zurueck, die dadurch leer bleiben.
 */
function leereListenFesthalten(live) {
  const leer = [];
  for (const pfad of VERWALTETE_LISTEN) {
    const teile = pfad.split(".");
    let node = live;
    for (let i = 0; i < teile.length - 1; i++) {
      if (!node || typeof node !== "object") {
        node = null;
        break;
      }
      node = node[teile[i]];
    }
    if (!node || typeof node !== "object") continue;
    const letztes = teile[teile.length - 1];
    if (Array.isArray(node[letztes])) continue;
    // Ein Objekt mit Zahlen-Schluesseln ist eine Liste mit Loechern — die
    // Datenbank speichert Listen so, sobald ein Platz fehlt.
    if (node[letztes] && typeof node[letztes] === "object") {
      node[letztes] = Object.keys(node[letztes])
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => node[letztes][k])
        .filter((x) => x !== null && x !== undefined);
      continue;
    }
    node[letztes] = [];
    leer.push(pfad);
  }
  return leer;
}

/**
 * Texte der Vorlage übernehmen — nur dort, wo es das Feld im Live-Inhalt schon
 * gibt. Bilder, Videos, Termine, Farben und Links bleiben unangetastet.
 * Dieselbe Regel wie der Knopf „Texte umstellen" in der Verwaltung.
 */
export function adoptTexts(live, template) {
  for (const [path, text] of collectStrings(template)) {
    const keys = path.split(".");
    let cur = live;
    let tpl = template;
    let mismatch = false;
    for (let i = 0; i < keys.length - 1 && cur != null; i++) {
      // Übernommen wird Feld für Feld über den Pfad. In Listen zählt dabei nur
      // die Position — stehen dort unterschiedlich viele Einträge, gehört
      // Position 2 der Vorlage nicht zu Position 2 des Live-Inhalts. Genau so
      // ist "Luzern" schon einmal auf "Sektor 11" gerutscht. Solche Pfade
      // bleiben deshalb unangetastet.
      if (Array.isArray(cur) && Array.isArray(tpl) && cur.length !== tpl.length) {
        mismatch = true;
        break;
      }
      cur = cur[keys[i]];
      tpl = tpl == null ? null : tpl[keys[i]];
    }
    if (mismatch) continue;
    if (Array.isArray(cur) && Array.isArray(tpl) && cur.length !== tpl.length) continue;
    const last = keys[keys.length - 1];
    if (cur && typeof cur === "object" && cur[last] !== undefined) cur[last] = text;
  }
  live.site.lang = template.site.lang;
  live.site.languages = list(template.site.languages).slice();
  live.i18n = template.i18n;
  live.i18nHash = template.i18nHash;
  if (template.ui) live.ui = template.ui;
  // Seitenaufteilung und Reihenfolge der Vorlage übernehmen — die alten
  // englischen Stände tragen noch die Vier-Seiten-Struktur mit sich.
  if (template.pages !== undefined) live.pages = JSON.parse(JSON.stringify(template.pages));
  if (template.layout !== undefined) live.layout = list(template.layout).slice();
}

/**
 * Steckt in der Datenbank noch der englische Werks-Stand? Verglichen wird
 * Text für Text mit den alten Auslieferungs-Texten (content/legacy-en.json).
 * Ab 10 Treffern gilt der Stand als "nie inhaltlich angefasst" — eigene
 * Bilder, Videos, Termine und Links zählen nicht mit und bleiben erhalten.
 */
function looksLikeLegacy(live, legacy) {
  if (!legacy) return 0;
  let hits = 0;
  for (const [path, text] of collectStrings(legacy)) {
    const keys = path.split(".");
    let cur = live;
    for (let i = 0; i < keys.length - 1 && cur != null; i++) cur = cur[keys[i]];
    if (cur && typeof cur === "object" && String(cur[keys[keys.length - 1]] ?? "").trim() === text.trim()) hits++;
  }
  return hits;
}

/**
 * Korrekturen an dem, was aus der Verwaltung kommt.
 *
 * Hintergrund: `withDefaults` laesst bei jedem Wert die Datenbank gewinnen.
 * Eine Korrektur, die nur im Repo steht, waere daher wirkungslos.
 *
 * Eine frueher hier eingebaute Fassungsnummer (contentRevision) hat sich als
 * falsch erwiesen: sie stand in defaults/site.json, die Verwaltung uebernahm
 * sie beim Laden in ihren Inhalt und schrieb sie beim Speichern in die
 * Datenbank — zusammen mit dem UNkorrigierten Stand. Danach hielt der Build
 * die Datenbank fuer aktuell und der alte Name kam zurueck. Genau so ist
 * "Sam Sparkling" wieder aufgetaucht.
 *
 * Deshalb ohne Nummer, mit zwei Arten von Regeln:
 *
 *   IMMER          Die Schreibweise. Sie kann nie falsch sein und nie zu oft
 *                  laufen — der Name heisst "Sam Sparking", fertig.
 *
 *   NUR SOLANGE    Alles andere greift nur, solange die Daten noch exakt den
 *   UNANGETASTET   alten Stand tragen. Sobald in der Verwaltung etwas daran
 *                  geaendert wurde, passt die Bedingung nicht mehr und der
 *                  Build laesst die Stelle in Ruhe. Die Verwaltung behaelt
 *                  damit immer das letzte Wort, ohne dass jemand irgendwo
 *                  eine Nummer mitfuehren muss.
 */

/**
 * "Sam Sparkling" war jahrelang falsch geschrieben. Ausgenommen ist der
 * Hostname djsamsparkling.netlify.app — das ist eine Adresse: wird sie
 * mitkorrigiert, zeigen Canonical, hreflang und Sitemap ins Leere. Er wird
 * darum vor der Ersetzung beiseitegelegt und danach unveraendert zurueck-
 * geschrieben.
 */
const HOST_MARKE = "\u0001";
function schreibweise(v) {
  if (typeof v !== "string" || !v.includes("parkling")) return v;
  const hosts = [];
  return v
    .replace(/djsamsparkling/gi, (m) => {
      hosts.push(m);
      return HOST_MARKE;
    })
    .replace(/Sparkling/g, "Sparking")
    .replace(/sparkling/g, "sparking")
    .replace(new RegExp(HOST_MARKE, "g"), () => hosts.shift());
}

/**
 * Schreibweise in jedem Text des Baums korrigieren — auch in Listen aus
 * reinem Text (Absaetze, Keywords, Stichworte). Die werden ueber den Index
 * zurueckgeschrieben; ein blosses forEach wuerde den Ersatz verwerfen.
 */
function schreibweiseTief(node) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      if (typeof v === "string") node[i] = schreibweise(v);
      else schreibweiseTief(v);
    });
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === "string") node[k] = schreibweise(v);
    else schreibweiseTief(v);
  }
}

/**
 * Holt die Stellen aus der Vorlage nach, die in der Datenbank noch den Stand
 * von vor dieser Änderung tragen. Alles andere — Bilder, Videos, Termine,
 * Texte, Links — bleibt unangetastet: die Verwaltung behält die Hoheit.
 */
const kopie = (v) => JSON.parse(JSON.stringify(v));

/**
 * Jeder Schritt gehört genau zu der Fassung, die ihn gebracht hat, und läuft
 * nur einmal. Das ist der springende Punkt: würde bei jeder neuen Fassung
 * wieder der ganze Satz laufen, käme mit Fassung 3 auch die Sichtbarkeit aus
 * Fassung 2 zurück — ein in der Verwaltung eingeschalteter Shop wäre beim
 * nächsten Build wieder aus, ohne dass jemand etwas dagegen tun kann.
 */
const LOCAL_KORREKTUREN = resolve(ROOT, "content/korrekturen.json");

/** Wird in loadContent() gefuellt; leer heisst: keine Korrekturen hinterlegt. */
let KORREKTUREN = null;

/**
 * Passt die Liste aus der Verwaltung zu einem der bekannten Altstaende?
 *
 * Zwei Dinge, die vorher falsch waren und die Ersetzung still ins Leere
 * laufen liessen:
 *
 *   EIN Massstab reichte nicht. In der Datenbank stand eine andere alte
 *   Liste als die, gegen die hier verglichen wurde — der Abgleich traf nie
 *   zu, die Website zeigte weiter die alte Liste, und nichts hat gemeldet,
 *   dass die Regel gar nicht greift. `namen` darf deshalb auch eine Liste
 *   von Listen sein: passt EINER der Staende, wird ersetzt.
 *
 *   Die REIHENFOLGE darf nicht zaehlen. Die Verwaltung sortiert die Liste
 *   beim Speichern um; ein Vergleich Platz fuer Platz waere schon dadurch
 *   hinfaellig. Verglichen wird darum, welche Namen vorkommen und wie oft.
 *
 * Die Schutzwirkung bleibt: eine Liste, die zu keinem bekannten Stand passt,
 * hat jemand selbst gepflegt und wird nicht angefasst.
 */
const alsZaehlung = (namen) => {
  const m = new Map();
  for (const n of namen) m.set(n, (m.get(n) || 0) + 1);
  return m;
};

const gleicheZaehlung = (a, b) => {
  if (a.size !== b.size) return false;
  for (const [n, z] of a) if (b.get(n) !== z) return false;
  return true;
};

const gleicheNamen = (items, namen) => {
  if (!Array.isArray(items) || !Array.isArray(namen) || !namen.length) return false;
  const staende = Array.isArray(namen[0]) ? namen : [namen];
  const haben = alsZaehlung(list(items).map((i) => str(i?.name)));
  return staende.some(
    (stand) => Array.isArray(stand) && gleicheZaehlung(alsZaehlung(stand.map(str)), haben)
  );
};

/**
 * Korrigiert den Stand aus der Verwaltung. Gibt zurueck, was angefasst wurde —
 * fuer das Build-Protokoll, damit nachvollziehbar bleibt, warum sich etwas
 * geaendert hat.
 */
/** Leere Felder weglassen — der Schnappschuss soll keine leeren Zeilen tragen. */
const nurGefuellt = (o) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== undefined && v !== null));

export function nachziehen(live, korr) {
  const getan = [];
  if (!live || typeof live !== "object") return getan;

  // --- immer ---------------------------------------------------------------
  const vorher = JSON.stringify(live);
  schreibweiseTief(live);
  if (JSON.stringify(live) !== vorher) getan.push("Schreibweise");

  if (!korr || typeof korr !== "object") return getan;

  const ls = live.sections || (live.sections = {});

  // --- nur solange die Stelle noch unangetastet ist ------------------------

  /* Referenzen: hier stand bis zum 11.08.2026 eine Ersetzung. Sie tauschte die
     Liste aus der Verwaltung gegen eine im Repo gepflegte Fassung, solange die
     Verwaltung einen der bekannten Altstaende trug (`alteReferenzen`).

     Das ist der Grund, warum "IVY — St. Gallen" auf der Website fehlte,
     obwohl der Eintrag in der Verwaltung stand: die Ersetzungsliste kannte
     stattdessen "Club Eden — St. Gallen". Wer in der Verwaltung eine Referenz
     anlegt, umbenennt, verschiebt oder gross stellt, muss das auf der Website
     sehen. Deshalb ist die Regel weg — samt der Nachtrag-Regel fuer Orte und
     der positionsgebundenen Ortsuebersetzung (siehe korr.i18n).

     Referenzen kommen jetzt unveraendert aus der Verwaltung: Reihenfolge,
     "Gross zeigen" und der Schalter des Abschnitts. Kein Rueckfall, keine
     Demo-Liste. */

  // Kennzahlen und Booking-Bild: nur, wenn dort noch nichts steht.
  if (list(korr.heroStats).length && !list(live.hero?.stats).length) {
    live.hero = { ...live.hero, stats: kopie(korr.heroStats) };
    getan.push("Kennzahlen");
  }

  // Die mittlere Kennzahl hiess "Clubs & Festivals" und zaehlte damit etwas
  // anderes, als sie zeigte. Sie heisst neu "Shows" — ersetzt wird nur,
  // solange die drei Aufschriften noch die alten sind.
  const alteStats = list(korr.alteHeroStats);
  const stats = list(live.hero?.stats);
  if (
    list(korr.heroStats).length &&
    alteStats.length === stats.length &&
    stats.every((s, i) => str(s?.label) === alteStats[i])
  ) {
    stats.forEach((s, i) => {
      const neu = korr.heroStats[i];
      if (neu && str(neu.label)) s.label = neu.label;
    });
    getan.push("Kennzahl-Aufschriften");
  }

  /* Die Zahl neben "Shows" nennt die Gesamtzahl gespielter Shows. In der
     Datenbank stand zuletzt 2, die Seite zeigte darum "2+ SHOWS" — verlangt
     sind 30. Gesucht wird die Kennzahl ueber ihre Aufschrift (die steht nach
     der Umbenennung oben schon auf "Shows"); nur wenn keine passt, greift der
     Platz in der Liste.

     Wie bei shop.sichtbar ueberstimmt diese Regel bewusst die Verwaltung —
     sonst waere die Zahl beim naechsten Speichern wieder eine andere. Wer sie
     dort wieder selbst setzen will, loescht `heroShows` aus der
     Korrekturdatei. */
  const hs = korr.heroShows;
  if (hs && str(hs.wert)) {
    // Nur ueber die Aufschrift, bewusst ohne Rueckfall auf den Platz in der
    // Liste: stuende dort eine ganz eigene Kennzahl, wuerde ein Rueckfall
    // ausgerechnet die ueberschreiben. Erkannt werden die heutige Aufschrift
    // und die alte, falls die Umbenennung oben nicht mehr gegriffen hat.
    const namen = [str(hs.label, "Shows"), ...list(hs.auchLabel).map(str)]
      .filter(Boolean)
      .map((n) => n.toLowerCase());
    const ziel = list(live.hero?.stats).find((s) =>
      namen.includes(str(s?.label).toLowerCase())
    );
    if (ziel && str(ziel.value) !== str(hs.wert)) {
      ziel.value = str(hs.wert);
      getan.push(`Kennzahl ${str(ziel.label)} = ${str(hs.wert)}`);
    }
  }

  // Die Genre-Zeile im Hero ist weg (siehe renderPage). Der Wert bleibt in der
  // Datenbank stehen und wird nur nicht mehr gelesen — hier wird er auch aus
  // dem Schnappschuss geraeumt, damit niemand ihn dort noch pflegt.
  if (str(live.hero?.meta)) {
    delete live.hero.meta;
    for (const lang of ["de", "fr"]) delete live.i18n?.[lang]?.hero?.meta;
    getan.push("Genre-Zeile");
  }

  // Namen der Termine ohne Leerzeichen am Rand — in der Verwaltung steht
  // "Aftersun " mit angehaengtem Leerzeichen, das stand so auch auf der Seite
  // und im Terminblatt (shows-data). Reine Formsache, darum ohne Bedingung.
  let getrimmt = 0;
  list(ls.shows?.items).forEach((i) => {
    const sauber = str(i?.name).trim();
    if (sauber && sauber !== i.name) {
      i.name = sauber;
      getrimmt++;
    }
  });
  if (getrimmt) getan.push(`${getrimmt} Terminname(n) getrimmt`);

  // Aftersun spielt in Luzern, in der Verwaltung stand Herisau.
  for (const s of list(korr.shows)) {
    const treffer = list(ls.shows?.items).filter(
      (i) => list(s.alteNamen).includes(str(i?.name).trim()) && str(i?.city) === str(s.alteStadt)
    );
    treffer.forEach((i) => {
      i.name = str(i.name).trim();
      i.city = str(s.city);
      if (str(s.country)) i.country = str(s.country);
    });
    if (treffer.length) getan.push(`Show ${str(s.name)} → ${str(s.city)}`);
  }

  /* Kanaele: hier standen bis zum 11.08.2026 drei Regeln, die den Stand aus
     der Verwaltung ergaenzt haben — und genau daher kam der Unterschied, den
     der Kunde gemeldet hat. In der Verwaltung stand links nur Mixcloud, auf
     der Website und in der Vorschau standen vier Kanaele.

       ausDemKopf   setzte `inHeader:false` fuer Instagram, wo nichts gesetzt war
       erwartet     legte fehlende Kanaele (Instagram, TikTok, Spotify,
                    Mixcloud) OHNE Adresse an
       adressen     trug die nachgelieferten Adressen von TikTok und Spotify ein

     Alle drei sind weg. Die Kanaele stehen jetzt genau so auf der Website, wie
     sie in der Verwaltung gespeichert sind — mit Adresse, mit Handle, mit dem
     Schalter fuer das Zeichen im Kopf. Verloren geht dabei nichts: die
     Verwaltung traegt die vier Kanaele beim Laden selbst nach, wenn sie in den
     gespeicherten Daten fehlen, und sagt es mit einem Hinweis zum Speichern
     (siehe verwaltung/public/js/kanaele-nachtragen.js). Nach einmal Speichern
     sind Verwaltung, Vorschau und Website auf demselben Stand.

     Auch die vierte Regel ist weg: `korr.instagram` legte Instagram an, wenn
     gar keines hinterlegt war. Fuer die Website gilt jetzt ohne Ausnahme —
     was in der Verwaltung steht, steht auf der Seite, und nur das. */

  /* Wie viele Fotos die Bilderwand zuerst zeigt: 6 (zwei Spalten, drei Reihen).
     Kundenwunsch vom 10.08.2026 — in der Verwaltung stand 4. Greift immer. */
  if (Number(korr.galerie?.startAnzahl) > 0 && ls.gallery) {
    const soll = Number(korr.galerie.startAnzahl);
    if (Number(ls.gallery.mobileLimit) !== soll) {
      ls.gallery.mobileLimit = soll;
      getan.push(`Galerie zeigt zuerst ${soll} Fotos`);
    }
  }


  /* Der Shop hatte hier drei Regeln. Alle drei sind weg (11.08.2026):

       verloreneWare   holte den Artikel "Beispiel" zurueck, sobald die
                       Warenliste leer war
       texte           schrieb note, emptyText und buyLabel, sobald das Feld
                       leer war oder den bekannten deutschen Text trug
       alteWaehrung    ersetzte die Waehrung "CHF 5"

     Warum weg: sie standen genau dort, wo der Kunde arbeitet. Wer den letzten
     Artikel loeschte, hatte ihn nach dem Publizieren wieder; wer die
     Einleitungszeile leerte, las danach erneut "Merch from Sam Sparking …".
     Das ist die Meldung "nach Publizieren werden im Shop nicht alle
     Aenderungen aktualisiert" — von hier kam sie.

     Der Shop haengt jetzt ausschliesslich an der Verwaltung: Warenliste,
     Felder, Zustand, Reihenfolge und Loeschungen. Nichts wird hier ergaenzt,
     nichts ersetzt. Der Artikel steht als echte Ware in der Datenbank; fehlt
     er dort, traegt ihn die Verwaltung einmalig nach und merkt sich das
     (verwaltung/public/js/ware-nachtragen.js). */

  /* Die Video-Seite ist zurueckgenommen (11.08.2026). Videos stehen wieder in
     der Bilderwand; eine eigene Seite /videos/ soll es nicht mehr geben —
     keine Route, kein Menuepunkt, kein Eintrag in der Sitemap.

     Aufgeraeumt wird hier statt nur in der Korrekturdatei, weil die Seite in
     jedem Stand stecken kann, der zwischendurch gebaut wurde: im
     eingecheckten Schnappschuss ebenso wie in der Datenbank, falls dort einmal
     gespeichert wurde. Die MEDIEN bleiben unangetastet — entfernt wird nur die
     Seite und der Abschnitt, der auf sie zeigte. */
  {
    const hatteSeite = list(live.pages).some((p) => str(p.slug) === "videos");
    if (hatteSeite) live.pages = list(live.pages).filter((p) => str(p.slug) !== "videos");
    const hatteAbschnitt = ls.videos !== undefined;
    delete ls.videos;
    live.layout = list(live.layout).filter((k) => k !== "videos");
    for (const wurzel of ["i18n", "i18nHash"]) {
      for (const lang of Object.keys(live[wurzel] || {})) {
        delete live[wurzel][lang]?.sections?.videos;
      }
    }
    if (hatteSeite || hatteAbschnitt) getan.push("Video-Seite zurueckgenommen");
  }

  // Seitenaufteilung: Booking und Shop haben eigene Seiten bekommen. Ersetzt
  // wird nur die unangetastete Einseiter-Aufteilung — sobald in der Verwaltung
  // eine zweite Seite steht, entscheidet sie.
  if (list(korr.seiten).length && list(live.pages).length <= 1) {
    live.pages = kopie(korr.seiten);
    for (const lang of ["de", "fr"]) {
      const q = korr.i18n?.[lang]?.seiten;
      if (q && live.i18n?.[lang]) live.i18n[lang].pages = kopie(q);
    }
    getan.push(`Seiten (${korr.seiten.length})`);
  }

  /* Eine in der Korrekturdatei vorgesehene Seite fehlt ganz — dann anlegen,
     an derselben Stelle wie dort. Anlass: die Video-Seite kam am 10.08.2026
     dazu, der Stand hatte aber schon drei Seiten. Die Regel darueber ersetzt
     nur den unangetasteten Einseiter und haette hier nicht gegriffen: der
     Video-Abschnitt haette auf keiner Seite gestanden und waere trotz allem
     nicht gebaut worden.

     Ergaenzt wird nur, was noch NIRGENDS steht — wer eine Seite in der
     Verwaltung loescht oder ihre Abschnitte anders verteilt, behaelt das
     letzte Wort. Die Stelle zaehlt: die Seiten-Uebersetzungen haengen am
     Platz in der Liste. */
  if (list(korr.seiten).length && list(live.pages).length > 1) {
    const fehlend = korr.seiten.filter(
      (soll) => !list(live.pages).some((p) => str(p.slug) === str(soll.slug))
    );
    /* GENAU EINE fehlende Seite heisst: alle anderen beschlossenen Seiten sind
       da, es ist also eine dazugekommene. Fehlen mehrere, ist das eine eigene
       Aufteilung aus der Verwaltung — die bleibt unangetastet, auch wenn dann
       ein Abschnitt nirgends steht. Ohne diese Bedingung baute die Regel einer
       selbst gebauten Seitenstruktur die beschlossenen Seiten wieder ein. */
    if (fehlend.length === 1) {
      const soll = fehlend[0];
      const abschnitte = list(soll.sections);
      const versorgt =
        abschnitte.length &&
        abschnitte.every((k) => list(live.pages).some((p) => list(p.sections).includes(k)));
      if (!versorgt) {
        const platz = korr.seiten.findIndex((s) => str(s.slug) === str(soll.slug));
        live.pages.splice(Math.min(platz < 0 ? live.pages.length : platz, live.pages.length), 0, kopie(soll));
        getan.push(`Seite /${str(soll.slug)}/ angelegt`);
      }
    }
  }

  /* Impressum: die Angaben stehen in content/korrekturen.json, weil
     content/site.json bei jedem Build aus der Datenbank neu geschrieben wird.
     Gesetzt wird nur, was fehlt — was in der Verwaltung eingetragen ist,
     gewinnt. */
  const impressum = Object.entries(korr.impressum || {}).filter(([f]) => !f.startsWith("_"));
  if (impressum.length) {
    const ziel = live.imprint || (live.imprint = {});
    let n = 0;
    for (const [feld, wert] of impressum) {
      if (str(ziel[feld])) continue;
      ziel[feld] = wert;
      n++;
    }
    if (n) getan.push(`${n} Impressum-Angabe(n)`);
  }

  /* Der Fotograf ist ueberall weg (11.08.2026, letzte Fassung).

     Erst wurde er nur nicht mehr angezeigt — das Feld stand aber weiter in der
     Verwaltung und in den Daten, und der Kunde hat es dort wiedergefunden. Der
     Auftrag lautet "entferne ueberall den Fotografen", also wird er auch
     geloescht: `site.photoCredit` und jedes `credit` an einem Bild.

     Das laeuft bei JEDEM Build und haengt an keiner Marke — anders als die
     Ergaenzungen weiter unten. Der Grund: das Feld gibt es im Modell nicht
     mehr. Ein Wert, der aus einem alten Stand der Datenbank nachkommt, waere
     kein Kundenwunsch, sondern ein Rest.

     Die Bilder selbst bleiben unangetastet: geloescht wird nur diese eine
     Angabe am Eintrag, nicht der Eintrag. */
  let creditsWeg = 0;
  if (live.site && live.site.photoCredit !== undefined) {
    delete live.site.photoCredit;
    creditsWeg++;
  }
  const creditRaeumen = (knoten) => {
    if (Array.isArray(knoten)) return knoten.forEach(creditRaeumen);
    if (!knoten || typeof knoten !== "object") return;
    if (knoten.credit !== undefined) {
      delete knoten.credit;
      creditsWeg++;
    }
    for (const wert of Object.values(knoten)) creditRaeumen(wert);
  };
  creditRaeumen(live.sections);
  /* Auch die Uebersetzungen und ihre Pruefsummen tragen die Angabe noch — dort
     unter `site.photoCredit` und als `credit` an den Bildern. */
  for (const wurzel of ["i18n", "i18nHash"]) {
    const tabellen = live[wurzel];
    if (!tabellen || typeof tabellen !== "object") continue;
    for (const tabelle of Object.values(tabellen)) {
      if (!tabelle || typeof tabelle !== "object") continue;
      if (tabelle.site && tabelle.site.photoCredit !== undefined) {
        delete tabelle.site.photoCredit;
        creditsWeg++;
      }
      creditRaeumen(tabelle.sections);
    }
  }
  /* Ohne Meldung — auch nicht im Bau-Protokoll. Hier stand bis zum 11.08.2026
     eine Zeile wie "81 Fotocredit(s) geloescht"; sie war ueber die Verwaltung
     sichtbar und damit selbst wieder eine Fotografen-Angabe auf dem Bildschirm.
     Der Auftrag lautet "ueberall entfernen", also auch die Meldung darueber.
     Belegt ist das Loeschen durch die Tests (scripts/build.test.mjs), nicht
     durch einen Hinweis, den jemand lesen muss. */
  void creditsWeg;

  /* ---------------------------------------------------------------------
     ERGAENZEN, NIE ERSETZEN.

     Die folgenden Regeln fuellen Luecken im Stand aus der Datenbank, damit die
     Website vollstaendig ist, ohne dass jemand die Verwaltung oeffnen und
     speichern muss. Sie ueberschreiben nichts, sortieren nichts um, loeschen
     nichts — und sie halten sich selbst an: hat die Verwaltung den Stand einmal
     gespeichert, traegt der Inhalt unter `migrationen` eine Marke, und die
     zugehoerige Regel laeuft nie wieder. Ab dann laesst sich alles loeschen und
     bleibt geloescht.

     Genau darin unterscheiden sie sich von den Regeln, die im August entfernt
     wurden: jene ERSETZTEN (die Referenzliste wurde ausgetauscht, geloeschte
     Ware kam zurueck, geleerte Texte wurden neu geschrieben).
     --------------------------------------------------------------------- */
  const erledigt = (marke) => live.migrationen && live.migrationen[marke] === true;

  /* Referenzen: fehlende anhaengen. Erkannt an Name UND Ort, unabhaengig von
     Gross/Klein und Bindestrichen. Nie gross, nie umsortiert. */
  if (!erledigt("referenzen")) {
    const soll = list(korr.referenzenNachtragen?.eintraege).filter((r) => str(r?.name));
    if (soll.length) {
      const ziel = ls.references || (ls.references = {});
      if (!Array.isArray(ziel.items)) ziel.items = [];
      const da = new Set(ziel.items.map((r) => refSchluessel(r?.name, r?.city)));
      let n = 0;
      for (const r of soll) {
        const key = refSchluessel(r.name, r.city);
        if (da.has(key)) continue;
        ziel.items.push(str(r.city) ? { name: str(r.name), city: str(r.city) } : { name: str(r.name) });
        da.add(key);
        n++;
      }
      if (n) getan.push(`${n} Referenz(en) ergaenzt`);

      /* Und die vier, die bis zum 11.08.2026 gross ueber den anderen standen,
         ruecken einmalig nach vorne. Seit alle Referenzen gleich aussehen,
         entscheidet allein die Reihenfolge; ohne diesen Schritt saehe die Seite
         anders aus als vorher. Verschoben werden nur Positionen — Inhalt,
         Schreibweise und die Reihenfolge der uebrigen bleiben. */
      const zuerst = list(korr.referenzenNachtragen?.zuerst).map((r) =>
        refSchluessel(r?.name, r?.city)
      );
      if (zuerst.length) {
        const rang = (r) => {
          const i = zuerst.indexOf(refSchluessel(r?.name, r?.city));
          return i < 0 ? zuerst.length : i;
        };
        const vorher = ziel.items.map((r) => refSchluessel(r?.name, r?.city)).join("|");
        // Stabil sortieren: gleiche Raenge behalten ihre bisherige Ordnung.
        ziel.items = ziel.items
          .map((r, i) => [r, i])
          .sort((a, b) => rang(a[0]) - rang(b[0]) || a[1] - b[1])
          .map(([r]) => r);
        if (ziel.items.map((r) => refSchluessel(r?.name, r?.city)).join("|") !== vorher)
          getan.push("die vier bisher grossen Referenzen nach vorne");
      }
    }
  }

  /* Kanaele: fehlende einsetzen, an der Stelle der Liste. Erkannt am Namen ODER
     am Hostnamen — "Insta" und "Instagram" sind derselbe Kanal. Eine hinterlegte
     Adresse gewinnt immer. */
  if (!erledigt("kanaele")) {
    const soll = list(korr.kanaeleNachtragen?.eintraege).filter((x) => str(x?.label));
    if (soll.length) {
      const ziel = ls.contact || (ls.contact = {});
      if (!Array.isArray(ziel.socials)) ziel.socials = [];
      const name = (x) => str(x?.label).trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
      const host = (x) => (String(x?.url || "").match(/^https?:\/\/(?:www\.)?([^/]+)/i) || [, ""])[1].toLowerCase();
      const daNamen = new Set(ziel.socials.map(name).filter(Boolean));
      const daHosts = new Set(ziel.socials.map(host).filter(Boolean));
      let n = 0;
      for (const [nr, kanal] of soll.entries()) {
        if (daNamen.has(name(kanal))) continue;
        const h = host(kanal);
        if (h && daHosts.has(h)) continue;
        const naechster = soll
          .slice(nr + 1)
          .map((k) => ziel.socials.findIndex((x) => name(x) === name(k)))
          .find((i) => i >= 0);
        ziel.socials.splice(naechster === undefined ? ziel.socials.length : naechster, 0, kopie(kanal));
        daNamen.add(name(kanal));
        if (h) daHosts.add(h);
        n++;
      }
      if (n) getan.push(`${n} Kanal/Kanaele ergaenzt`);
    }
  }

  /* Shop: die Einladung oben und der Informationsstreifen. Nur leere Felder,
     und die Warenliste bleibt in jedem Fall unberuehrt. */
  if (!erledigt("shopInfo") && korr.shopEinladung) {
    const shop = ls.shop || (ls.shop = {});
    let n = 0;
    for (const [feld, wert] of Object.entries(korr.shopEinladung.felder || {})) {
      if (str(shop[feld])) continue;
      shop[feld] = wert;
      n++;
    }
    if (!list(shop.info).length && list(korr.shopEinladung.info).length) {
      shop.info = kopie(korr.shopEinladung.info);
      n += shop.info.length;
    }
    for (const [lang, werte] of Object.entries(korr.shopEinladung.i18n || {})) {
      const i18n = live.i18n || (live.i18n = {});
      const dort = i18n[lang] || (i18n[lang] = {});
      const abschnitte = dort.sections || (dort.sections = {});
      const ziel = abschnitte.shop || (abschnitte.shop = {});
      for (const [feld, wert] of Object.entries(werte)) {
        if (feld === "info") {
          // Uebersetzungen der Streifen-Punkte haengen am Platz in der Liste.
          const vorhanden = ziel.info || (ziel.info = {});
          list(wert).forEach((eintrag, i) => {
            const platz = vorhanden[String(i)] || (vorhanden[String(i)] = {});
            for (const [f, v] of Object.entries(eintrag)) if (!str(platz[f])) platz[f] = v;
          });
          continue;
        }
        if (str(ziel[feld])) continue;
        ziel[feld] = wert;
        n++;
      }
    }
    if (n) getan.push(`${n} Shop-Angabe(n) ergaenzt`);
  }

  /* Zwei Ansichten des Shops (12.08.2026, zweiter Anlauf).

     Erst hatte der Shop nur eine eigene Seite /shop/ — der Kunde suchte sein
     Produkt auf der Startseite und fand nichts. Dann wanderte alles auf die
     Startseite; auch das war nicht gemeint. Gewollt ist beides:

       Startseite, unter der Galerie:  der helle Block "Sam Sparking Shop" als
                                       Einladung, mit Knopf auf /shop/
       /shop/:                         der dunkle Katalog mit der Ware

     Beides kommt aus demselben Abschnitt in der Verwaltung — es gibt nichts
     doppelt zu pflegen. Welche Ansicht eine Seite zeigt, entscheidet der
     Generator: traegt mehr als eine Seite den Shop, zeigt die erste die
     Einladung und die letzte den Katalog (siehe renderPage).

     Diese Regel sorgt nur dafuer, dass BEIDE Plaetze da sind — einmalig, mit
     Marke. Danach entscheidet die Seitenaufteilung der Verwaltung.

     Die Marke heisst absichtlich anders als beim ersten Anlauf ("shopAufStart"):
     wer den Stand zwischendurch gespeichert hat, traegt jene Marke schon und
     saehe diese Korrektur sonst nie. */
  if (!erledigt("shopSeiteUndEinladung")) {
    const seiten = list(live.pages);
    const start = seiten[0];
    if (start) {
      const getan2 = [];
      /* 1) Die eigene Seite /shop/ zurueckholen — aber nur als REPARATUR.

         Fehlt sie, weil der erste Anlauf sie aufgeloest hat (Marke
         "shopAufStart"), kommt sie zurueck. Fehlt sie, weil jemand in der
         Verwaltung eine eigene Aufteilung gebaut hat, bleibt das so: eine
         Aufteilung von Hand ist eine Entscheidung, kein Versehen. */
      const repariert = erledigt("shopAufStart");
      if (repariert && !seiten.some((p) => str(p?.slug) === "shop")) {
        const vorlage = list(korr.seiten).find((p) => str(p?.slug) === "shop");
        seiten.push(
          kopie(vorlage || { slug: "shop", navLabel: "Shop", title: "Shop", hero: "compact", inNav: true, enabled: true, sections: ["shop"] })
        );
        // Der Seitenname haengt am Platz in der Liste — Uebersetzung mitgeben.
        const platz = String(seiten.length - 1);
        for (const [lang, block] of Object.entries(korr.i18n || {})) {
          const name = block?.seiten?.["2"];
          if (!name) continue;
          const i18n = live.i18n || (live.i18n = {});
          const dort = i18n[lang] || (i18n[lang] = {});
          const tabelle = dort.pages || (dort.pages = {});
          if (!tabelle[platz]) tabelle[platz] = kopie(name);
        }
        getan2.push("Seite /shop/");
      }
      // 2) Die Startseite traegt den Shop, direkt hinter der Galerie.
      const ziel = list(start.sections);
      if (!ziel.includes("shop")) {
        const nachGalerie = ziel.indexOf("gallery");
        ziel.splice(nachGalerie < 0 ? ziel.length : nachGalerie + 1, 0, "shop");
        start.sections = ziel;
        getan2.push("Einladung auf der Startseite");
      }
      live.pages = seiten;
      if (getan2.length) getan.push(`Shop: ${getan2.join(" + ")}`);
    }
  }

  /* Die Telefonnummer gibt es nicht mehr — ueberall (12.08.2026).

     Erst wurde sie nur nicht mehr angezeigt, dann geleert. Beides war halb: das
     Feld stand weiter in der Verwaltung und der Schluessel weiter in den Daten.
     Der Kunde will es ganz weg, also wird `sections.contact.phone` GELOESCHT —
     hier und in den Uebersetzungen.

     Wie beim Fotografen haengt das an keiner Marke: das Feld gibt es im Modell
     nicht mehr, und ein Wert aus einem alten Stand waere ein Rest.

     Das Telefonfeld IM Booking-Formular bleibt — dort traegt der Besucher seine
     eigene Nummer ein, das ist etwas anderes. */
  if (ls.contact && ls.contact.phone !== undefined) delete ls.contact.phone;
  for (const wurzel of ["i18n", "i18nHash"]) {
    for (const tabelle of Object.values(live[wurzel] || {})) {
      const dort = tabelle?.sections?.contact;
      if (dort && dort.phone !== undefined) delete dort.phone;
    }
  }

  /* Release-Sperre: wie beim Impressum stehen die Angaben in
     content/korrekturen.json, weil content/site.json bei jedem Build aus der
     Datenbank neu geschrieben wird. Gesetzt wird nur, was fehlt — und der
     Schalter nur, wenn er dort ueberhaupt nicht vorkommt. Wer in der
     Verwaltung ausschaltet, bleibt ausgeschaltet. */
  const rel = Object.entries(korr.release || {}).filter(([f]) => !f.startsWith("_"));
  if (rel.length) {
    const ziel = live.release || (live.release = {});
    let n = 0;
    for (const [feld, wert] of rel) {
      if (feld === "enabled") {
        if (ziel.enabled === undefined) { ziel.enabled = wert; n++; }
        continue;
      }
      if (str(ziel[feld])) continue;
      ziel[feld] = wert;
      n++;
    }
    if (n) getan.push(`${n} Release-Angabe(n)`);

    /* Ein Sonderfall: der Text stand schon in der Datenbank, als der Kunde ihn
       auf "Meine neue Website" geaendert haben wollte. Ersetzt wird deshalb
       genau der eine bekannte Wortlaut — schreibt jemand in der Verwaltung
       etwas anderes, passt die Regel nicht mehr und laesst den Text stehen. */
    const alterText = str(korr.release.alterText);
    if (alterText && str(ziel.text) === alterText && str(korr.release.text)) {
      ziel.text = str(korr.release.text);
      getan.push("Release-Text");
    }
  }

  if (korr.bookingBild?.src && !ls.booking?.photo?.src) {
    ls.booking = { ...ls.booking, photo: kopie(korr.bookingBild) };
    getan.push("Booking-Bild");
  }

  // Uebersetzungen zu den ersetzten Listen mitziehen.
  for (const lang of ["de", "fr"]) {
    const q = korr.i18n?.[lang];
    if (!q) continue;
    const zielS = live.i18n?.[lang]?.sections;
    if (q.referenzen && zielS?.references) zielS.references.items = kopie(q.referenzen);
    if (q.heroStats && live.i18n?.[lang]?.hero) live.i18n[lang].hero.stats = kopie(q.heroStats);
    /* Die Faktenzeile in "Ueber mich" stand auf /de/ und /fr/ englisch da
       ("Clubs & festivals", "BPM home base"), waehrend die gleichen Kennzahlen
       im Hero uebersetzt waren — fuer die Fakten gab es einfach keine
       Uebersetzung. Wie beim Hero haengt sie am PLATZ in der Liste, deshalb
       tragen die Eintraege dieselben Nummern; die stillgelegte Kennzahl behaelt
       ihren Platz, damit nichts verrutscht. */
    if (q.aboutFacts) {
      const ziel = zielS || (live.i18n[lang].sections = {});
      ziel.about = { ...ziel.about, facts: kopie(q.aboutFacts) };
    }
    if (q.seiten && live.i18n?.[lang]) live.i18n[lang].pages = kopie(q.seiten);
    /* Im franzoesischen Menue stand "Kontakt" — der deutsche Wert war in die
       franzoesische Uebersetzung geraten. Ersetzt wird nur genau dieser
       Fehlwert; ein eigener Text bleibt stehen. */
    if (q.kontaktNavLabel && zielS?.contact && str(zielS.contact.navLabel) === "Kontakt") {
      zielS.contact.navLabel = q.kontaktNavLabel;
      getan.push(`Kontakt-Menuepunkt ${lang}`);
    }
  }

  /* Sichtbarkeit und Reihenfolge bleiben unangetastet — darueber entscheidet
     allein die Verwaltung.

     Bis zum 11.08.2026 gab es hier eine Ausnahme: `shop.sichtbar` erzwang den
     Shop-Abschnitt, damit /shop/ oeffentlich mit 200 antwortet. Der Preis war,
     dass der Schalter "Auf Website anzeigen" in der Verwaltung wirkungslos
     blieb — eine Attrappe. Die Regel ist weg. Schaltet jemand den Shop aus,
     verschwindet /shop/ tatsaechlich (404); genau das soll der Schalter ja
     bewirken. */

  /* Die Kennzahl "First set 2021" war vom 10.08.2026 bis zur Rueckmeldung des
     Kunden am selben Tag stillgelegt (Regel `entfernteKennzahlen`). Der Kunde
     will die Jahreszahl im Hero wieder sehen — die Regel ist damit weg, und
     hier werden die Markierungen aus alten Staenden aufgeraeumt. Ohne das
     bliebe die Kennzahl im eingecheckten Schnappschuss weiter versteckt, denn
     dort steht `entfernt: true` schon geschrieben. */
  let entstillt = 0;
  for (const eintrag of [...list(live.hero?.stats), ...list(ls.about?.facts)]) {
    if (eintrag && eintrag.entfernt !== undefined) {
      delete eintrag.entfernt;
      entstillt++;
    }
  }
  if (entstillt) getan.push(`${entstillt} stillgelegte Kennzahl(en) wieder sichtbar`);

  /* Die Faktenzeile unten in "Ueber mich" faellt ganz weg — Kundenwunsch vom
     10.08.2026 (siehe aboutFakten._warum in korrekturen.json). Hier wird die
     Liste geleert; der Generator laesst bei leerer Liste das ganze <dl> aus,
     also bleibt keine Flaeche und keine Trennlinie stehen.

     Die Uebersetzungen haengen am Platz in der Liste und werden mit geleert —
     sonst blieben Eintraege stehen, die auf nichts mehr zeigen.

     NICHT die Kennzahlen im Hero: die bleiben, samt "2021 / First set". */
  if (korr.aboutFakten?.leeren === true && list(ls.about?.facts).length) {
    const weg = ls.about.facts.length;
    ls.about.facts = [];
    for (const wurzel of ["i18n", "i18nHash"]) {
      for (const lang of Object.keys(live[wurzel] || {})) {
        const dort = live[wurzel]?.[lang]?.sections?.about;
        if (dort && dort.facts !== undefined) delete dort.facts;
      }
    }
    getan.push(`${weg} Fakt(en) aus "Ueber mich" entfernt`);
  }

  return getan;
}

/**
 * Bildmasse aus der Medienbibliothek der Verwaltung. Sie stehen dort seit dem
 * Hochladen (width/height je Datei), kamen bisher aber nie in der Website an.
 *
 * Die Masse liegen bewusst NICHT im Inhalt: dort muessten sie bei jedem
 * Bildwechsel mitgepflegt werden und waeren schnell falsch. Der Generator
 * schlaegt sie stattdessen ueber die Bild-Adresse nach und schreibt einen
 * Schnappschuss mit, damit ein Build ohne API (und die lokale Vorschau)
 * dieselben Zahlen hat.
 */
async function ladeBildmasse() {
  const api = process.env.MEDIA_API_URL || process.env.CONTENT_API_URL?.replace(/content\.json/, "media.json");
  const map = new Map();

  if (api && /media\.json/.test(api)) {
    try {
      const res = await fetch(api, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) || {};
      for (const m of Object.values(data)) {
        const url = str(m?.url);
        const w = Number(m?.width) || 0;
        const h = Number(m?.height) || 0;
        if (url && w > 0 && h > 0) map.set(url, { w, h });
      }
      if (map.size) {
        await writeFile(LOCAL_MASSE, JSON.stringify(Object.fromEntries(map), null, 2) + "\n");
        console.log(`[build] Bildmasse aus der Medienbibliothek: ${map.size} Bild(er)`);
        return map;
      }
    } catch (err) {
      console.warn("[build] Medienbibliothek nicht lesbar:", err.message);
    }
  }

  try {
    const roh = JSON.parse(await readFile(LOCAL_MASSE, "utf8"));
    for (const [url, m] of Object.entries(roh)) {
      if (Number(m?.w) > 0 && Number(m?.h) > 0) map.set(url, { w: Number(m.w), h: Number(m.h) });
    }
    if (map.size) console.log(`[build] Bildmasse aus dem Schnappschuss: ${map.size} Bild(er)`);
  } catch (e) {
    /* noch kein Schnappschuss — dann bleiben die Bilder ohne width/height */
  }
  return map;
}

/** Korrekturen laden. Fehlt die Datei, bleibt nur die Schreibweise. */
async function ladeKorrekturen() {
  try {
    return JSON.parse(await readFile(LOCAL_KORREKTUREN, "utf8"));
  } catch (e) {
    console.warn("[build] content/korrekturen.json nicht lesbar:", e.message);
    return null;
  }
}

async function loadContent() {
  KORREKTUREN = await ladeKorrekturen();
  const apiUrl = process.env.CONTENT_API_URL;
  if (apiUrl) {
    try {
      const headers = { Accept: "application/json" };
      const token = process.env.CONTENT_API_TOKEN;
      if (token) headers.Authorization = `Bearer ${token}`;
      // no-store: der Build darf nie eine zwischengespeicherte Antwort sehen.
      // Sonst baut er nach dem Publizieren noch den Stand von vorher.
      const res = await fetch(apiUrl, { headers, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const live = data && data.content ? data.content : data;
      if (!live || typeof live !== "object" || !live.site) {
        throw new Error("Antwort enthält kein site-Objekt");
      }
      /* Zuerst festhalten, welche verwalteten Listen die Datenbank NICHT
         geliefert hat — die bleiben leer, statt aus dem letzten Build
         nachgefuellt zu werden. Muss vor withDefaults passieren. */
      const leer = leereListenFesthalten(live);
      if (leer.length) console.log(`[build] leer aus der Verwaltung: ${leer.join(", ")}`);
      let content = live;
      try {
        const template = JSON.parse(await readFile(LOCAL_CONTENT, "utf8"));
        let legacy = null;
        try {
          legacy = JSON.parse(await readFile(resolve(ROOT, "content/legacy-en.json"), "utf8"));
        } catch (e) {
          /* keine Legacy-Datei — dann entscheidet nur die Sprach-Einstellung */
        }
        // Alter Stand in der Datenbank? Zwei Anzeichen: (a) die Hauptsprache
        // weicht von der Vorlage ab, oder (b) die Texte sind noch die alten
        // englischen Werkstexte — auch wenn in der Verwaltung längst
        // "Deutsch" eingestellt wurde. In beiden Fällen kommen Texte,
        // Übersetzungen und Seitenaufteilung aus der Vorlage; Bilder, Videos,
        // Termine und Links bleiben unangetastet.
        const legacyHits = looksLikeLegacy(live, legacy);
        if (String(live.site?.lang || "") !== String(template.site?.lang || "") || legacyHits >= 10) {
          console.log(
            `[build] Datenbank trägt noch den alten Stand ` +
              `(Sprache "${live.site?.lang}", ${legacyHits} Werkstexte erkannt) — ` +
              `Texte, Übersetzungen und Seitenaufteilung aus der Vorlage übernommen.`
          );
          adoptTexts(live, template);
        }
        const korrigiert = nachziehen(live, KORREKTUREN);
        if (korrigiert.length) {
          console.log(`[build] Aus der Vorlage nachgezogen: ${korrigiert.join(", ")}.`);
        }
        content = withDefaults(live, template);
      } catch (e) {
        console.warn("[build] Vorlage content/site.json nicht lesbar:", e.message);
      }
      const gerutscht = showsNachReferenzen(content, today());
      if (gerutscht.length)
        console.log(`[build] vorbei, jetzt Referenz: ${gerutscht.join(", ")}`);
      console.log(`[build] Inhalt von der Verwaltung geladen: ${apiUrl}`);
      // Snapshot mitschreiben, damit der Build ohne API reproduzierbar bleibt.
      await writeFile(LOCAL_CONTENT, JSON.stringify(content, null, 2) + "\n");
      return content;
    } catch (err) {
      console.warn(
        "\n" +
          "########################################################\n" +
          "#  WARNUNG: Verwaltungs-API nicht erreichbar!           #\n" +
          `#  ${String(err.message).slice(0, 50).padEnd(50)}#\n` +
          "#  Es wird der eingecheckte Stand content/site.json     #\n" +
          "#  verwendet — evtl. NICHT der aktuellste Inhalt.       #\n" +
          "########################################################\n"
      );
    }
  }
  const raw = await readFile(LOCAL_CONTENT, "utf8");
  const lokal = JSON.parse(raw);
  // Auch hier korrigieren: der eingecheckte Stand ist ein Abzug der Datenbank
  // und traegt darum dieselben alten Stellen. Ohne diesen Schritt haette die
  // Vorschau ohne API einen anderen Inhalt als die Website.
  const korrigiert = nachziehen(lokal, KORREKTUREN);
  const gerutschtLokal = showsNachReferenzen(lokal, today());
  if (gerutschtLokal.length) korrigiert.push(`vorbei, jetzt Referenz: ${gerutschtLokal.join(", ")}`);
  console.log(
    "[build] Inhalt aus content/site.json geladen" +
      (korrigiert.length ? ` — nachgezogen: ${korrigiert.join(", ")}` : "")
  );
  /* Korrigierten Stand zurueckschreiben, sonst weicht die eingecheckte Datei von
     dem ab, was gebaut wurde. Verglichen wird der Text, nicht die Liste der
     Meldungen: manche Korrekturen loeschen nur ein Feld und melden das
     absichtlich nicht (Fotograf, Telefonnummer) — die waeren sonst im
     Schnappschuss nicht angekommen. */
  const nachher = JSON.stringify(lokal, null, 2) + "\n";
  if (nachher !== raw) await writeFile(LOCAL_CONTENT, nachher);
  return lokal;
}

/* --------------------------------------------------------------- bausteine */

function sectionHead(n, s, key) {
  if (CTX.hideHead === key) return "";
  return `
      <div class="shead rv">
        <span class="num" aria-hidden="true">${num(n)}</span>
        <h2 id="${esc(key)}-h">${esc(s.title)}<i>${esc(s.titleAccent)}</i></h2>
        <span class="shead-rule" aria-hidden="true"></span>
      </div>`;
}

/*
 * Bilder über das Netlify-Image-CDN ausliefern: verkleinert, als WebP/AVIF,
 * am Netz-Rand zwischengespeichert. Die Uploads aus der Verwaltung sind
 * Handyfotos in Originalgrösse (mehrere MB) — direkt aus Firebase geladen
 * fühlt sich das auf dem Handy wie "Bilder laden nicht" an.
 *
 * Aktiv nur, wenn der Build bei Netlify läuft (oder IMAGE_CDN=1 gesetzt ist);
 * lokal bleiben die Originalpfade, damit Vorschau und Tests ohne CDN laufen.
 */
const CDN = !!(process.env.NETLIFY || process.env.IMAGE_CDN);

function cdnUrl(src, w) {
  const clean = String(src || "").trim();
  if (!CDN || !clean || isVideoUrl(clean)) return rooted(clean);
  if (/^data:/i.test(clean)) return clean;
  return `/.netlify/images?url=${encodeURIComponent(rooted(clean))}&w=${w}&q=72`;
}

/**
 * Bildmasse aus der Medienbibliothek, nach Adresse. Wird in ladeBildmasse()
 * gefüllt. Ohne Eintrag bleibt das Bild ohne width/height — dann verhält es
 * sich wie bisher.
 */
let BILDMASSE = new Map();

/** Masse eines Bildes: erst am Inhalt, sonst aus der Medienbibliothek. */
function masseVon(media, raw) {
  const w = Number(media?.width) || 0;
  const h = Number(media?.height) || 0;
  if (w > 0 && h > 0) return { w, h };
  const m = BILDMASSE.get(raw);
  return m && m.w > 0 && m.h > 0 ? m : null;
}

function picture(media, { className = "", eager = false, sizes = "", widths = [480, 800, 1200], style = "" } = {}) {
  const raw = String(media?.src || "").trim();
  if (!raw || !safeUrl(raw)) return "";
  const srcset = CDN
    ? ` srcset="${widths.map((w) => `${esc(cdnUrl(raw, w))} ${w}w`).join(", ")}"`
    : "";
  // width/height reservieren den Platz, bevor das Bild da ist — ohne sie
  // springt der Text beim Nachladen nach unten (Layout Shift). Die Zahlen
  // sind nur das Seitenverhältnis; die tatsächliche Grösse macht das CSS.
  const masse = masseVon(media, raw);
  const attrs = [
    `src="${esc(cdnUrl(raw, widths[widths.length - 1]))}"`,
    `alt="${esc(media?.alt || "")}"`,
    masse ? `width="${masse.w}" height="${masse.h}"` : "",
    eager ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"',
    sizes ? `sizes="${esc(sizes)}"` : "",
    className ? `class="${esc(className)}"` : "",
  ].filter(Boolean);
  return `<img ${attrs.join(" ")}${srcset}${style}>`;
}

/** MIME-Typ aus der Dateiendung (Firebase-URLs tragen die Endung im Pfad). */
const videoType = (url) => {
  const u = String(url || "").toLowerCase();
  if (/\.webm(\?|#|$)/.test(u)) return "video/webm";
  if (/\.(mov|m4v)(\?|#|$)/.test(u)) return "video/quicktime";
  return "video/mp4";
};

const isVideoUrl = (url) => /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(String(url || ""));

/**
 * Ortsangaben für Suchmaschinen. Alte, aber weiterhin gelesene Signale für
 * lokale Suchen ("DJ St. Gallen").
 */
function geoMeta(contact) {
  const place = str(contact?.base);
  if (!place) return "";
  const region = /st\.?\s*gallen/i.test(place) ? "CH-SG" : "CH";
  return `  <meta name="geo.region" content="${esc(region)}">
  <meta name="geo.placename" content="${esc(place)}">
`;
}

/**
 * Aufsteigende Funken — das bewegte Element der Seite, passend zum Namen
 * Sparking. Position, Grösse, Tempo und Drift jedes Funkens sind fest
 * eingerechnet, damit jeder Build dieselbe Datei erzeugt; animiert wird rein
 * in CSS, negative Verzögerungen lassen die Funken schon beim Laden fliegen.
 */
function sparks(n = 16) {
  let out = "";
  for (let i = 0; i < n; i++) {
    const x = ((i * 61) % 97) + 2;
    const size = 2 + ((i * 7) % 3);
    const t = (7 + ((i * 13) % 8)).toFixed(1);
    const d = (-(((i * 17) % 20) / 20) * 7).toFixed(2);
    const dx = ((i * 29) % 11) - 5;
    out += `<span style="--x:${x}%;--s:${size}px;--t:${t}s;--d:${d}s;--dx:${dx}vw"></span>`;
  }
  return out;
}

/**
 * Hintergrundbild der ganzen Seite. Liegt hinter allem, bewegt sich nicht mit
 * und ist stark abgedunkelt — die Inhalte stehen darauf frei, ohne dass der
 * Text an Kontrast verliert.
 */
function pageBackground(site) {
  if (!safeUrl(site.backgroundImage)) return "";
  const small = esc(cdnUrl(site.backgroundImage, 800));
  const big = esc(cdnUrl(site.backgroundImage, 1600));
  const style = CDN
    ? `background-image:url('${small}');background-image:image-set(url('${small}') 1x,url('${big}') 2x)`
    : `background-image:url('${big}')`;
  return `  <div class="page-bg" aria-hidden="true" style="${style}"></div>`;
}

/**
 * Hero-Hintergrund. Video läuft stumm in Dauerschleife — anders erlaubt kein
 * Browser Autoplay. Das Poster wird sofort angezeigt (und bleibt stehen, wenn
 * jemand „Bewegung reduzieren" eingestellt hat, siehe assets/site.js).
 */
/**
 * Anzeige-Art eines Mediums:
 *   fill (Standard) – fuellt die Flaeche, Raender werden abgeschnitten
 *   full            – das ganze Bild/Video ist zu sehen, ggf. mit Rand
 * Dazu der Bildausschnitt (welcher Teil sichtbar bleibt, wenn beschnitten wird).
 */
const FOCUS = new Set(["center", "top", "bottom", "left", "right"]);

function fitAttrs(m) {
  const full = str(m?.fit) === "full";
  const focus = FOCUS.has(str(m?.focus)) ? str(m.focus) : "center";
  return {
    cls: full ? " fit-full" : "",
    style: !full && focus !== "center" ? ` style="object-position:${esc(focus)}"` : "",
  };
}

/**
 * Zuschnitt eines Videos: ab welcher und bis zu welcher Sekunde abgespielt
 * wird. Beide Angaben sind freiwillig — ohne sie läuft das ganze Video.
 * Geschnitten wird nicht die Datei, sondern die Wiedergabe (assets/site.js);
 * die Sekunden stehen darum als data-Attribute am <video>.
 */
function clipAttrs(m) {
  const sec = (v) => {
    const n = Number.parseFloat(String(v ?? "").replace(",", "."));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  };
  const start = sec(m?.clipStart);
  const end = sec(m?.clipEnd);
  let out = "";
  if (start !== null) out += ` data-clip-start="${start}"`;
  if (end !== null && (start === null || end > start)) out += ` data-clip-end="${end}"`;
  return out;
}

function heroMedia(hero, site) {
  const m = hero.media || {};
  if (m.type === "video" && safeUrl(m.src)) {
    const posterSrc = safeUrl(m.poster) || safeUrl(site?.ogImage) || safeUrl(site?.backgroundImage);
    const poster = posterSrc ? esc(cdnUrl(posterSrc, 1600)) : "";
    const f = fitAttrs(m);
    return `<video class="hero-video${f.cls}" autoplay muted loop playsinline preload="auto"${
      poster ? ` poster="${poster}"` : ""
    }${f.style}${clipAttrs(m)} aria-hidden="true" tabindex="-1"><source src="${href(m.src)}"></video>`;
  }
  const f = fitAttrs(m);
  return picture(m, {
    eager: true,
    sizes: "100vw",
    className: f.cls.trim(),
    style: f.style,
  });
}

/**
 * Kennzahlen auf dem ersten Bildschirm. Im HTML steht immer der fertige Wert —
 * ohne JavaScript, bei „Bewegung reduzieren“ und für Suchmaschinen ist die
 * Zahl damit sofort da. Der Zähl-Effekt (assets/site.js) zerlegt sie in
 * Vorsatz, Ziffern und Nachsatz; darum stehen diese Teile als data-Attribute
 * daneben statt sie im Browser noch einmal aus dem Text zu raten.
 */
function heroStats(hero) {
  // `entfernt` setzt die Korrekturdatei (entfernteKennzahlen). Die Kennzahl
  // bleibt an ihrem Platz stehen, damit die Uebersetzungen nicht verrutschen
  // — gezeigt wird sie nicht mehr.
  const items = list(hero?.stats).filter((s) => str(s?.value) && s?.entfernt !== true);
  if (!items.length) return "";
  const rows = items
    .map((s) => {
      const value = str(s.value).trim();
      // "7+" → Ziffern "7", Nachsatz "+";  "CHF 5" → Vorsatz "CHF ", Ziffern "5"
      const m = value.match(/^([^\d]*)(\d[\d'’.,]*)(.*)$/);
      const data = m
        ? ` data-to="${esc(m[2].replace(/[^\d]/g, ""))}"` +
          ` data-pre="${esc(m[1])}" data-post="${esc(m[3])}"`
        : "";
      return `<div class="hstat">
          <strong class="hstat-value"${data}>${esc(value)}</strong>
          ${str(s.label) ? `<span class="hstat-label">${esc(s.label)}</span>` : ""}
        </div>`;
    })
    .join("\n        ");
  return `<div class="hero-stats">
        ${rows}
      </div>`;
}

function renderAbout(n, s) {
  // `entfernt`: siehe heroStats — von der Korrekturdatei stillgelegt.
  const facts = list(s.facts).filter((f) => str(f?.value) && f?.entfernt !== true);
  const paragraphs = list(s.paragraphs).filter((p) => str(p));
  const firstParagraph = paragraphs[0];
  const moreParagraphs = paragraphs.slice(1);
  return `
  <section class="pad" id="about" aria-labelledby="about-h">
    <div class="wrap">${sectionHead(n, s, "about")}
      <div class="about-grid">
        <div class="about-photo rv">
          ${picture(s.photo, { sizes: "(max-width:860px) 90vw, 40vw" })}
        </div>
        <div class="about-copy rv">
          ${str(s.lede) ? `<p class="lede">${inline(s.lede)}</p>` : ""}
          ${firstParagraph ? `<p>${inline(firstParagraph)}</p>` : ""}
          ${
            moreParagraphs.length
              ? `<div class="about-more" id="about-more">
            ${moreParagraphs.map((p) => `<p>${inline(p)}</p>`).join("\n            ")}
          </div>
          <button class="about-toggle mono" type="button" aria-controls="about-more" aria-expanded="false"
                  data-more="${esc(UI.moreStory)}" data-less="${esc(UI.lessStory)}">${esc(
                    UI.moreStory
                  )}</button>`
              : ""
          }
          ${
            list(s.words).length
              ? `<div class="three-words">${list(s.words)
                  .map((w) => `<span>${esc(w)}</span>`)
                  .join("")}</div>`
              : ""
          }
        </div>
      </div>
      ${
        facts.length
          ? `<dl class="facts rv">${facts
              .map(
                (f) =>
                  `<div><dt class="mono">${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`
              )
              .join("")}</dl>`
          : ""
      }
    </div>
  </section>`;
}

function renderSound(n, s) {
  const mixes = list(s.mixes).filter((m) => str(m?.title));
  return `
  <section class="sound pad" id="sound" aria-labelledby="sound-h">
    <div class="wrap">${sectionHead(n, s, "sound")}
      <div class="sound-grid">
        <div class="rv">
          <ul class="genre-list">
            ${list(s.genres)
              .filter((g) => str(g?.name))
              .map(
                (g) =>
                  `<li>${esc(g.name)} <span class="mono">${esc(str(g.meta, "Genre"))}</span></li>`
              )
              .join("\n            ")}
          </ul>
          ${str(s.note) ? `<p class="live-note">${inline(s.note)}</p>` : ""}
        </div>
        <div class="mix-stack rv">
          ${mixes
            .map(
              (m) => `<article class="mix-card">
            ${str(m.kicker) ? `<span class="mono">${esc(m.kicker)}</span>` : ""}
            <h3>${esc(m.title)}</h3>
            ${str(m.text) ? `<p>${inline(m.text)}</p>` : ""}
            ${
              safeUrl(m.embedUrl)
                ? `<div class="mix-embed"><iframe src="${href(m.embedUrl)}" title="${esc(
                    m.title
                  )}" loading="lazy" allow="autoplay" frameborder="0"></iframe></div>`
                : ""
            }
            ${
              safeUrl(m.linkUrl)
                ? `<a class="btn" href="${href(m.linkUrl)}" target="_blank" rel="noopener noreferrer">${esc(
                    str(m.linkLabel, "Listen")
                  )}</a>`
                : ""
            }
          </article>`
            )
            .join("\n          ")}
        </div>
      </div>
    </div>
  </section>`;
}

function renderExperience(n, s) {
  const moments = list(s.moments).filter((m) => str(m?.title));
  return `
  <section class="pad" id="experience" aria-labelledby="experience-h">
    <div class="wrap">${sectionHead(n, s, "experience")}
      ${str(s.lede) ? `<p class="lede rv">${inline(s.lede)}</p>` : ""}
      ${
        moments.length
          ? `<div class="experience-composition rv">
        <div class="speaker-model" aria-hidden="true">
          <span class="speaker-aura"></span>
          <span class="sound-ring ring-one"></span>
          <span class="sound-ring ring-two"></span>
          <span class="speaker-beam beam-left"></span>
          <span class="speaker-beam beam-right"></span>
          <span class="speaker-levels">
            <i style="--level:28%"></i><i style="--level:54%"></i><i style="--level:82%"></i>
            <i style="--level:46%"></i><i style="--level:70%"></i><i style="--level:38%"></i>
          </span>
          <div class="speaker-rig">
            <span class="rig-hook"></span>
            <div class="line-array">
              <span class="array-module"><i></i><i></i></span>
              <span class="array-module"><i></i><i></i></span>
              <span class="array-module"><i></i><i></i></span>
              <span class="array-module"><i></i><i></i></span>
            </div>
            <div class="sub-cabinet">
              <span class="speaker-brand">SAM SPARKLING<small>LIVE SYSTEM</small></span>
              <span class="sub-driver"><i></i></span>
              <span class="speaker-port"></span>
            </div>
          </div>
          <span class="speaker-floor"></span>
        </div>
        <div class="moment-grid">${moments
              .map(
                (m, index) => `<article class="mix-card" data-step="${String(index + 1).padStart(
                  2,
                  "0"
                )}">
            ${str(m.kicker) ? `<span class="mono">${esc(m.kicker)}</span>` : ""}
            <h3>${esc(m.title)}</h3>
            ${str(m.text) ? `<p>${inline(m.text)}</p>` : ""}
          </article>`
              )
              .join("\n          ")}</div>
      </div>`
          : ""
      }
      ${
        safeUrl(s.embedUrl)
          ? `<div class="mix-embed rv"><iframe src="${href(s.embedUrl)}" title="${esc(
              str(s.embedLabel, "Aftermovie")
            )}" loading="lazy" allow="autoplay" frameborder="0"></iframe></div>`
          : ""
      }
      ${
        str(s.quote?.text)
          ? `<blockquote class="lede rv">${inline(s.quote.text)}${
              [str(s.quote.name), str(s.quote.venue)].filter(Boolean).length
                ? `<footer class="mono">— ${[esc(s.quote.name), esc(s.quote.venue)]
                    .filter(Boolean)
                    .join(", ")}</footer>`
                : ""
            }</blockquote>`
          : ""
      }
    </div>
  </section>`;
}

function showRow(sh, idx) {
  const date = isoDate(sh.date);
  const booked = sh.status === "booked";
  const d = date ? new Date(date + "T12:00:00Z") : null;
  const day = d ? String(d.getUTCDate()).padStart(2, "0") : "";
  const month = d
    ? d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase()
    : "";
  const year = d ? d.getUTCFullYear() : "";
  const soldOut = sh.status === "soldout";
  /* Der Ticket-Link haengt AM LINK, nicht am Status.

     Anlass (Kundenmeldung 12.08.2026): "Tickets buchen über Shows geht nicht".
     Und tatsaechlich — bei "Aftersun" stand eine echte Ticket-Adresse in der
     Verwaltung, auf der Seite aber nur das Wort "Gebucht". Der Grund: der Link
     wurde bei `status === "booked"` unterdrueckt.

     Das war eine Fehldeutung des Status. In der Verwaltung heisst er
     "bestaetigt / gebucht / ausverkauft" — "gebucht" sagt, dass Sam den Termin
     hat, nicht dass es keine Tickets gibt. Nur "ausverkauft" schliesst den
     Verkauf aus.

     Also: gueltige Adresse und nicht ausverkauft -> Ticket-Knopf. Sonst steht
     dort, was zutrifft: "Ausverkauft", ein freier Hinweis aus dem Ticket-Feld
     ("DM for friendlist") oder — wenn es nichts zu sagen gibt — nichts. Eine
     leere Beschriftung stand vorher als leeres Feld in der Zeile. */
  const kasse = safeUrl(sh.ticketUrl) && !soldOut;
  const freierHinweis = !safeUrl(sh.ticketUrl) ? str(sh.ticketUrl).trim() : "";
  const label = soldOut ? UI.soldOut : str(sh.ticketLabel, UI.tickets);
  const hinweis = soldOut ? UI.soldOut : freierHinweis || (booked ? UI.booked : "");
  return `<li class="show${soldOut ? " soldout" : ""}${booked ? " booked" : ""}"${date ? ` data-date="${esc(date)}"` : ""}>
          <span class="show-date"><b>${esc(day)}</b><span class="mono">${esc(month)} ${esc(
    year
  )}</span></span>
          <span class="show-main">
            <span class="show-name">${esc(sh.name)}</span>
            <span class="mono show-where">${[str(sh.venue), str(sh.city), str(sh.country)]
              .filter(Boolean)
              .map(esc)
              .join(" · ")}</span>
          </span>
          ${
            kasse
              ? `<span class="show-cta"><a class="btn btn-sm" href="${href(
                  sh.ticketUrl
                )}" target="_blank" rel="noopener noreferrer">${esc(label)}</a></span>`
              : hinweis
              ? `<span class="show-cta"><span class="mono">${esc(hinweis)}</span></span>`
              : `<span class="show-cta"></span>`
          }
        </li>`;
}

function renderShows(n, s) {
  const t = today();
  const items = list(s.items).filter((i) => str(i?.name));
  if (!items.length) return "";
  /* Chronologisch, immer — unabhaengig davon, in welcher Reihenfolge die
     Termine in der Verwaltung stehen. Zuerst das Datum, bei gleichem Datum die
     Uhrzeit. Termine ohne Datum stehen ganz hinten: sie lassen sich nirgends
     einordnen, und "irgendwann" gehoert nicht vor einen festen Termin.
     Uhrzeit fehlt haeufig — dann zaehlt sie als 00:00 und der Termin steht vor
     denen mit Zeitangabe am selben Tag. */
  const zeit = (i) => {
    const m = String(i?.time ?? "").match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  };
  const chronologisch = (a, b) => {
    const da = isoDate(a.date), db = isoDate(b.date);
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    if (da !== db) return da < db ? -1 : 1;
    return zeit(a) - zeit(b);
  };
  const upcoming = items
    .filter((i) => !isoDate(i.date) || isoDate(i.date) >= t)
    .sort(chronologisch);
  // Rueckblick andersherum: das Juengste zuerst.
  const past = items
    .filter((i) => isoDate(i.date) && isoDate(i.date) < t)
    .sort((a, b) => -chronologisch(a, b));


  return `
  <section class="pad shows-sec" id="shows" aria-labelledby="shows-h">
    <div class="wrap">${sectionHead(n, s, "shows")}
      ${
        upcoming.length
          ? `<ul class="show-list rv" id="show-list">
        ${upcoming.map(showRow).join("\n        ")}
      </ul>`
          : `<div class="empty-state rv"><span class="mono">${esc(UI.calShow)}</span><p>${inline(
              str(s.emptyText, "No dates announced right now.")
            )}</p></div>`
      }
      ${
        past.length
          ? `<details class="past-shows rv">
        <summary class="mono">${esc(str(s.pastLabel, "Played before"))} (${past.length})</summary>
        <ul class="show-list past">
        ${past.map(showRow).join("\n        ")}
        </ul>
      </details>`
          : ""
      }
    </div>
  </section>`;
}

/**
 * Referenzen — eine Liste, ein Stil, eine Reihenfolge.
 *
 * Bis zum 11.08.2026 standen oben vier grosse Karten und darunter, hinter einer
 * Zwischenzeile ("Also played at"), der kleine Rest. Das ist weg: alle
 * Referenzen erscheinen fortlaufend im selben kleinen Stil.
 *
 * Warum: die Aufteilung war eine zweite, unsichtbare Rangfolge neben der
 * Reihenfolge in der Verwaltung. Wer dort mit ↑ ↓ etwas nach oben schob, sah
 * nichts davon, solange der Eintrag nicht auch "Gross zeigen" trug — und wer
 * "Gross zeigen" setzte, sprengte die Reihenfolge. Jetzt entscheidet allein die
 * Reihenfolge in der Verwaltung, und die ist eins zu eins zu sehen.
 *
 * `highlight` bleibt im Inhalt stehen (die Auswahl des Kunden geht nicht
 * verloren), hat auf die Darstellung aber keine Wirkung mehr. Auch `group`
 * buendelt nichts mehr — eine Liste bleibt eine Liste.
 */
function renderReferences(n, s, bookingTarget) {
  const items = list(s.items).filter((i) => str(i?.name));

  const linkOf = (v) => {
    const url = safeUrl(v.url) || anchor("#booking");
    const ext = /^https?:/i.test(url) ? ' target="_blank" rel="noopener noreferrer"' : "";
    return { url, ext };
  };

  /* Auf dem Handy zunaechst nur die obersten vier, der Rest hinter einem Knopf
     (Kundenwunsch 12.08.2026). Auf dem Desktop bleibt alles zu sehen — dort
     steht die Liste als Raster und kostet kaum Hoehe, auf dem Handy dagegen
     untereinander: 25 Eintraege waren dort eine halbe Seite Scrollen zwischen
     zwei Abschnitten.

     Alle Eintraege stehen im Dokument, auch die verborgenen. Verborgen wird
     ausschliesslich per CSS und nur in der schmalen Breite — wer kein
     JavaScript hat, sieht die vollstaendige Liste (`html.js` fehlt dann). */
  const MOBIL_SICHTBAR = 4;
  const versteckt = Math.max(0, items.length - MOBIL_SICHTBAR);
  const liste = items.length
    ? `<ul class="venue-list rv" id="venue-list">
        ${items
          .map((v, i) => {
            const { url, ext } = linkOf(v);
            const extra = i >= MOBIL_SICHTBAR ? ' data-extra="true"' : "";
            return `<li${extra}><a href="${esc(url)}"${ext}><span class="venue-name">${esc(
              v.name
            )}</span><span class="venue-city">${esc(str(v.city))}</span></a></li>`;
          })
          .join("\n        ")}
      </ul>${
        versteckt
          ? `
      <button class="venue-more btn" type="button" aria-controls="venue-list" aria-expanded="false"
              data-more="${esc(UI.showMoreVenues.replace("{n}", versteckt))}"
              data-less="${esc(UI.showLessVenues)}">${esc(
              UI.showMoreVenues.replace("{n}", versteckt)
            )}</button>`
          : ""
      }`
    : "";

  return `
  <section class="pad" id="references" aria-labelledby="references-h">
    <div class="wrap">${sectionHead(n, s, "references")}
      ${liste}
      ${
        str(s.note)
          ? `<p class="live-note rv">${inline(s.note)} <a class="accent" href="${esc(
              /* "Dein Club oder Festival als Nächstes? Schreib mir →" ist eine
                 Anfrage, kein Kontaktwunsch: der Weg dorthin ist das
                 Booking-Formular auf der eigenen Booking-Seite, nicht der
                 Kontakt-Abschnitt. `bookingTarget` rechnet die Adresse fertig
                 aus — samt Sprachpräfix und SITE_BASE, also /booking/ auf der
                 Produktivdomain und /site/booking/ in der Vorführ-Fassung.
                 Fehlt der Booking-Abschnitt ganz, bleibt der Kontakt der
                 nächstbeste Weg, statt ins Leere zu zeigen. */
              bookingTarget || anchor("#contact")
            )}">${esc(
              str(s.noteLinkLabel, "Get in touch →")
            )}</a></p>`
          : ""
      }
    </div>
  </section>`;
}

function renderGallery(n, s) {
  /* Fotos UND Videos — Vorgabe vom 10.08.2026. Ein Video steht als eigene
     Kachel mit Vorschaubild und Play-Zeichen dazwischen; die Seite /videos/
     bleibt zusaetzlich bestehen und ist nicht die einzige Ablage.
     Bilder werden dadurch nicht verdraengt: die Reihenfolge kommt aus der
     Verwaltung, ein Video nimmt keinem Foto den Platz weg. */
  const items = list(s.items).filter((i) => safeUrl(i?.src));
  // Fuer die Lightbox-Beschriftung zaehlen nur Bilder — Videos laufen dort nicht.
  const photos = items.filter((i) => !isVideoUrl(i.src));
  // Wie viele Bilder ohne Zutun zu sehen sind — auf allen Bildschirmbreiten
  // gleich, damit die Zahl im Knopf ("6 weitere Bilder") überall stimmt.
  const limit = Math.max(2, Math.min(12, Number.parseInt(s.mobileLimit, 10) || 6));
  const remaining = Math.max(0, items.length - limit);

  const cell = (g, i) => {
    const extra = i >= limit ? ' data-extra="true"' : "";
    if (isVideoUrl(g.src)) {
      const gf = fitAttrs(g);
      /* Die Kachel zeigt zunaechst nur das Vorschaubild; abgespielt wird erst,
         wenn der Zeiger darauf liegt (auf dem Handy: sobald sie im Bild ist).
         Darum kein autoplay und nur `metadata` vorladen — sonst zieht eine
         Galerie voller Videos beim Seitenaufruf zig Megabyte.
         Das Play-Zeichen macht sichtbar, dass hier ein Video steht und kein
         Foto. */
      return `<figure class="gal-video${gf.cls}"${extra}>
          <video src="${href(g.src)}" muted loop playsinline preload="metadata"${
        g.poster ? ` poster="${href(cdnUrl(g.poster, 800))}"` : ""
      }${gf.style}${clipAttrs(g)} aria-label="${esc(g.alt || "")}"></video>
          <span class="gal-play" aria-hidden="true"></span>
        </figure>`;
    }
    const idx = photos.indexOf(g) + 1;
    return `<figure${extra}>
          <button type="button" class="gal-btn" aria-label="${esc(
            UI.openImage.replace("{n}", idx).replace("{total}", photos.length)
          )}">
            ${picture(g, { sizes: "(max-width:700px) 100vw, 33vw", widths: [480, 800] })}
          </button>
        </figure>`;
  };

  return `
  <section class="pad" id="gallery" aria-labelledby="gallery-h">
    <div class="wrap">${sectionHead(n, s, "gallery")}
      <div class="gal rv" id="gal">
        ${items.map(cell).join("\n        ")}
      </div>
      ${
        remaining
          ? `<button class="gal-more btn" type="button" aria-controls="gal" aria-expanded="false"
                  data-more="${esc(UI.showMoreImages.replace("{n}", remaining))}"
                  data-less="${esc(UI.showLessImages)}">${esc(
                    UI.showMoreImages.replace("{n}", remaining)
                  )}</button>`
          : ""
      }
    </div>
  </section>`;
}

/**
 * Preis huebsch ausgeben: "45" + "CHF" -> "CHF 45.—"
 *
 * Die Waehrung wird beschnitten. In der Verwaltung stand "CHF " mit Leerzeichen
 * am Ende — auf der Seite wurde daraus "CHF  25.—" mit doppeltem Abstand.
 */
export function priceTag(price, currency) {
  const v = String(price ?? "").trim();
  if (!v) return "";
  const cur = String(currency ?? "").trim();
  return /[A-Za-z]/.test(v) ? v : `${cur} ${v}${/[.,]/.test(v) ? "" : ".—"}`.trim();
}

/**
 * Bezahlung. Bis August 2026 stand hier TWINT/Bank samt QR-Code zum
 * Abscannen — die Kundin überwies selbst, der Versand ging nach Zahlungs-
 * eingang raus. Das ist keine Bezahlung im Shop, sondern eine Rechnung ohne
 * Kontrolle: niemand weiss, ob und wann Geld kam, und der QR-Code taugt
 * ausdrücklich nicht als Ersatz für eine Bezahlseite.
 *
 * Bezahlt wird deshalb über Stripe. Der Ablauf steht in AUDIT.md; hier steht
 * nur, was die Kundin vor dem Absenden wissen muss.
 */
/**
 * Ist eine echte Stripe-Adresse hinterlegt?
 *
 * Dieselbe Pruefung wie in netlify/functions/order.mjs — und zwar bewusst
 * Zeichen fuer Zeichen dieselbe Regel: nur https und nur stripe.com oder
 * link.com. Waere die Seite grosszuegiger als der Endpunkt, verspraeche sie
 * eine Bezahlung, die der Endpunkt danach verweigert. Ein Tippfehler in der
 * Umgebungsvariablen faellt damit auf die sichere Seite.
 */
/**
 * Ein Stripe **Payment Link** je Artikel — die Adresse, die im Stripe-Dashboard
 * unter "Payment links" entsteht. Sie sieht immer gleich aus:
 * `https://buy.stripe.com/...`
 *
 * Bewusst enger als `istStripeAdresse`: dort sind alle Adressen unter
 * stripe.com und link.com erlaubt (Weiterleitungen des Endpunkts). Hier geht es
 * um einen Knopf, der Geld kostet — und der darf nur auf die Kasse zeigen, die
 * Stripe fuer genau diesen Artikel ausgestellt hat. Ein Dashboard-Link
 * (dashboard.stripe.com) oder eine Rechnung waere hier falsch.
 *
 * Ein Geheimnis steckt hier nie drin: ein Payment Link ist eine oeffentliche
 * Adresse, die man auch auf ein Plakat drucken koennte. API-Schluessel gehoeren
 * NICHT hierher und werden vom Generator auch nirgends gelesen.
 */
export function istPaymentLink(roh) {
  const wert = String(roh ?? "").trim();
  if (!/^https:\/\/[^\s]+$/i.test(wert)) return false;
  try {
    return new URL(wert).hostname.toLowerCase() === "buy.stripe.com";
  } catch {
    return false;
  }
}

export function istStripeAdresse(roh) {
  const wert = String(roh ?? "").trim();
  if (!/^https:\/\/[^\s]+$/i.test(wert)) return false;
  try {
    const { hostname } = new URL(wert);
    return /(^|\.)stripe\.com$/i.test(hostname) || /(^|\.)link\.com$/i.test(hostname);
  } catch {
    return false;
  }
}

/**
 * Darf die Seite eine aktive Bezahlung ankuendigen?
 *
 * Netlify baut mit `node scripts/build.mjs`; STRIPE_PAYMENT_LINK_URL steht
 * dort als Umgebungsvariable schon beim Bauen zur Verfuegung. Baut jemand
 * anders (der stuendliche Abgleich in GitHub Actions, eine Vorschau von Hand),
 * fehlt sie — dann sagt die Seite, die Bezahlung sei noch nicht aktiv. Das ist
 * die richtige Richtung: lieber zu wenig versprechen als zu viel.
 */
export const zahlungBereit = (site) =>
  istStripeAdresse(process.env.STRIPE_PAYMENT_LINK_URL) ||
  istStripeAdresse(site?.stripePaymentLink) ||
  site?.stripeReady === true;

/*
 * Hier standen bis zum 12.08.2026 zwei Bloecke: "Bezahlen" mit einem Hinweis
 * zur Zahlungsart und darunter das Bestellformular "Wohin darf es gehen?" mit
 * Name, E-Mail und Lieferadresse.
 *
 * Beide sind weg (Kundenwunsch 12.08.2026). Gekauft wird ueber den Stripe
 * Payment Link des Artikels: Stripe nimmt Adresse und Zahlung in einem Schritt
 * auf, das Formular fragte dieselben Angaben ein zweites Mal ab und versprach
 * ausserdem eine Bestaetigungsmail an die Kundschaft, die es nie verschickt hat.
 *
 * Der Endpunkt /api/order bleibt bestehen und unveraendert — er wird von der
 * Seite nur nicht mehr aufgerufen.
 *
 * Ein Artikel OHNE gueltigen Zahlungslink hat damit keinen Kaufweg mehr. Statt
 * eines Knopfes, der nirgendwohin fuehrt, steht dort ein Verweis auf die
 * E-Mail-Adresse der Seite (siehe `kasse` unten).
 */


/**
 * Wie breit eine Ware-Kachel mindestens sein darf, je nachdem wie viel im Shop
 * steht. Je mehr Ware, desto kleiner die Kachel — damit auch ein voller Shop
 * ohne Wischen und ohne endloses Scrollen auf einmal zu sehen ist. Bei wenig
 * Ware bleiben die Kacheln gross, sonst sähen drei Artikel verloren aus.
 *
 * Die Zahl geht als `--tile` in die Seite; das Raster (`.shop-grid`) füllt
 * damit `auto-fill` und rechnet die Spalten selbst aus.
 */
function kachelbreite(anzahl) {
  if (anzahl <= 3) return 240;
  if (anzahl <= 6) return 196;
  if (anzahl <= 10) return 164;
  if (anzahl <= 16) return 136;
  return 116;
}

/* Die drei Zeichen fuer den Informationsstreifen unter dem Katalog. Fest im
   Generator, weil ein Zeichen kein Inhalt ist — Titel und Text kommen aus der
   Verwaltung. Bewusst schlicht: Strichzeichnung in der Textfarbe, kein Bild,
   keine fremde Schrift, kein Nachladen. */
const SHOP_ICONS = {
  zahlung: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/>',
  versand: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  fragen: '<path d="M21 12a9 9 0 1 1-3.2-6.9"/><path d="M9.4 9a2.7 2.7 0 1 1 3.4 2.6c-.6.2-.9.7-.9 1.3v.6"/><path d="M12 17h.01"/>',
};
const shopIcon = (key) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${
    SHOP_ICONS[String(key || "").toLowerCase()] || SHOP_ICONS.fragen
  }</svg>`;

/**
 * Der Shop — eigenes Bild, aber im Haus-Designsystem.
 *
 * Aufbau (Kundenwunsch vom 11.08.2026), unter dem unveraenderten Kopf:
 *
 *   1. helle, grosszuegige Merch-Flaeche: Kicker, starke Ueberschrift, kurze
 *      Beschreibung, ein kontrastreicher Knopf, der zum Katalog scrollt.
 *   2. dunkler Katalog: Karten mit Bild, optionalem Abzeichen ("Bestseller"),
 *      Name, Beschreibung, Preis und Kauf-Knopf. Drei Spalten auf dem Rechner,
 *      zwei auf dem Tablet, eine auf dem Handy — auch mit einem einzigen
 *      Artikel sauber (die Karte bleibt in Lesebreite statt sich zu strecken).
 *   3. Informationsstreifen aus drei Punkten mit Zeichen.
 *
 * Alles Inhaltliche kommt aus der Verwaltung: Kicker, Ueberschrift,
 * Beschreibung, Knopf-Aufschrift, je Artikel Bild, Abzeichen, Name,
 * Beschreibung, Preis, Kauf-Link, Zustand und Reihenfolge, sowie die drei
 * Punkte des Streifens. Der Generator liefert nur Rueckfalltexte, damit nie
 * eine leere Flaeche dasteht.
 *
 * Ist gar keine Ware da, bleibt es beim schlichten Leer-Block mit dem Text aus
 * der Verwaltung — dann gibt es nichts zu bewerben.
 */
/**
 * Der Shop in zwei Ansichten — aus demselben Abschnitt der Verwaltung.
 *
 *   "einladung"  der helle Block: Kleinzeile, Ueberschrift, ein, zwei Saetze
 *                und ein Knopf. Steht auf der Startseite unter der Galerie und
 *                fuehrt auf die Shop-Seite. Keine Ware, keine Preise — wer
 *                kaufen will, geht einen Schritt weiter.
 *   "katalog"    der dunkle Teil: die Ware und der Informationsstreifen, mit
 *                normaler Abschnitts-Ueberschrift. Steht auf /shop/.
 *   "alles"      beides untereinander (eine Seite traegt den Shop allein).
 *
 * `katalogZiel` ist die Adresse der Shop-Seite; sie steht am Knopf der
 * Einladung. Fehlt sie, springt der Knopf zum Katalog auf derselben Seite.
 */
function renderShop(n, s, site, kontaktMail = "", modus = "alles", katalogZiel = "") {
  const items = list(s.items).filter((p) => str(p?.name));
  const cur = str(s.currency, "CHF").trim() || "CHF";
  const buy = str(s.buyLabel, UI.buy);
  // Wohin ein Artikel ohne Zahlungslink verweist: an die E-Mail-Adresse aus dem
  // Kontakt. Ein Bestellformular gibt es hier nicht mehr.
  const mail = str(kontaktMail).trim();

  /* Kein Artikel: der Leer-Block. Hier — und nur hier — steht die
     Einleitungszeile `note`. Ueber Ware gehoert sie nicht: der Satz "Merch from
     Sam Sparking — every piece helps fund the next production." stammt aus der
     Zeit, als es nichts zu kaufen gab (Kundenwunsch 11.08.2026). Geloescht ist
     er nicht, er erscheint nur im leeren Shop. */
  if (!items.length) {
    return `
  <section class="pad shop-sec" id="shop" aria-labelledby="shop-h">
    <div class="wrap">${sectionHead(n, s, "shop")}
      ${str(s.note) ? `<p class="shop-note rv">${inline(s.note)}</p>` : ""}
      <div class="empty-state rv"><span class="mono">Shop</span><p>${esc(
        str(s.emptyText, "Merch ist in Arbeit.")
      )}</p></div>
    </div>
  </section>`;
  }

  const cards = items
    .map((p) => {
      const sold = p.status === "soldout";
      const price = priceTag(p.price, cur);
      /* Der Kauf-Knopf fuehrt auf die Kasse DIESES Artikels, wenn dafuer ein
         Stripe Payment Link hinterlegt ist. Damit stimmen Preis und Ware
         garantiert zusammen: Stripe kennt beides aus dem Link.

         Kein Rueckfall auf einen globalen Link: der gehoert zu einem anderen
         Preis und wuerde den falschen Betrag abrechnen. Eine ungueltige Adresse
         (Tippfehler, Dashboard-Link) zaehlt wie keine.

         Fehlt der Link, ging es bis zum 12.08.2026 ins Bestellformular weiter
         unten. Das Formular ist weg; ohne Zahlungslink verweist der Knopf
         darum auf die E-Mail-Adresse aus dem Kontakt — mit dem Artikel im
         Betreff. Fehlt auch die, steht kein Knopf da: ein Weg, der nirgendwohin
         fuehrt, ist schlimmer als keiner. */
      const kasse = istPaymentLink(p.paymentLink) ? str(p.paymentLink).trim() : "";
      const perMail = mail
        ? `mailto:${mail}?subject=${encodeURIComponent(`${UI.orderSubject}: ${str(p.name)}`)}`
        : "";
      const cta = sold
        ? `<span class="mono sold-mark">${esc(UI.soldOut)}</span>`
        : kasse
        ? `<a class="btn sm solid buy-now" href="${esc(kasse)}" target="_blank" rel="noopener noreferrer"
              data-product="${esc(p.name)}">${esc(buy)}</a>`
        : perMail
        ? `<a class="btn sm solid buy-mail" href="${esc(perMail)}">${esc(UI.orderByMail)}</a>`
        : "";
      /* Das Abzeichen ist frei beschriftbar ("Bestseller", "Neu", "Letzte
         Stueck") und steht nur da, wenn in der Verwaltung etwas eingetragen
         ist. Ausverkauft schlaegt es: dann sagt die Karte das Wichtigere. */
      const abzeichen =
        !sold && str(p.badge)
          ? `<span class="prod-badge">${esc(str(p.badge).trim())}</span>`
          : "";
      return `<article class="prod rv${sold ? " soldout" : ""}">
          <div class="prod-shot">
            ${
              p.src
                ? picture(p, {
                    sizes: "(max-width:640px) 92vw, (max-width:1000px) 44vw, 30vw",
                    widths: [480, 800, 1200],
                  })
                : `<span class="prod-noshot" aria-hidden="true">${esc(
                    str(p.name).trim().slice(0, 1).toUpperCase()
                  )}</span>`
            }
            ${abzeichen}
          </div>
          <div class="prod-body">
            <h3>${esc(p.name)}</h3>
            ${str(p.note) ? `<p>${esc(p.note)}</p>` : ""}
            <div class="prod-foot">
              ${str(p.price) ? `<span class="price">${esc(price)}</span>` : ""}
              ${cta}
            </div>
          </div>
        </article>`;
    })
    .join("\n        ");

  // Die drei Punkte des Streifens. Steht in der Verwaltung nichts, bleibt der
  // Streifen ganz weg — statt drei leere Kaesten zu zeigen.
  const infos = list(s.info)
    .filter((i) => str(i?.title) || str(i?.text))
    .slice(0, 3);
  const streifen = infos.length
    ? `
      <ul class="shop-info rv">
        ${infos
          .map(
            (i) => `<li>
          <span class="shop-info-ico" aria-hidden="true">${shopIcon(i.icon)}</span>
          <div>
            ${str(i.title) ? `<strong>${esc(i.title)}</strong>` : ""}
            ${str(i.text) ? `<p>${inline(i.text)}</p>` : ""}
          </div>
        </li>`
          )
          .join("\n        ")}
      </ul>`
    : "";

  const ctaLabel = str(s.ctaLabel, UI.shopCta);
  /* Der Knopf der Einladung fuehrt auf die Shop-Seite. Nur wenn Einladung und
     Katalog auf derselben Seite stehen, springt er nach unten. */
  const ctaZiel = modus === "einladung" && katalogZiel ? katalogZiel : anchor("#shop-katalog");
  const einladung = `
    <div class="shop-intro">
      <div class="wrap shop-intro-in rv">
        <span class="mono shop-kicker">${esc(str(s.kicker, UI.shopKicker))}</span>
        <h2 id="shop-h" class="shop-headline">${esc(
          str(s.headline, `${str(site?.artist, "Sam Sparking")} Shop`)
        )}</h2>
        ${str(s.intro) ? `<p class="shop-lede">${inline(s.intro)}</p>` : ""}
        ${
          ctaLabel
            ? `<a class="btn solid big shop-cta" href="${esc(ctaZiel)}">${esc(ctaLabel)}</a>`
            : ""
        }
      </div>
    </div>`;
  const katalog = `
    <div class="shop-cat pad" id="shop-katalog">
      <div class="wrap">
        ${modus === "katalog" ? sectionHead(n, s, "shop") : ""}
        <div class="shop-grid${items.length === 1 ? " einer" : ""}">
        ${cards}
        </div>
${streifen}
      </div>
    </div>`;

  /* Der Abschnitt verweist nur dann auf eine Ueberschrift, wenn es sie in ihm
     wirklich gibt. Auf /shop/ traegt die Seite ihren Titel schon im Kopf, die
     Abschnitts-Ueberschrift entfaellt darum (CTX.hideHead) — ein
     aria-labelledby ins Leere waere fuer Hilfsmittel schlechter als keines. */
  const bau = (inhalt, extra = "") =>
    `
  <section class="shop-sec${extra}" id="shop"${
      inhalt.includes('id="shop-h"') ? ' aria-labelledby="shop-h"' : ""
    }>${inhalt}
  </section>`;

  if (modus === "einladung") return bau(einladung, " nur-einladung");
  if (modus === "katalog") return bau(katalog);
  return bau(`${einladung}${katalog}`);
}

/* Der technische Rider ("Preferred setup", CDJs, Mixer, Booth-Monitore) stand
   hier bis August 2026 eingeklappt unter dem Formular. Der Kunde wollte ihn
   ganz weg: die Geräteliste gehört ins Gespräch mit der Technik, nicht auf die
   Seite. Damit fallen auch die Rider-Felder in der Verwaltung weg — steht im
   Inhalt noch ein `rider`-Knoten, wird er schlicht nicht mehr gelesen. */

function renderBooking(n, s, site) {
  const f = s.form || {};
  // Das Formular sendet an den eigenen Endpunkt, nicht an eine in der
  // Verwaltung hinterlegte Datenbank-Adresse. Es haengt daher nur noch am
  // Schalter in der Verwaltung.
  const formEnabled = f.enabled !== false;
  // Anfragen ist der wichtigste Weg der Seite. Deshalb steht hier links die
  // Ansage und rechts gleich das Formular — ohne Umweg über einen Knopf.
  return `
  <section class="booking pad" id="booking" aria-labelledby="booking-h">
    <span class="section-mark" aria-hidden="true">${esc(str(s.title) + str(s.titleAccent))}</span>
    <div class="wrap">
      <div class="booking-grid">
      <div class="booking-lead rv">
        <span class="mono">${esc(str(s.navLabel, "Booking"))}</span>
        <h2 id="booking-h" class="booking-claim">${esc(str(s.claim, "Let's create"))} <i>${esc(
    str(s.claimAccent, "something.")
  )}</i></h2>
        ${str(s.lead) ? `<p class="lede">${inline(s.lead)}</p>` : ""}
        <span class="mono">${esc(str(s.availableKicker, "Available for"))}</span>
        <ul class="avail">
          ${list(s.available)
            .filter((a) => str(a))
            .map(
              (a, i) =>
                `<li><span class="mono">${String.fromCharCode(65 + i)}</span>${esc(a)}</li>`
            )
            .join("\n          ")}
        </ul>
        ${
          safeUrl(s.photo?.src)
            ? `<figure class="booking-photo rv">
          ${picture(s.photo, { sizes: "(max-width:900px) 92vw, 42vw", widths: [600, 1000] })}
          ${
            /* Hier stand der Fotocredit des Booking-Bildes. Er ist ueberall
               weg — nicht nur unsichtbar, sondern aus den Daten geloescht
               (siehe nachziehen). */
            ""
          }
        </figure>`
            : ""
        }
        ${
          safeUrl(s.presskitUrl)
            ? `<div class="btn-row">
          <a class="btn" href="${href(s.presskitUrl)}" download>${esc(
                str(s.presskitLabel, "Presskit (PDF)")
              )}</a>
        </div>`
            : ""
        }
        ${
          formEnabled
            ? ""
            : `<div class="btn-row">
          <a class="btn solid" href="${anchorHref("#contact")}">${esc(
                str(f.submitLabel, "Request a date")
              )}</a>
        </div>`
        }
      </div>
      ${
        formEnabled
          ? `
      <form class="bform rv" id="booking-form" data-endpoint="${esc(
        BOOKING_ENDPOINT
      )}" data-sending="${esc(UI.sending)}" data-invalid="${esc(UI.formInvalid)}"
            data-captcha="${esc(UI.captchaWrong)}"${formDemoAttr} novalidate>
        <div class="bform-head">
          <span class="mono">${esc(str(f.kicker, "Booking request"))}</span>
          <h3>${esc(str(f.title, "Tell me about your event"))}</h3>
        </div>
        <div class="bform-grid">
          <label><span class="lbl">${esc(UI.fName)} <i aria-hidden="true">*</i></span>
            <input name="name" type="text" required maxlength="120" autocomplete="name"
                   placeholder="${esc(UI.phName)}">
          </label>
          <label><span class="lbl">${esc(UI.fEmail)} <i aria-hidden="true">*</i></span>
            <input name="email" type="email" required maxlength="160" autocomplete="email"
                   placeholder="${esc(UI.phEmail)}">
          </label>
          <label><span class="lbl">${esc(UI.fPhone)} <i aria-hidden="true">*</i></span>
            <input name="phone" type="tel" required maxlength="40" autocomplete="tel"
                   placeholder="${esc(UI.phPhone)}">
          </label>
          <label><span class="lbl">${esc(UI.fEvent)} <i aria-hidden="true">*</i></span>
            <input name="event" type="text" required maxlength="160" placeholder="${esc(UI.phEvent)}">
          </label>
          <label><span class="lbl">${esc(UI.fCity)} <i aria-hidden="true">*</i></span>
            <input name="city" type="text" required maxlength="120" placeholder="${esc(UI.phCity)}">
          </label>
          <label><span class="lbl">${esc(UI.fDate)} <i aria-hidden="true">*</i></span>
            <input name="date" type="date" required>
          </label>
          <label><span class="lbl">${esc(UI.fSetLength)} <i aria-hidden="true">*</i></span>
            <input name="setLength" type="text" required maxlength="60" placeholder="${esc(UI.fSetLengthHint)}">
          </label>
          <label class="bform-captcha"><span class="lbl">${esc(UI.captcha)} <i aria-hidden="true">*</i></span>
            <span class="captcha-row">
              <span class="captcha-sum" aria-hidden="true"><b data-a></b> + <b data-b></b> =</span>
              <input name="captcha" type="text" required inputmode="numeric" maxlength="4"
                     autocomplete="off" aria-label="${esc(UI.captchaAria)}" placeholder="?">
            </span>
          </label>
          <label class="span-2"><span class="lbl">${esc(UI.fMessage)} <i aria-hidden="true">*</i></span>
            <textarea name="message" rows="3" required maxlength="4000"
                      placeholder="${esc(UI.phMessage)}"></textarea>
          </label>
          <label class="hp" aria-hidden="true" tabindex="-1"><span class="lbl">${esc(UI.fHoneypot)}</span>
            <input name="website" type="text" tabindex="-1" autocomplete="off">
          </label>
        </div>
        <div class="bform-cal" id="bform-cal"
             data-weekdays="${esc(UI.weekdays)}" data-hint="${esc(UI.pickDay)}"
             data-busy="${esc(UI.dayBusy)}" hidden></div>
        <div class="bform-foot">
          <button class="btn solid big wide" type="submit">${esc(
            str(f.submitLabel, "Send request")
          )}<span class="cta-arr" aria-hidden="true">→</span></button>
          <p class="bform-msg" role="status" aria-live="polite"
             data-success="${esc(str(f.successText, "Thanks — your request landed."))}"
             data-error="${esc(str(f.errorText, "Something went wrong. Please e-mail instead."))}"></p>
          <p class="bform-fine mono">${esc(UI.formFine)}</p>
          ${formDemoNote()}
        </div>
      </form>`
          : ""
      }
      </div>
    </div>
  </section>`;
}

/** Aus einer Profil-URL den Benutzernamen ziehen: …/samsparking/ → @samsparking */
function handleOf(url) {
  const clean = String(url || "").split(/[?#]/)[0].replace(/\/+$/, "");
  const last = clean.split("/").pop() || "";
  if (!last || /^https?:$/i.test(last) || last.includes(".")) return "";
  return last.startsWith("@") ? last : "@" + last;
}

/** Stilisiertes Kanal-Zeichen aus Label/URL — einfarbig, ohne Fremd-Dateien. */
function socialIcon(label, url) {
  const key = (String(label) + " " + String(url)).toLowerCase();
  const P = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  let body = "";
  if (key.includes("instagram"))
    body = `<rect x="3.5" y="3.5" width="17" height="17" rx="4.5" ${P}/><circle cx="12" cy="12" r="4" ${P}/><circle cx="17" cy="7" r="1.2" fill="currentColor"/>`;
  else if (key.includes("tiktok"))
    body = `<path d="M14 4v9.6a3.6 3.6 0 1 1-3-3.55" ${P}/><path d="M14 5.4c.7 1.9 2.3 3.2 4.4 3.4" ${P}/>`;
  else if (key.includes("youtube"))
    body = `<rect x="3" y="6" width="18" height="12" rx="3.5" ${P}/><path d="M10.5 9.5v5l4.5-2.5z" fill="currentColor"/>`;
  else if (key.includes("spotify"))
    body = `<circle cx="12" cy="12" r="8.5" ${P}/><path d="M8.5 10.2c2.6-.8 5-.6 7 .5M9 12.8c2-.6 3.9-.4 5.5.5M9.5 15.2c1.5-.4 2.9-.3 4 .3" ${P}/>`;
  else if (key.includes("soundcloud") || key.includes("mixcloud"))
    body = `<path d="M4 15v-3M6.5 15v-5M9 15V8M11.5 15V6.5M14 15V9" ${P}/><path d="M14 15h3.5a2.5 2.5 0 0 0 .4-4.97A4 4 0 0 0 14 9" ${P}/>`;
  else if (key.includes("facebook"))
    body = `<path d="M14.5 8H13c-.8 0-1.3.5-1.3 1.3V11h2.6l-.4 2.6h-2.2V20" ${P}/><rect x="3.5" y="3.5" width="17" height="17" rx="4.5" ${P}/>`;
  else if (key.includes("presskit") || key.includes(".pdf"))
    /* Blatt mit Pfeil nach unten — das Presskit ist kein Kanal zum Folgen,
       sondern eine Datei zum Mitnehmen. */
    body = `<path d="M6 3.5h7.5L18 8v12.5H6z" ${P}/><path d="M13.5 3.5V8H18" ${P}/><path d="M12 11v5.5M9.6 14.4 12 16.8l2.4-2.4" ${P}/>`;
  else body = `<path d="M7 17 17 7M9.5 7H17v7.5" ${P}/>`;
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

/* Kanaele ohne Adresse standen hier bis zum 11.08.2026 als "folgt" auf der
   Seite — genannt, aber nicht verlinkt. Der Kunde will das nicht mehr: ein
   Kanal, der nirgendwo hinfuehrt, gehoert nicht auf die Website. Gezeigt wird
   nur noch, was eine gueltige Adresse hat; sobald in der Verwaltung eine
   eingetragen und publiziert ist, erscheint der Kanal von selbst. */

/**
 * Kontakt — E-Mail, Standort, Kanaele.
 *
 * Bei den Kanaelen steht seit dem 12.08.2026 auch das Presskit (Kundenwunsch).
 * Es ist kein Kanal zum Folgen, sondern eine Datei zum Mitnehmen: eigenes
 * Zeichen, `download`, und es steht hinten — die Kanaele behalten ihre
 * Reihenfolge. Ohne hinterlegte Datei steht es nirgends.
 */
function renderContact(n, s, bookingTarget, presskit = {}) {
  const mail = str(s.email);
  const socials = list(s.socials).filter((x) => str(x?.label) && safeUrl(x?.url));
  const pk = safeUrl(presskit.url)
    ? { url: presskit.url, label: str(presskit.label, "Presskit (PDF)") }
    : null;
  const meta = `
        <div class="contact-meta">
          ${/* Hier stand die Telefonnummer. Sie ist weg — das Feld gibt es
                nicht mehr (siehe nachziehen). */ ""}
          ${
            str(s.base)
              ? `<div><span class="mono">${esc(UI.base)}</span><span>${esc(s.base)}</span></div>`
              : ""
          }
        </div>`;
  return `
  <section class="pad contact accent-block" id="contact" aria-labelledby="contact-h">
    <span class="contact-mark" aria-hidden="true">${esc(str(s.title) + str(s.titleAccent))}</span>
    <div class="wrap">${sectionHead(n, s, "contact")}
      <div class="contact-grid rv">
        <div class="contact-main">
          ${str(s.kicker) ? `<span class="mono">${esc(s.kicker)}</span>` : ""}
          ${
            mail
              ? `<a class="big-mail" href="mailto:${esc(mail)}">${esc(mail)}</a>
          <div class="mail-tools">
            <button class="copy-mail mono" type="button" data-mail="${esc(mail)}" data-done="${esc(
                  UI.copied
                )}">${esc(UI.copyMail)}</button>
            ${
              bookingTarget
                ? `<a class="btn ink" href="${esc(bookingTarget)}">${esc(UI.bookCta)}</a>`
                : ""
            }
          </div>`
              : ""
          }
          ${meta}
        </div>
        ${
          socials.length || pk
            ? `<div class="contact-side">
          <span class="mono side-label">${esc(UI.follow)}</span>
          <div class="social-cards">
          ${socials
            .map((x) => {
              const handle = str(x.handle, handleOf(x.url));
              return `<a class="scard" href="${href(x.url)}" target="_blank" rel="noopener noreferrer me">
            <span class="scard-ico" aria-hidden="true">${socialIcon(x.label, x.url)}</span>
            <span class="scard-arrow" aria-hidden="true">↗</span>
            <span class="scard-name">${esc(x.label)}</span>
            ${handle ? `<span class="mono">${esc(handle)}</span>` : ""}
          </a>`;
            })
            .join("\n          ")}
          ${
            pk
              ? `<a class="scard scard-file" href="${href(pk.url)}" download>
            <span class="scard-ico" aria-hidden="true">${socialIcon("presskit", pk.url)}</span>
            <span class="scard-arrow" aria-hidden="true">↓</span>
            <span class="scard-name">${esc(pk.label)}</span>
            <span class="mono">PDF</span>
          </a>`
              : ""
          }
          </div>
        </div>`
            : ""
        }
      </div>
    </div>
  </section>`;
}

/* ------------------------------------------------------------ json-ld */

function structuredData(c, sections, page, pages) {
  const site = c.site;
  const base = site.domain.replace(/\/+$/, "");
  const contact = sections.contact || {};
  const sameAs = list(contact.socials)
    .map((s) => safeUrl(s.url))
    .filter(Boolean);

  const person = {
    "@type": "Person",
    "@id": `${base}/#artist`,
    name: site.artist,
    jobTitle: "DJ & Producer",
    url: `${base}/`,
    image: absolute(base, site.ogImage),
    description: site.description,
    knowsAbout: list(sections.sound?.genres)
      .map((g) => str(g?.name))
      .filter(Boolean),
    homeLocation: contact.base
      ? { "@type": "Place", name: contact.base }
      : undefined,
  };
  if (contact.email) person.email = `mailto:${contact.email}`;
  if (sameAs.length) person.sameAs = sameAs;
  if (contact.base) {
    const [city, country] = String(contact.base).split(",").map((x) => x.trim());
    person.address = {
      "@type": "PostalAddress",
      addressLocality: city || contact.base,
      addressCountry: /schweiz|switzerland|suisse|ch/i.test(country || "") ? "CH" : country || "CH",
    };
  }
  if (contact.email) {
    person.contactPoint = {
      "@type": "ContactPoint",
      contactType: "booking",
      ...(contact.email ? { email: contact.email } : {}),
      availableLanguage: languagesOf(c).map((l) => LANG_NAMES[l] || l),
    };
  }
  const genres = list(sections.sound?.genres)
    .map((g) => str(g?.name))
    .filter(Boolean);
  if (genres.length) person.genre = genres;

  const graph = [
    person,
    {
      "@type": "WebSite",
      "@id": `${base}/#website`,
      url: `${base}/`,
      name: `${site.artist} — Official Website`,
      inLanguage: languagesOf(c),
      publisher: { "@id": `${base}/#artist` },
      copyrightHolder: { "@id": `${base}/#artist` },
    },
    {
      "@type": "ImageObject",
      "@id": `${base}/#logo`,
      url: absolute(base, site.ogImage),
      caption: site.artist,
    },
  ];

  if (page) {
    const home = !page.slug;
    graph.push({
      "@type": home ? ["WebPage", "ProfilePage"] : "WebPage",
      "@id": `${base}${pagePath(page.slug)}#page`,
      url: `${base}${pagePath(page.slug)}`,
      name: home ? site.title : page.navLabel,
      description: home ? site.description : str(page.description, site.description),
      inLanguage: site.lang,
      isPartOf: { "@id": `${base}/#website` },
      about: { "@id": `${base}/#artist` },
      primaryImageOfPage: { "@id": `${base}/#logo` },
      breadcrumb: {
        "@type": "BreadcrumbList",
        itemListElement: home
          ? [{ "@type": "ListItem", position: 1, name: str(pages?.[0]?.navLabel, "Start"), item: `${base}/` }]
          : [
              { "@type": "ListItem", position: 1, name: str(pages?.[0]?.navLabel, "Start"), item: `${base}/` },
              { "@type": "ListItem", position: 2, name: page.navLabel, item: `${base}${pagePath(page.slug)}` },
            ],
      },
    });
  }

  // Galerie als Bilderliste — hilft der Google-Bildersuche
  if (!page || list(page.sections).includes("gallery")) {
    const images = list(sections.gallery?.items)
      .map((g) => ({ src: safeUrl(g?.src), alt: str(g?.alt) }))
      .filter((g) => g.src && !isVideoUrl(g.src));
    if (images.length) {
      graph.push({
        "@type": "ImageGallery",
        "@id": `${base}${page ? pagePath(page.slug) : "/"}#gallery`,
        name: str(sections.gallery?.navLabel, "Galerie"),
        isPartOf: { "@id": `${base}/#website` },
        image: images.map((g) => ({
          "@type": "ImageObject",
          contentUrl: absolute(base, g.src),
          caption: g.alt || site.artist,
        })),
      });
    }
  }

  // Produkte des Shops (nur mit Preis)
  if (!page || list(page.sections).includes("shop")) {
    // Beschnitten: "CHF " mit Leerzeichen waere in den strukturierten Daten
    // keine gueltige Waehrung.
    const cur = str(sections.shop?.currency, "CHF").trim() || "CHF";
    for (const p of list(sections.shop?.items)) {
      if (!str(p?.name) || !str(p?.price) || p.status === "soldout") continue;
      const amount = String(p.price).replace(/[^\d.]/g, "");
      if (!amount) continue;
      graph.push({
        "@type": "Product",
        name: str(p.name),
        ...(safeUrl(p.src) ? { image: absolute(base, p.src) } : {}),
        ...(str(p.note) ? { description: str(p.note) } : {}),
        brand: { "@type": "Brand", name: site.artist },
        offers: {
          "@type": "Offer",
          price: amount,
          priceCurrency: cur,
          availability: "https://schema.org/InStock",
          ...(safeUrl(p.linkUrl) ? { url: safeUrl(p.linkUrl) } : {}),
        },
      });
    }
  }

  // Termine nur auf der Seite auszeichnen, die sie auch anzeigt
  if (page && !list(page.sections).includes("shows")) return { "@context": "https://schema.org", "@graph": graph };

  const t = today();
  for (const sh of list(sections.shows?.items)) {
    const date = isoDate(sh.date);
    if (!str(sh.name) || !date || date < t) continue;
    graph.push({
      "@type": "MusicEvent",
      name: `${site.artist} @ ${sh.name}`,
      startDate: date,
      eventStatus:
        sh.status === "cancelled"
          ? "https://schema.org/EventCancelled"
          : "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      location: {
        "@type": "Place",
        name: str(sh.venue, sh.name),
        address: {
          "@type": "PostalAddress",
          addressLocality: str(sh.city),
          addressCountry: str(sh.country, "CH"),
        },
      },
      performer: { "@id": `${base}/#artist` },
      url: safeUrl(sh.ticketUrl) || `${base}${page ? pagePath(page.slug) : "/"}#shows`,
      ...(safeUrl(sh.ticketUrl)
        ? {
            offers: {
              "@type": "Offer",
              url: safeUrl(sh.ticketUrl),
              availability:
                sh.status === "soldout"
                  ? "https://schema.org/SoldOut"
                  : "https://schema.org/InStock",
            },
          }
        : {}),
    });
  }

  return { "@context": "https://schema.org", "@graph": graph };
}

/* ------------------------------------------------------------- dokument */

/* --------------------------------------------------------------- oberfläche
   Kurztexte der Oberfläche. Sie stehen im Inhalt (also übersetzbar); fehlt
   einer, greift der deutsche Vorgabewert. */
const UI_DEFAULTS = {
  skip: "Zum Inhalt springen",
  menu: "Menü",
  close: "Schliessen",
  scroll: "Scrollen ↓",
  imageViewer: "Bildansicht",
  prevImage: "Vorheriges Bild",
  nextImage: "Nächstes Bild",
  openImage: "Bild {n} von {total} gross öffnen",
  rights: "Alle Rechte vorbehalten",
  base: "Standort",
  tickets: "Tickets",
  soldOut: "Ausverkauft",
  booked: "Gebucht",
  calShow: "Termin",
  language: "Sprache",
  buy: "Kaufen",
  bookDay: "Diesen Tag anfragen",
  pickDay: "Oder Wunschdatum direkt im Kalender antippen:",
  dayBusy: "Belegt",
  toTop: "Nach oben",
  shopKicker: "MERCH",
  shopCta: "Zum Katalog",
  rlDays: "Tage",
  rlHours: "Std",
  rlMinutes: "Min",
  rlSeconds: "Sek",
  rlNote: "Die Seite öffnet sich von selbst — offen lassen genügt.",
  cookieTitle: "Cookies",
  cookieText: "Notwendige Speicherung hält diese Seite am Laufen — zum Beispiel deine Entscheidung hier. Darüber hinaus setzt die Website nichts: kein Tracking, keine Werbe-Cookies, keine Analyse. Wählst du „Alle akzeptieren“, wären künftige Zusatzdienste erlaubt; heute ist keiner eingebunden.",
  cookieNecessary: "Nur notwendige",
  cookieAll: "Alle akzeptieren",
  cookieSettings: "Cookie-Einstellungen",
  cookieSavedNecessary: "Gespeichert: nur notwendige.",
  cookieSavedAll: "Gespeichert: alle akzeptiert.",
  replyNote: "Antwort meist innert 48 Stunden",
  copyMail: "E-Mail kopieren",
  copied: "Kopiert ✓",
  bookCta: "Booking anfragen",
  moreStory: "Ganze Story lesen",
  lessStory: "Weniger anzeigen",
  showMoreImages: "{n} weitere Bilder",
  showLessImages: "Weniger Bilder",
  /* Referenzen auf dem Handy: nur die obersten vier, der Rest hinter diesem
     Knopf. Auf dem Desktop steht der Knopf nicht da (CSS). */
  showMoreVenues: "{n} weitere anzeigen",
  showLessVenues: "Weniger anzeigen",
  onThisPage: "Auf dieser Seite",
  /* Fuer eine Ware ohne Zahlungslink: der Knopf schreibt eine Mail, mit dem
     Artikel im Betreff. Versprochen wird dabei nichts — kein Preis, keine
     Bezahlart, keine Lieferzeit. */
  orderByMail: "Per E-Mail bestellen",
  orderSubject: "Bestellung",
  formDemo: "Vorführ-Fassung: dieses Formular sendet nichts.",
  follow: "Kanäle",
  notFoundTitle: "Nichts hier.",
  notFoundText: "Diese Seite gibt es nicht (mehr). Zurück zum Start — dort steht alles Aktuelle.",
  notFoundCta: "Zur Startseite",
  prevMonth: "Vorheriger Monat",
  nextMonth: "Nächster Monat",
  weekdays: "Mo,Di,Mi,Do,Fr,Sa,So",
  sending: "Wird gesendet …",
  formInvalid: "Bitte die markierten Felder prüfen.",
  fName: "Name",
  fEmail: "E-Mail",
  fPhone: "Telefon",
  fEvent: "Event / Club",
  fCity: "Ort",
  fDate: "Datum",
  fSetLength: "Set-Länge",
  fSetLengthHint: "z. B. 60 Min.",
  fMessage: "Nachricht",
  fHoneypot: "Bitte leer lassen",
  phName: "Max Muster",
  phEmail: "deine@email.ch",
  phPhone: "+41 79 123 45 67",
  phEvent: "Club, Festival, Firmenfest …",
  phCity: "St. Gallen",
  phMessage: "Deine Nachricht …",
  captcha: "Anti-Spam — bitte lösen",
  captchaAria: "Ergebnis der Rechenaufgabe",
  captchaWrong: "Die Rechnung stimmt noch nicht.",
  formFine:
    "* Pflichtfelder · Deine Angaben werden nur für die Bearbeitung deiner Anfrage verwendet.",
  channelSoon: "folgt",
};

/**
 * UI_DEFAULTS ist deutsch. Es ist der Rückfall für alles, was die Verwaltung
 * (noch) nicht mitliefert — und damit fiel auf der englischen und der
 * französischen Seite deutscher Text heraus: auf /shop/ stand mitten im
 * englischen Text deutsche Formular-Beschriftung. Das Formular ist inzwischen
 * weg, die Lehre bleibt: jeder Oberflächentext braucht hier seine Sprache.
 *
 * Diese Tabelle trägt den Rückfall je Sprache nach. Sie enthält bewusst nur
 * Oberflächentexte — Inhalte kommen weiter aus der Verwaltung, und was dort
 * steht, gewinnt auch hier (siehe renderPage: c.ui wird zuletzt gemischt).
 */
const UI_SPRACHE = {
  en: {
    buy: "Buy",
    orderByMail: "Order by e-mail",
    showMoreVenues: "Show {n} more",
    showLessVenues: "Show less",
    orderSubject: "Order",
    soldOut: "Sold out",
    onThisPage: "On this page",
    shopKicker: "MERCH",
    shopCta: "Browse the drop",
    rlDays: "Days",
    rlHours: "Hrs",
    rlMinutes: "Min",
    rlSeconds: "Sec",
    rlNote: "The page opens by itself — just leave it open.",
    cookieTitle: "Cookies",
    cookieText:
      "Necessary storage keeps this page working — your choice here, for example. Beyond that the site sets nothing: no tracking, no advertising cookies, no analytics. Choosing \u201cAccept all\u201d would allow future extras; today none are in use.",
    cookieNecessary: "Necessary only",
    cookieAll: "Accept all",
    cookieSettings: "Cookie settings",
    cookieSavedNecessary: "Saved: necessary only.",
    cookieSavedAll: "Saved: all accepted.",
    payStripeNote:
      "Payment happens after you submit, via Stripe — card, Apple Pay, Google Pay or TWINT. Your order ships as soon as the payment is confirmed.",
    formDemo: "Demo version: this form does not send anything.",
    channelSoon: "follows",
  },
  fr: {
    buy: "Acheter",
    orderByMail: "Commander par e-mail",
    showMoreVenues: "Afficher {n} de plus",
    showLessVenues: "Afficher moins",
    orderSubject: "Commande",
    soldOut: "Épuisé",
    onThisPage: "Sur cette page",
    shopKicker: "MERCH",
    shopCta: "Voir le catalogue",
    rlDays: "Jours",
    rlHours: "H",
    rlMinutes: "Min",
    rlSeconds: "Sec",
    rlNote: "La page s'ouvre d'elle-même — il suffit de la laisser ouverte.",
    cookieTitle: "Cookies",
    cookieText:
      "Le stockage nécessaire fait fonctionner cette page — ton choix ici, par exemple. Au-delà, le site ne dépose rien : ni traçage, ni cookies publicitaires, ni analyse. « Tout accepter » autoriserait de futurs services additionnels ; aujourd\u2019hui aucun n\u2019est intégré.",
    cookieNecessary: "Nécessaires uniquement",
    cookieAll: "Tout accepter",
    cookieSettings: "Réglages des cookies",
    cookieSavedNecessary: "Enregistré : nécessaires uniquement.",
    cookieSavedAll: "Enregistré : tout accepté.",
    payStripeNote:
      "Le paiement se fait après l'envoi, via Stripe — carte, Apple Pay, Google Pay ou TWINT. L'expédition part dès que le paiement est confirmé.",
    formDemo: "Version de démonstration : ce formulaire n'envoie rien.",
    channelSoon: "à venir",
  },
};

/** Oberflächentexte einer Sprache: deutscher Grundstock, Sprachtabelle, Verwaltung. */
const uiFuer = (c, lang) => ({
  ...UI_DEFAULTS,
  ...(UI_SPRACHE[lang] || {}),
  ...(c?.ui || {}),
});

/* Die gerade gültigen Oberflächentexte — von renderPage je Sprache gesetzt. */
let UI = { ...UI_DEFAULTS };

/* ------------------------------------------------------------------- i18n */

/**
 * Mehrsprachigkeit: Deutsch ist der gepflegte Stand ("Master"), Englisch und
 * Französisch liegen als flache Übersetzungstabelle daneben —
 * i18n.en["sections.about.lede"] = "…".
 *
 * Vor dem Rendern wird der ganze Inhaltsbaum einmal in die Zielsprache
 * übersetzt (localize). Dadurch bleiben alle Bausteine unverändert; fehlt eine
 * Übersetzung, steht dort der deutsche Text — nie eine Lücke.
 */

/** Felder, die nie übersetzt werden (Technik, Adressen, Zahlen). */
const NO_TRANSLATE = new Set([
  "src", "poster", "url", "ticketUrl", "linkUrl", "embedUrl", "presskitUrl",
  "ogImage", "domain", "bookingApi", "themeColor", "accentColor", "lang",
  "slug", "date", "status", "email", "phone", "country", "createdAt",
  "updatedAt", "updatedBy", "schemaVersion", "type", "view",
  "value", "logoText", "artist", "languages", "nameSpaced", "nameMain",
  // Eigennamen: Clubs, Festivals, Geräte, Genre-Bezeichnungen
  "name", "venue", "inquiryId", "backgroundImage", "price", "currency", "twint",
  "fit", "focus", "mobileLimit",
]);

const looksTechnical = (v) =>
  /^(https?:|mailto:|tel:|#|\/)/i.test(v) ||
  /^#[0-9a-f]{3,8}$/i.test(v) ||
  /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Pfade, die technische Schlüssel enthalten (Abschnitts-Namen, keine Texte)
 * oder Eigennamen tragen.
 *
 * Kanäle gehören dazu: "Instagram", "Spotify" und "Mixcloud" heissen in jeder
 * Sprache gleich. Übersetzt man sie trotzdem, zeigt die Übersetzungstabelle
 * über die Position auf den Kanal — und sobald in der Verwaltung ein Kanal
 * gelöscht wird, rutscht der Name des gelöschten auf den nächsten Eintrag.
 * Genau so trug der Mixcloud-Link auf /de/ und /fr/ die Aufschrift "Instagram"
 * (dieselbe Falle wie "Luzern" auf "Sektor 11", siehe adoptTexts).
 */
/* `imprint.*` ebenfalls: beim Standort uebersetzt renderImpressum nur das
   Landeswort. Eine zweite Uebersetzung von Hand wuerde daneben stehen. Muss mit
   der Verwaltung uebereinstimmen (verwaltung/public/js/i18n.js). */
/* Und `sections.references.items.*`: Clubs und Festivals heissen in jeder
   Sprache gleich, Orte ebenso. Uebersetzt man sie, haengt die Tabelle am PLATZ
   in der Liste — kommt vorne ein Eintrag dazu, traegt plötzlich der falsche
   Club den Namen. Genau so hiess "B9" auf /de/ und /fr/ noch "B9
   eventlocation", nachdem die Liste gewachsen war. */
const NO_TRANSLATE_PATH =
  /^layout\.|^pages\.\d+\.sections\.|^pages\.\d+\.hero$|^sections\.contact\.socials\.|^sections\.references\.items\.|^imprint\./;

/** Alle übersetzbaren Textstellen als [pfad, text]. */
export function collectStrings(node, prefix = "", out = []) {
  if (prefix && NO_TRANSLATE_PATH.test(prefix)) return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectStrings(v, `${prefix}.${i}`, out));
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      // Unter ui.* stehen nur Oberflächentexte — dort gelten die technischen
      // Schlüsselnamen (phone, close, …) nicht als Sperre.
      if ((!prefix.startsWith("ui") && NO_TRANSLATE.has(k)) || k === "i18n" || k === "i18nHash") continue;
      collectStrings(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }
  if (typeof node === "string" && node.trim() && !looksTechnical(node)) {
    out.push([prefix, node]);
  }
  return out;
}

function setDeep(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return;
    cur = cur[keys[i]];
  }
  if (cur && typeof cur === "object") cur[keys[keys.length - 1]] = value;
}

/**
 * Übersetzungstabelle einer Sprache flach machen.
 *
 * Zwei Schreibweisen sind erlaubt und ergeben dasselbe:
 *   flach     i18n.en["sections.about.lede"] = "…"
 *   verschach i18n.en.sections.about.lede    = "…"
 *
 * Die Verwaltung schreibt die verschachtelte Form, weil Schlüssel in der
 * Realtime Database keine Punkte enthalten dürfen. Von Hand gepflegte
 * Dateien dürfen weiter Punkt-Pfade verwenden.
 */
export function flattenI18n(node, prefix = "", out = {}) {
  if (!node || typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flattenI18n(v, path, out);
    else if (typeof v === "string") out[path] = v;
  }
  return out;
}

/** Inhalt in eine Sprache übersetzen. Fehlende Stellen bleiben deutsch. */
export function localize(content, lang) {
  const master = String(content.site?.lang || "de");
  if (lang === master) return content;
  const table = flattenI18n((content.i18n && content.i18n[lang]) || {});
  const copy = JSON.parse(JSON.stringify(content));
  for (const [path, value] of Object.entries(table)) {
    // Dieselbe Sperre wie beim Einsammeln: was nie übersetzt werden durfte,
    // wird auch nicht eingesetzt. Ältere Stände in der Datenbank tragen solche
    // Einträge noch — sie dürfen die Kanäle nicht umbenennen.
    if (NO_TRANSLATE_PATH.test(path)) continue;
    if (typeof value === "string" && value.trim()) setDeep(copy, path, value);
  }
  copy.site.lang = lang;
  return copy;
}

/**
 * Welche Sprachen gebaut werden. Erste ist die Hauptsprache.
 * Eine Sprache ohne eigene Übersetzungstabelle wird übersprungen — sonst
 * entstünde ein kompletter Seitensatz, der nur die Hauptsprache wiederholt.
 */
function languagesOf(c) {
  const master = String(c.site?.lang || "de");
  const extra = list(c.site?.languages)
    .map((l) => String(l).toLowerCase())
    .filter((l) => /^[a-z]{2}$/.test(l) && l !== master)
    .filter((l) => Object.keys(flattenI18n((c.i18n && c.i18n[l]) || {})).length > 0);
  return [master, ...new Set(extra)];
}

/** Präfix einer Sprache: Hauptsprache ohne, andere mit /en, /fr */
const langPrefix = (lang, master) => (lang === master ? "" : `/${lang}`);

/** Dasselbe für Links auf der Seite selbst — inklusive Basis-Verzeichnis. */
const navPrefix = (lang, master) => BASE + langPrefix(lang, master);

const LANG_NAMES = { de: "Deutsch", en: "English", fr: "Français" };
const OG_LOCALE = { de: "de_CH", en: "en_US", fr: "fr_CH" };

/* ------------------------------------------------------------------ seiten */

/**
 * Seitenstruktur. Fehlt sie (alter Inhalt), wird aus dem bisherigen `layout`
 * eine einzelne Startseite gebaut — die Website bleibt damit eine One-Pager.
 */
function pagesOf(c) {
  const sections = c.sections || {};
  const known = (keys) => list(keys).filter((k) => sections[k] && sections[k].enabled !== false);

  const pages = list(c.pages)
    .filter((p) => p && p.enabled !== false)
    .map((p, i) => ({
      slug: i === 0 ? "" : slugify(p.slug),
      navLabel: str(p.navLabel, str(p.title, "Seite")),
      title: str(p.title, str(p.navLabel, "")),
      sections: known(p.sections),
      hero: str(p.hero, i === 0 ? "full" : "compact"),
      ticker: p.ticker !== undefined ? p.ticker !== false : i === 0,
      inNav: p.inNav !== false,
      seo: p.seo || {},
    }));

  // Eine Unterseite ohne Abschnitt waere eine leere Seite mit einem Menuepunkt,
  // der ins Nichts fuehrt — genau das passiert, sobald der Shop in der
  // Verwaltung ausgeschaltet wird. Solche Seiten fallen weg; die Startseite
  // bleibt immer, auch wenn dort gerade nichts eingeschaltet ist.
  const bewohnt = pages.filter((p, i) => i === 0 || p.sections.length);

  if (bewohnt.length) {
    // Doppelte Slugs entschärfen, sonst überschreiben sich die Dateien.
    const seen = new Set();
    bewohnt.forEach((p, i) => {
      let sl = p.slug;
      while (sl !== "" && seen.has(sl)) sl += "-2";
      if (i > 0 && sl === "") sl = "seite-" + i;
      p.slug = sl;
      seen.add(sl);
    });
    return bewohnt;
  }

  return [
    {
      slug: "",
      navLabel: "Start",
      title: "",
      sections: known(c.layout),
      hero: "full",
      ticker: true,
      inNav: true,
      seo: {},
    },
  ];
}

const slugify = (v) =>
  String(v || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 60);

/* Welche Seite und welche Sprache gerade gebaut werden — damit Sprungmarken
   wie #booking auch dann ankommen, wenn der Abschnitt inzwischen auf einer
   anderen Seite liegt, und damit Links in der Sprache bleiben. */
let CTX = { page: null, pages: [], prefix: "" };

/** Adresse einer Seite in der aktuellen Sprache: "/", "/shows/", "/en/shows/" */
const pagePath = (slug) => `${CTX.prefix}${slug ? `/${slug}/` : "/"}`;

/**
 * Verweis auf einen Abschnitt: auf derselben Seite ein Anker, sonst der Link
 * auf die Seite, die den Abschnitt zeigt. Findet sich der Abschnitt nirgends,
 * bleibt der Anker stehen (schadet nicht, springt nur nicht).
 */
function anchor(target) {
  const t = String(target || "").trim();
  if (!t.startsWith("#")) return rooted(t);
  const key = t.slice(1);
  const page = CTX.page;
  if (!page || list(page.sections).includes(key)) return t;
  const other = CTX.pages.find((p) => list(p.sections).includes(key));
  return other ? `${pagePath(other.slug)}${t}` : t;
}

const anchorHref = (v) => esc(anchor(v));

/**
 * Pfade in Inhalten sind relativ gedacht (img/hero.jpg). Auf Unterseiten
 * würden sie ins Leere zeigen, deshalb werden sie ab Wurzel geschrieben.
 */
function rooted(url) {
  const u = safeUrl(url);
  if (!u) return "";
  if (/^(https?:|mailto:|tel:|#)/i.test(u)) return u;
  if (u.startsWith("/")) return BASE + u;
  return BASE + "/" + u.replace(/^\.?\//, "");
}

/* --------------------------------------------------------------- dokument */

/**
 * Welche Abschnitte diese Website überhaupt bauen kann — dieselben Schlüssel
 * wie `renderers` weiter unten, und beide gehören zusammen.
 *
 * Der Grund für die Liste: Der Inhalt kommt aus der Verwaltung und trägt
 * mitunter Abschnitte, die es hier nicht mehr gibt — der Shop etwa, den der
 * Kunde 2026 von der Seite genommen hat, liegt in der Datenbank weiter. Ein
 * solcher Abschnitt fiel bisher zwar aus dem Rumpf (kein Baustein), stand aber
 * weiter im Menü: ein Menüpunkt „Shop", der auf `#shop` zeigt und ins Leere
 * läuft. Unbekannte Abschnitte fallen deshalb schon hier weg — im Menü wie im
 * Rumpf.
 */
const BAUBAR = new Set([
  "about",
  "shows",
  "references",
  "gallery",
  "booking",
  "shop",
  "contact",
]);

/**
 * Wohin die Formulare senden. Bewusst eigene Adressen dieser Website und
 * nicht die Datenbank-Adresse aus der Verwaltung: der Browser darf den
 * Eingang nicht direkt kennen (sonst kann jeder hineinschreiben), und eine
 * Bestellung oder Anfrage muss serverseitig eine E-Mail ausloesen. Die
 * Funktionen dahinter stehen in netlify/functions/.
 */
const BOOKING_ENDPOINT = "/api/booking";
const ORDER_ENDPOINT = "/api/order";

/**
 * Vorführ-Fassung (Beispiel-Sami): dort liegt nur die gebaute Website, ohne
 * die Funktionen dahinter. Ein Formular, das dann ins Leere sendet, sähe
 * funktionsfähig aus und wäre es nicht — deshalb sagen die Formulare dort
 * offen, dass sie nichts verschicken, und senden gar nicht erst.
 */
const FORMS_DEMO = process.env.FORMS_DEMO === "1";
const formDemoAttr = FORMS_DEMO ? ' data-demo="true"' : "";
const formDemoNote = () =>
  FORMS_DEMO ? `<p class="bform-demo mono">${esc(UI.formDemo)}</p>` : "";

function renderPage(c, page, pages, lang, langs) {
  const master = langs[0];
  // Der Vorhang vor dem Release — siehe releaseKopf()/releaseVorhang().
  const rel = releaseStand(c);
  UI = uiFuer(c, lang);
  const ui = UI;
  const site = c.site;
  const base = site.domain.replace(/\/+$/, "");
  const sections = c.sections || {};
  const isHome = !page.slug;
  // Shows gehoeren nur dann auf die Seite — und damit ins Menue —, wenn noch
  // ein Termin aussteht. Steht in der Verwaltung nur Vergangenes, fuehrte der
  // Menuepunkt bisher auf eine Seite, die nichts als "keine Termine" sagt.
  // Der Rueckblick ("Already played") bleibt erhalten, sobald wieder ein
  // kommender Termin dabei ist.
  const heute = today();
  const hasShows = list(sections.shows?.items).some(
    (item) => str(item?.name) && (!isoDate(item.date) || isoDate(item.date) >= heute)
  );
  /* Welche Abschnitte eine Seite wirklich baut. Als Funktion, weil das Menue
     dieselbe Rechnung fuer die STARTSEITE braucht — nicht nur fuer die Seite,
     auf der man gerade steht. */
  const baubareAbschnitte = (seite) =>
    list(seite?.sections).filter(
      (key) =>
        sections[key] &&
        BAUBAR.has(key) &&
        sections[key].enabled !== false &&
        (key !== "shows" || hasShows)
    );
  const order = baubareAbschnitte(page);
  const effectivePage = { ...page, sections: order };
  CTX = { page: effectivePage, pages, hideHead: null, prefix: navPrefix(lang, master) };
  // Das Formular haengt nicht mehr an einer in der Verwaltung hinterlegten
  // Adresse: es sendet immer an den eigenen Endpunkt /api/booking. Abschalten
  // laesst es sich weiterhin in der Verwaltung (form.enabled).
  const bookingPage = pages.find((p) => list(p.sections).includes("booking"));
  const hasBooking = !!bookingPage;
  const hasBookingForm = hasBooking && sections.booking?.form?.enabled !== false;
  // Der Knopf zeigt direkt auf das Formular — auch von einer anderen Seite aus.
  // `anchor()` kennt nur Abschnitts-Schluessel, "#booking-form" ist keiner;
  // der Weg zur Booking-Seite wird deshalb hier gebaut.
  const bookingTarget = (() => {
    if (!hasBooking) return "";
    const hash = hasBookingForm ? "#booking-form" : "#booking";
    return bookingPage.slug === page.slug ? hash : `${pagePath(bookingPage.slug)}${hash}`;
  })();

  // Dasselbe fuer den Shop: er liegt auf einer eigenen Seite, ist aber nur da,
  // solange er in der Verwaltung eingeschaltet ist und Ware enthaelt.
  const shopPage = pages.find((p) => list(p.sections).includes("shop"));
  const shopTarget = !shopPage
    ? ""
    : shopPage.slug === page.slug
    ? "#shop"
    : `${pagePath(shopPage.slug)}`;

  const renderers = {
    about: renderAbout,
    sound: renderSound,
    experience: renderExperience,
    shows: renderShows,
    references: (n, s) => renderReferences(n, s, bookingTarget),
    gallery: renderGallery,
    /* Traegt mehr als eine Seite den Shop, zeigt die erste die Einladung und die
       letzte den Katalog. Traegt ihn nur eine, steht dort beides. So gibt es
       nichts doppelt in der Verwaltung und keinen zweiten Abschnitt. */
    shop: (n, s) => {
      const traeger = pages.filter((p) => list(p.sections).includes("shop"));
      const katalogSeite = traeger[traeger.length - 1];
      const modus =
        traeger.length < 2
          ? "alles"
          : str(katalogSeite?.slug) === str(page.slug)
          ? "katalog"
          : "einladung";
      return renderShop(
        n,
        s,
        site,
        str(sections.contact?.email),
        modus,
        modus === "einladung" ? pagePath(str(katalogSeite?.slug)) : ""
      );
    },
    booking: (n, s) => renderBooking(n, s, site),
    contact: (n, s) =>
      renderContact(n, s, bookingTarget, {
        url: sections.booking?.presskitUrl,
        label: sections.booking?.presskitLabel,
      }),
  };

  const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const firstKey = order[0];
  CTX.hideHead =
    page.hero === "compact" &&
    firstKey &&
    norm(str(sections[firstKey].navLabel, firstKey)) === norm(page.navLabel)
      ? firstKey
      : null;

  const body = order
    .map((key, i) => (renderers[key] ? renderers[key](i + 1, sections[key]) : ""))
    .join("\n");

  const navPages = pages.filter((p) => p.inNav);

  /**
   * EIN Menü für alle Seiten — auf /shop/ steht dasselbe wie auf /.
   *
   * Vorher hing das Menü an der Seite, auf der man gerade stand: die
   * Startseite zeigte ihre Abschnitte (About, Shows, …), der Shop nur "#shop",
   * und die eigene Seite fehlte jeweils in der Liste. Damit sah der Kopf auf
   * jeder Seite anders aus.
   *
   * Jetzt gilt überall dieselbe Liste: zuerst alle Seiten (Booking als
   * Hauptknopf, danach der Shop), dann die Abschnitte der STARTSEITE. Steht man
   * nicht auf der Startseite, zeigen deren Sprungmarken quer dorthin
   * (`/#about` statt `#about`) — sonst führten sie ins Leere.
   *
   * Einziger Unterschied je Seite ist `aria-current` am eigenen Eintrag: das
   * ist keine andere Navigation, sondern die Auskunft, wo man gerade ist (die
   * Unterstreichung im Kopf hängt daran).
   */
  const pageCls = (slug) =>
    slug === "booking" ? ' class="nav-cta"' : slug === "shop" ? ' class="nav-hot"' : "";
  const pageLinks = navPages.map(
    (p) =>
      `<li${pageCls(p.slug)}><a href="${esc(pagePath(p.slug))}"${
        p.slug === page.slug ? ' aria-current="page"' : ""
      }>${esc(p.navLabel)}</a></li>`
  );
  const startseite = pages.find((p) => !p.slug) || pages[0];
  const istStartseite = !page.slug;
  /* Ein Abschnitt, der auch eine eigene Seite hat, steht NUR als Seite im Menü.
     Anlass (12.08.2026): der Shop steht seit heute an zwei Plaetzen — der
     Katalog auf /shop/, die Einladung auf der Startseite. Im Kopf stand
     daraufhin zweimal "Shop": einmal als Seite, einmal als Sprungmarke. Die
     Seite gewinnt: dort liegt die Ware.

     Verglichen wird der Name der Seite mit dem des Abschnitts (/shop/ zu
     "shop"). Nicht die Abschnitte der Unterseiten: "contact" steht auch auf der
     Booking-Seite, gehoert im Menue aber weiter zur Startseite. */
  const alsSeite = new Set(navPages.map((p) => str(p.slug)).filter(Boolean));
  const sectionLinks = baubareAbschnitte(startseite)
    .filter((key) => !alsSeite.has(key))
    .map((key) => {
    const cls = key === "booking" ? ' class="nav-cta"' : key === "shop" ? ' class="nav-hot"' : "";
    const ziel = istStartseite ? `#${key}` : `${pagePath(startseite.slug)}#${key}`;
    return `<li${cls}><a href="${esc(ziel)}">${esc(
      str(sections[key]?.navLabel, str(sections[key]?.title, key))
    )}</a></li>`;
  });
  const nav = [...pageLinks, ...sectionLinks].join("\n          ");

  // Auf einer Unterseite mit mehreren Abschnitten zusätzlich Sprungmarken
  // anbieten. Bei einem einzigen Abschnitt wäre das eine Leiste mit einem
  // Eintrag — die bleibt weg.
  const subNav =
    navPages.length > 1 && order.length > 1 && page.slug
      ? `
    <nav class="subnav" aria-label="${esc(ui.onThisPage)}">
      <div class="wrap subnav-inner">
        ${order
          .map(
            (key) =>
              `<a href="#${esc(key)}">${esc(
                str(sections[key].navLabel, sections[key].title + sections[key].titleAccent)
              )}</a>`
          )
          .join("")}
      </div>
    </nav>`
      : "";

  // Die Kanäle stehen auf jeder Seite im Fuss, nicht nur im Kontakt-Abschnitt.
  const footSocials = list(sections.contact?.socials).filter(
    (x) => str(x?.label) && safeUrl(x?.url)
  );

  // Im Kopf steht standardmaessig KEIN Kanal-Zeichen mehr: der Kopf traegt den
  // Namen und das Menue, mehr nicht — das Instagram-Zeichen sass dort im Weg
  // und stand doppelt zum Fuss. Wer einen Kanal doch oben will, schaltet ihn
  // in der Verwaltung je Kanal ausdruecklich ein (inHeader: true).
  const headSocials = footSocials.filter((x) => x.inHeader === true);
  const headSocialsBlock = headSocials.length
    ? `<div class="head-social">${headSocials
        .map(
          (x) =>
            `<a href="${href(x.url)}" target="_blank" rel="noopener noreferrer me" aria-label="${esc(
              x.label
            )}" title="${esc(x.label)}">${socialIcon(x.label, x.url)}</a>`
        )
        .join("")}</div>`
    : "";

  const accent = color(site.accentColor, "#2e6bff");
  const ink = color(site.themeColor, "#05070e");
  const ogImage = absolute(base, cdnUrl(site.ogImage, 1200));
  const ticker = c.ticker || {};
  const tickerItems = list(ticker.items).filter((t) => str(t?.text) || str(t?.accent));

  const url = base + pagePath(page.slug);
  const title = str(
    page.seo?.title,
    isHome ? site.title : `${page.navLabel} — ${site.artist}`
  );
  const description = str(page.seo?.description, site.description);

  const tickerBlock =
    page.ticker && ticker.enabled !== false && tickerItems.length
      ? `
  <div class="ticker" aria-hidden="true">
    <div class="ticker-track">
      ${[0, 1]
        .map(() =>
          tickerItems
            .map(
              (t) =>
                `<span class="smash">${esc(t.text)}<i>${esc(t.accent)}</i></span><b>◆</b>`
            )
            .join("")
        )
        .join("")}
    </div>
  </div>`
      : "";

  // "Book me" im Hero fuehrt auf das Formular — seit Booking eine eigene Seite
  // hat, also quer auf /booking/#booking-form. bookingTarget rechnet den Weg
  // schon fertig aus (samt SITE_BASE); nur ein in der Verwaltung abweichend
  // gesetztes Ziel geht vor und wird hier selbst aufgeloest.
  const configuredHeroCta = str(c.hero?.ctaHref, "#booking");
  const heroCtaHref =
    configuredHeroCta === "#booking" && bookingTarget
      ? bookingTarget
      : anchor(configuredHeroCta);

  const hero =
    page.hero === "none"
      ? ""
      : page.hero === "compact"
      ? `
  <section class="hero hero-compact" id="top">
    <div class="wrap">
      <p class="mono">${esc(str(c.hero?.kicker, site.artist))}</p>
      ${/* Zwei Zeilen: der Name, darunter die Seite in der Akzentfarbe. Bis zum
           12.08.2026 stand hier nur "Shop" — auf der Shop-Seite fehlte der Name
           ganz (Kundenwunsch: "oben noch den Namen schreiben"). Der Name kommt
           aus den Stammdaten, die Zeile darunter ist der Seitentitel. */ ""}
      <h1 class="hero-zwei"><span class="hero-artist">${esc(
        str(site.artist, "Sam Sparking")
      )}</span><span class="hero-seite">${esc(
        /* Der Menuename zuerst: er ist uebersetzt ("Boutique" auf /fr/), der
           Seitentitel steht nur in der Hauptsprache. */
        str(page.navLabel, page.title)
      )}</span></h1>
      <div class="sparks" aria-hidden="true">${sparks(8)}</div>
    </div>
  </section>`
      : `
  <section class="hero" id="top">
    <div class="hero-bg">
      ${heroMedia(c.hero || {}, site)}
    </div>
    <div class="hero-inner">
      ${c.hero?.kicker ? `<p class="mono">${esc(c.hero.kicker)}</p>` : ""}
      <h1${
        c.hero?.nameSpaced ? ` aria-label="${esc(site.artist)}"` : ""
      }>${
        c.hero?.nameSpaced
          ? `<span class="sp">${esc(c.hero.nameSpaced)}</span> `
          : ""
      }${esc(c.hero?.nameMain || site.artist)}</h1>
      <div class="hero-sub">
        ${/* Unter dem Namen steht genau ein Satz — der Anspruch, in der
             Akzentfarbe. Die Genre-Zeile ("Euphoric Hardstyle / Melodic
             Hardstyle") stand bis August 2026 daneben und ist weg: sie
             wiederholte, was der Sound-Abschnitt ohnehin sagte, und nahm dem
             Satz die Wirkung. `hero.meta` wird darum nicht mehr gelesen. */ ""}
        ${c.hero?.tagline ? `<span class="tag">${esc(c.hero.tagline)}</span>` : ""}
        ${
          c.hero?.ctaLabel
            ? `<a class="hero-cta" href="${esc(heroCtaHref)}">${esc(
                c.hero.ctaLabel
              )}<span class="cta-arr" aria-hidden="true">→</span></a>`
            : ""
        }
        ${
          shopTarget
            ? `<a class="hero-cta alt" href="${esc(shopTarget)}">${esc(
                str(sections.shop?.navLabel, "Shop")
              )}</a>`
            : ""
        }
      </div>
      ${heroStats(c.hero)}
    </div>
    <div class="sparks" aria-hidden="true">${sparks()}</div>
    <a class="hero-scroll mono" href="#${esc(order[0] || "top")}" aria-hidden="true" tabindex="-1">${esc(ui.scroll)}</a>
  </section>`;

  const heroPreload = (() => {
    if (page.hero !== "full") return "";
    const m = c.hero?.media || {};
    const links = [];
    if (m.type === "video" && safeUrl(m.src)) {
      // Das Video selbst frueh anfordern — noch bevor der Parser beim
      // <video>-Element ankommt. Nur fuer die eigene, komprimierte Fassung.
      if (/^\/?media\//.test(String(m.src)))
        links.push(`  <link rel="preload" as="video" href="${esc(rooted(m.src))}" fetchpriority="high">`);
    }
    const first = m.type === "video" ? m.poster : m.src;
    if (safeUrl(first) && !isVideoUrl(first)) {
      if (CDN) {
        const set = [640, 1024, 1600]
          .map((w) => `${esc(cdnUrl(first, w))} ${w}w`)
          .join(", ");
        links.push(`  <link rel="preload" as="image" imagesrcset="${set}" imagesizes="100vw" fetchpriority="high">`);
      } else {
        links.push(`  <link rel="preload" as="image" href="${esc(rooted(first))}" fetchpriority="high">`);
      }
    }
    return links.length ? links.join("\n") + "\n" : "";
  })();

  // Termine als JSON für die Kalenderansicht (assets/site.js baut sie auf)
  const showsData =
    order.includes("shows")
      ? `
  <script type="application/json" id="shows-data">${jsonScript(
    list(sections.shows.items)
      .filter((i) => str(i?.name) && isoDate(i.date))
      .map((i) => ({
        date: isoDate(i.date),
        name: str(i.name),
        venue: str(i.venue),
        city: str(i.city),
        url: safeUrl(i.ticketUrl),
        status: str(i.status, "confirmed"),
      }))
  )}</script>`
      : "";

  return `<!DOCTYPE html>
<!--
  Diese Datei wird generiert — NICHT direkt bearbeiten.
  Inhalte pflegst du in der Verwaltung (oder in content/site.json),
  danach "node scripts/build.mjs" bzw. ein Netlify-Deploy.
-->
<html lang="${esc(site.lang || "en")}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">

  <!-- Primary SEO -->
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="keywords" content="${esc(list(site.keywords).join(", "))}">
  <link rel="canonical" href="${esc(url)}">
${langs
  .map(
    (l) =>
      `  <link rel="alternate" hreflang="${esc(l)}" href="${esc(
        base + langPrefix(l, master) + (page.slug ? `/${page.slug}/` : "/")
      )}">`
  )
  .join("\n")}
  <link rel="alternate" hreflang="x-default" href="${esc(
    base + (page.slug ? `/${page.slug}/` : "/")
  )}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
  <meta name="googlebot" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
  <meta name="author" content="${esc(site.artist)}">
  <meta name="publisher" content="${esc(site.artist)}">
  <meta name="creator" content="${esc(site.artist)}">
${geoMeta(sections.contact)}
  <!-- Open Graph / Social -->
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${esc(site.artist)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:title" content="${esc(isHome ? str(site.ogTitle, title) : title)}">
  <meta property="og:description" content="${esc(
    isHome ? str(site.ogDescription, description) : description
  )}">
  <meta property="og:image" content="${esc(ogImage)}">
  <meta property="og:image:alt" content="${esc(c.hero?.media?.alt || site.artist)}">
  <meta property="og:locale" content="${esc(OG_LOCALE[lang] || "de_CH")}">
${langs
  .filter((l) => l !== lang)
  .map((l) => `  <meta property="og:locale:alternate" content="${esc(OG_LOCALE[l] || l)}">`)
  .join("\n")}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(isHome ? str(site.ogTitle, title) : title)}">
  <meta name="twitter:description" content="${esc(
    isHome ? str(site.ogDescription, description) : description
  )}">
  <meta name="twitter:image" content="${esc(ogImage)}">
  <meta name="twitter:image:alt" content="${esc(c.hero?.media?.alt || site.artist)}">

  <!-- Structured data -->
  <script type="application/ld+json">
${jsonScript(structuredData(c, sections, page, pages))}
  </script>

  <meta name="theme-color" content="${esc(ink)}">
  <link rel="apple-touch-icon" href="${BASE}/img/icon-180.png">
  <link rel="icon" type="image/png" sizes="32x32" href="${BASE}/img/icon-32.png">
  <link rel="manifest" href="${BASE}/manifest.webmanifest">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='${encodeURIComponent(
    ink
  )}'/%3E%3Cpath d='M36 6 14 38h14l-4 20 26-34H34z' fill='${encodeURIComponent(
    accent
  )}'/%3E%3C/svg%3E">

  <link rel="preconnect" href="https://firebasestorage.googleapis.com" crossorigin>
  <link rel="preload" as="font" type="font/woff2" href="${BASE}/assets/fonts/archivo-latin.woff2" crossorigin>
  <link rel="preload" as="font" type="font/woff2" href="${BASE}/assets/fonts/plexmono-400-latin.woff2" crossorigin>
${heroPreload}
  <link rel="stylesheet" href="${BASE}/assets/site.css">
  <style>:root{--ink:${ink};--spark:${accent};}</style>${releaseKopf(rel)}
</head>
<body data-page="${esc(page.slug || "home")}">
${releaseVorhang(rel, ui, lang, master)}
${pageBackground(site)}
  <a class="skip" href="#${esc(order[0] || "top")}">${esc(ui.skip)}</a>

  <header>
    <div class="progress" id="progress" aria-hidden="true"></div>
    <a class="logo" href="${BASE}/">${esc(str(site.logoText, site.artist))}</a>
    <nav id="nav">
      <button class="nav-close" type="button" aria-label="${esc(ui.close)}">✕</button>
      <ul>
          ${nav}
      </ul>
      ${
        langs.length > 1
          ? `<div class="nav-langs">${langs
              .map(
                (l) =>
                  `<a href="${esc(
                    navPrefix(l, master) + (page.slug ? `/${page.slug}/` : "/")
                  )}" lang="${esc(l)}"${l === lang ? ' aria-current="true"' : ""}>${esc(l.toUpperCase())}</a>`
              )
              .join("")}</div>`
          : ""
      }
    </nav>
    ${headSocialsBlock}
    <button class="burger" id="burger" aria-label="${esc(ui.menu)}" aria-expanded="false" aria-controls="nav" data-open="${esc(ui.menu)}" data-close="${esc(ui.close)}">${esc(ui.menu)}</button>
  </header>
  <main id="main">
${hero}${tickerBlock}${subNav}
${body}
  </main>

  <div class="lb" id="lb" role="dialog" aria-modal="true" aria-label="${esc(ui.imageViewer)}" hidden>
    <button class="lb-close" id="lb-close" aria-label="${esc(ui.close)}">✕</button>
    <button class="lb-nav lb-prev" id="lb-prev" aria-label="${esc(ui.prevImage)}">‹</button>
    <figure class="lb-fig"><img id="lb-img" src="" alt=""><figcaption id="lb-cap" class="mono"></figcaption></figure>
    <button class="lb-nav lb-next" id="lb-next" aria-label="${esc(ui.nextImage)}">›</button>
  </div>

  <a class="totop" href="#top" aria-label="${esc(ui.toTop || "Nach oben")}">↑</a>
${
  hasBooking
    ? `  <div class="actbar" id="actbar" aria-hidden="true">
    <a class="btn solid" href="${esc(bookingTarget)}">${esc(ui.bookCta)}</a>
  </div>
`
    : ""
}

  ${/* Die Einwilligung. Zwei Entscheidungen, gleich gross und gleich betont —
        keine ist als Standard hervorgehoben. Sie steht beim ersten Besuch da,
        wird gespeichert und laesst sich unten im Fuss ueber
        "Cookie-Einstellungen" jederzeit wieder oeffnen und aendern.

        Von hier gehen zwei Wege weiter: zum Impressum und zur Datenschutz-
        Erklaerung. Beide bleiben inhaltlich unveraendert.

        Erst nach "Alle akzeptieren" darf ueberhaupt etwas Zusaetzliches laden.
        Wie das technisch faellt, steht in assets/site.js (data-consent) — und
        heute ist kein einziger solcher Dienst eingebunden. */ ""}
  <aside class="cookie" id="cookie" hidden role="region" aria-labelledby="cookie-h">
    <div class="cookie-in">
      <div class="cookie-say">
        <span class="mono" id="cookie-h">${esc(ui.cookieTitle)}</span>
        <p>${esc(ui.cookieText)}</p>
        <p class="cookie-ways">
          <a href="${esc(navPrefix(lang, master) + "/" + IMPRESSUM_SLUG + "/")}">${esc(
    (IMPRESSUM_TEXT[lang] || IMPRESSUM_TEXT.de).titel
  )}</a>
          <a href="${esc(navPrefix(lang, master) + "/" + (LEGAL_SLUG[lang] || "legal") + "/")}">${esc(
    LEGAL_FUSS[lang] || LEGAL_FUSS.de
  )}</a>
        </p>
      </div>
      <div class="cookie-acts">
        <button class="btn sm cookie-btn" id="cookie-min" type="button" data-wahl="notwendig">${esc(
          ui.cookieNecessary
        )}</button>
        <button class="btn sm cookie-btn" id="cookie-all" type="button" data-wahl="alle">${esc(
          ui.cookieAll
        )}</button>
      </div>
    </div>
  </aside>

  <footer>${
    footSocials.length
      ? `
    <div class="wrap foot-social">
      <span class="mono">${esc(ui.follow)}</span>
      <ul>
        ${footSocials
          .map(
            (x) =>
              `<li><a href="${href(x.url)}" target="_blank" rel="noopener noreferrer me" title="${esc(
                x.label
              )}"><span aria-hidden="true">${socialIcon(x.label, x.url)}</span><span>${esc(
                x.label
              )}</span></a></li>`
          )
          .join("\n        ")}
        ${
          /* Auch im Fuss steht das Presskit bei den Kanaelen (12.08.2026) —
             dieselbe Datei, dasselbe Zeichen, zum Herunterladen. */
          safeUrl(sections.booking?.presskitUrl)
            ? `<li><a href="${href(sections.booking.presskitUrl)}" download title="${esc(
                str(sections.booking.presskitLabel, "Presskit (PDF)")
              )}"><span aria-hidden="true">${socialIcon(
                "presskit",
                sections.booking.presskitUrl
              )}</span><span>${esc(
                str(sections.booking.presskitLabel, "Presskit (PDF)")
              )}</span></a></li>`
            : ""
        }
      </ul>
    </div>`
      : ""
  }
    <div class="wrap foot">
      ${
        langs.length > 1
          ? `<nav class="langs" aria-label="${esc(ui.language)}">
        <span class="mono">${esc(ui.language)}</span>
        ${langs
          .map(
            (l) =>
              `<a href="${esc(
                navPrefix(l, master) + (page.slug ? `/${page.slug}/` : "/")
              )}" lang="${esc(l)}"${l === lang ? ' aria-current="true"' : ""}>${esc(
                LANG_NAMES[l] || l.toUpperCase()
              )}</a>`
          )
          .join("")}
      </nav>`
          : ""
      }
      <span class="mono">© <span id="yr">${today().slice(0, 4)}</span> ${esc(
    site.artist
  )} — ${esc(ui.rights)}</span>
      <a class="mono" href="${esc(navPrefix(lang, master) + "/" + IMPRESSUM_SLUG + "/")}">${esc(
    (IMPRESSUM_TEXT[lang] || IMPRESSUM_TEXT.de).titel
  )}</a>
      <a class="mono" href="${esc(navPrefix(lang, master) + "/" + (LEGAL_SLUG[lang] || "legal") + "/")}">${esc(
    LEGAL_FUSS[lang] || LEGAL_FUSS.de
  )}</a>
      ${/* Die Entscheidung laesst sich jederzeit aendern. Ein Knopf und kein
           Link, weil er keine Seite oeffnet, sondern die Abfrage zurueckholt.
           Sieht aus wie die Links daneben. */ ""}
      <button class="mono foot-link" id="cookie-open" type="button">${esc(
        ui.cookieSettings
      )}</button>
      ${site.claim ? `<span class="claim">${esc(site.claim)}</span>` : ""}
      ${
        /* Der Fotocredit im Fuss ("Photography — …") ist weg. Kundenwunsch vom
           11.08.2026: keine sichtbaren Fotografen-Angaben, weder hier noch an
           der Galerie, im Booking-Bild oder in den strukturierten Daten. Das
           Feld bleibt im Inhalt stehen, es wird nur nicht mehr angezeigt. */
        ""
      }
    </div>
  </footer>
${showsData}
  <script src="${BASE}/assets/site.js" defer></script>
</body>
</html>
`;
}

/* ------------------------------------------------------- rechtliches */

const LEGAL_LABEL = { de: "Impressum & Datenschutz", en: "Legal & privacy", fr: "Mentions légales" };
/* Im Fuss steht seit dem 11.08.2026 zusaetzlich das Impressum als eigene Seite.
   Stand dort daneben weiter "Impressum & Datenschutz", las man auf /de/ zweimal
   "Impressum" und wusste nicht, welcher Link welcher ist. Die Datenschutz-Seite
   heisst im Fuss deshalb nur noch nach ihrem zweiten Teil; die Seite selbst
   behaelt Titel und Inhalt unveraendert. */
const LEGAL_FUSS = { de: "Datenschutz", en: "Privacy", fr: "Protection des données" };
const LEGAL_SLUG = { de: "rechtliches", en: "legal", fr: "mentions-legales" };

const LEGAL_TEXT = {
  de: {
    title: "Impressum & Datenschutz",
    impressum: "Impressum",
    impressumBody: (artist, base, email) =>
      `<p>Verantwortlich für diese Website:</p><p><strong>${artist}</strong><br>${base}<br><a href="mailto:${email}">${email}</a></p>`,
    privacy: "Datenschutz",
    blocks: [
      ["Kurzfassung", "Diese Website kommt ohne Tracking, Werbe-Cookies und Analyse-Dienste aus. Personendaten fallen nur an, wenn du sie selbst über ein Formular schickst."],
      ["Hosting", "Die Website wird bei Netlify (Netlify Inc., USA) ausgeliefert. Beim Aufruf verarbeitet Netlify technisch notwendige Verbindungsdaten (z. B. IP-Adresse) in Server-Protokollen. Bilder werden über das Bild-CDN von Netlify verkleinert ausgeliefert."],
      ["Medien", "Bilder und Videos liegen bei Google Firebase (Google Ireland Ltd.). Beim Laden dieser Dateien wird deine IP-Adresse an Firebase übermittelt."],
      ["Booking-Anfragen und Bestellungen", "Schickst du eine Anfrage oder Bestellung ab, werden die Angaben aus dem Formular (Name, E-Mail, Nachricht, ggf. Datum und Ort) in einer Firebase-Datenbank gespeichert und ausschliesslich zur Bearbeitung deiner Anfrage verwendet. Sie werden nicht weitergegeben und auf Wunsch gelöscht."],
      ["Bezahlung", "Beim Kauf über einen Bezahl-Link (z. B. Stripe) oder per TWINT gelten die Datenschutzbestimmungen des jeweiligen Anbieters; diese Website selbst speichert keine Zahlungsdaten."],
      ["Lokaler Speicher", "Die Website merkt sich lediglich im Browser (localStorage), dass du den Hinweis unten bestätigt hast. Es werden keine Cookies zu Werbe- oder Analysezwecken gesetzt."],
      ["Deine Rechte", "Du hast das Recht auf Auskunft, Berichtigung und Löschung deiner Daten (DSG/DSGVO). Melde dich dafür per E-Mail."],
    ],
  },
  en: {
    title: "Legal notice & privacy",
    impressum: "Legal notice",
    impressumBody: (artist, base, email) =>
      `<p>Responsible for this website:</p><p><strong>${artist}</strong><br>${base}<br><a href="mailto:${email}">${email}</a></p>`,
    privacy: "Privacy",
    blocks: [
      ["In short", "This website uses no tracking, no advertising cookies and no analytics. Personal data is only processed when you submit it through a form yourself."],
      ["Hosting", "The site is served by Netlify (Netlify Inc., USA). When you visit, Netlify processes technically necessary connection data (e.g. IP address) in server logs. Images are resized and delivered via Netlify's image CDN."],
      ["Media", "Images and videos are stored with Google Firebase (Google Ireland Ltd.). Loading these files transmits your IP address to Firebase."],
      ["Booking requests and orders", "If you submit a request or an order, the form details (name, e-mail, message, date and place if given) are stored in a Firebase database and used solely to handle your request. They are not shared and will be deleted on request."],
      ["Payment", "Purchases via a payment link (e.g. Stripe) or TWINT are governed by the provider's privacy policy; this website itself stores no payment data."],
      ["Local storage", "The site only remembers in your browser (localStorage) that you confirmed the notice below. No advertising or analytics cookies are set."],
      ["Your rights", "You have the right to access, correct and delete your data (Swiss FADP / GDPR). Just send an e-mail."],
    ],
  },
  fr: {
    title: "Mentions légales & protection des données",
    impressum: "Mentions légales",
    impressumBody: (artist, base, email) =>
      `<p>Responsable de ce site :</p><p><strong>${artist}</strong><br>${base}<br><a href="mailto:${email}">${email}</a></p>`,
    privacy: "Protection des données",
    blocks: [
      ["En bref", "Ce site n'utilise ni traçage, ni cookies publicitaires, ni outils d'analyse. Des données personnelles ne sont traitées que si tu les envoies toi-même via un formulaire."],
      ["Hébergement", "Le site est servi par Netlify (Netlify Inc., USA). Lors de la visite, Netlify traite des données de connexion techniquement nécessaires (p. ex. adresse IP) dans ses journaux. Les images sont redimensionnées et livrées via le CDN d'images de Netlify."],
      ["Médias", "Les images et vidéos sont hébergées chez Google Firebase (Google Ireland Ltd.). Leur chargement transmet ton adresse IP à Firebase."],
      ["Demandes de booking et commandes", "Si tu envoies une demande ou une commande, les informations du formulaire (nom, e-mail, message, date et lieu le cas échéant) sont enregistrées dans une base Firebase et utilisées uniquement pour traiter ta demande. Elles ne sont pas transmises et seront supprimées sur demande."],
      ["Paiement", "Les achats via un lien de paiement (p. ex. Stripe) ou TWINT sont soumis aux règles de l'opérateur concerné ; ce site ne conserve aucune donnée de paiement."],
      ["Stockage local", "Le site retient uniquement dans ton navigateur (localStorage) que tu as confirmé l'avis en bas de page. Aucun cookie publicitaire ou d'analyse n'est déposé."],
      ["Tes droits", "Tu as le droit d'accéder à tes données, de les corriger et de les supprimer (LPD/RGPD). Il suffit d'envoyer un e-mail."],
    ],
  },
};

/* ------------------------------------------------------------- Impressum */

/* Die Adresse ist in jeder Sprache dieselbe: /impressum/, /de/impressum/,
   /fr/impressum/. "Impressum" ist im schweizerischen Sprachgebrauch auch auf
   englisch- und franzoesischsprachigen Seiten der gelaeufige Begriff, und eine
   Adresse, die ueberall gleich heisst, laesst sich weitergeben. */
const IMPRESSUM_SLUG = "impressum";

/* Nur die Aufschriften stehen hier — die Angaben selbst (E-Mail, Standort)
   kommen aus dem Inhalt und sind in der Verwaltung bearbeitbar. Bewusst
   knapp: keine Strassenadresse, keine Handelsregister- oder
   Mehrwertsteuernummer. Was nicht bekannt ist, steht nicht da. */
const IMPRESSUM_TEXT = {
  de: { titel: "Impressum", email: "E-Mail", standort: "Standort", zurueck: "zurück zur Website" },
  en: { titel: "Impressum", email: "E-mail", standort: "Location", zurueck: "back to the website" },
  fr: { titel: "Impressum", email: "E-mail", standort: "Lieu", zurueck: "retour au site" },
};

/* Der Standort steht EINMAL im Inhalt ("Herisau, Schweiz") — sonst liefen die
   Sprachen auseinander, sobald der Kunde ihn in der Verwaltung aendert. Nur
   das Landeswort wird uebersetzt, und nur wenn es am Ende genau so dasteht.
   Der Ort selbst bleibt unangetastet: Herisau heisst in jeder Sprache Herisau. */
const LAENDER = {
  Schweiz: { en: "Switzerland", fr: "Suisse" },
  Switzerland: { de: "Schweiz", fr: "Suisse" },
  Suisse: { de: "Schweiz", en: "Switzerland" },
};
const standortInSprache = (wert, lang) => {
  const text = str(wert).trim();
  for (const [wort, sprachen] of Object.entries(LAENDER)) {
    if (!text.endsWith(wort)) continue;
    const ersatz = sprachen[lang];
    return ersatz ? text.slice(0, -wort.length) + ersatz : text;
  }
  return text;
};

/** Impressum — eine schlichte, kurze Seite je Sprache. */
function renderImpressum(c, lang, langs) {
  const site = c.site;
  const master = langs[0];
  // Auch das Impressum bleibt bis zum Release hinter dem Vorhang — sonst waere
  // ueber diese Adresse schon vorher etwas erreichbar.
  const rel = releaseStand(c);
  const ui = uiFuer(c, lang);
  const t = IMPRESSUM_TEXT[lang] || IMPRESSUM_TEXT.de;
  const imp = c.imprint || {};
  const contact = c.sections?.contact || {};
  // Die E-Mail kommt aus dem Impressum, sonst aus dem Kontakt-Abschnitt: zwei
  // Stellen mit derselben Angabe sollen nicht auseinanderlaufen.
  const email = str(imp.email) || str(contact.email, "info@samsparking.ch");
  const standort = standortInSprache(imp.location, lang);
  const artist = esc(site.artist);
  const ink = color(site.themeColor, "#05070e");
  const accent = color(site.accentColor, "#2e6bff");
  const prefix = navPrefix(lang, master);
  const zeile = (label, wert) =>
    wert ? `<p><span class="mono">${esc(label)}</span> ${wert}</p>` : "";
  return `<!DOCTYPE html>
<html lang="${esc(lang)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(t.titel)} — ${artist}</title>
  <meta name="description" content="${esc(t.titel)} — ${artist}">
  <link rel="canonical" href="${esc(
    site.domain.replace(/\/+$/, "") + langPrefix(lang, master) + "/" + IMPRESSUM_SLUG + "/"
  )}">
  <link rel="stylesheet" href="${BASE}/assets/site.css">
  <style>:root{--ink:${ink};--spark:${accent};}
    .legal{max-width:720px;margin:0 auto;padding:clamp(90px,14vh,140px) 22px 80px;}
    .legal h1{font-size:clamp(1.6rem,5vw,2.6rem);margin-bottom:34px;}
    .legal p{color:var(--bone-dim);margin-bottom:12px;}
    .legal p .mono{display:block;color:var(--bone);}
    .legal a{color:var(--spark);}
    .legal .langs{border:0;padding:0;margin:22px 0 0;}
  </style>${releaseKopf(rel)}
</head>
<body>
${releaseVorhang(rel, ui, lang, master)}
  <main class="legal">
    <a class="mono" href="${esc(prefix || "/")}">← ${artist} — ${esc(t.zurueck)}</a>
    ${
      langs.length > 1
        ? `<nav class="langs" aria-label="${esc(LANG_NAMES[lang] || "Sprache")}">${langs
            .map(
              (l) =>
                `<a href="${esc(navPrefix(l, master) + "/" + IMPRESSUM_SLUG + "/")}" lang="${esc(
                  l
                )}"${l === lang ? ' aria-current="true"' : ""}>${esc(LANG_NAMES[l] || l)}</a>`
            )
            .join("")}</nav>`
        : ""
    }
    <h1>${esc(t.titel)}</h1>
    <p><strong>${artist}</strong></p>
    ${zeile(t.email, `<a href="mailto:${esc(email)}">${esc(email)}</a>`)}
    ${zeile(t.standort, esc(standort))}
    <p><a href="${esc(navPrefix(lang, master) + "/" + (LEGAL_SLUG[lang] || "legal") + "/")}">${esc(
    LEGAL_LABEL[lang] || LEGAL_LABEL.de
  )}</a></p>
  </main>
  ${/* Ohne dieses Skript laeuft der Countdown auf dieser Seite nicht — der
       Vorhang ginge hier nie auf. */ ""}
  <script src="${BASE}/assets/site.js" defer></script>
</body>
</html>
`;
}

/** Impressum & Datenschutz — eine schlichte Seite je Sprache. */
function renderLegal(c, lang, langs) {
  const site = c.site;
  const master = langs[0];
  const rel = releaseStand(c);
  const ui = uiFuer(c, lang);
  const t = LEGAL_TEXT[lang] || LEGAL_TEXT.de;
  const contact = c.sections?.contact || {};
  const email = esc(str(contact.email, "info@samsparking.ch"));
  const artist = esc(site.artist);
  const base = esc(str(contact.base, "St. Gallen, Schweiz"));
  const ink = color(site.themeColor, "#05070e");
  const accent = color(site.accentColor, "#2e6bff");
  const prefix = navPrefix(lang, master);
  return `<!DOCTYPE html>
<html lang="${esc(lang)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(t.title)} — ${artist}</title>
  <meta name="robots" content="noindex, follow">
  <link rel="stylesheet" href="${BASE}/assets/site.css">
  <style>:root{--ink:${ink};--spark:${accent};}
    .legal{max-width:720px;margin:0 auto;padding:clamp(90px,14vh,140px) 22px 80px;}
    .legal h1{font-size:clamp(1.6rem,5vw,2.6rem);margin-bottom:34px;}
    .legal h2{font-size:1.15rem;margin:38px 0 12px;}
    .legal h3{font-size:.95rem;margin:24px 0 6px;color:var(--bone);}
    .legal p{color:var(--bone-dim);margin-bottom:12px;}
    .legal a{color:var(--spark);}
    .legal .langs{border:0;padding:0;margin:22px 0 0;}
  </style>${releaseKopf(rel)}
</head>
<body>
${releaseVorhang(rel, ui, lang, master)}
  <main class="legal">
    <a class="mono" href="${esc(prefix || "/")}">← ${artist}</a>
    ${
      langs.length > 1
        ? `<nav class="langs" aria-label="${esc(LANG_NAMES[lang] || "Sprache")}">${langs
            .map(
              (l) =>
                `<a href="${esc(navPrefix(l, master) + "/" + (LEGAL_SLUG[l] || "legal") + "/")}" lang="${esc(
                  l
                )}"${l === lang ? ' aria-current="true"' : ""}>${esc(LANG_NAMES[l] || l)}</a>`
            )
            .join("")}</nav>`
        : ""
    }
    <h1>${esc(t.title)}</h1>
    <h2>${esc(t.impressum)}</h2>
    ${t.impressumBody(artist, base, email)}
    <h2>${esc(t.privacy)}</h2>
    ${t.blocks.map(([h, b]) => `<h3>${esc(h)}</h3><p>${esc(b)}</p>`).join("\n    ")}
  </main>
  <script src="${BASE}/assets/site.js" defer></script>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ main */

function renderSitemap(c, pages, langs) {
  const base = c.site.domain.replace(/\/+$/, "");
  const master = langs[0];
  // Bilder der Galerie mitschicken — sie kommen so in die Google-Bildersuche
  const galleryImages = list(c.sections?.gallery?.items)
    .map((g) => ({ src: safeUrl(g?.src), alt: str(g?.alt) }))
    .filter((g) => g.src && !isVideoUrl(g.src))
    .slice(0, 1000);
  const rows = [];
  for (const lang of langs) {
    for (const p of pages) {
      const path = langPrefix(lang, master) + (p.slug ? `/${p.slug}/` : "/");
      const alts = langs
        .map(
          (l) =>
            `      <xhtml:link rel="alternate" hreflang="${esc(l)}" href="${esc(
              base + langPrefix(l, master) + (p.slug ? `/${p.slug}/` : "/")
            )}"/>`
        )
        .join("\n");
      const images = list(p.sections).includes("gallery")
        ? galleryImages
            .map(
              (g) => `    <image:image>
      <image:loc>${esc(absolute(base, g.src))}</image:loc>${
                g.alt ? `\n      <image:title>${esc(g.alt)}</image:title>` : ""
              }
    </image:image>`
            )
            .join("\n")
        : "";
      rows.push(`  <url>
    <loc>${esc(base)}${esc(path)}</loc>
${alts}
    <lastmod>${today()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${!p.slug && lang === master ? "1.0" : "0.8"}</priority>${images ? "\n" + images : ""}
  </url>`);
    }
  }
  /* Das Impressum gehoert in die Sitemap. Es steht nicht in `pages` (es ist
     keine Seite mit Abschnitten, sondern eine feste kurze Seite), muss aber
     auffindbar sein — anders als "Impressum & Datenschutz", das auf noindex
     steht. */
  for (const lang of langs) {
    const alts = langs
      .map(
        (l) =>
          `      <xhtml:link rel="alternate" hreflang="${esc(l)}" href="${esc(
            base + langPrefix(l, master) + "/" + IMPRESSUM_SLUG + "/"
          )}"/>`
      )
      .join("\n");
    rows.push(`  <url>
    <loc>${esc(base + langPrefix(lang, master) + "/" + IMPRESSUM_SLUG + "/")}</loc>
${alts}
    <lastmod>${today()}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${rows.join("\n")}
</urlset>
`;
}

/** Einfache 404-Seite im Look der Website. */
function render404(c, langs) {
  const site = c.site;
  // Auch die 404-Seite bleibt bis zum Release hinter dem Vorhang.
  const rel = releaseStand(c);
  const ink = color(site.themeColor, "#05070e");
  const accent = color(site.accentColor, "#2e6bff");
  const ui = uiFuer(c, langs[0]);
  return `<!DOCTYPE html>
<html lang="${esc(langs[0] || "de")}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>404 — ${esc(site.artist)}</title>
  <meta name="robots" content="noindex, follow">
  <link rel="stylesheet" href="${BASE}/assets/site.css">
  <style>:root{--ink:${ink};--spark:${accent};}
    .nf{min-height:100svh;display:flex;align-items:center;}
    .nf h1{font-size:clamp(3rem,14vw,9rem);font-variation-settings:'wdth' 122,'wght' 850;}
    .nf p{color:var(--bone-dim);margin:18px 0 30px;max-width:46ch;}
  </style>${releaseKopf(rel)}
</head>
<body data-page="404">
${releaseVorhang(rel, ui, langs[0], langs[0])}
${pageBackground(site)}
  <main class="nf">
    <div class="wrap">
      <span class="mono">404</span>
      <h1>${esc(str(ui.notFoundTitle, "Nichts hier."))}</h1>
      <p>${esc(str(ui.notFoundText, "Diese Seite gibt es nicht (mehr). Zurück zum Start — dort steht alles Aktuelle."))}</p>
      <a class="btn" href="${BASE}/">${esc(str(ui.notFoundCta, "Zur Startseite"))}</a>
    </div>
  </main>
  <script src="${BASE}/assets/site.js" defer></script>
</body>
</html>
`;
}

function renderRobots(c) {
  const base = c.site.domain.replace(/\/+$/, "");
  return `User-agent: *
Allow: /

Sitemap: ${base}/sitemap.xml
`;
}

async function main() {
  const content = await loadContent();
  BILDMASSE = await ladeBildmasse();
  if (!content.site || !content.site.domain) {
    throw new Error("content: site.domain fehlt");
  }

  // Hero-Video: die Verwaltung liefert Originale in voller Bitrate (das
  // aktuelle: 15+ Mbit/s — auf Mobilfunk kommt der Puffer nie hinterher).
  // Die GitHub Action legt eine komprimierte Fassung unter media/ ab samt
  // Quelle-Marker; passt der Marker zur aktuellen Quelle, nimmt der Build
  // die schlanke Fassung. Laedt Sam ein neues Video hoch, greift wieder das
  // Original, bis die Action nachgezogen hat.
  try {
    const hv = content.hero?.media;
    if (hv?.type === "video" && /^https?:/i.test(String(hv.src || ""))) {
      const markerFile = resolve(ROOT, "media/hero-video.source");
      const localFile = resolve(ROOT, "media/hero-video.mp4");
      if (existsSync(markerFile) && existsSync(localFile)) {
        const known = (await readFile(markerFile, "utf8")).trim();
        if (known === String(hv.src).trim()) {
          hv.src = "media/hero-video.mp4";
          console.log("[build] Hero-Video: komprimierte lokale Fassung eingesetzt");
        }
      }
    }
  } catch (e) {
    console.warn("[build] Video-Optimierung uebersprungen:", e.message);
  }
  await mkdir(resolve(ROOT, "content"), { recursive: true });

  const langs = languagesOf(content);
  const master = langs[0];
  const pages = pagesOf(content);
  const written = [];

  for (const lang of langs) {
    const localized = localize(content, lang);
    const localizedPages = pagesOf(localized);
    for (const page of localizedPages) {
      const dir = [lang === master ? "" : lang, page.slug].filter(Boolean).join("/");
      const rel = dir ? `${dir}/index.html` : "index.html";
      const file = resolve(ROOT, rel);
      await mkdir(dirname(file), { recursive: true });
      const html = renderPage(localized, page, localizedPages, lang, langs);
      await writeFile(file, html);
      written.push(rel);
      // Gemeldet wird, was wirklich in der Datei steht — nicht, was der Inhalt
      // vorschlägt. Sonst führt die Meldung Abschnitte auf, die es hier gar
      // nicht mehr gibt (siehe BAUBAR) und die niemand auf der Seite findet.
      const gebaut = list(page.sections).filter((k) => BAUBAR.has(k));
      console.log(
        `[build] ${rel.padEnd(30)} ${(html.length / 1024).toFixed(1).padStart(5)} kB  ` +
          `(${gebaut.join(", ") || "keine Abschnitte"})`
      );
    }
  }

  // Impressum & Datenschutz je Sprache
  for (const lang of langs) {
    const rel = (langPrefix(lang, master) + "/" + (LEGAL_SLUG[lang] || "legal") + "/index.html").replace(/^\//, "");
    const file = resolve(ROOT, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, renderLegal(content, lang, langs));
    written.push(rel);
  }
  console.log("[build] Rechtliches je Sprache");

  // Impressum je Sprache — kurz, und in jeder Sprache unter /impressum/
  for (const lang of langs) {
    const rel = (langPrefix(lang, master) + "/" + IMPRESSUM_SLUG + "/index.html").replace(/^\//, "");
    const file = resolve(ROOT, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, renderImpressum(content, lang, langs));
    written.push(rel);
  }
  console.log("[build] Impressum je Sprache");

  await writeFile(resolve(ROOT, "sitemap.xml"), renderSitemap(content, pages, langs));
  await writeFile(resolve(ROOT, "robots.txt"), renderRobots(content));
  await writeFile(resolve(ROOT, "404.html"), render404(content, langs));
  console.log("[build] sitemap.xml, robots.txt, 404.html");

  // Verzeichnisse aufräumen, die zu keiner Seite mehr gehören
  const wanted = new Set(written.map((r) => r.split("/")[0]).filter((d) => d !== "index.html"));
  langs.slice(1).forEach((l) => wanted.add(l));
  for (const entry of await readdir(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || KEEP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    if (wanted.has(entry.name)) continue;
    if (existsSync(resolve(ROOT, entry.name, "index.html"))) {
      await rm(resolve(ROOT, entry.name), { recursive: true, force: true });
      console.log(`[build] entfernt: ${entry.name}/ (keine Seite mehr)`);
    }
  }

  // Dasselbe innerhalb der Sprachverzeichnisse (en/, fr/, …)
  // Behalten wird, was dieser Lauf wirklich geschrieben hat
  const writtenDirs = new Set(
    written.map((r) => r.split("/").slice(0, -1).join("/")).filter(Boolean)
  );
  for (const lang of langs.slice(1)) {
    const dir = resolve(ROOT, lang);
    if (!existsSync(dir)) continue;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (writtenDirs.has(`${lang}/${entry.name}`)) continue;
      if (existsSync(resolve(dir, entry.name, "index.html"))) {
        await rm(resolve(dir, entry.name), { recursive: true, force: true });
        console.log(`[build] entfernt: ${lang}/${entry.name}/ (keine Seite mehr)`);
      }
    }
  }

  const shows = list(content.sections?.shows?.items).length;
  const gal = list(content.sections?.gallery?.items).length;
  const missing = langs
    .slice(1)
    .map((l) => {
      const have = Object.keys(flattenI18n((content.i18n && content.i18n[l]) || {})).length;
      const total = collectStrings(content).length;
      return `${l}: ${have}/${total}`;
    })
    .join(", ");
  console.log(
    `[build] fertig — ${langs.length} Sprache(n) (${langs.join(", ")}), ` +
      `${pages.length} Seite(n) je Sprache, ${shows} Show(s), ${gal} Galeriebild(er)`
  );
  if (missing) console.log(`[build] Übersetzungen: ${missing}`);
}

// Nur bauen, wenn die Datei direkt aufgerufen wurde — beim Importieren aus
// einem Test soll nichts geschrieben werden.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[build] FEHLER:", err.message);
    process.exit(1);
  });
}
