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
import { istStripeAdresse, releaseZeitpunkt } from "./build.mjs";

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

/* Der Inhalt, mit dem gebaut wurde — der Stand NACH den Korrekturen, denn
   build.mjs schreibt ihn zurueck. Referenzen, Kanaele und Ware werden dagegen
   geprueft statt gegen eine Liste im Test: sonst schreibt der Test der
   Verwaltung vor, was dort stehen darf. */
const INHALT = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));
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

/* Die Referenzen stehen seit dem 11.08.2026 alle im selben kleinen Stil — es
   gibt keine grossen Karten und keinen "Rest" mehr.

   NEU am 12.08.2026: auf dem HANDY stehen zunaechst nur die obersten vier, der
   Rest klappt auf. Das ist keine Rueckkehr der zweiten Stufe — alle Eintraege
   sehen gleich aus, die Reihenfolge bleibt die der Verwaltung, und auf dem
   Desktop steht weiterhin alles da. `.venue-more` ist darum erlaubt; verboten
   bleibt, was zwei GROESSEN oder zwei GRUPPEN gemacht hat.

   Diese Stelle prueft deshalb dreierlei: die alten Bauteile sind weg, der
   Knopf gehoert zur schmalen Breite (auf dem Desktop display:none), und
   verborgen wird nur mit JavaScript — ohne `html.js` steht die ganze Liste da,
   sonst waeren Eintraege unerreichbar. */
{
  const css = await readFile(resolve(ROOT, "assets/site.css"), "utf8");
  for (const weg of [".venue-rest", ".venue-group", "--venue-lead-fit", ".venue-idx"])
    if (css.includes(weg)) meckern(`assets/site.css traegt wieder "${weg}" — die zweite Stufe ist zurueck`);
  if (!/\.venue-more\{display:none;\}/.test(css))
    meckern("assets/site.css zeigt den Referenz-Knopf auch auf dem Desktop");
  const handy = css.match(/@media\(max-width:700px\)\{[\s\S]*?\n\}/g) || [];
  if (!handy.some((b) => b.includes(".venue-more{display:inline-flex")))
    meckern("assets/site.css blendet den Referenz-Knopf auf dem Handy nicht ein");
  if (!/\.js \.venue-list:not\(\.offen\) > li\[data-extra\]\{display:none;\}/.test(css))
    meckern("assets/site.css verbirgt die weiteren Referenzen nicht (oder auch ohne JavaScript)");
  const js = await readFile(resolve(ROOT, "assets/site.js"), "utf8");
  if (js.includes("--venue-lead-fit"))
    meckern("assets/site.js rechnet wieder mit zwei Groessen fuer die Referenzen");
  if (!/refListe\.classList\.toggle\("offen"/.test(js))
    meckern("assets/site.js hat keinen Umschalter fuer die weiteren Referenzen");
}

/* Die Kundenwuensche vom 10.08.2026, gemessen an der fertigen Seite — nicht
   an den Daten. Was hier steht, hat der Kunde ausdruecklich verlangt; geht es
   verloren, faellt es sonst erst auf der Website auf. */
{
  const seite = async (rel) => {
    const p = resolve(ROOT, rel);
    return existsSync(p) ? await readFile(p, "utf8") : null;
  };
  const startseiten = ["index.html", "de/index.html", "fr/index.html"];

  const refImInhalt = (INHALT.sections?.references?.items || []).filter((r) => r && r.name);
  const kanaeleImInhalt = (INHALT.sections?.contact?.socials || []).filter((x) => x && x.label);

  for (const rel of startseiten) {
    const h = await seite(rel);
    if (!h) continue;

    /* 1) Die Jahreszahl im Hero MUSS da sein. Sie war am 10.08.2026 kurz
          stillgelegt; der Kunde hat das am selben Tag zurueckgenommen. Geprueft
          wird die Aufschrift in der Sprache der Route zusammen mit "2021" —
          eine leere Kennzahlen-Leiste faellt damit auf. */
    const kennzahl = { "index.html": "First set", "de/index.html": "Erstes Set", "fr/index.html": "Premier set" }[rel];
    const leiste = h.match(/<div class="hero-stats">[\s\S]*?<\/div>\s*<\/div>/);
    if (!leiste) meckern(`${rel}: keine Kennzahlen-Leiste im Hero`);
    else {
      if (!leiste[0].includes(kennzahl))
        meckern(`${rel}: Kennzahl "${kennzahl}" fehlt im Hero`);
      if (!leiste[0].includes(">2021<")) meckern(`${rel}: die Jahreszahl 2021 fehlt im Hero`);
    }
    /* Die Faktenzeile unten in "Ueber mich" ist dagegen GANZ weg — kein <dl>,
       keine Trennlinie, kein Platzhalter (Kundenwunsch 10.08.2026). Geprueft
       wird nur der About-Abschnitt: "BPM home base" steht auch als Kennzahl im
       Hero, und dort gehoert sie hin. */
    if (/<dl class="facts/.test(h)) meckern(`${rel}: Faktenzeile in "Ueber mich" steht wieder da`);
    const about = h.match(/<section[^>]*id="about"[\s\S]*?<\/section>/);
    if (about) {
      for (const wort of ["Clubs &amp; festivals", "Clubs &amp; Festivals", "BPM home base", "BPM Zuhause", "BPM de référence"])
        if (about[0].includes(wort)) meckern(`${rel}: Fakt "${wort}" steht wieder in "Ueber mich"`);
    }

    /* 3) Referenzen: eine Liste, genau die der Verwaltung, in ihrer
       Reihenfolge. Bis zum 11.08.2026 gab es oben vier grosse Karten und
       darunter, hinter der Zeile "Also played at", den kleinen Rest — eine
       zweite Rangfolge, die in der Verwaltung nicht zu sehen war. Jetzt zaehlt
       allein die Reihenfolge dort. */
    const refBlock = (h.match(/<section class="pad" id="references"[\s\S]*?<\/section>/) || [""])[0];
    const istRef = [...refBlock.matchAll(
      /<li[^>]*><a[^>]*><span class="venue-name">([^<]*)<\/span><span class="venue-city">([^<]*)</g
    )].map((m) => `${m[1]} — ${m[2]}`.trim().replace(/ —$/, ""));
    const sollRef = refImInhalt.map((r) => `${r.name} — ${r.city || ""}`.trim().replace(/ —$/, ""));
    if (istRef.join(" | ") !== sollRef.join(" | "))
      meckern(
        `${rel}: Referenzen weichen ab\n           Verwaltung: ${sollRef.join(" | ")}` +
          `\n           Seite:      ${istRef.join(" | ")}`
      );
    // Keine zweite Stufe mehr: keine grossen Karten, keine Zwischenzeile.
    if (/class="lead"/.test(refBlock)) meckern(`${rel}: es gibt wieder grosse Referenz-Karten`);
    for (const weg of ["venue-rest", "venue-group"])
      if (refBlock.includes(weg)) meckern(`${rel}: "${weg}" steht wieder in den Referenzen`);

    /* Die Handy-Stufe (12.08.2026): die obersten vier stehen offen da, alles
       weitere traegt data-extra, und der Knopf steht genau dann da, wenn es
       etwas aufzuklappen gibt. Die Reihenfolge ist oben schon geprueft — sie
       aendert sich dadurch nicht, es geht nur um sichtbar/verborgen. */
    const offen = [...refBlock.matchAll(/<li(?! data-extra)[^>]*><a/g)].length;
    const weitere = [...refBlock.matchAll(/<li data-extra="true">/g)].length;
    const hatKnopf = /class="venue-more btn"/.test(refBlock);
    if (istRef.length) {
      if (offen !== Math.min(4, istRef.length))
        meckern(`${rel}: ${offen} Referenzen stehen auf dem Handy offen, erwartet ${Math.min(4, istRef.length)}`);
      if (weitere !== Math.max(0, istRef.length - 4))
        meckern(`${rel}: ${weitere} Referenzen sind eingeklappt, erwartet ${Math.max(0, istRef.length - 4)}`);
      if (weitere && !hatKnopf) meckern(`${rel}: eingeklappte Referenzen ohne Knopf zum Aufklappen`);
      if (!weitere && hatKnopf) meckern(`${rel}: Knopf zum Aufklappen, obwohl nichts eingeklappt ist`);
      if (hatKnopf && !/aria-expanded="false"/.test(refBlock))
        meckern(`${rel}: der Knopf sagt Hilfsmitteln nicht, dass die Liste eingeklappt ist`);
    }
    const mehr = String(INHALT.sections?.references?.moreLabel || "").trim();
    if (mehr && refBlock.includes(mehr))
      meckern(`${rel}: die Zwischenzeile "${mehr}" steht wieder da`);
    // Und die Gegenprobe zur Ursache: der Eintrag der Verwaltung ist wirklich da.
    if (refImInhalt.some((r) => r.name === "IVY") && !/venue-name">IVY</.test(h))
      meckern(`${rel}: "IVY" steht in der Verwaltung, aber nicht auf der Seite`);

    /* 7) Die Kanaele stehen genau so auf der Seite, wie sie im Inhalt stehen —
       in derselben Reihenfolge, mit derselben Adresse. Hier stand bis zum
       11.08.2026 eine feste Liste von vier Kanaelen im Test; der Generator
       legte fehlende selbst an, damit sie erfuellt war. Genau daher kam der
       Unterschied: in der Verwaltung stand nur Mixcloud, auf der Seite vier.
       Verlinkt wird nur, wo eine Adresse hinterlegt ist — geraten wird nichts. */
    const fuss = h.match(/<div class="wrap foot-social">[\s\S]*?<\/ul>/);
    if (!fuss) meckern(`${rel}: kein Kanal-Block im Fuss`);
    else {
      // Der Name steht im letzten <span> der Zeile — davor steht das Zeichen.
      const istKanaele = [...fuss[0].matchAll(/<li[^>]*>[\s\S]*?<span>([^<]*)<\/span>/g)].map((m) => m[1]);
      const sollKanaele = kanaeleImInhalt.map((x) => String(x.label));
      if (istKanaele.join(" | ") !== sollKanaele.join(" | "))
        meckern(
          `${rel}: Kanaele weichen ab\n           Verwaltung: ${sollKanaele.join(" | ")}` +
            `\n           Seite:      ${istKanaele.join(" | ")}`
        );
      /* Kein geratener Link: jede Adresse auf der Seite muss im Inhalt stehen. */
      const erlaubt = new Set(kanaeleImInhalt.map((x) => String(x.url || "")).filter(Boolean));
      for (const treffer of fuss[0].match(/href="([^"]*)"/g) || []) {
        const url = treffer.slice(6, -1);
        if (!erlaubt.has(url))
          meckern(`${rel}: Kanal-Adresse im Fuss, die nicht im Inhalt steht: ${url}`);
      }
      for (const kanal of kanaeleImInhalt) {
        const name = String(kanal.label);
        const zeile = fuss[0].match(
          new RegExp(`<li[^>]*>(?:(?!</li>)[\\s\\S])*?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?</li>`)
        );
        if (!zeile) {
          meckern(`${rel}: Kanal "${name}" fehlt im Fuss`);
          continue;
        }
        const url = String(kanal.url || "");
        if (!url) {
          // Ohne Adresse bleibt der Kanal unverlinkt stehen statt ins Leere zu zeigen.
          if (/<a /.test(zeile[0])) meckern(`${rel}: "${name}" ist verlinkt, obwohl keine Adresse hinterlegt ist`);
          continue;
        }
        if (!zeile[0].includes(`href="${url}"`)) meckern(`${rel}: "${name}" zeigt nicht auf ${url}`);
        // Fremdes Fenster, aber ohne Zugriff auf dieses und ohne Referrer.
        if (!/rel="[^"]*noopener[^"]*"/.test(zeile[0]) || !/rel="[^"]*noreferrer[^"]*"/.test(zeile[0]))
          meckern(`${rel}: "${name}" ohne rel="noopener noreferrer"`);
        if (!/target="_blank"/.test(zeile[0])) meckern(`${rel}: "${name}" oeffnet nicht in neuem Fenster`);
      }
    }

    // 9) Kein Kanal-Zeichen im Kopf; Shows/Booking/Shop fuehren irgendwohin.
    const kopf = h.match(/<header[\s\S]*?<\/header>/);
    if (kopf && kopf[0].includes("<svg")) meckern(`${rel}: Zeichen im Kopf — dort gehoert keins hin`);
    if (kopf && !/href="[^"]*\/booking\/"/.test(kopf[0])) meckern(`${rel}: kein Weg zum Booking im Kopf`);
    if (kopf && !/href="[^"]*\/shop\/"/.test(kopf[0])) meckern(`${rel}: kein Weg zum Shop im Kopf`);
  }

  // 2) Shows stehen nur da, wenn ein Termin aussteht — sonst gar nicht.
  //    Eine Seite mit "keine Termine" ist schlechter als keine Section.
  for (const rel of startseiten) {
    const h = await seite(rel);
    if (!h) continue;
    const hatSection = h.includes('id="shows"');
    const hatLeermeldung = h.includes("empty-state");
    if (hatSection && hatLeermeldung)
      meckern(`${rel}: Shows-Section steht leer da — ohne Termin gehoert sie ganz weg`);
    if (!hatSection && /href="#shows"/.test(h))
      meckern(`${rel}: Menuepunkt Shows fuehrt ins Leere`);
  }

  // 2b) Der Satz unter den Referenzen ("Dein Club oder Festival als
  //     Naechstes? Schreib mir →") ist eine Anfrage und muss auf die
  //     Booking-Seite fuehren, nicht auf #contact. Geprueft wird die
  //     tatsaechlich gebaute Adresse samt Sprachpraefix und SITE_BASE — genau
  //     die Stelle, an der der Verweis schon einmal auf dem Anker stehen
  //     geblieben ist.
  for (const rel of startseiten) {
    const h = await seite(rel);
    if (!h) continue;
    const note = h.match(/<p class="live-note rv">[\s\S]*?<\/p>/);
    if (!note) continue;
    const ziel = note[0].match(/<a class="accent" href="([^"]*)"/);
    if (!ziel) {
      meckern(`${rel}: Referenzen-Satz ohne Verweis`);
      continue;
    }
    const erwartet = `${BASE}${rel === "index.html" ? "" : "/" + rel.split("/")[0]}/booking/#booking-form`;
    if (ziel[1] !== erwartet)
      meckern(`${rel}: Referenzen-Satz fuehrt auf "${ziel[1]}" statt auf "${erwartet}"`);
  }

  // 5)+6) Kein Rider als Anforderung, keine erfundene Bezahladresse.
  const booking = await seite("booking/index.html");
  if (booking) {
    for (const wort of ["Preferred Setup", "Preferred setup", "CDJ", "4× required"])
      if (booking.includes(wort)) meckern(`booking: "${wort}" steht wieder auf der Seite`);
  }
  const shop = await seite("shop/index.html");
  if (shop) {
    if (/qr-?code/i.test(shop)) meckern("shop: QR-Code auf der Seite, obwohl keiner hinterlegt ist");
    /* Stripe-Adressen: erlaubt ist genau, was am Artikel in der Verwaltung
       steht — ein Payment Link je Preis. Alles andere waere geraten. Frueher
       stand hier "gar keine Stripe-Adresse"; seit der Kunde Payment Links
       pflegt, gehoeren sie auf die Seite. */
    const erlaubteKassen = new Set(
      (INHALT.sections?.shop?.items || [])
        .map((p) => String(p?.paymentLink || "").trim())
        .filter(Boolean)
    );
    for (const m of shop.match(/https?:\/\/[^"'\s<]*stripe[^"'\s<]*/gi) || [])
      if (!erlaubteKassen.has(m))
        meckern(`shop: Stripe-Adresse im Quelltext, die so nicht hinterlegt ist: ${m}`);
  }

  /* Die Bilderwand: gleichmaessiges Raster, 6 Fotos zu Beginn, Videos als
     eigene Kachel mit Play-Zeichen. Die eigene Video-SEITE ist zurueckgenommen
     (11.08.2026) — es darf keine Datei und kein Verweis dorthin mehr geben. */
  {
    for (const rel of startseiten) {
      const h = await seite(rel);
      if (!h) continue;
      const gal = h.match(/<div class="gal rv" id="gal">[\s\S]*?\n      <\/div>/);
      if (!gal) {
        meckern(`${rel}: keine Bilderwand gefunden`);
        continue;
      }
      const kacheln = [...gal[0].matchAll(/<figure([^>]*)>/g)].map((m) => m[1]);
      const sofort = kacheln.filter((a) => !a.includes("data-extra")).length;
      if (sofort !== 6) meckern(`${rel}: Bilderwand zeigt zuerst ${sofort} Fotos statt 6`);
      const spaeter = kacheln.length - sofort;
      const knopf = h.match(/<button class="gal-more[^>]*data-more="([^"]*)"[^>]*data-less="([^"]*)"/);
      if (spaeter && !knopf) meckern(`${rel}: ${spaeter} weitere Fotos, aber kein Knopf dafuer`);
      if (knopf && !knopf[2].trim()) meckern(`${rel}: kein Text zum Wieder-Zuklappen`);

      // Videos in der Bilderwand: als Video erkennbar, nichts startet allein.
      for (const kachel of gal[0].match(/<figure class="gal-video[\s\S]*?<\/figure>/g) || []) {
        if (!/<span class="gal-play"/.test(kachel))
          meckern(`${rel}: Video-Kachel ohne Play-Zeichen — sieht aus wie ein Foto`);
        const v = kachel.match(/<video[^>]*>/);
        if (v && /autoplay/.test(v[0])) meckern(`${rel}: Video in der Bilderwand startet von allein`);
        if (v && !/playsinline/.test(v[0])) meckern(`${rel}: Video ohne playsinline (iOS)`);
      }
      const videosImGrid = (gal[0].match(/<video/g) || []).length;
      const videoKacheln = (gal[0].match(/<figure class="gal-video/g) || []).length;
      if (videosImGrid !== videoKacheln)
        meckern(`${rel}: ${videosImGrid} Videos, aber ${videoKacheln} Video-Kacheln`);
    }

    // Keine Spur der zurueckgenommenen Video-Seite.
    for (const [datei, h] of html) {
      if (/href="[^"]*\/videos\/"/.test(h)) meckern(`${datei}: Verweis auf die entfernte Seite /videos/`);
    }
    for (const d of dateien) {
      if (/(^|\/)videos\//.test(d)) meckern(`${d}: die Video-Seite ist noch gebaut`);
    }
    const sitemap = await seite("sitemap.xml");
    if (sitemap && /\/videos\//.test(sitemap)) meckern("sitemap.xml nennt noch /videos/");
  }

  /* Der Kopf ist auf JEDER Seite derselbe — gleiche Eintraege, gleiche
     Reihenfolge, gleiche Beschriftung. Vorher zeigte die Startseite ihre
     Abschnitte und der Shop nur "#shop"; die eigene Seite fehlte jeweils.
     Verglichen wird je Sprache, denn die Beschriftungen sind uebersetzt. */
  for (const [sprache, seitenSatz] of Object.entries({
    en: ["index.html", "booking/index.html", "shop/index.html"],
    de: ["de/index.html", "de/booking/index.html", "de/shop/index.html"],
    fr: ["fr/index.html", "fr/booking/index.html", "fr/shop/index.html"],
  })) {
    const koepfe = [];
    for (const rel of seitenSatz) {
      const h = await seite(rel);
      if (!h) continue;
      const kopf = h.match(/<header[\s\S]*?<\/header>/);
      if (!kopf) {
        meckern(`${rel}: kein Kopf`);
        continue;
      }
      /* Die Beschriftungen zaehlen, nicht die Adressen: auf der Startseite
         zeigen die Sprungmarken auf "#about", von einer Unterseite quer auf
         "/#about". Das ist derselbe Menuepunkt. `aria-current` steht nur am
         eigenen Eintrag und wird deshalb herausgerechnet. */
      const eintraege = [...kopf[0].matchAll(/<li([^>]*)><a [^>]*>([^<]*)<\/a><\/li>/g)].map(
        (m) => `${m[1].trim()}|${m[2].trim()}`
      );
      koepfe.push([rel, eintraege.join(" · ")]);
    }
    const [erste, ...rest] = koepfe;
    for (const [rel, liste] of rest) {
      if (liste !== erste[1])
        meckern(
          `${rel}: anderer Kopf als ${erste[0]}\n         dort: ${erste[1]}\n         hier: ${liste}`
        );
    }
    // Und die Sprungmarken der Startseite muessen von der Unterseite aus
    // wirklich dorthin zeigen.
    const unterseite = await seite(seitenSatz[2]);
    if (unterseite) {
      const kopf = unterseite.match(/<header[\s\S]*?<\/header>/)[0];
      const quer = [...kopf.matchAll(/href="([^"]*#[a-z]+)"/g)].map((m) => m[1]);
      for (const u of quer)
        if (u.startsWith("#"))
          meckern(`${seitenSatz[2]}: Sprungmarke "${u}" zeigt auf die eigene Seite statt auf die Startseite`);
    }
  }

  /* Kauf-Knoepfe im Shop: jeder fuehrt auf die Kasse SEINES Artikels.  /* Kauf-Knoepfe im Shop: jeder fuehrt auf die Kasse SEINES Artikels.

     Ein Stripe Payment Link gehoert zu genau einem Preis. Zeigte ein Knopf auf
     den Link eines anderen Artikels (oder auf einen globalen), waere der
     abgerechnete Betrag ein anderer als der angezeigte. */
  for (const rel of ["shop/index.html", "de/shop/index.html", "fr/shop/index.html"]) {
    const h = await seite(rel);
    if (!h) continue;
    const karten = [...h.matchAll(/<article class="prod[\s\S]*?<\/article>/g)].map((m) => m[0]);
    const links = [];
    for (const karte of karten) {
      const name = (karte.match(/<h3>([^<]*)<\/h3>/) || [])[1] || "(ohne Namen)";
      const kauf = karte.match(/<a class="btn sm buy-now"[^>]*href="([^"]*)"[^>]*>/);
      if (!kauf) continue;
      const url = kauf[1];
      if (!/^https:\/\/buy\.stripe\.com\//.test(url))
        meckern(`${rel}: Kauf-Knopf von "${name}" zeigt auf "${url}" — kein Stripe Payment Link`);
      if (!/target="_blank"/.test(kauf[0]) || !/noopener/.test(kauf[0]) || !/noreferrer/.test(kauf[0]))
        meckern(`${rel}: Kauf-Knopf von "${name}" ohne target=_blank / noopener noreferrer`);
      links.push([name, url]);
    }
    // Zwei Artikel duerfen nie dieselbe Kasse haben.
    const doppelt = links.filter(([, u], i) => links.findIndex(([, v]) => v === u) !== i);
    if (doppelt.length)
      meckern(`${rel}: mehrere Artikel teilen einen Payment Link: ${doppelt.map(([n]) => n).join(", ")}`);
  }

  /* Der Shop spricht auf jeder Route seine eigene Sprache.

     Anlass (Sichttest 10.08.2026): auf der englischen /shop/ stand "Merch von
     Sam Sparking" und "Kaufen", auf /fr/shop/ dasselbe Deutsch — in der
     Verwaltung war der Grundwert deutsch getippt, und Uebersetzungen gab es
     fuer den Shop gar keine. Geprueft wird nur der sichtbare Abschnitt: der
     Quelltext traegt Schema-Daten und Kommentare in anderen Sprachen, die
     niemand liest.

     Erkannt wird an Woertern, die es nur in einer Sprache gibt. Eigennamen
     ("Merch", "Shop", "Sam Sparking") taugen dafuer nicht. */
  const NUR_DEUTSCH = ["Zum Katalog", "Kleine Auflagen", "Versand", "Kaufen", "ist bald offen"];
  const NUR_FRANZOESISCH = ["Voir le catalogue", "Petites séries", "Expédition", "Acheter", "bientôt"];
  const NUR_ENGLISCH = ["Browse the drop", "Small runs", "Shipping", "opens soon"];
  const SPRACHPROBE = {
    "shop/index.html": { erlaubt: NUR_ENGLISCH, verboten: [...NUR_DEUTSCH, ...NUR_FRANZOESISCH] },
    "de/shop/index.html": { erlaubt: NUR_DEUTSCH, verboten: [...NUR_ENGLISCH, ...NUR_FRANZOESISCH] },
    "fr/shop/index.html": { erlaubt: NUR_FRANZOESISCH, verboten: [...NUR_ENGLISCH, ...NUR_DEUTSCH] },
  };
  for (const [rel, probe] of Object.entries(SPRACHPROBE)) {
    const h = await seite(rel);
    if (!h) continue;
    const abschnitt = h.match(/<section class="[^"]*shop-sec"[\s\S]*?<\/section>\s*<\/div>\s*<\/div>\s*<\/section>|<section class="[^"]*shop-sec"[\s\S]*/);
    if (!abschnitt) {
      meckern(`${rel}: kein Shop-Abschnitt auf der Seite`);
      continue;
    }
    const sichtbar = abschnitt[0].replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ");
    const fremd = probe.verboten.filter((w) => sichtbar.includes(w));
    if (fremd.length) meckern(`${rel}: fremdsprachiger Shop-Text: ${fremd.join(", ")}`);
    if (!probe.erlaubt.some((w) => sichtbar.includes(w)))
      meckern(`${rel}: kein Shop-Text in der Sprache der Route`);
  }

  /* Die Shop-Seite darf keine Bezahlung versprechen, die es nicht gibt.
     Anlass: auf der oeffentlichen Seite stand "via Stripe — card, Apple Pay,
     Google Pay or TWINT" und "Continue to payment", obwohl
     STRIPE_PAYMENT_LINK_URL nirgends hinterlegt war. Geprueft wird gegen
     denselben Schalter, mit dem gebaut wurde. */
  const zahlbar = istStripeAdresse(process.env.STRIPE_PAYMENT_LINK_URL);
  const htmlEsc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const wareImInhalt = (INHALT.sections?.shop?.items || [])
    .filter((p) => p && String(p.name || "").trim())
    .map((p) => htmlEsc(String(p.name).trim()));
  const ZAHLWORTE = ["Stripe", "TWINT", "Apple Pay", "Google Pay"];
  for (const rel of ["shop/index.html", "de/shop/index.html", "fr/shop/index.html"]) {
    const h = await seite(rel);
    if (!h) continue;
    // Kommentare zaehlen nicht — der Wartungshinweis darf Stripe nennen, er
    // steht nicht auf der Seite.
    const sichtbar = h.replace(/<!--[\s\S]*?-->/g, "");
    /* Im SICHTBAREN Text darf keine Bezahlart stehen — weder mit noch ohne
       hinterlegten Zahlungslink. Frueher war die Regel zweiseitig: ohne Link
       durfte nichts versprochen werden, mit Link musste etwas dastehen. Der
       Block "Bezahlen" ist weg; welche Karten und Wallets gelten, sagt Stripe
       auf seiner eigenen Seite, und nur dort ist es auch wahr.
       Adressen zaehlen nicht mit — "buy.stripe.com" im href ist keine Aussage
       an die Kundschaft. */
    const nurText = sichtbar.replace(/<[^>]*>/g, " ");
    const versprochen = ZAHLWORTE.filter((w) => nurText.includes(w));
    if (versprochen.length)
      meckern(`${rel}: nennt ${versprochen.join(", ")} im sichtbaren Text — das verspricht die Seite nicht mehr`);

    /* KEIN Bestellformular mehr, auf keiner Sprachfassung.

       Bis zum 12.08.2026 stand unter dem Katalog ein Block "Bezahlen" und
       darunter das Formular "Wohin darf es gehen?" mit acht Pflichtfeldern.
       Diese Stelle verlangte damals das Gegenteil: Ware ohne Formular war ein
       Fehler. Der Kunde hat den ganzen Teil abbestellt — Adresse und Zahlung
       nimmt Stripe in einem Schritt auf, das Formular fragte dasselbe ein
       zweites Mal ab und versprach ausserdem eine Bestaetigungsmail an die
       Kundschaft, die nie verschickt wurde. */
    const hatWare = /<article class="prod/.test(h);
    for (const weg of ['id="order-form"', 'class="oform', "/api/order", "#order-form", "pay-methods"])
      if (h.includes(weg)) meckern(`${rel}: "${weg}" ist zurueck — das Bestellformular ist abbestellt`);

    /* Jede Ware braucht trotzdem einen Weg zum Kauf: entweder die Bezahlseite
       dieses Artikels oder, wenn keine hinterlegt ist, die E-Mail-Adresse aus
       dem Kontakt. Ein Knopf, der nirgendwohin fuehrt, waere schlimmer als
       keiner — und genau das war der Rueckfall aufs Formular. */
    const karten = [...h.matchAll(/<article class="prod[\s\S]*?<\/article>/g)].map((m) => m[0]);
    for (const karte of karten) {
      const name = (karte.match(/<h3>([^<]*)<\/h3>/) || ["", "?"])[1];
      if (/class="mono sold-mark"/.test(karte)) continue; // ausverkauft: kein Weg noetig
      const kasse = /href="https:\/\/buy\.stripe\.com\/[^"]+"/.test(karte);
      const perMail = /href="mailto:[^"]+"/.test(karte);
      if (!kasse && !perMail) meckern(`${rel}: "${name}" hat keinen Weg zum Kauf`);
      if (kasse && !/target="_blank" rel="noopener noreferrer"/.test(karte))
        meckern(`${rel}: die Bezahlseite von "${name}" oeffnet ohne target/rel`);
    }
    // Und ohne Ware muss die Seite sagen, warum sie leer ist.
    if (!hatWare && !/class="empty-state/.test(h))
      meckern(`${rel}: leerer Shop ohne Hinweis, dass noch keine Ware da ist`);

    /* Der Leer-Text nur dann, wenn es wirklich nichts zu kaufen gibt.

       Anlass (Kundenmeldung 11.08.2026): auf /shop/ stand in allen drei
       Sprachen "The shop opens soon", obwohl ein Artikel veroeffentlicht war —
       eine Regel im Generator hatte ihn wegen seines Namens entfernt. Der
       Vergleich laeuft gegen den Inhalt, mit dem gebaut wurde: steht dort
       Ware, muss sie auf der Seite stehen, und umgekehrt. */
    if (wareImInhalt.length && !hatWare)
      meckern(
        `${rel}: Leer-Text, obwohl ${wareImInhalt.length} Artikel veroeffentlicht ` +
          `sind (${wareImInhalt.join(", ")})`
      );
    if (!wareImInhalt.length && hatWare)
      meckern(`${rel}: Ware auf der Seite, die im Inhalt nicht steht`);
    for (const name of wareImInhalt)
      if (!h.includes(`<h3>${name}</h3>`)) meckern(`${rel}: Artikel "${name}" fehlt auf der Seite`);
  }

  /* Hier stand die Regel fuer die Weiterleitung nach dem Bestellformular: erst
     weiterleiten, wenn die Antwort wirklich eine Stripe-Adresse enthaelt. Das
     Formular ist weg (12.08.2026), also darf im Browser auch nichts mehr
     weiterleiten. Geprueft wird jetzt das: kein Versand, keine Weiterleitung,
     keine Vorauswahl im Formular. */
  {
    const js = await readFile(resolve(ROOT, "assets/site.js"), "utf8");
    for (const weg of ["order-form", "order-jump", "paymentUrl", "/api/order"])
      if (js.includes(weg))
        meckern(`assets/site.js arbeitet wieder mit "${weg}" — das Bestellformular ist abbestellt`);
  }

  /* Der Vorhang vor dem Release (11.08.2026). Solange der Zeitpunkt in der
     Zukunft liegt, liegt er auf JEDER oeffentlichen Seite — sonst waere ueber
     eine Unteradresse schon vorher etwas erreichbar.

     Seit dem 12.08.2026, 18:00 gilt die andere Haelfte derselben Regel: ist der
     Zeitpunkt herum, darf auf keiner Seite noch ein Vorhang stehen. Frueher
     hing das allein am Schalter `release.enabled`; ein abgelaufener Release
     baute weiter einen Vorhang, den erst JavaScript im Browser wegnahm. */
  {
    const relZiel = (() => {
      const r = INHALT.release || {};
      if (r.enabled === false || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.date || ""))) return 0;
      return releaseZeitpunkt(r.date, r.time, r.zone || "Europe/Zurich");
    })();
    const ziel = relZiel > Date.now() ? 1 : 0;
    for (const [datei, h] of html) {
      if (datei === "coming-soon.html") continue;
      const hatVorhang = /<section class="release"/.test(h);
      const hatSkript = /vor-release/.test(h);
      if (ziel && !hatVorhang) meckern(`${datei}: kein Release-Vorhang`);
      if (ziel && !hatSkript) meckern(`${datei}: kein Skript, das den Vorhang vor dem Zeichnen setzt`);
      if (!ziel && hatVorhang)
        meckern(`${datei}: Release-Vorhang, obwohl abgeschaltet oder der Zeitpunkt herum ist`);
      if (!ziel && hatSkript)
        meckern(`${datei}: die Seite setzt noch die Klasse "vor-release" — der Release ist durch`);
      if (!ziel) continue;
      const zeit = h.match(/data-ziel="(\d+)"/);
      if (!zeit) meckern(`${datei}: kein Zielzeitpunkt am Vorhang`);
      else if (Number(zeit[1]) !== 1786550400000)
        meckern(`${datei}: Zielzeitpunkt ${zeit[1]} statt 12.08.2026 18:00 Europe/Zurich`);
      // Vier Felder: Tage, Stunden, Minuten, Sekunden.
      if ((h.match(/class="rl-zahl"/g) || []).length !== 4)
        meckern(`${datei}: der Zaehler hat nicht vier Felder`);
      // Und von dort geht es weiter zu Impressum und Datenschutz.
      if (!/class="rl-ways"/.test(h)) meckern(`${datei}: keine Wege aus dem Vorhang heraus`);
    }
  }

  /* Die Einwilligung: zwei gleichwertige Entscheidungen, ein Weg zurueck im
     Fuss, und kein Skript, das vor der Zustimmung laedt. */
  {
    for (const rel of [...startseiten, "shop/index.html", "booking/index.html"]) {
      const h = await seite(rel);
      if (!h) continue;
      const box = h.match(/<aside class="cookie"[\s\S]*?<\/aside>/);
      if (!box) {
        meckern(`${rel}: keine Einwilligungs-Abfrage`);
        continue;
      }
      const knoepfe = [...box[0].matchAll(/<button class="([^"]*)"[^>]*data-wahl="([^"]*)"/g)];
      if (knoepfe.length !== 2) meckern(`${rel}: ${knoepfe.length} Entscheidungen statt zwei`);
      const wahlen = knoepfe.map((k) => k[2]).sort().join("|");
      if (wahlen !== "alle|notwendig") meckern(`${rel}: die Entscheidungen heissen "${wahlen}"`);
      /* Gleichwertig heisst auch: gleich aussehen. Traegt einer der beiden
         Knoepfe eine Klasse, die der andere nicht hat, ist einer betont. */
      if (knoepfe.length === 2 && knoepfe[0][1] !== knoepfe[1][1])
        meckern(`${rel}: die Knoepfe sehen unterschiedlich aus: "${knoepfe[0][1]}" / "${knoepfe[1][1]}"`);
      // Von der Abfrage aus erreichbar: Impressum und Datenschutz.
      if (!/class="cookie-ways"/.test(box[0])) meckern(`${rel}: keine Wege aus der Abfrage heraus`);
      // Und im Fuss laesst sie sich wieder oeffnen.
      if (!/id="cookie-open"/.test(h)) meckern(`${rel}: kein Zugang "Cookie-Einstellungen" im Fuss`);
      /* Nichts Fremdes darf vor der Einwilligung laden. Geprueft wird der
         gebaute Quelltext: jedes <script src> zeigt auf die eigene Domain. */
      for (const m of h.matchAll(/<script[^>]*\ssrc="([^"]*)"/g)) {
        const url = m[1];
        if (/^https?:\/\//i.test(url)) meckern(`${rel}: laedt ein fremdes Skript: ${url}`);
      }
      for (const m of h.matchAll(/<(iframe|img)[^>]*\ssrc="(https?:\/\/[^"]*)"/g)) {
        // Bilder und Videos vom eigenen Speicher sind notwendig; Werbe- oder
        // Analyse-Einbettungen waeren es nicht.
        if (!/firebasestorage\.googleapis\.com/.test(m[2]))
          meckern(`${rel}: fremde Einbettung vor der Einwilligung: ${m[2]}`);
      }
    }
  }

  /* Der Fotograf ist GELOESCHT, nicht versteckt (11.08.2026). Geprueft wird
     beides: dass die Angabe im Inhalt gar nicht mehr vorkommt, und dass keine
     Seite sie zeigt — an der Galerie, im Fuss, am Booking-Bild oder in den
     strukturierten Daten. */
  {
    const inhaltRoh = JSON.stringify(INHALT);
    if (inhaltRoh.includes("photoCredit")) meckern("content/site.json traegt wieder photoCredit");
    if (inhaltRoh.includes('"credit"')) meckern("content/site.json traegt wieder ein credit-Feld");
    for (const [datei, h] of html) {
      if (/creditText/.test(h)) meckern(`${datei}: Fotocredit in den strukturierten Daten`);
      if (/photoCredit/.test(h)) meckern(`${datei}: photoCredit steht im Quelltext`);
      const gal = h.match(/<div class="gal"[\s\S]*?<\/div>\s*<\/div>/);
      if (gal && /<figcaption/.test(gal[0])) meckern(`${datei}: Beschriftung an den Galerie-Kacheln`);
    }
    /* Und die Bilderwand ist dabei vollzaehlig geblieben: 47 Eintraege, davon
       44 mit Adresse (drei sind leere Plaetze aus der Verwaltung). Geloescht
       wurde nur die Angabe zum Fotografen AM Eintrag, nie der Eintrag — und
       schon gar nicht eine Datei oder ihre Adresse. Dass in manchen Dateinamen
       historisch "sarto" steckt, aendert daran nichts: Adressen werden nicht
       angefasst. */
    /* 44 Medien, jedes mit Adresse. Bis zum 12.08.2026 standen hier 47
       Eintraege — drei davon waren leere Plaetze ohne Bild und ohne Adresse
       ("leerer Platz" in der Verwaltung). Die Datenbank speichert ein leeres
       Objekt nicht, deshalb sind sie beim Publizieren der Verwaltung von selbst
       weggefallen. Verloren ist dabei kein Medium: alle 44 Adressen sind
       unveraendert. */
    const medien = INHALT.sections?.gallery?.items || [];
    if (medien.length !== 44) meckern(`${medien.length} Galerie-Eintraege statt 44`);
    const ohneAdresse = medien.filter((i) => !i || !i.src).length;
    if (ohneAdresse) meckern(`${ohneAdresse} Galerie-Eintraege ohne Adresse`);
  }

  /* Die Telefonnummer ist von der Website genommen. Das Feld im
     Booking-Formular bleibt — dort traegt der Besucher SEINE Nummer ein. */
  {
    const nummer = String(INHALT.sections?.contact?.phone || "").trim();
    for (const [datei, h] of html) {
      if (nummer && h.includes(nummer)) meckern(`${datei}: die Telefonnummer steht wieder da`);
      if (/href="tel:/.test(h)) meckern(`${datei}: eine tel:-Adresse steht auf der Seite`);
      if (/"telephone"/.test(h)) meckern(`${datei}: Telefonnummer in den strukturierten Daten`);
    }
  }

  /* Der Shop im neuen Bild: helle Einladung, dunkler Katalog, Infostreifen.
     Alles Inhaltliche kommt aus der Verwaltung. */
  for (const rel of ["shop/index.html", "de/shop/index.html", "fr/shop/index.html"]) {
    const h = await seite(rel);
    if (!h) continue;
    const ware = (INHALT.sections?.shop?.items || []).filter((p) => p && p.name);
    if (!ware.length) continue;
    for (const [was, muster] of [
      ["Kicker", /class="mono shop-kicker"/],
      ["Ueberschrift", /class="shop-headline"/],
      ["Knopf zum Katalog", /class="btn solid big shop-cta"/],
      ["Katalog", /id="shop-katalog"/],
      ["Raster", /class="shop-grid/],
    ])
      if (!muster.test(h)) meckern(`${rel}: ${was} fehlt im Shop`);
    // Der Knopf muss wirklich zum Katalog fuehren.
    const cta = h.match(/class="btn solid big shop-cta" href="([^"]*)"/);
    if (cta && !cta[1].endsWith("#shop-katalog"))
      meckern(`${rel}: der Knopf zeigt auf "${cta[1]}" statt auf den Katalog`);
    // Der Informationsstreifen: hoechstens drei Punkte, alle mit Zeichen.
    const streifen = h.match(/<ul class="shop-info rv">[\s\S]*?<\/ul>/);
    const infoImInhalt = (INHALT.sections?.shop?.info || []).filter((i) => i && (i.title || i.text));
    if (infoImInhalt.length && !streifen) meckern(`${rel}: der Informationsstreifen fehlt`);
    if (streifen) {
      const punkte = (streifen[0].match(/<li>/g) || []).length;
      if (punkte !== Math.min(3, infoImInhalt.length))
        meckern(`${rel}: ${punkte} Punkte im Streifen statt ${Math.min(3, infoImInhalt.length)}`);
      if ((streifen[0].match(/<svg /g) || []).length !== punkte)
        meckern(`${rel}: nicht jeder Punkt hat ein Zeichen`);
      /* Keine unbelegten Versprechen. Stripe, TWINT und feste Lieferfristen
         gehoeren nicht in einen Text, den niemand einloesen kann. */
      const text = streifen[0].replace(/<[^>]+>/g, " ");
      for (const wort of ["Stripe", "TWINT", "Apple Pay", "Google Pay", "kostenlos", "free shipping", "24h", "48h"])
        if (text.includes(wort)) meckern(`${rel}: der Streifen verspricht "${wort}"`);
    }
    // Die alte Einleitungszeile darf ueber Ware nicht mehr stehen.
    if (/class="shop-note/.test(h)) meckern(`${rel}: die alte Einleitungszeile steht ueber der Ware`);
    if (/class="empty-state/.test(h)) meckern(`${rel}: der Leer-Block steht trotz Ware da`);
    // Jede Karte traegt, was die Verwaltung hergibt.
    for (const p of ware) {
      const karte = [...h.matchAll(/<article class="prod[\s\S]*?<\/article>/g)]
        .map((m) => m[0])
        .find((k) => k.includes(`<h3>${p.name}</h3>`));
      if (!karte) {
        meckern(`${rel}: der Artikel "${p.name}" fehlt`);
        continue;
      }
      if (p.badge && !karte.includes(`class="prod-badge">${p.badge}<`))
        meckern(`${rel}: das Abzeichen "${p.badge}" fehlt an "${p.name}"`);
      if (!p.badge && /class="prod-badge"/.test(karte))
        meckern(`${rel}: "${p.name}" traegt ein Abzeichen, das im Inhalt nicht steht`);
      if (p.price && !/class="price"/.test(karte)) meckern(`${rel}: kein Preis an "${p.name}"`);
    }
  }

  /* Das Impressum: eigene Seite je Sprache, im Fuss jeder Seite verlinkt, und
     bewusst knapp. Kundenwunsch vom 11.08.2026. */
  {
    const impressumSeiten = ["impressum/index.html", "de/impressum/index.html", "fr/impressum/index.html"];
    const email = String(INHALT.imprint?.email || INHALT.sections?.contact?.email || "");
    for (const rel of impressumSeiten) {
      const h = await seite(rel);
      if (!h) {
        meckern(`${rel}: die Seite wurde nicht gebaut`);
        continue;
      }
      if (!/<h1>Impressum<\/h1>/.test(h)) meckern(`${rel}: keine Ueberschrift "Impressum"`);
      if (email && !h.includes(`mailto:${email}`)) meckern(`${rel}: die E-Mail ${email} fehlt`);
      // Der Ort steht da — das Landeswort in der Sprache der Seite.
      if (!/Herisau/.test(h)) meckern(`${rel}: der Standort fehlt`);
      /* Bewusst knapp: keine Strassenadresse, keine Handelsregister- oder
         Mehrwertsteuernummer, keine erfundene Telefonnummer. Was nicht bekannt
         ist, steht nicht da. */
      for (const wort of ["Handelsregister", "CHE-", "MwSt", "UID", "Postfach", "strasse ", "Strasse "])
        if (h.includes(wort)) meckern(`${rel}: "${wort}" steht auf der Seite — nicht bekannt`);
      if (/\b\+41\s?\d/.test(h)) meckern(`${rel}: eine Telefonnummer steht im Impressum`);
      // Und die Sprachen zeigen aufeinander.
      for (const ziel of ["/impressum/", "/de/impressum/", "/fr/impressum/"])
        if (!h.includes(`href="${BASE}${ziel}"`)) meckern(`${rel}: kein Weg nach ${ziel}`);
    }
    // Sichtbarer Weg dorthin: im Fuss jeder gebauten Seite.
    for (const [datei, h] of html) {
      if (datei.startsWith("impressum/") || /\/impressum\//.test(datei)) continue;
      if (/rechtliches|mentions-legales|^legal\//.test(datei) || /\/(rechtliches|mentions-legales)\//.test(datei)) continue;
      if (datei === "404.html" || datei === "coming-soon.html") continue;
      const fuss = h.match(/<div class="wrap foot">[\s\S]*?<\/div>/);
      if (!fuss) continue;
      if (!/>Impressum</.test(fuss[0])) meckern(`${datei}: kein Impressum-Link im Fuss`);
    }
    // In der Sitemap steht es auch — anders als "Impressum & Datenschutz".
    const sitemap = await seite("sitemap.xml");
    if (sitemap)
      for (const ziel of ["/impressum/", "/de/impressum/", "/fr/impressum/"])
        if (!sitemap.includes(ziel)) meckern(`sitemap.xml: ${ziel} fehlt`);
  }

  // 8) Die Schreibweise — ausser im Hostname, der eine Adresse ist.
  for (const rel of [...startseiten, "booking/index.html", "shop/index.html"]) {
    const h = await seite(rel);
    if (!h) continue;
    const reste = h.replace(/djsamsparkling/gi, "").match(/sparkling/gi);
    if (reste) meckern(`${rel}: ${reste.length}x "Sparkling" ausserhalb des Hostnamens`);
  }

  // Kein deutscher Rueckfall auf der englischen und franzoesischen Seite.
  const deutsch = ["Wohin darf es gehen", "Weiter zur Bezahlung", "Bezahlt wird nach dem Absenden", "Anzahl", "Strasse und Nummer"];
  for (const rel of ["index.html", "shop/index.html", "fr/index.html", "fr/shop/index.html"]) {
    const h = await seite(rel);
    if (!h) continue;
    for (const w of deutsch)
      if (h.includes(w)) meckern(`${rel}: deutscher Text auf einer nicht-deutschen Seite: "${w}"`);
  }
}

if (fehler) {
  console.error(`\n${fehler} Fehler.`);
  process.exit(1);
}
console.log(
  `Wuensche: "First set 2021" weg, Club Eden statt IVY, Jugendopenair SG+Wattwil,\n` +
    `          vier Kanaele genannt und nur echte verlinkt, kein Zeichen im Kopf,\n` +
    `          kein Rider, keine erfundene Bezahladresse, Schreibweise "Sparking".\n` +
  `Wege: ${dateien.length} gebaute Seiten, alle Menuepunkte und Sprungmarken fuehren irgendwohin.\n` +
    `Formulare: senden nur an /api/booking und /api/order, jedes Feld Pflicht,\n` +
    `           Erfolgs- und Fehlermeldung vorhanden, keine Datenbank-Adresse im Quelltext.`
);
