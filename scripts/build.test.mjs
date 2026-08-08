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
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { adoptTexts, collectStrings, localize, nachziehen } from "./build.mjs";

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
live2.sections.references.items = template.sections.references.items.map((i) => ({
  ...i,
  city: "ALT",
}));
adoptTexts(live2, template);
if (live2.sections.references.items[1].city !== template.sections.references.items[1].city) {
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
  db.contentRevision = 4;                       // Altlast, darf nichts mehr bewirken
  db.site.artist = "Sam Sparkling";
  db.site.logoText = "Sam Sparkling";
  db.hero.nameMain = "Sparkling";
  db.site.domain = "https://djsamsparkling.netlify.app";
  db.sections.about.paragraphs = ["Der Name **Sparkling** ist kein Zufall."];
  db.sections.references.items = korr.alteReferenzen.map((n) => ({ name: n, city: "?" }));
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
  if (db.sections.references.items.length !== korr.referenzen.length)
    meckern("Referenzliste nicht ersetzt: " + db.sections.references.items.length);
  if (!db.sections.contact.socials.some((x) => /instagram/i.test(x.label))) meckern("Instagram fehlt");
  if (!db.hero.stats.length) meckern("Kennzahlen fehlen");
  if (!db.sections.booking.photo.src) meckern("Booking-Bild fehlt");
  if (db.sections.shop.enabled !== true)
    meckern("Der Shop-Schalter aus der Verwaltung wurde ueberschrieben");
  if (!getan.includes("Schreibweise")) meckern("Schreibweise nicht als Aenderung gemeldet");
}

{
  // Der Kunde hat die Referenzen selbst bearbeitet — dann nichts anfassen.
  const eigen = JSON.parse(JSON.stringify(template));
  eigen.sections.references.items = [{ name: "Nur ein Club", city: "Chur" }];
  eigen.sections.contact.socials = [{ label: "Instagram", url: "https://instagram.com/anders" }];
  eigen.hero.stats = [{ value: "9", label: "Eigene Zahl" }];
  eigen.sections.booking.photo = { src: "eigenes.jpg", alt: "", credit: "" };

  nachziehen(eigen, korr);
  if (eigen.sections.references.items.length !== 1)
    meckern("Eigene Referenzliste wurde ueberschrieben");
  if (eigen.sections.contact.socials.length !== 1)
    meckern("Instagram doppelt eingetragen, obwohl schon vorhanden");
  if (eigen.hero.stats[0].value !== "9") meckern("Eigene Kennzahlen ueberschrieben");
  if (eigen.sections.booking.photo.src !== "eigenes.jpg") meckern("Eigenes Booking-Bild ueberschrieben");
}

{
  // Ohne Korrekturdatei bleibt wenigstens die Schreibweise.
  const nur = JSON.parse(JSON.stringify(template));
  nur.site.artist = "Sam Sparkling";
  nachziehen(nur, null);
  if (nur.site.artist !== "Sam Sparking") meckern("Schreibweise braucht die Korrekturdatei — darf sie nicht");
}

if (fehler) {
  console.error(`\n${fehler} Fehler.`);
  process.exit(1);
}
console.log("adoptTexts: Orte, Kanäle und Einträge bleiben unangetastet; gleich lange Listen werden weiter übernommen.");
console.log("localize: Kanal-Namen bleiben in jeder Sprache stehen, auch bei veralteten Übersetzungen.");
console.log("nachziehen: Schreibweise immer; Listen, Kanaele und Bilder nur solange sie in der\n            Verwaltung unangetastet sind. Schalter und eigene Eintraege bleiben unberuehrt.");
