/**
 * Prüft, dass adoptTexts() keine Texte über ungleich lange Listen schmiert.
 *
 * Hintergrund: adoptTexts übernimmt die Texte der Vorlage Feld für Feld über
 * den Pfad. In Listen zählt dabei nur die Position. Stehen in der Vorlage mehr
 * Einträge als im Live-Inhalt, gehört Position 2 der Vorlage nicht zu Position
 * 2 des Live-Inhalts — und "Luzern" landet bei "Sektor 11".
 *
 * Aufruf:  node scripts/build.test.mjs
 */

import { readFile } from "node:fs/promises";
import * as nodeFs from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adoptTexts,
  gespielteShows,
  releaseZeitpunkt,
  showVorbei,
  collectStrings,
  istPaymentLink,
  istStripeAdresse,
  localize,
  nachziehen,
  priceTag,
  zahlungBereit,
} from "./build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const template = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));

/* Der Stand, wie ihn die Verwaltung liefert: kürzere Listen als die Vorlage.
   Die Vorlage führt sieben Referenzen — hier stehen sechs, damit die Sperre
   gegen ungleich lange Listen überhaupt geprüft wird. */
const live = JSON.parse(JSON.stringify(template));
live.site.lang = "de"; // weicht von der Vorlage ab -> adoptTexts greift
live.sections.references.items = [
  { city: "St. Gallen", name: "Kugl" },
  { city: "Zurich", name: "Sektor 11" },
  { city: "Schaan, FL", name: "The Q" },
  { city: "St. Gallen", name: "IVY" },
  { city: "Gossau", name: "BBC" },
  { city: "St. Gallen", name: "B9" },
];
live.sections.contact.socials = [
  { label: "Mixcloud", url: "https://www.mixcloud.com/samsparking/" },
];
live.sections.booking.available = ["Clubs & Venues", "Festivals", "Switzerland & Europe"];

adoptTexts(live, template);

const ORTE = {
  Kugl: "St. Gallen",
  "Sektor 11": "Zurich",
  "The Q": "Schaan, FL",
  IVY: "St. Gallen",
  BBC: "Gossau",
  B9: "St. Gallen",
};

/**
 * Alle gebauten Seiten, die den Shows-Abschnitt tragen — je Sprache eine.
 * Gesucht statt behauptet: ob die Shows auf der Startseite stehen oder auf
 * einer eigenen Seite (/shows/), entscheidet der Kunde in der Verwaltung.
 */
function seitenMitShows() {
  const { readdirSync, readFileSync, existsSync, statSync } = nodeFs;
  const ueberspringen = new Set([
    "node_modules", "scripts", "content", "media", "img", "assets", "presskit", "netlify",
  ]);
  const gefunden = [];
  const suche = (rel, tiefe) => {
    const abs = rel ? resolve(ROOT, rel) : ROOT;
    const datei = resolve(abs, "index.html");
    if (existsSync(datei) && statSync(datei).isFile()) {
      const html = readFileSync(datei, "utf8");
      if (html.includes('id="shows"')) gefunden.push([rel ? `${rel}/index.html` : "index.html", html]);
    }
    if (tiefe <= 0) return;
    for (const eintrag of readdirSync(abs, { withFileTypes: true })) {
      if (!eintrag.isDirectory()) continue;
      if (ueberspringen.has(eintrag.name) || eintrag.name.startsWith(".")) continue;
      suche(rel ? `${rel}/${eintrag.name}` : eintrag.name, tiefe - 1);
    }
  };
  suche("", 2);
  return gefunden;
}

let fehler = 0;
const meckern = (text) => {
  fehler++;
  console.error("  FEHLER: " + text);
};

if (live.sections.references.items.length !== 6) {
  meckern(`Referenzliste hat neu ${live.sections.references.items.length} statt 6 Einträge`);
}
for (const r of live.sections.references.items) {
  if (ORTE[r.name] !== r.city) {
    meckern(`${r.name} steht neu in "${r.city}" statt in "${ORTE[r.name]}"`);
  }
}

const kanaele = live.sections.contact.socials;
if (kanaele.length !== 1 || kanaele[0].label !== "Mixcloud") {
  meckern("Kanal verändert: " + JSON.stringify(kanaele));
}
if (kanaele[0] && kanaele[0].url !== "https://www.mixcloud.com/samsparking/") {
  meckern("Kanal-Adresse verändert: " + kanaele[0].url);
}

if (live.sections.booking.available.join("|") !== "Clubs & Venues|Festivals|Switzerland & Europe") {
  meckern('"Verfügbar für" verändert: ' + JSON.stringify(live.sections.booking.available));
}

/* Gegenprobe: bei gleich langen Listen soll weiterhin übernommen werden —
   dafür ist adoptTexts schliesslich da (alte englische Werkstexte ablösen). */
const live2 = JSON.parse(JSON.stringify(template));
live2.site.lang = "de";
/* Geprueft an den Absaetzen von "Ueber mich": Referenz-Orte taugen dafuer seit
   dem 11.08.2026 nicht mehr — Clubs und Orte werden gar nicht mehr uebersetzt
   (NO_TRANSLATE_PATH), weil die Tabelle sonst am Platz in der Liste haengt. */
live2.sections.about.paragraphs = template.sections.about.paragraphs.map(() => "ALT");
adoptTexts(live2, template);
if (live2.sections.about.paragraphs[0] !== template.sections.about.paragraphs[0]) {
  meckern("Bei gleich langen Listen wird nicht mehr übernommen — adoptTexts ist wirkungslos");
}

/* --------------------------------------------------------------------------
   Kanal-Namen sind Eigennamen und werden nie übersetzt.

   Vorher trug die Übersetzungstabelle "sections.contact.socials.0.label" —
   die zeigt über die Position auf den Kanal. Nachdem in der Verwaltung
   Instagram und Spotify gelöscht worden waren, rutschte "Instagram" auf
   Position 0 und der Mixcloud-Link hiess auf /de/ und /fr/ "Instagram".
   -------------------------------------------------------------------------- */

if (collectStrings(template).some(([pfad]) => /^sections\.contact\.socials\./.test(pfad))) {
  meckern("Kanal-Namen werden zum Übersetzen angeboten — sie sind Eigennamen");
}

/* Ein alter Stand aus der Datenbank: Übersetzungen für Kanäle, die es nicht
   mehr gibt. Die dürfen keinen Kanal umbenennen. */
const altbestand = JSON.parse(JSON.stringify(template));
altbestand.site.lang = "en";
altbestand.sections.contact.socials = [
  { label: "Instagram", url: "https://www.instagram.com/sam_sparking/" },
  { label: "Mixcloud", url: "https://www.mixcloud.com/samsparking/" },
];
altbestand.i18n = altbestand.i18n || {};
altbestand.i18n.de = altbestand.i18n.de || {};
altbestand.i18n.de.sections = altbestand.i18n.de.sections || {};
altbestand.i18n.de.sections.contact = altbestand.i18n.de.sections.contact || {};
altbestand.i18n.de.sections.contact.socials = {
  0: { label: "Spotify" },
  1: { label: "Instagram" },
};

const uebersetzt = localize(altbestand, "de").sections.contact.socials;
for (const [i, erwartet] of ["Instagram", "Mixcloud"].entries()) {
  if (uebersetzt[i].label !== erwartet) {
    meckern(`Kanal ${i} heisst auf /de/ neu "${uebersetzt[i].label}" statt "${erwartet}"`);
  }
}
if (uebersetzt[0].url !== "https://www.instagram.com/sam_sparking/") {
  meckern("Instagram-Adresse verändert: " + uebersetzt[0].url);
}

/* ------------------------------------------------------------------------
   nachziehen(): korrigiert den Stand aus der Verwaltung.

   Zwei Arten von Regeln — die Schreibweise immer, alles andere nur solange
   die Stelle unangetastet ist. Genau daran ist die fruehere Fassung mit einer
   Nummer gescheitert: die Verwaltung uebernahm die Nummer aus den Defaults
   und schrieb sie mit dem UNkorrigierten Stand in die Datenbank; danach hielt
   der Build sie fuer aktuell und "Sam Sparkling" kam zurueck.
   ------------------------------------------------------------------------ */
const korr = JSON.parse(await readFile(resolve(ROOT, "content/korrekturen.json"), "utf8"));

{
  // Der Stand, wie er nach jenem Speichern in der Datenbank stand
  const db = JSON.parse(JSON.stringify(template));
  /* Die Marken weg: die Vorlage traegt sie inzwischen, weil die Verwaltung den
     Nachtrag selbst gespeichert hat. Geprueft wird hier aber der Zustand DAVOR
     — ein Stand, in dem noch etwas fehlt. */
  delete db.migrationen;
  db.contentRevision = 4;                       // Altlast, darf nichts mehr bewirken
  db.site.artist = "Sam Sparkling";
  db.site.logoText = "Sam Sparkling";
  db.hero.nameMain = "Sparkling";
  db.site.domain = "https://djsamsparkling.netlify.app";
  db.sections.about.paragraphs = ["Der Name **Sparkling** ist kein Zufall."];
  db.sections.references.items = [
    { name: "Kugl", city: "St. Gallen", highlight: true },
    { name: "IVY", city: "St. Gallen" },
  ];
  db.sections.contact.socials = [{ label: "Mixcloud", url: "https://www.mixcloud.com/samsparking/" }];
  db.sections.shop.enabled = true;
  db.hero.stats = [];
  db.sections.booking.photo = { src: "", alt: "", credit: "" };

  const getan = nachziehen(db, korr);
  const alsText = JSON.stringify(db);
  const hosts = (alsText.match(/djsamsparkling/gi) || []).length;
  const reste = (alsText.match(/[Ss]parkling/g) || []).length - hosts;

  if (reste !== 0) meckern(`${reste}x "Sparkling" nach dem Nachziehen uebrig`);
  if (!hosts) meckern("Hostname djsamsparkling mitkorrigiert — Canonical und Sitemap zeigen ins Leere");
  if (db.site.artist !== "Sam Sparking") meckern("Kuenstlername nicht korrigiert: " + db.site.artist);
  /* Referenzen und Kanaele bleiben unangetastet — die Verwaltung entscheidet.
     Bis zum 11.08.2026 stand hier das Gegenteil: die Referenzliste MUSSTE
     ersetzt werden und Instagram MUSSTE dazukommen. Genau daher fehlte
     "IVY — St. Gallen" auf der Website und die Verwaltung zeigte nur Mixcloud,
     wo die Seite vier Kanaele fuehrte. */
  /* Ergaenzt, nie ersetzt (11.08.2026): die bestehenden Eintraege stehen
     unveraendert vorne, Fehlendes kommt dahinter. Damit ist die Website nach
     einem Build vollstaendig, ohne dass jemand die Verwaltung oeffnen muss. */
  const refNamen = db.sections.references.items.map((r) => r.name);
  if (!refNamen.includes("Kugl") || !refNamen.includes("IVY"))
    meckern("bestehende Referenz verschwunden: " + refNamen.join(", "));
  if (!refNamen.includes("Maiaiaiparty")) meckern("fehlende Referenz nicht ergaenzt");
  const doppelt = refNamen.filter((x, i) => refNamen.indexOf(x) !== i);
  if (doppelt.length) meckern("Referenz doppelt: " + [...new Set(doppelt)].join(", "));
  const kugl = db.sections.references.items.find((r) => r.name === "Kugl");
  if (kugl.highlight !== true) meckern('"Gross zeigen" am bestehenden Eintrag verloren');
  const nachgetragen = db.sections.references.items.filter((r) => r.name === "Maiaiaiparty");
  if (nachgetragen.some((r) => r.highlight)) meckern("ein nachgetragener Eintrag ist gross");
  const kanalNamen = db.sections.contact.socials.map((x) => x.label);
  if (kanalNamen[1] !== "Mixcloud" && !kanalNamen.includes("Mixcloud"))
    meckern("bestehender Kanal verschwunden: " + kanalNamen.join(", "));
  for (const soll of ["Instagram", "Mixcloud", "TikTok", "Spotify"])
    if (!kanalNamen.includes(soll)) meckern(`Kanal "${soll}" nicht ergaenzt`);
  const mix = db.sections.contact.socials.find((x) => x.label === "Mixcloud");
  if (mix.url !== "https://www.mixcloud.com/samsparking/")
    meckern("die Adresse des bestehenden Kanals wurde veraendert: " + mix.url);
  if (!db.hero.stats.length) meckern("Kennzahlen fehlen");
  if (!db.sections.booking.photo.src) meckern("Booking-Bild fehlt");
  if (db.sections.shop.enabled !== true)
    meckern("Der Shop-Schalter aus der Verwaltung wurde ueberschrieben");
  if (!getan.includes("Schreibweise")) meckern("Schreibweise nicht als Aenderung gemeldet");
}

{
  // Der Kunde hat die Referenzen selbst bearbeitet — dann nichts anfassen.
  const eigen = JSON.parse(JSON.stringify(template));
  delete eigen.migrationen;
  eigen.sections.references.items = [{ name: "Nur ein Club", city: "Chur" }];
  eigen.sections.contact.socials = [{ label: "Instagram", url: "https://instagram.com/anders" }];
  eigen.hero.stats = [{ value: "9", label: "Eigene Zahl" }];
  eigen.sections.booking.photo = { src: "eigenes.jpg", alt: "", credit: "" };

  nachziehen(eigen, korr);
  /* Der eigene Eintrag bleibt, unveraendert. Vor ihm stehen die vier, die
     frueher gross waren (einmalige Umordnung, siehe oben) — sein Inhalt und
     seine Ordnung zu den anderen eigenen Eintraegen bleiben. */
  const eigenerRef = eigen.sections.references.items.find((r) => r.name === "Nur ein Club");
  if (!eigenerRef) meckern("Eigene Referenz verschwunden");
  else if (eigenerRef.city !== "Chur") meckern("Eigene Referenz veraendert: " + JSON.stringify(eigenerRef));
  /* Kein Kanal kommt dazu und keiner verschwindet. Bis zum 11.08.2026 legte
     der Generator hier fehlende Kanaele an und trug Adressen nach — deshalb
     stand auf der Website etwas anderes als in der Verwaltung. Nachgetragen
     wird jetzt in der Verwaltung selbst, wo es bearbeitbar ist und
     mitgespeichert wird. */
  const eigeneKanaele = eigen.sections.contact.socials;
  // Ergaenzt wird, was fehlt — der eigene Instagram-Eintrag bleibt aber einmalig
  // und behaelt seine Adresse.
  const insta2 = eigeneKanaele.filter((x) => /instagram/i.test(x.label + " " + (x.url || "")));
  if (insta2.length !== 1) meckern("Instagram doppelt: " + JSON.stringify(insta2));
  if (insta2[0].url !== "https://instagram.com/anders")
    meckern("eigene Kanal-Adresse ueberschrieben: " + insta2[0].url);
  if (eigen.hero.stats[0].value !== "9") meckern("Eigene Kennzahlen ueberschrieben");
  if (eigen.sections.booking.photo.src !== "eigenes.jpg") meckern("Eigenes Booking-Bild ueberschrieben");
}

{
  /* Die Korrekturen vom August 2026: Kennzahl-Aufschrift, Ort der Show,
     Instagram aus dem Kopf, Waehrung und die neue Seitenaufteilung. Alle
     greifen nur, solange die Stelle in der Verwaltung unangetastet ist. */
  const db = JSON.parse(JSON.stringify(template));
  delete db.migrationen;
  db.hero.stats = korr.alteHeroStats.map((label) => ({ value: "1", label }));
  db.hero.meta = "Euphoric Hardstyle / Melodic Hardstyle";
  db.sections.shows.items = [{ name: "Aftersun ", city: "Herisau", date: "2026-08-29" }];
  db.sections.contact.socials = [
    { label: "Instagram", url: "https://www.instagram.com/sam_sparking/" },
    { label: "Mixcloud", url: "https://www.mixcloud.com/samsparking/" },
  ];
  db.sections.shop.currency = "CHF 5";
  db.sections.shop.items = [{ name: "Beispiel", note: "as", alt: "as", linkUrl: "asd", price: "35" }];
  db.pages = [{ slug: "", navLabel: "Home", sections: ["about", "booking", "shop"] }];

  nachziehen(db, korr);

  if (db.hero.stats[1].label !== "Shows")
    meckern('Kennzahl heisst weiter "' + db.hero.stats[1].label + '" statt "Shows"');
  if (db.hero.stats[1].value !== String(gespielteShows(db)))
    meckern(
      `Kennzahl Shows steht auf ${db.hero.stats[1].value} statt ${gespielteShows(db)} ` +
        "(gezaehlt wird NACH allen Regeln, die Listen ergaenzen)"
    );
  if (db.hero.meta) meckern("Genre-Zeile im Hero nicht geraeumt");
  if (db.sections.shows.items[0].city !== "Luzern")
    meckern("Aftersun steht weiter in " + db.sections.shows.items[0].city);
  if (db.sections.shows.items[0].name !== "Aftersun") meckern("Leerzeichen im Show-Namen geblieben");
  /* Der Schalter "Zeichen oben im Kopfbereich zeigen" gehoert der Verwaltung.
     Bis zum 11.08.2026 setzte hier eine Regel `inHeader:false` fuer Instagram,
     wo nichts gesetzt war — jetzt bleibt der Wert, wie er ist. */
  const insta = db.sections.contact.socials.find((x) => /instagram/i.test(x.label));
  if ("inHeader" in insta) meckern("Der Kopf-Schalter wurde von aussen gesetzt: " + insta.inHeader);
  /* Die beiden vorhandenen Kanaele bleiben mit ihrer Adresse; die fehlenden
     zwei kommen dazu, damit die Website vollstaendig ist. */
  const kanal = (name) => db.sections.contact.socials.find((x) => x.label === name);
  if (kanal("Instagram")?.url !== "https://www.instagram.com/sam_sparking/")
    meckern("Instagram-Adresse veraendert: " + kanal("Instagram")?.url);
  if (kanal("Mixcloud")?.url !== "https://www.mixcloud.com/samsparking/")
    meckern("Mixcloud-Adresse veraendert: " + kanal("Mixcloud")?.url);
  for (const soll of ["TikTok", "Spotify"]) if (!kanal(soll)) meckern(`Kanal "${soll}" nicht ergaenzt`);
  const labels = db.sections.contact.socials.map((x) => x.label);
  if (new Set(labels).size !== labels.length) meckern("Kanal doppelt: " + labels.join(", "));
  /* Der Shop geht seit dem 11.08.2026 vollstaendig unangetastet durch — es
     gibt hier keine Shop-Regel mehr. Vorher standen drei davon genau dort, wo
     der Kunde arbeitet: eine ersetzte die Waehrung, eine schrieb die Texte,
     eine holte den Artikel "Beispiel" zurueck, sobald die Liste leer war.
     Zusammen ergaben sie die Meldung "nach Publizieren werden im Shop nicht
     alle Aenderungen aktualisiert". */
  const shopVorher = JSON.stringify({
    currency: "CHF 5",
    items: [{ name: "Beispiel", note: "as", alt: "as", linkUrl: "asd", price: "35" }],
    enabled: true,
  });
  const shopNachher = JSON.stringify({
    currency: db.sections.shop.currency,
    items: db.sections.shop.items,
    enabled: db.sections.shop.enabled,
  });
  if (shopVorher !== shopNachher) meckern("Der Shop wurde angefasst: " + shopNachher);
  // Und die Texte bleiben auch: was in der Verwaltung steht, steht auf der Seite.
  if (db.i18n?.de?.sections?.shop?.note !== template.i18n?.de?.sections?.shop?.note)
    meckern("Shop-Text in de veraendert: " + db.i18n?.de?.sections?.shop?.note);

  /* Drei Seiten: Startseite, Booking, Shop. Die Video-Seite vom 10.08.2026 ist
     am 11.08.2026 wieder zurueckgenommen — Videos stehen als Kacheln in der
     Galerie, eine eigene Route dafuer gibt es nicht mehr. */
  const sollSeiten = korr.seiten.map((p) => p.slug);
  if (db.pages.map((p) => p.slug).join("|") !== sollSeiten.join("|"))
    meckern("Seitenadressen stimmen nicht: " + db.pages.map((p) => p.slug).join(", "));
  if (db.pages[0].sections.includes("booking"))
    meckern("Booking steht weiter als Abschnitt auf der Startseite");
}

{
  /* Gegenprobe: der Generator fasst die Warenliste ueberhaupt nicht mehr an,
     und ein selbst geschriebener Text behaelt das letzte Wort. */
  const db = JSON.parse(JSON.stringify(template));
  db.sections.shop.items = [
    { name: "Beispiel", price: "35" },
    { name: "Hoodie Euphoric", price: "79", src: "img/hoodie.jpg" },
  ];
  db.sections.shop.note = "Our own line, hand-printed in St. Gallen.";
  nachziehen(db, korr);

  const namen = db.sections.shop.items.map((p) => p.name);
  if (!namen.includes("Beispiel"))
    meckern('"Beispiel" wurde entfernt — der Name ist kein Grund, Ware zu verstecken');
  if (!namen.includes("Hoodie Euphoric"))
    meckern("echte Ware verschwunden — uebrig: " + (namen.join(", ") || "nichts"));
  if (namen.length !== 2) meckern("Warenliste veraendert: " + namen.join(", "));
  if (db.sections.shop.note !== "Our own line, hand-printed in St. Gallen.")
    meckern("eigener Shop-Text ueberschrieben: " + db.sections.shop.note);
  // Die Rueckhol-Regel darf sich nicht einmischen, solange Ware dasteht.
  if (namen.filter((x) => x === "Beispiel").length !== 1)
    meckern('"Beispiel" doppelt eingesetzt: ' + namen.join(", "));
}

{
  /* Ein leerer Shop bleibt leer.

     Bis zum 11.08.2026 holte hier eine Regel den Artikel "Beispiel" zurueck,
     sobald die Warenliste leer war. Gut gemeint — aber damit liess sich der
     letzte Artikel nie loeschen: nach dem Publizieren stand er wieder da. Die
     Regel ist weg. Wer alles loescht, hat einen leeren Shop, und der Leer-Text
     erscheint zu Recht. */
  const db = JSON.parse(JSON.stringify(template));
  db.sections.shop.items = [];
  nachziehen(db, korr);
  if ((db.sections.shop.items || []).length !== 0)
    meckern(
      "Ware in einen leeren Shop gelegt: " +
        db.sections.shop.items.map((p) => p.name).join(", ")
    );
  if (korr.shop !== undefined) meckern("korrekturen.json traegt wieder einen shop-Block");
}

{
  /* Und ein voller Shop bleibt voll — Reihenfolge, Felder und Zustand
     unveraendert. Das ist die Gegenprobe zur Publish-Meldung: was die
     Verwaltung schickt, kommt genau so an. */
  const db = JSON.parse(JSON.stringify(template));
  const ware = [
    { name: "Hoodie", price: "79", badge: "Bestseller", note: "Schwer und warm.", status: "available" },
    { name: "Cap", price: "35", status: "soldout" },
    { name: "Beispiel", price: "35" },
  ];
  db.sections.shop.items = JSON.parse(JSON.stringify(ware));
  nachziehen(db, korr);
  if (JSON.stringify(db.sections.shop.items) !== JSON.stringify(ware))
    meckern("Warenliste veraendert: " + JSON.stringify(db.sections.shop.items));
}

{
  /* Referenzen: ERGAENZEN, NIE ERSETZEN — und nach der Marke gar nichts mehr.

     Vorgeschichte in zwei Stufen. Bis zum 10.08.2026 tauschte eine Regel die
     Liste der Verwaltung gegen eine im Repo gepflegte aus; genau deshalb fehlte
     "IVY — St. Gallen". Die Regel ist weg. Seit dem 11.08.2026 steht hier eine
     andere: sie haengt an, was fehlt, damit die Website vollstaendig ist, ohne
     dass jemand die Verwaltung oeffnen und speichern muss. Sie ueberschreibt
     nichts und sortiert die vorhandenen Eintraege nicht um — ausser den vier
     frueher grossen, die einmalig nach vorne ruecken. */
  const paare = (c) => c.sections.references.items.map((r) => `${r.name} — ${r.city}`);
  const vollstaendig = korr.referenzenNachtragen.eintraege.map((r) => `${r.name} — ${r.city}`);

  {
    // Ein leerer Stand wird komplett gefuellt.
    const db = JSON.parse(JSON.stringify(template));
    db.sections.references.items = [];
    delete db.migrationen;
    nachziehen(db, korr);
    for (const eintrag of vollstaendig)
      if (!paare(db).includes(eintrag)) meckern(`"${eintrag}" fehlt nach dem Ergaenzen`);
    if (paare(db).length !== vollstaendig.length)
      meckern(`${paare(db).length} Eintraege statt ${vollstaendig.length}`);
    // Nichts davon ist gross — was hervorsticht, entscheidet die Verwaltung.
    if (db.sections.references.items.some((r) => r.highlight))
      meckern("ein ergaenzter Eintrag ist gross");
  }

  {
    // Ein eigener Eintrag bleibt, mit Schreibweise und Zustand.
    const db = JSON.parse(JSON.stringify(template));
    db.sections.references.items = [
      { name: "Nur ein Club", city: "Chur", highlight: true, url: "https://beispiel.ch" },
    ];
    delete db.migrationen;
    nachziehen(db, korr);
    const eigen = db.sections.references.items.find((r) => r.name === "Nur ein Club");
    if (!eigen) meckern("der eigene Eintrag ist verschwunden");
    else {
      if (eigen.city !== "Chur" || eigen.url !== "https://beispiel.ch" || eigen.highlight !== true)
        meckern("der eigene Eintrag wurde veraendert: " + JSON.stringify(eigen));
    }
    // Keine Dubletten, auch nicht bei anderer Schreibweise.
    const p2 = paare(db);
    const doppelt = p2.filter((x, i) => p2.indexOf(x) !== i);
    if (doppelt.length) meckern("Dublette: " + [...new Set(doppelt)].join(", "));
  }

  {
    // Gross/Klein und Bindestriche zaehlen nicht als Unterschied.
    const db = JSON.parse(JSON.stringify(template));
    db.sections.references.items = [{ name: "kugl", city: "st. gallen" }];
    delete db.migrationen;
    nachziehen(db, korr);
    const kugl = db.sections.references.items.filter((r) => /kugl/i.test(r.name));
    if (kugl.length !== 1) meckern("Kugl doppelt: " + JSON.stringify(kugl));
    if (kugl[0].name !== "kugl") meckern("die Schreibweise wurde geaendert: " + kugl[0].name);
  }

  {
    /* Die Marke: hat die Verwaltung einmal gespeichert, laeuft nichts mehr.
       Ohne das liesse sich eine Referenz nie loeschen — sie kaeme beim naechsten
       Build zurueck, und genau daran ist der Shop frueher gescheitert. */
    const db = JSON.parse(JSON.stringify(template));
    db.migrationen = { referenzen: true, kanaele: true, shopInfo: true, telefon: true };
    db.sections.references.items = [{ name: "Nur ein Club", city: "Chur" }];
    db.sections.contact.socials = [{ label: "Mixcloud", url: "https://www.mixcloud.com/samsparking/" }];
    db.sections.contact.phone = "+41 77 509 11 71";
    db.sections.shop.info = [];
    db.sections.shop.kicker = "";
    nachziehen(db, korr);
    if (paare(db).join(" | ") !== "Nur ein Club — Chur")
      meckern("trotz Marke ergaenzt: " + paare(db).join(", "));
    if (db.sections.contact.socials.length !== 1)
      meckern("trotz Marke Kanaele ergaenzt: " + db.sections.contact.socials.map((x) => x.label).join(", "));
    /* Die Telefonnummer ist die Ausnahme: sie wird IMMER geloescht, ohne Marke.
       Das Feld gibt es im Modell nicht mehr — wie beim Fotografen. */
    if ("phone" in db.sections.contact) meckern("das Telefonfeld steht noch da");
    if ((db.sections.shop.info || []).length) meckern("trotz Marke den Streifen angelegt");
    if (db.sections.shop.kicker) meckern("trotz Marke den Kicker gesetzt");
  }

  {
    // Die vier frueher grossen ruecken einmalig nach vorne, ohne Inhalt zu aendern.
    const db = JSON.parse(JSON.stringify(template));
    db.sections.references.items = [
      { name: "The Q", city: "Schaan, FL" },
      { name: "Kugl", city: "St. Gallen" },
      { name: "IVY", city: "St. Gallen" },
      { name: "BBC", city: "Gossau" },
    ];
    delete db.migrationen;
    nachziehen(db, korr);
    const ersteVier = paare(db).slice(0, 4);
    if (ersteVier[0] !== "Kugl — St. Gallen" || !ersteVier.includes("BBC — Gossau"))
      meckern("die vier stehen nicht vorne: " + ersteVier.join(", "));
    // The Q und IVY behalten ihre Ordnung untereinander.
    const rest = paare(db);
    if (rest.indexOf("The Q — Schaan, FL") > rest.indexOf("IVY — St. Gallen"))
      meckern("die Ordnung der uebrigen wurde umgeworfen: " + rest.slice(0, 8).join(", "));
  }

  /* Und in korrekturen.json darf keine ERSETZENDE Liste zurueckkommen. */
  for (const feld of ["referenzen", "alteReferenzen", "kanaele", "instagram", "shop"])
    if (korr[feld] !== undefined)
      meckern(`korrekturen.json traegt wieder "${feld}" — das ersetzte statt zu ergaenzen`);
  for (const lang of ["de", "fr"])
    if (korr.i18n?.[lang]?.referenzen !== undefined)
      meckern(`korrekturen.json traegt wieder i18n.${lang}.referenzen (Orte nach Platz)`);
}

{
  /* Der Stand, wie ihn die Verwaltung am 11.08.2026 um 21:09 publiziert hat:
     47 Medien, ein echter Artikel, sieben Referenzen, ein Kanal, die alte
     Telefonnummer, kein Shop-Hero, kein Release. Daraus muss OHNE jedes Zutun
     ein vollstaendiger Stand werden — und der Artikel und die Medien duerfen
     dabei nicht angefasst werden. */
  const db = JSON.parse(JSON.stringify(template));
  delete db.migrationen;
  db.sections.references.items = [
    { name: "Kugl", city: "St. Gallen" },
    { name: "Sektor 11", city: "Zürich" },
    { name: "The Q", city: "Schaan, FL" },
    { name: "IVY", city: "St. Gallen" },
    { name: "BBC", city: "Gossau" },
    { name: "B9", city: "St. Gallen" },
    { name: "Ultrawild Festival", city: "St. Gallen" },
  ];
  db.sections.contact.socials = [{ label: "Mixcloud", url: "https://www.mixcloud.com/samsparking/" }];
  db.sections.contact.phone = "+41 77 509 11 71";
  const ware = [{ name: "Snapback-Cap Sam Sparking", price: "25", src: "https://beispiel/cap.jpg", paymentLink: "https://buy.stripe.com/test" }];
  db.sections.shop = { enabled: true, currency: "CHF", items: JSON.parse(JSON.stringify(ware)) };
  const medien = db.sections.gallery.items.length;
  delete db.release;

  nachziehen(db, korr);

  // Vollstaendig — ohne dass jemand die Verwaltung geoeffnet hat.
  const namen = db.sections.references.items.map((r) => r.name);
  if (namen.length !== korr.referenzenNachtragen.eintraege.length)
    meckern(`${namen.length} Referenzen statt ${korr.referenzenNachtragen.eintraege.length}`);
  if (!namen.includes("IVY")) meckern("IVY fehlt");
  const dop = namen.filter((x, i) => namen.indexOf(x) !== i);
  if (dop.length) meckern("Referenz doppelt: " + [...new Set(dop)].join(", "));
  if (namen.slice(0, 4).join(" | ") !== "Kugl | Sektor 11 | BBC | Ultrawild Festival")
    meckern("die ersten vier stimmen nicht: " + namen.slice(0, 4).join(", "));

  const kanaele = db.sections.contact.socials;
  if (kanaele.map((x) => x.label).join(" | ") !== "Instagram | Mixcloud | TikTok | Spotify")
    meckern("Kanaele: " + kanaele.map((x) => x.label).join(", "));
  for (const k of kanaele) if (!k.url) meckern(`Kanal "${k.label}" ohne Adresse`);
  if ("phone" in db.sections.contact) meckern("das Telefonfeld steht noch im Kontakt");
  if (!db.sections.shop.kicker || !db.sections.shop.headline || !db.sections.shop.ctaLabel)
    meckern("Shop-Einladung fehlt");
  if ((db.sections.shop.info || []).length !== 3) meckern("Infostreifen fehlt");
  if (!db.imprint?.email || !db.imprint?.location) meckern("Impressum fehlt");
  if (db.release?.enabled !== true || db.release?.date !== "2026-08-12")
    meckern("Release-Sperre fehlt: " + JSON.stringify(db.release));

  // UND: der echte Artikel und die Medien sind unangetastet.
  if (JSON.stringify(db.sections.shop.items) !== JSON.stringify(ware))
    meckern("die veroeffentlichte Ware wurde veraendert: " + JSON.stringify(db.sections.shop.items));
  if (db.sections.gallery.items.length !== medien)
    meckern(`Galerie veraendert: ${db.sections.gallery.items.length} statt ${medien}`);
}

{
  /* Ortsuebersetzungen nach Platz gibt es auch im Inhalt nicht mehr. Sie
     wanderten beim Umsortieren in der Verwaltung zum falschen Club: Platz 2
     war "Ultrawild Festival — St. Gallen", nach dem Umsortieren "The Q —
     Schaan, FL" — und die Uebersetzung machte daraus wieder St. Gallen. */
  for (const root of ["i18n", "i18nHash"])
    for (const lang of Object.keys(template[root] || {})) {
      const ref = template[root][lang]?.sections?.references;
      if (ref && ref.items !== undefined)
        meckern(`${root}.${lang}.sections.references.items steht wieder im Inhalt`);
    }
}

{
  /* Vergangene Shows werden zu Referenzen (11.08.2026).

     "Vorbei" heisst: der Tag ist ganz herum. Ein Termin am heutigen Tag zaehlt
     bis Mitternacht als kommend — auch ohne Uhrzeit, denn eine Show endet nach
     Mitternacht und soll nicht mittendrin aus der Liste fallen. */
  const HEUTE = "2026-08-12";
  if (showVorbei({ date: "2026-08-11" }, HEUTE) !== true) meckern("Gestern gilt nicht als vorbei");
  if (showVorbei({ date: HEUTE }, HEUTE) !== false) meckern("Heute gilt schon als vorbei");
  if (showVorbei({ date: "2026-08-13" }, HEUTE) !== false) meckern("Morgen gilt als vorbei");
  if (showVorbei({ date: "" }, HEUTE) !== false) meckern("Ein Termin ohne Datum gilt als vorbei");

  /* Vergangene Shows wandern NICHT mehr automatisch in die Referenzen.

     Bis zum 07.09.2026 legte showsNachReferenzen fuer jeden vergangenen Termin
     einen Referenz-Eintrag an. Seit die Termine im Rueckblick stehen, war das
     eine Doppelnennung auf ein und derselben Seite. Die Funktion ist weg —
     geprueft wird, dass sie nicht durch die Hintertuer zurueckkommt: der
     Generator laesst die Referenzliste in Ruhe. */
  const db = JSON.parse(JSON.stringify(template));
  db.sections.references.items = [
    { name: "Kugl", city: "St. Gallen", highlight: true },
    { name: "Sektor 11", city: "Zürich", highlight: true },
  ];
  db.sections.shows.items = [
    { name: "Nox club", city: "Chur", date: "2026-08-13" },
    { name: "Altes Fest", city: "Wil", date: "2026-07-04" },
    { name: "Ohne Datum", city: "Zug" },
  ];
  const refsVorher = JSON.stringify(db.sections.references.items);
  nachziehen(db, korr);
  if (JSON.stringify(db.sections.references.items) !== refsVorher)
    meckern(
      "Der Generator hat die Referenzliste veraendert: " +
        JSON.stringify(db.sections.references.items)
    );
  if (db.sections.shows.items.length !== 3) meckern("Ein Termin wurde geloescht");
}

{
  /* Der Release-Zeitpunkt: aus Datum, Uhrzeit und Zeitzone wird EIN Moment.
     Geprueft wird gegen die Ortszeit in Zurich — im Sommer wie im Winter, denn
     die Umstellung steckt in der Umrechnung. */
  const zurich = (ms) =>
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Zurich",
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(ms));

  const sommer = releaseZeitpunkt("2026-08-12", "18:00", "Europe/Zurich");
  if (zurich(sommer) !== "2026-08-12 18:00") meckern("Sommerzeit falsch: " + zurich(sommer));
  if (new Date(sommer).toISOString() !== "2026-08-12T16:00:00.000Z")
    meckern("Sommer-Zeitpunkt in UTC falsch: " + new Date(sommer).toISOString());

  const winter = releaseZeitpunkt("2026-01-15", "18:00", "Europe/Zurich");
  if (zurich(winter) !== "2026-01-15 18:00") meckern("Winterzeit falsch: " + zurich(winter));

  // Genau in der Nacht der Zeitumstellung (letzter Sonntag im Maerz 2026).
  const umstellung = releaseZeitpunkt("2026-03-29", "12:00", "Europe/Zurich");
  if (zurich(umstellung) !== "2026-03-29 12:00")
    meckern("Zeitumstellung falsch: " + zurich(umstellung));

  if (releaseZeitpunkt("", "18:00") !== 0) meckern("Ohne Datum muesste 0 herauskommen");

  // Und die Angaben stehen bereit, damit die Sperre ueberhaupt greift.
  if (korr.release?.enabled !== true) meckern("Die Release-Sperre ist nicht eingeschaltet");
  if (korr.release?.date !== "2026-08-12" || korr.release?.time !== "18:00")
    meckern(`Release steht auf ${korr.release?.date} ${korr.release?.time}`);
  if (korr.release?.zone !== "Europe/Zurich") meckern("Zeitzone fehlt oder ist falsch");
}

{
  /* Der Fotograf ist ueberall geloescht — nicht nur unsichtbar.

     Erst wurde er nur nicht mehr angezeigt; das Feld stand aber weiter in der
     Verwaltung, und der Kunde hat es dort wiedergefunden. Jetzt wird es bei
     JEDEM Build geraeumt, ohne Marke: das Feld gibt es im Modell nicht mehr,
     ein Wert aus einem alten Stand waere ein Rest. */
  /* Der Name des Fotografen steht bewusst nirgends mehr im Repo — auch nicht
     als Probewert. Geprueft wird die Struktur: das Feld selbst darf nicht
     ueberleben, egal was darin stand. */
  const PROBE = "Beispiel Fotostudio";
  const db = JSON.parse(JSON.stringify(template));
  db.site.photoCredit = PROBE;
  db.sections.gallery.items = [
    { src: "a.jpg", alt: "A", credit: PROBE },
    { src: "b.jpg", alt: "B" },
  ];
  db.sections.about.photo = { src: "p.jpg", alt: "P", credit: "Photo — " + PROBE };
  db.sections.booking.photo = { src: "q.jpg", alt: "Q", credit: PROBE };
  db.i18n = db.i18n || {};
  db.i18n.de = db.i18n.de || {};
  db.i18n.de.site = { photoCredit: PROBE };
  nachziehen(db, korr);

  const roh = JSON.stringify(db);
  if (roh.includes(PROBE)) meckern("Der Fotocredit steht noch im Inhalt");
  if (roh.includes("photoCredit")) meckern("photoCredit steht noch im Inhalt");
  if (roh.includes('"credit"')) meckern("ein credit-Feld steht noch im Inhalt");
  // Die Bilder bleiben — geloescht wird nur diese eine Angabe.
  if (db.sections.gallery.items.length !== 2) meckern("ein Medium ist verschwunden");
  if (db.sections.gallery.items[0].src !== "a.jpg" || db.sections.gallery.items[0].alt !== "A")
    meckern("das Medium wurde veraendert: " + JSON.stringify(db.sections.gallery.items[0]));
  if (db.sections.about.photo.src !== "p.jpg") meckern("das Portrait wurde veraendert");
  if (db.sections.booking.photo.src !== "q.jpg") meckern("das Booking-Bild wurde veraendert");
}

{
  /* Und im veroeffentlichten Stand steht er auch nicht mehr — samt der Probe,
     dass dabei nichts anderes verloren gegangen ist. */
  const roh = JSON.stringify(template);
  for (const wort of ["photoCredit", '"credit"'])
    if (roh.includes(wort)) meckern(`"${wort}" steht wieder im Inhalt`);
  /* Und auch die Korrekturdatei und der Fingerabdruck-Stand duerfen ihn nicht
     zurueckbringen — dort stand er zuletzt noch. */
  for (const [name, datei] of [["korrekturen.json", korr]])
    if (JSON.stringify(datei).includes('"credit"'))
      meckern(`${name} traegt wieder ein credit-Feld`);
  /* Die Bilderwand ist vollzaehlig: 47 Eintraege, davon 44 mit Adresse (drei
     leere Plaetze aus der Verwaltung). Geloescht wurde nur die Angabe zum
     Fotografen AM Eintrag — keine Datei, keine Adresse, kein Eintrag. */
  /* 44 Medien, jedes mit Adresse. Die drei frueheren Leer-Plaetze sind beim
     Publizieren der Verwaltung von selbst weggefallen — die Datenbank speichert
     ein leeres Objekt nicht. Kein Medium ist verloren. */
  /* Wie in links.test.mjs: keine feste Zahl auf Kundendaten. Wer ein Bild
     loescht oder einen Platz leer laesst, darf damit keinen roten Prueflauf
     ausloesen — sonst schaut irgendwann niemand mehr hin. */
  const medien = template.sections.gallery.items || [];
  const mitBild = medien.filter((i) => i && i.src);
  if (mitBild.length < 20)
    meckern(`nur noch ${mitBild.length} Galeriebilder mit Adresse — da ist etwas verloren gegangen`);
  if (!(template.sections.shop.items || []).some((p) => p.paymentLink))
    meckern("der Bezahl-Link am Artikel ist verloren gegangen");
  /* Referenzen: keine feste Zahl mehr. Vergangene Termine wandern von selbst
     hierher (showsNachReferenzen) — die Liste WAECHST also im Betrieb, und eine
     harte 25 haette den Test bei der naechsten gespielten Show rot gemacht.
     Geprueft wird stattdessen, was wirklich gelten muss: der gepflegte
     Grundstock ist noch da, jeder Eintrag hat einen Namen, und nichts steht
     doppelt drin. */
  const refs = template.sections.references.items || [];
  if (refs.length < 25) meckern(`nur noch ${refs.length} Referenzen (mindestens 25 erwartet)`);
  if (refs.some((r) => !r || !String(r.name || "").trim()))
    meckern("eine Referenz ohne Namen");
  const refKey = (r) =>
    `${String(r.name || "").trim().toLowerCase()}|${String(r.city || "").trim().toLowerCase()}`;
  if (new Set(refs.map(refKey)).size !== refs.length)
    meckern("eine Referenz steht doppelt in der Liste");
  /* Kanaele pflegt der Kunde ebenfalls selbst — geprueft wird, dass ueberhaupt
     welche dastehen und jeder eine Aufschrift hat, nicht ihre Anzahl. */
  const kanaeleJetzt = template.sections.contact.socials || [];
  if (!kanaeleJetzt.length) meckern("es steht kein einziger Kanal mehr im Inhalt");
  if (kanaeleJetzt.some((k) => !String(k?.label || "").trim()))
    meckern("ein Kanal ohne Aufschrift");
  if (template.release?.enabled !== true || template.release?.date !== "2026-08-12")
    meckern("die Release-Sperre wurde veraendert: " + JSON.stringify(template.release));
}

{
  /* Die Telefonnummer ist von der Website genommen (11.08.2026). Geraeumt wird
     nur die eine bekannte Nummer — eine neue in der Verwaltung bleibt stehen. */
  /* Das Telefonfeld gibt es nicht mehr — es wird geloescht, nicht geleert, und
     zwar jede Nummer. Bis zum 12.08.2026 wurde nur die eine bekannte Nummer
     geleert; das Feld stand danach weiter in der Verwaltung und der Schluessel
     weiter in den Daten. Der Kunde will es ganz weg. */
  const db = JSON.parse(JSON.stringify(template));
  db.sections.contact.phone = "+41 77 509 11 71";
  nachziehen(db, korr);
  if ("phone" in db.sections.contact) meckern("Telefonfeld nicht geloescht");

  const eigen = JSON.parse(JSON.stringify(template));
  eigen.sections.contact.phone = "+41 44 000 00 00";
  nachziehen(eigen, korr);
  if ("phone" in eigen.sections.contact) meckern("auch eine neue Nummer muss weg");
  // Und in den Uebersetzungen ebenso.
  const mitI18n = JSON.parse(JSON.stringify(template));
  mitI18n.i18n = { de: { sections: { contact: { phone: "077 …" } } } };
  nachziehen(mitI18n, korr);
  if ("phone" in (mitI18n.i18n.de.sections.contact || {}))
    meckern("Telefonfeld in der Uebersetzung geblieben");
  // E-Mail und Standort bleiben.
  if (eigen.sections.contact.email !== template.sections.contact.email) meckern("E-Mail angefasst");
  if (eigen.sections.contact.base !== template.sections.contact.base) meckern("Standort angefasst");
}

{
  /* Das Impressum: die Angaben kommen aus content/korrekturen.json, weil der
     Inhalt bei jedem Build aus der Datenbank neu geschrieben wird. Gesetzt
     wird nur, was fehlt. */
  const leer = JSON.parse(JSON.stringify(template));
  delete leer.imprint;
  nachziehen(leer, korr);
  if (leer.imprint?.email !== "info@samsparking.ch")
    meckern("Impressum: E-Mail fehlt oder ist falsch: " + leer.imprint?.email);
  if (leer.imprint?.location !== "Herisau, Schweiz")
    meckern("Impressum: Standort fehlt oder ist falsch: " + leer.imprint?.location);
  /* Keine Strassenadresse und keine erfundenen Pflichtangaben. Geprueft werden
     nur die Angaben selbst — die _warum-Notiz darf erklaeren, was fehlt. */
  const alsText = JSON.stringify(
    Object.fromEntries(Object.entries(korr.impressum || {}).filter(([f]) => !f.startsWith("_")))
  );
  for (const wort of ["strasse", "straße", "Postfach", "UID", "CHE-", "MwSt", "Handelsregister"])
    if (new RegExp(wort, "i").test(alsText)) meckern(`Impressum traegt "${wort}" — nicht bekannt, nicht erfunden`);

  // Was in der Verwaltung steht, gewinnt.
  const eigen = JSON.parse(JSON.stringify(template));
  eigen.imprint = { email: "hallo@example.ch", location: "Chur, Schweiz" };
  nachziehen(eigen, korr);
  if (eigen.imprint.email !== "hallo@example.ch" || eigen.imprint.location !== "Chur, Schweiz")
    meckern("Eigene Impressum-Angaben ueberschrieben: " + JSON.stringify(eigen.imprint));
}

{
  /* Die Zahl neben "Shows" wird GEZAEHLT, nicht hingeschrieben.
     (Vorher stand sie als feste 30 in der Korrekturdatei — nach jeder neuen
     Show waere sie falsch gewesen, und angefasst haette sie nie wieder jemand.)

     Gezaehlt werden die Auftritte, die die Website kennt: Termine unter "Shows"
     und Referenzen, ohne Dubletten. Der Mindestwert aus der Korrekturdatei ist
     der vom Kunden bestaetigte Gesamtstand und greift nur, solange die Daten
     weniger hergeben. */
  const zaehlDb = (refs, shows) => {
    const db = JSON.parse(JSON.stringify(template));
    db.sections.references.items = refs;
    db.sections.shows.items = shows;
    db.hero.stats = [
      { value: "2021", label: "First set" },
      { value: "2", label: "Shows" },
      { value: "150", label: "BPM home base" },
    ];
    nachziehen(db, korr);
    return db;
  };
  const mindestens = Number(korr.heroShows?.mindestens) || 0;
  if (!mindestens) meckern("heroShows.mindestens fehlt in der Korrekturdatei");

  // Wenig Daten: der bestaetigte Mindestwert steht da.
  const wenig = zaehlDb([{ name: "Kugl", city: "St. Gallen" }], [{ name: "Nox", city: "Chur", date: "2026-01-01" }]);
  if (wenig.hero.stats[1].value !== String(mindestens))
    meckern(`Bei wenig Daten steht "${wenig.hero.stats[1].value}" statt dem Mindestwert ${mindestens}`);
  if (wenig.hero.stats[0].value !== "2021" || wenig.hero.stats[2].value !== "150")
    meckern("Die anderen Kennzahlen wurden mitveraendert");

  // Mehr Auftritte als der Mindestwert: die Zahl folgt den Daten.
  const viele = Array.from({ length: mindestens + 5 }, (_, i) => ({ name: `Club ${i}`, city: "St. Gallen" }));
  const gross = zaehlDb(viele, []);
  if (gross.hero.stats[1].value !== String(mindestens + 5))
    meckern(
      `Die Kennzahl folgt den Daten nicht: "${gross.hero.stats[1].value}" statt ${mindestens + 5}`
    );

  // Derselbe Auftritt in beiden Listen zaehlt einmal — auch mit anderer
  // Schreibweise und Leerzeichen ("Nox Club " in den Referenzen).
  const doppelt = zaehlDb(
    [...viele, { name: "Nox Club ", city: "Chur" }],
    [{ name: "nox club", city: "CHUR", date: "2026-01-01" }]
  );
  if (doppelt.hero.stats[1].value !== String(mindestens + 6))
    meckern(`Dublette doppelt gezaehlt: "${doppelt.hero.stats[1].value}" statt ${mindestens + 6}`);

  // Gleicher Name, anderer Ort ist ein anderer Auftritt.
  const zweiOrte = zaehlDb(
    [...viele, { name: "Jugendopenair", city: "St. Gallen" }, { name: "Jugendopenair", city: "Wattwil" }],
    []
  );
  if (zweiOrte.hero.stats[1].value !== String(mindestens + 7))
    meckern(`Gleicher Name an zwei Orten falsch gezaehlt: "${zweiOrte.hero.stats[1].value}"`);

  // Gefunden wird die Kennzahl ueber die Aufschrift, nicht ueber den Platz —
  // auch mit der alten Aufschrift, falls die Umbenennung nicht mehr greift.
  const verschoben = JSON.parse(JSON.stringify(template));
  verschoben.hero.stats = [{ value: "2", label: "Shows" }, { value: "2021", label: "First set" }];
  nachziehen(verschoben, korr);
  if (verschoben.hero.stats[0].value === "2")
    meckern("Kennzahl an anderer Stelle nicht ueber die Aufschrift gefunden");
  const altLabel = JSON.parse(JSON.stringify(template));
  altLabel.hero.stats = [{ value: "2", label: "Clubs & Festivals" }];
  nachziehen(altLabel, korr);
  if (altLabel.hero.stats[0].value === "2") meckern("Kennzahl mit alter Aufschrift nicht gefunden");
}

{
  // Eigene Stellen bleiben unberuehrt — auch die neuen Regeln fassen nichts an,
  // was in der Verwaltung schon jemand gesetzt hat.
  const eigen = JSON.parse(JSON.stringify(template));
  eigen.hero.stats = [{ value: "9", label: "Eigene Zahl" }];
  eigen.sections.shows.items = [{ name: "Aftersun", city: "Zug", date: "2026-08-29" }];
  eigen.sections.shop.currency = "EUR";
  eigen.sections.contact.socials = [
    { label: "Instagram", url: "https://instagram.com/x", inHeader: true },
  ];
  /* Eine eigene Seitenaufteilung. Sie versorgt ALLE beschlossenen Abschnitte —
     sonst greift die Regel vom 10.08.2026 und legt die fehlende Seite an, deren
     Abschnitte nirgends stehen. Das ist gewollt (ein Abschnitt darf nicht
     heimatlos werden) und hier nicht der Pruefgegenstand: hier geht es darum,
     dass eine eigene Aufteilung nicht umgebaut wird.

     Bis zum 12.08.2026 lagen Booking und Shop auf eigenen Seiten. Der Shop ist
     seither ein Abschnitt der Startseite, und die Startseite hier deckt beides
     mit ab. */
  eigen.pages = [
    { slug: "", navLabel: "Home", sections: ["about", "shop", "booking", "contact"] },
    { slug: "extra", navLabel: "Extra", sections: ["gallery"] },
  ];

  nachziehen(eigen, korr);
  if (eigen.hero.stats[0].label !== "Eigene Zahl") meckern("Eigene Kennzahl umbenannt");
  if (eigen.sections.shows.items[0].city !== "Zug") meckern("Eigener Ort der Show ueberschrieben");
  if (eigen.sections.shop.currency !== "EUR") meckern("Eigene Waehrung ueberschrieben");
  if (eigen.sections.contact.socials[0].inHeader !== true)
    meckern("Ausdruecklich eingeschalteter Kopf-Kanal wieder abgeschaltet");
  if (eigen.pages.length !== 2) meckern("Eigene Seitenaufteilung ueberschrieben");
}

{
  // Ohne Korrekturdatei bleibt wenigstens die Schreibweise.
  const nur = JSON.parse(JSON.stringify(template));
  nur.site.artist = "Sam Sparkling";
  nachziehen(nur, null);
  if (nur.site.artist !== "Sam Sparking") meckern("Schreibweise braucht die Korrekturdatei — darf sie nicht");
}

{
  /* Die Jahreszahl im Hero: "First set 2021".
 
     Sie war am 10.08.2026 kurz stillgelegt (Regel `entfernteKennzahlen`). Der
     Kunde hat das am selben Tag zurueckgenommen — die Zahl muss im Hero stehen,
     in allen drei Sprachen. Die Regel ist weg; hier wird geprueft, dass auch
     ein alter Stand mit `entfernt: true` wieder sichtbar wird.

     Die Faktenzeile unten in "Ueber mich" faellt dagegen GANZ weg (Regel
     `aboutFakten`) — das ist nicht dasselbe und darf die Kennzahlen im Hero
     nicht mitnehmen. */
  const db = JSON.parse(JSON.stringify(template));
  db.hero.stats = [
    { label: "First set", value: "2021", entfernt: true },   // Altlast
    { label: "Shows", value: "30" },
    { label: "BPM home base", value: "150" },
  ];
  db.sections.about.facts = [
    { label: "First set", value: "2021", entfernt: true },
    { label: "Clubs & festivals", value: "7+" },
  ];
  db.i18n = db.i18n || {};
  db.i18n.de = db.i18n.de || {};
  db.i18n.de.hero = { stats: { 0: { label: "Erstes Set" }, 1: { label: "Shows" }, 2: { label: "BPM Zuhause" } } };
  db.i18n.de.sections = db.i18n.de.sections || {};
  db.i18n.de.sections.about = { facts: { 0: { label: "Erstes Set" }, 1: { label: "Clubs & Festivals" } } };

  nachziehen(db, korr);

  // Hero: drei Kennzahlen, keine mehr stillgelegt.
  if (db.hero.stats.length !== 3) meckern("Hero-Kennzahlen: " + db.hero.stats.length + " statt 3");
  if (db.hero.stats.some((x) => x.entfernt !== undefined))
    meckern("Im Hero ist noch eine Kennzahl stillgelegt");
  const jahr = db.hero.stats.find((x) => x.label === "First set");
  if (!jahr || jahr.value !== "2021") meckern('"First set 2021" fehlt im Hero');
  // Die Uebersetzung sitzt weiter auf demselben Platz wie ihre Kennzahl.
  if (db.i18n.de.hero.stats["0"].label !== "Erstes Set" || db.i18n.de.hero.stats["1"].label !== "Shows")
    meckern("Uebersetzung der Kennzahlen ist verrutscht");

  // "Ueber mich": Faktenzeile ganz weg, samt Uebersetzung.
  if (db.sections.about.facts.length !== 0)
    meckern("Faktenzeile in \"Ueber mich\" nicht geleert: " + JSON.stringify(db.sections.about.facts));
  if (db.i18n.de.sections.about.facts !== undefined)
    meckern("Uebersetzung der Faktenzeile steht noch da und zeigt auf nichts");

  // Wiederholbar: ein zweiter Lauf darf nichts mehr melden und nichts kippen.
  const nochmal = nachziehen(db, korr);
  if (nochmal.some((m) => /wieder sichtbar|aus "Ueber mich" entfernt/.test(m)))
    meckern("Die Regel meldet sich beim zweiten Lauf erneut: " + nochmal.join(", "));
  if (db.hero.stats.length !== 3 || db.sections.about.facts.length !== 0)
    meckern("Zweiter Lauf veraendert den Stand");
}

{
  /* Wann darf die Shop-Seite eine Bezahlung ankuendigen?
     Anlass: die oeffentliche Seite versprach "via Stripe — card, Apple Pay,
     Google Pay or TWINT" und "Continue to payment", obwohl gar kein
     Zahlungslink hinterlegt war. Die Pruefung muss Zeichen fuer Zeichen
     dieselbe sein wie in netlify/functions/order.mjs — waere die Seite
     grosszuegiger, verspraeche sie, was der Endpunkt danach verweigert. */
  const gueltig = [
    "https://buy.stripe.com/abc123",
    "https://checkout.stripe.com/c/pay/xyz",
    "https://pay.link.com/abc",
  ];
  const ungueltig = [
    "",
    "   ",
    null,
    undefined,
    "http://buy.stripe.com/abc", // kein https
    "https://boese.example/pay", // fremder Host
    "https://stripe.com.boese.example/pay", // Host nur vorgetaeuscht
    "https://notstripe.com/abc",
    "keine adresse",
  ];
  for (const u of gueltig)
    if (!istStripeAdresse(u)) meckern(`Echte Stripe-Adresse abgelehnt: ${u}`);
  for (const u of ungueltig)
    if (istStripeAdresse(u))
      meckern(`Ungueltige Bezahladresse durchgelassen: ${JSON.stringify(u)}`);

  const vorher = process.env.STRIPE_PAYMENT_LINK_URL;
  delete process.env.STRIPE_PAYMENT_LINK_URL;
  if (zahlungBereit({})) meckern("Ohne Zahlungslink gilt die Bezahlung faelschlich als bereit");
  if (zahlungBereit({ stripePaymentLink: "https://boese.example/pay" }))
    meckern("Ein fremder Host schaltet die Bezahlung frei");
  if (!zahlungBereit({ stripePaymentLink: "https://buy.stripe.com/abc" }))
    meckern("Ein echter Zahlungslink im Inhalt schaltet die Bezahlung nicht frei");

  process.env.STRIPE_PAYMENT_LINK_URL = "https://buy.stripe.com/abc";
  if (!zahlungBereit({})) meckern("STRIPE_PAYMENT_LINK_URL schaltet die Bezahlung nicht frei");
  process.env.STRIPE_PAYMENT_LINK_URL = "https://boese.example/pay";
  if (zahlungBereit({}))
    meckern("Eine falsch gesetzte STRIPE_PAYMENT_LINK_URL schaltet die Bezahlung frei");
  if (vorher === undefined) delete process.env.STRIPE_PAYMENT_LINK_URL;
  else process.env.STRIPE_PAYMENT_LINK_URL = vorher;
}

{
  /* Was publiziert wurde, bleibt sichtbar — auch nach dem Datum.

     Am 27.08.2026 war der aufklappbare Rueckblick unter den Shows entfernt
     worden, weil vergangene Termine ueber showsNachReferenzen ohnehin bei den
     Referenzen landen. Die Abnahme am 07.09.2026 hat gezeigt, was das
     tatsaechlich heisst: als der letzte Termin vorbei war, verschwand der
     ganze Abschnitt samt Menuepunkt, und keine der publizierten Shows war im
     Frontend noch zu finden.

     Die Regel lautet jetzt: kommende Termine oben, vergangene darunter im
     Rueckblick — offen sichtbar, nicht zugeklappt —, und der Abschnitt steht,
     solange ueberhaupt ein Termin mit Namen da ist.

     Geprueft an den GEBAUTEN Seiten. Welche Seite die Shows traegt, entscheidet
     der Kunde in der Verwaltung (Einseiter oder eigene Seite) — die Pruefung
     sucht sie deshalb, statt einen Pfad zu behaupten. */
  const { readFileSync } = await import("node:fs");
  const heute = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(new Date());
  const termine = (template.sections.shows.items || []).filter((i) => String(i?.name || "").trim());
  const vergangene = termine.filter((i) => showVorbei(i, heute));
  const kommende = termine.filter((i) => !showVorbei(i, heute));

  const showSeiten = seitenMitShows();
  if (termine.length && !showSeiten.length)
    meckern("keine einzige gebaute Seite traegt den Shows-Abschnitt");

  for (const [datei, html] of showSeiten) {
    /* Jeder vergangene Termin steht im Rueckblick — mit Namen. */
    const rueckblick = html.match(/<ul class="show-list past" id="past-show-list">[\s\S]*?<\/ul>/);
    if (vergangene.length && !rueckblick)
      meckern(`${datei}: der Rueckblick auf vergangene Shows fehlt`);
    for (const sh of vergangene) {
      if (!rueckblick || !rueckblick[0].includes(String(sh.name).trim()))
        meckern(`${datei}: der vergangene Termin "${sh.name}" fehlt im Rueckblick`);
    }
    if (vergangene.length && /id="past-shows"[^>]*\shidden/.test(html))
      meckern(`${datei}: der Rueckblick ist versteckt, obwohl vergangene Termine da sind`);

    /* Und er steht NUR dort — nicht zusaetzlich unter den kommenden. */
    const oben = html.match(/<ul class="show-list rv" id="show-list">[\s\S]*?<\/ul>/);
    const obenVergangen = oben
      ? [...oben[0].matchAll(/data-date="([^"]*)"/g)].map((m) => m[1]).filter((d) => d < heute)
      : [];
    if (obenVergangen.length)
      meckern(`${datei}: vergangene Termine stehen unter den kommenden: ${obenVergangen.join(", ")}`);

    /* Beide Listen chronologisch: oben aufsteigend, im Rueckblick absteigend. */
    const daten = (block) =>
      block ? [...block[0].matchAll(/data-date="([^"]*)"/g)].map((m) => m[1]) : [];
    const obenDaten = daten(oben);
    if (obenDaten.join(",") !== [...obenDaten].sort().join(","))
      meckern(`${datei}: kommende Termine nicht aufsteigend: ${obenDaten.join(", ")}`);
    const untenDaten = daten(rueckblick);
    if (untenDaten.join(",") !== [...untenDaten].sort().reverse().join(","))
      meckern(`${datei}: vergangene Termine nicht absteigend: ${untenDaten.join(", ")}`);

    /* Kein Ticket-Knopf an einem Termin, der vorbei ist. */
    for (const zeile of rueckblick ? rueckblick[0].split("<li ").slice(1) : []) {
      if (/<a class="btn btn-sm"/.test(zeile))
        meckern(`${datei}: ein vergangener Termin traegt noch einen Ticket-Knopf`);
    }

    /* Das Terminblatt speist den Booking-Kalender — dort gehoert nur die
       Zukunft hinein, buchen laesst sich nichts Vergangenes. */
    const blatt = html.match(/<script type="application\/json" id="shows-data">([\s\S]*?)<\/script>/);
    if (blatt) {
      const alt = JSON.parse(blatt[1]).filter((s2) => String(s2.date) < heute);
      if (alt.length)
        meckern(`${datei}: das Terminblatt traegt vergangene Tage: ${alt.map((a) => a.date).join(", ")}`);
    }
  }

  /* Der Menuepunkt fuehrt zu den Shows, solange es Termine gibt — auch wenn
     alle vorbei sind. Genau daran ist es am 07.09.2026 gescheitert. */
  if (termine.length) {
    const start = readFileSync(resolve(ROOT, "index.html"), "utf8");
    if (!/href="[^"]*(#shows|\/shows\/)"/.test(start))
      meckern("die Startseite verlinkt die Shows nicht mehr im Menue");
  }
  if (!kommende.length && !vergangene.length && showSeiten.length)
    meckern("der Shows-Abschnitt steht da, obwohl es gar keine Termine gibt");
}

if (fehler) {
  console.error(`\n${fehler} Fehler.`);
  process.exit(1);
}
console.log("Shows: kommende Termine oben (aufsteigend), vergangene darunter im offenen Rueckblick\n       (absteigend, ohne Ticket-Knopf) — der Abschnitt bleibt, solange es Termine gibt.");
console.log("adoptTexts: Orte, Kanäle und Einträge bleiben unangetastet; gleich lange Listen werden weiter übernommen.");
console.log("localize: Kanal-Namen bleiben in jeder Sprache stehen, auch bei veralteten Übersetzungen.");
console.log("nachziehen: Schreibweise immer; Listen, Kanaele und Bilder nur solange sie in der\n            Verwaltung unangetastet sind. Schalter und eigene Eintraege bleiben unberuehrt.");
console.log("nachziehen: Kennzahl \"Shows\", Aftersun in Luzern, Instagram aus dem Kopf, Waehrung\n            CHF, eigene Seiten fuer Booking und Shop — jeweils nur auf dem alten Stand.");
console.log("nachziehen: Referenzen — jeder bekannte Altstand loest die Ersetzung aus, auch\n            umsortiert; oben Kugl, Sektor 11, Ultrawild, BBC; Club Eden statt IVY,\n            Jugendopenair in St. Gallen UND Wattwil, keine Dublette.");
console.log("nachziehen: Die Zahl neben \"Shows\" steht auf 30 — gefunden ueber die Aufschrift\n            (auch die alte), nie ueber den Platz in der Liste.");
console.log("nachziehen: TikTok und Spotify werden genannt, aber ohne geratene Adresse;\n            Instagram bleibt einmalig.");
console.log("nachziehen: \"First set 2021\" wird stillgelegt statt geloescht — die Kennzahlen\n            behalten ihren Platz, damit die Uebersetzungen nicht verrutschen.");
console.log("Bezahlung: nur https und nur stripe.com/link.com gelten als Zahlungslink —\n           dieselbe Regel wie im Endpunkt; ein fremder Host schaltet nichts frei.");

{
  /* Stripe Payment Links je Artikel.

     Vorgabe vom 10.08.2026: der Kunde soll einen Preis in Stripe anlegen, daraus
     einen Payment Link erzeugen und ihn beim Artikel einsetzen — ohne
     API-Schluessel und ohne Umgebungsvariable je Artikel. Der Kauf-Knopf muss
     dann auf GENAU diesen Link zeigen.

     Geprueft wird die Pruefregel selbst: sie entscheidet, ob ein Knopf mit Geld
     hinter einer Adresse erscheint. Zu grosszuegig waere hier teuer. */
  const gueltig = [
    "https://buy.stripe.com/test_abc123",
    "https://buy.stripe.com/aEU00k1Zi9WZ2Xe4gh",
    "https://buy.stripe.com/x?prefilled_email=a%40b.ch",
  ];
  for (const u of gueltig)
    if (!istPaymentLink(u)) meckern(`gueltiger Payment Link nicht erkannt: ${u}`);

  const ungueltig = [
    ["", "leer"],
    ["   ", "nur Leerzeichen"],
    ["http://buy.stripe.com/x", "http statt https"],
    ["https://dashboard.stripe.com/payments", "Dashboard, keine Kasse"],
    ["https://stripe.com/de-ch", "Startseite von Stripe"],
    ["https://link.com/x", "Link.com ist kein Payment Link"],
    ["https://buy.stripe.com.boese.example/x", "fremde Domain mit buy.stripe.com davor"],
    ["https://boese.example/buy.stripe.com", "fremde Domain, Pfad getarnt"],
    ["buy.stripe.com/x", "ohne Schema"],
    ["javascript:alert(1)", "Skript-Adresse"],
    [null, "null"],
    [undefined, "undefined"],
  ];
  for (const [u, warum] of ungueltig)
    if (istPaymentLink(u)) meckern(`ungueltige Adresse durchgelassen (${warum}): ${u}`);

  /* Zwei Artikel, zwei verschiedene Kassen — plus einer ohne und einer mit
     Tippfehler. Genau die vier Faelle aus der Vorgabe. */
  const laden = {
    items: [
      { name: "Hoodie", price: "79", paymentLink: "https://buy.stripe.com/test_hoodie" },
      { name: "Shirt", price: "39", paymentLink: "https://buy.stripe.com/test_shirt" },
      { name: "Cap", price: "25" },
      { name: "Poster", price: "15", paymentLink: "https://dashboard.stripe.com/nope" },
    ],
  };
  const kassen = laden.items.map((p) => (istPaymentLink(p.paymentLink) ? p.paymentLink : ""));
  if (kassen[0] === kassen[1]) meckern("zwei Artikel teilen dieselbe Kasse");
  if (!kassen[0] || !kassen[1]) meckern("gueltige Payment Links kommen nicht an");
  if (kassen[2]) meckern("Artikel ohne Link bekommt eine Kasse");
  if (kassen[3]) meckern("Artikel mit Dashboard-Adresse bekommt eine Kasse");

  /* Kein Rueckfall auf einen globalen Link: der gehoert zu einem anderen Preis
     und wuerde den falschen Betrag abrechnen. */
  const vorher = process.env.STRIPE_PAYMENT_LINK_URL;
  process.env.STRIPE_PAYMENT_LINK_URL = "https://buy.stripe.com/global_anderer_preis";
  const kassenMitGlobal = laden.items.map((p) => (istPaymentLink(p.paymentLink) ? p.paymentLink : ""));
  if (kassenMitGlobal[2] || kassenMitGlobal[3])
    meckern("ein globaler Zahlungslink springt fuer einen Artikel ein — falscher Preis");
  if (vorher === undefined) delete process.env.STRIPE_PAYMENT_LINK_URL;
  else process.env.STRIPE_PAYMENT_LINK_URL = vorher;
}

{
  /* Kommende Shows stehen immer chronologisch — unabhaengig davon, wie sie in
     der Verwaltung sortiert sind. Bei gleichem Tag entscheidet die Uhrzeit.

     Geprueft wird an der GEBAUTEN Seite: die Reihenfolge entsteht erst dort,
     und genau dort ist sie sichtbar. */
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(resolve(ROOT, "index.html"), "utf8");
  const liste = html.match(/<ul class="show-list rv" id="show-list">[\s\S]*?<\/ul>/);
  if (liste) {
    const daten = [...liste[0].matchAll(/data-date="([^"]*)"/g)].map((m) => m[1]);
    const sortiert = [...daten].sort();
    if (daten.join(",") !== sortiert.join(","))
      meckern("Kommende Shows stehen nicht chronologisch: " + daten.join(", "));
  }
}

{
  /* Die Sortier-Regel selbst, mit einem Stand, den die Verwaltung so liefern
     koennte: durcheinander, zwei Termine am selben Tag, einer ohne Datum. */
  const db = JSON.parse(JSON.stringify(template));
  db.sections.shows.items = [
    { name: "C spaet", date: "2099-07-01", time: "23:00" },
    { name: "A frueh", date: "2099-06-01" },
    { name: "D ohne Datum" },
    { name: "B frueh am selben Tag", date: "2099-07-01", time: "18:30" },
    { name: "E ohne Uhrzeit, selber Tag", date: "2099-07-01" },
  ];
  nachziehen(db, korr);

  /* Dieselbe Rechnung wie im Generator — hier als Erwartung ausgeschrieben,
     damit der Test nicht einfach die Umsetzung wiederholt. */
  const soll = ["A frueh", "E ohne Uhrzeit, selber Tag", "B frueh am selben Tag", "C spaet", "D ohne Datum"];

  const zeit = (i) => {
    const m = String(i?.time ?? "").match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  };
  const ist = [...db.sections.shows.items]
    .sort((a, b) => {
      const da = a.date || "", dbb = b.date || "";
      if (!da && !dbb) return 0;
      if (!da) return 1;
      if (!dbb) return -1;
      if (da !== dbb) return da < dbb ? -1 : 1;
      return zeit(a) - zeit(b);
    })
    .map((i) => i.name);
  if (ist.join(" | ") !== soll.join(" | "))
    meckern(`Termine falsch sortiert:\n         soll: ${soll.join(" | ")}\n         ist:  ${ist.join(" | ")}`);
}

{
  /* "Auf Website anzeigen" / "Ausblenden" muss wirken — der Schalter der
     Verwaltung entscheidet, keine Regel ueberstimmt ihn mehr.

     Anlass: `shop.sichtbar` in der Korrekturdatei erzwang den Shop-Abschnitt.
     Der Schalter war damit eine Attrappe: ausschalten aenderte nichts. */
  for (const abschnitt of ["shop", "gallery", "references", "booking"]) {
    const aus = JSON.parse(JSON.stringify(template));
    aus.sections[abschnitt].enabled = false;
    nachziehen(aus, korr);
    if (aus.sections[abschnitt].enabled !== false)
      meckern(`"${abschnitt}" wurde wieder eingeschaltet — der Schalter ist wirkungslos`);

    const an = JSON.parse(JSON.stringify(template));
    an.sections[abschnitt].enabled = true;
    nachziehen(an, korr);
    if (an.sections[abschnitt].enabled !== true)
      meckern(`"${abschnitt}" wurde ausgeschaltet, obwohl es an war`);
  }
}

{
  /* Der Preis bekommt genau einen Abstand.

     Anlass: in der Verwaltung stand als Waehrung "CHF " mit Leerzeichen am
     Ende. Auf der Shop-Seite stand darum "CHF  25.—" mit doppeltem Abstand.
     Die Waehrung wird jetzt beschnitten — der Wert in der Datenbank bleibt,
     wie er ist, nur die Ausgabe ist sauber. */
  const faelle = [
    [["25", "CHF "], "CHF 25.—"],
    [["25", " CHF"], "CHF 25.—"],
    [["25", "CHF"], "CHF 25.—"],
    [["25.50", "CHF"], "CHF 25.50"],
    [["", "CHF"], ""],
    [["auf Anfrage", "CHF"], "auf Anfrage"],
    /* Waehrung im Preisfeld. Anlass (12.08.2026): im Shop stand "CHF 25.—"
       neben "5CHF" — beim zweiten Artikel war die Waehrung mit ins Preisfeld
       getippt, und weil dort ein Buchstabe stand, ging der Preis unveraendert
       durch. Jetzt wird sie herausgenommen und der Preis normal gesetzt. */
    [["5CHF", "CHF"], "CHF 5.—"],
    [["5 CHF", "CHF"], "CHF 5.—"],
    [["CHF 12", "CHF"], "CHF 12.—"],
    [["19,90", "EUR"], "EUR 19,90"],
  ];
  for (const [[preis, waehrung], soll] of faelle) {
    const ist = priceTag(preis, waehrung);
    if (ist !== soll) meckern(`priceTag(${JSON.stringify(preis)}, ${JSON.stringify(waehrung)}) = ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`);
    if (/ {2}/.test(ist)) meckern(`doppelter Abstand im Preis: ${JSON.stringify(ist)}`);
  }
}

{
  /* Zwei Ansichten des Shops (12.08.2026, zweiter Anlauf).

     Erst hatte der Shop nur seine eigene Seite — ein veroeffentlichter Artikel
     war "nicht zu sehen", weil ihn auf der Startseite nichts ankuendigte. Dann
     wanderte alles auf die Startseite; auch das war nicht gemeint. Jetzt gilt:
     die Einladung (heller Block) auf der Startseite unter der Galerie, der
     Katalog auf /shop/. Diese Regel sorgt dafuer, dass beide Plaetze da sind.

     Aelter als diese Stelle ist die Regel selbst nicht: der erste Anlauf hiess
     "shopAufStart" und loeste die Shop-Seite auf. Traegt ein Stand jene Marke,
     wird die Seite hier zurueckgeholt — sonst blieben Kunden mit dem
     Zwischenstand haengen. */
  const frisch = JSON.parse(JSON.stringify(template));
  frisch.pages = [
    { slug: "", navLabel: "Home", sections: ["about", "shows", "references", "gallery", "contact"] },
    { slug: "booking", navLabel: "Booking", sections: ["booking", "contact"] },
    { slug: "shop", navLabel: "Shop", sections: ["shop"] },
  ];
  delete frisch.migrationen;

  nachziehen(frisch, korr);

  const start = frisch.pages[0];
  if (!start.sections.includes("shop"))
    meckern("die Einladung fehlt auf der Startseite: " + start.sections.join(", "));
  else if (start.sections.indexOf("shop") !== start.sections.indexOf("gallery") + 1)
    meckern("die Einladung steht nicht direkt unter der Galerie: " + start.sections.join(", "));
  if (!frisch.pages.some((p) => String(p.slug) === "shop")) meckern("die Seite /shop/ fehlt");
  if (frisch.pages.length !== 3) meckern(`${frisch.pages.length} Seiten statt drei`);

  /* Reparatur: der erste Anlauf hatte die Shop-Seite aufgeloest. Wer den Stand
     in der Zwischenzeit gespeichert hat, bekommt sie zurueck — samt
     uebersetztem Seitennamen. */
  const zwischen = JSON.parse(JSON.stringify(template));
  zwischen.pages = [
    { slug: "", navLabel: "Home", sections: ["about", "gallery", "shop", "contact"] },
    { slug: "booking", navLabel: "Booking", sections: ["booking", "contact"] },
  ];
  zwischen.i18n = { de: { pages: { 0: { navLabel: "Start" }, 1: { navLabel: "Booking" } } } };
  zwischen.migrationen = { shopAufStart: true };

  nachziehen(zwischen, korr);

  if (!zwischen.pages.some((p) => String(p.slug) === "shop"))
    meckern("die Shop-Seite kam nicht zurueck: " + zwischen.pages.map((p) => p.slug).join(", "));
  if (zwischen.i18n.de.pages["2"]?.navLabel !== "Shop")
    meckern(`der deutsche Name der Shop-Seite fehlt: ${JSON.stringify(zwischen.i18n.de.pages)}`);

  /* Eine eigene Aufteilung OHNE jene Marke bleibt, wie sie ist: wer den Shop
     bewusst nur auf die Startseite legt, bekommt keine Seite aufgedraengt. */
  const eigenSeiten = JSON.parse(JSON.stringify(template));
  eigenSeiten.pages = [
    { slug: "", navLabel: "Home", sections: ["about", "gallery", "shop", "contact"] },
    { slug: "booking", navLabel: "Booking", sections: ["booking", "contact"] },
  ];
  delete eigenSeiten.migrationen;
  nachziehen(eigenSeiten, korr);
  if (eigenSeiten.pages.length !== 2)
    meckern("eine eigene Aufteilung bekam eine Shop-Seite aufgedraengt");

  // Und mit gesetzter Marke wird gar nichts mehr angefasst.
  const marke = JSON.parse(JSON.stringify(template));
  marke.pages = [{ slug: "", navLabel: "Home", sections: ["about", "gallery", "contact"] }, { slug: "laden", navLabel: "Laden", sections: ["shop"] }];
  marke.migrationen = { shopSeiteUndEinladung: true };
  nachziehen(marke, korr);
  if (marke.pages[0].sections.includes("shop"))
    meckern("die Einladung wurde trotz gesetzter Marke nachgetragen");
}
