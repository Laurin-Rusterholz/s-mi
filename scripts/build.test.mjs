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
   nachziehen(): die Datenbank traegt noch den Stand von vor der Umbenennung.
   Erwartet: jede Schreibweise korrigiert, Hostname unversehrt, Referenzen und
   Kanaele aus der Vorlage, Shop aus — und beim zweiten Aufruf passiert nichts
   mehr, weil der Stand jetzt in der Datenbank steht.
   ------------------------------------------------------------------------ */
{
  const alt = JSON.parse(JSON.stringify(template));
  delete alt.contentRevision;
  alt.site.artist = "Sam Sparkling";
  alt.site.logoText = "Sam Sparkling";
  alt.hero.nameMain = "Sparkling";
  alt.site.domain = "https://djsamsparkling.netlify.app";
  alt.site.keywords = ["Sam Sparkling", "Hardstyle DJ"];
  alt.sections.about.paragraphs = ["Der Name **Sparkling** ist kein Zufall."];
  alt.sections.contact.socials = [{ label: "Mixcloud", url: "https://www.mixcloud.com/samsparking/" }];
  alt.sections.references.items = [{ city: "St. Gallen", name: "Kugl" }];
  alt.sections.shop.enabled = true;

  const vorher = nachziehen(alt, template);
  if (vorher !== 0) meckern(`nachziehen() meldet Stand ${vorher} statt 0`);

  const alsText = JSON.stringify(alt);
  const hosts = (alsText.match(/djsamsparkling/gi) || []).length;
  const reste = (alsText.match(/[Ss]parkling/g) || []).length - hosts;
  if (reste !== 0) meckern(`${reste}x "Sparkling" nach dem Nachziehen uebrig`);
  if (!hosts) meckern("Hostname djsamsparkling wurde mitkorrigiert — Canonical und Sitemap zeigen ins Leere");
  if (alt.site.artist !== "Sam Sparking") meckern("Kuenstlername nicht korrigiert: " + alt.site.artist);
  if (alt.site.domain !== "https://djsamsparkling.netlify.app") meckern("Domain veraendert: " + alt.site.domain);
  if (alt.sections.references.items.length !== template.sections.references.items.length)
    meckern("Referenzliste nicht aus der Vorlage uebernommen");
  if (!alt.sections.contact.socials.some((s) => s.label === "Instagram"))
    meckern("Instagram fehlt nach dem Nachziehen");
  if (alt.sections.shop.enabled !== false) meckern("Shop steht nach dem Nachziehen wieder auf sichtbar");
  if (alt.contentRevision !== template.contentRevision) meckern("Stand nicht mitgeschrieben");
  if (nachziehen(alt, template) !== null) meckern("nachziehen() greift ein zweites Mal");
}

/* Ein in der Verwaltung eingeschalteter Abschnitt darf durch eine neuere
   Vorlagen-Fassung nicht wieder ausgehen: nur die Schritte laufen, die seit
   dem Stand der Datenbank dazugekommen sind. */
{
  const db = JSON.parse(JSON.stringify(template));
  db.contentRevision = 2;
  db.sections.shop.enabled = true;
  db.sections.booking.photo = { src: "", alt: "", credit: "" };

  nachziehen(db, template);

  if (db.sections.shop.enabled !== true)
    meckern("Der in der Verwaltung eingeschaltete Shop wurde vom Nachziehen wieder ausgeschaltet");
  if (!db.sections.booking.photo.src)
    meckern("Schritt 3 (Bild im Booking) ist nicht gelaufen");
  if (db.contentRevision !== template.contentRevision)
    meckern("Stand nach dem Teil-Nachziehen falsch: " + db.contentRevision);
}

if (fehler) {
  console.error(`\n${fehler} Fehler — adoptTexts schmiert Texte über die Listen.`);
  process.exit(1);
}
console.log("adoptTexts: Orte, Kanäle und Einträge bleiben unangetastet; gleich lange Listen werden weiter übernommen.");
console.log("localize: Kanal-Namen bleiben in jeder Sprache stehen, auch bei veralteten Übersetzungen.");
console.log("nachziehen: Schreibweise korrigiert, Hostname unversehrt, greift nur einmal — und ein\n            in der Verwaltung eingeschalteter Abschnitt bleibt eingeschaltet.");
