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
import { istStripeAdresse } from "./build.mjs";

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

/* Die Rangfolge der Referenzen haengt allein an der Schriftgroesse: oben gross,
   darunter klein. Die erste Fassung setzte den Rest auf 1rem — das sind bei
   html{font-size:17px} genau 17px, also Fliesstextgroesse, und damit war
   "klein" nicht zu erkennen. So ein Fehler faellt in keinem HTML-Test auf,
   deshalb steht die Pruefung hier. */
{
  const css = await readFile(resolve(ROOT, "assets/site.css"), "utf8");
  const groesse = (selektor) => {
    const m = css.match(
      new RegExp(selektor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{[^}]*?font-size:([^;]+);")
    );
    if (!m) return null;
    // Aus clamp(a,b,c) den groessten rem-Wert nehmen — das ist die Obergrenze.
    const rems = [...m[1].matchAll(/([\d.]+)rem/g)].map((x) => Number(x[1]));
    return rems.length ? Math.max(...rems) : null;
  };
  const rest = groesse(".venue-more .venue-name");
  const oben = groesse(".venue-list .lead .venue-name");
  if (rest === null) meckern("Keine Schriftgroesse fuer .venue-more .venue-name gefunden");
  else if (rest >= 1)
    meckern(
      `Die Restliste steht auf ${rest}rem (= ${(rest * 17).toFixed(0)}px bei html:17px) — ` +
        "das ist Fliesstextgroesse und nicht die verlangte kleine Schrift."
    );
  if (oben !== null && rest !== null && oben <= rest)
    meckern("Die hervorgehobenen Eintraege sind nicht groesser als der Rest");
  if (rest !== null && oben !== null && !fehler) {
    console.log(
      `Referenzen: oben bis ${oben}rem (${(oben * 17).toFixed(0)}px), Rest bis ${rest}rem ` +
        `(${(rest * 17).toFixed(0)}px) — die Rangfolge ist auch an der Groesse zu sehen.`
    );
  }
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

    // 3) Referenzen: Club Eden statt IVY, Jugendopenair zweimal mit
    //    verschiedenen Orten, genau vier hervorgehobene Eintraege.
    if (h.includes(">IVY<")) meckern(`${rel}: "IVY" steht noch in den Referenzen`);
    for (const n of ["Club Eden", "Picante"])
      if (!h.includes(n)) meckern(`${rel}: "${n}" fehlt in den Referenzen`);
    const jugend = [...h.matchAll(/Jugendopenair<\/span><span class="venue-city">([^<]*)</g)].map(
      (m) => m[1]
    );
    if (new Set(jugend).size !== jugend.length)
      meckern(`${rel}: Jugendopenair steht doppelt am selben Ort`);
    const hervor = (h.match(/<li class="lead">/g) || []).length;
    if (hervor !== 4) meckern(`${rel}: ${hervor} hervorgehobene Referenzen statt 4`);

    // 7) Alle vier Kanaele werden genannt; verlinkt wird nur, wo eine echte
    //    Adresse hinterlegt ist. Ein geratener Link waere schlimmer als keiner.
    const fuss = h.match(/<div class="wrap foot-social">[\s\S]*?<\/ul>/);
    if (!fuss) meckern(`${rel}: kein Kanal-Block im Fuss`);
    else {
      for (const k of ["Instagram", "TikTok", "Spotify", "Mixcloud"])
        if (!fuss[0].includes(`>${k}</span>`)) meckern(`${rel}: Kanal "${k}" fehlt im Fuss`);
      /* Erlaubt sind genau die vier Kanaele des Kuenstlers. TikTok und Spotify
         hat der Kunde am 10.08.2026 nachgeliefert — bis dahin standen sie
         bewusst unverlinkt da. Geraten wird weiterhin nichts: jede andere
         Adresse faellt hier auf. */
      for (const url of fuss[0].match(/href="([^"]*)"/g) || []) {
        if (!/^href="https:\/\/((www\.)?(instagram|mixcloud|tiktok)\.com|open\.spotify\.com)\//.test(url))
          meckern(`${rel}: unerwartete Kanal-Adresse im Fuss: ${url}`);
      }
      const SOLL = {
        TikTok: "https://www.tiktok.com/@sam_sparking",
        Spotify: "https://open.spotify.com/artist/318V87QIgd2VmokY52zP6S",
      };
      for (const [k, adresse] of Object.entries(SOLL)) {
        const zeile = fuss[0].match(new RegExp(`<li[^>]*>(?:(?!</li>)[\\s\\S])*?${k}[\\s\\S]*?</li>`));
        if (!zeile) {
          meckern(`${rel}: Kanal "${k}" fehlt im Fuss`);
          continue;
        }
        if (!zeile[0].includes(`href="${adresse}"`))
          meckern(`${rel}: "${k}" zeigt nicht auf ${adresse}`);
        // Fremdes Fenster, aber ohne Zugriff auf dieses und ohne Referrer.
        if (!/rel="[^"]*noopener[^"]*"/.test(zeile[0]) || !/rel="[^"]*noreferrer[^"]*"/.test(zeile[0]))
          meckern(`${rel}: "${k}" ohne rel="noopener noreferrer"`);
        if (!/target="_blank"/.test(zeile[0])) meckern(`${rel}: "${k}" oeffnet nicht in neuem Fenster`);
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
    for (const m of shop.match(/https?:\/\/[^"'\s<]*stripe[^"'\s<]*/gi) || [])
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
    const karten = [...h.matchAll(/<article class="product[\s\S]*?<\/article>/g)].map((m) => m[0]);
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
  const NUR_DEUTSCH = ["jedes Teil", "Kaufen", "ist bald offen", "verpasst du", "Kanälen"];
  const NUR_FRANZOESISCH = ["chaque pièce", "Acheter", "bientôt", "ci-dessous"];
  const NUR_ENGLISCH = ["every piece", "opens soon", "the works", "so you don't miss"];
  const SPRACHPROBE = {
    "shop/index.html": { erlaubt: NUR_ENGLISCH, verboten: [...NUR_DEUTSCH, ...NUR_FRANZOESISCH] },
    "de/shop/index.html": { erlaubt: NUR_DEUTSCH, verboten: [...NUR_ENGLISCH, ...NUR_FRANZOESISCH] },
    "fr/shop/index.html": { erlaubt: NUR_FRANZOESISCH, verboten: [...NUR_ENGLISCH, ...NUR_DEUTSCH] },
  };
  for (const [rel, probe] of Object.entries(SPRACHPROBE)) {
    const h = await seite(rel);
    if (!h) continue;
    const abschnitt = h.match(/<section class="pad shop-sec"[\s\S]*?<\/section>/);
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
  /* Was laut Inhalt im Shop steht — dagegen wird die gebaute Seite geprueft.
     Der Inhalt ist der Stand NACH den Korrekturen: build.mjs schreibt ihn
     zurueck, also steht hier genau die Ware, die die Seite zeigen muss. */
  const inhalt = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));
  const htmlEsc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const wareImInhalt = (inhalt.sections?.shop?.items || [])
    .filter((p) => p && String(p.name || "").trim())
    .map((p) => htmlEsc(String(p.name).trim()));
  const ZAHLWORTE = ["Stripe", "TWINT", "Apple Pay", "Google Pay"];
  for (const rel of ["shop/index.html", "de/shop/index.html", "fr/shop/index.html"]) {
    const h = await seite(rel);
    if (!h) continue;
    // Kommentare zaehlen nicht — der Wartungshinweis darf Stripe nennen, er
    // steht nicht auf der Seite.
    const sichtbar = h.replace(/<!--[\s\S]*?-->/g, "");
    const versprochen = ZAHLWORTE.filter((w) => sichtbar.includes(w));
    if (!zahlbar && versprochen.length)
      meckern(
        `${rel}: verspricht ${versprochen.join(", ")}, obwohl kein Zahlungslink hinterlegt ist`
      );
    if (zahlbar && !versprochen.length)
      meckern(`${rel}: Zahlungslink hinterlegt, aber die Seite sagt nichts zur Bezahlung`);

    // Der Knopf darf nur weiterfuehren, wenn es auch weitergeht.
    const knopf = sichtbar.match(/<button class="btn solid big" type="submit">([^<]*)</);
    const weiter = /Bezahlung|payment|paiement/i.test(knopf ? knopf[1] : "");
    if (!zahlbar && weiter)
      meckern(`${rel}: Knopf "${knopf[1].trim()}" kuendigt eine Bezahlung an, die es nicht gibt`);

    /* Bestellformular: genau dann, wenn es auch etwas zu bestellen gibt.
       Seit der Produktentscheidung vom 10.08.2026 steht keine Ware im Shop —
       Ein Formular ohne Ware waere eine Bestellung ins Leere; steht Ware da,
       muss das Formular her. Erkannt wird die Ware am Kachel-Bauteil, nicht
       am Inhalt. */
    const hatWare = /<article class="product/.test(h);
    const hatFormular = /id="order-form"/.test(h);
    if (hatWare && !hatFormular) meckern(`${rel}: Ware ohne Bestellformular`);
    if (!hatWare && hatFormular)
      meckern(`${rel}: Bestellformular ohne Ware — bestellen liesse sich nichts`);
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

  /* Die Weiterleitung im Browser: sie darf erst kommen, wenn die Antwort des
     Endpunkts wirklich eine Stripe-Adresse enthaelt. Ein blosses "ist da"
     genuegt nicht — sonst schickt eine falsche Antwort die Kundschaft
     irgendwohin. */
  {
    const js = await readFile(resolve(ROOT, "assets/site.js"), "utf8");
    if (/if\s*\(\s*out\s*&&\s*out\.paymentUrl\s*\)/.test(js))
      meckern("site.js leitet allein auf Verdacht weiter — die Adresse wird nicht geprueft");
    if (!/istStripeAdresse\(\s*out\.paymentUrl\s*\)/.test(js))
      meckern("site.js prueft die Bezahladresse nicht, bevor es weiterleitet");
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
