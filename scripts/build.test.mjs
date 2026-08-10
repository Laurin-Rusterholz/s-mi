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
  db.sections.references.items = korr.alteReferenzen[0].map((n) => ({ name: n, city: "?" }));
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
  const eigeneKanaele = eigen.sections.contact.socials;
  if (eigeneKanaele.filter((x) => /instagram/i.test(x.label + " " + (x.url || ""))).length !== 1)
    meckern("Instagram doppelt eingetragen, obwohl schon vorhanden");
  // Die erwarteten Kanaele kommen dazu — aber ausdruecklich OHNE Adresse.
  // Ein geratener Profil-Link waere schlimmer als ein fehlender.
  for (const l of korr.kanaele.erwartet) {
    const treffer = eigeneKanaele.filter((x) => new RegExp(l, "i").test(x.label + " " + (x.url || "")));
    if (treffer.length !== 1) meckern(`Kanal "${l}" steht ${treffer.length}x statt genau 1x`);
  }
  for (const l of ["TikTok", "Spotify"]) {
    const k = eigeneKanaele.find((x) => x.label === l);
    if (k && k.url) meckern(`Fuer "${l}" wurde eine Adresse geraten: ${k.url}`);
  }
  if (eigen.hero.stats[0].value !== "9") meckern("Eigene Kennzahlen ueberschrieben");
  if (eigen.sections.booking.photo.src !== "eigenes.jpg") meckern("Eigenes Booking-Bild ueberschrieben");
}

{
  /* Die Korrekturen vom August 2026: Kennzahl-Aufschrift, Ort der Show,
     Instagram aus dem Kopf, Waehrung und die neue Seitenaufteilung. Alle
     greifen nur, solange die Stelle in der Verwaltung unangetastet ist. */
  const db = JSON.parse(JSON.stringify(template));
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
  if (db.hero.stats[1].value !== korr.heroShows.wert)
    meckern("Kennzahl Shows steht auf " + db.hero.stats[1].value + " statt " + korr.heroShows.wert);
  if (db.hero.meta) meckern("Genre-Zeile im Hero nicht geraeumt");
  if (db.sections.shows.items[0].city !== "Luzern")
    meckern("Aftersun steht weiter in " + db.sections.shows.items[0].city);
  if (db.sections.shows.items[0].name !== "Aftersun") meckern("Leerzeichen im Show-Namen geblieben");
  const insta = db.sections.contact.socials.find((x) => /instagram/i.test(x.label));
  if (insta.inHeader !== false) meckern("Instagram steht weiter im Kopf");
  if (db.sections.shop.currency !== "CHF") meckern("Waehrung nicht korrigiert: " + db.sections.shop.currency);
  if (db.sections.shop.items[0].linkUrl) meckern('Tipprest "asd" als Kauf-Link geblieben');
  if (db.sections.shop.items[0].price !== "35") meckern("Preis der Ware angefasst");
  if (db.pages.length !== 3) meckern("Booking und Shop haben keine eigene Seite bekommen");
  if (db.pages[1].slug !== "booking" || db.pages[2].slug !== "shop")
    meckern("Seitenadressen stimmen nicht: " + db.pages.map((p) => p.slug).join(", "));
  if (db.pages[0].sections.includes("booking"))
    meckern("Booking steht weiter als Abschnitt auf der Startseite");
}

{
  /* Der Abgleich der Referenzliste. Hier ist die Ersetzung am 10.08.2026 still
     ins Leere gelaufen: in der Datenbank stand ein anderer Altstand als der
     eine, gegen den geprueft wurde — die Website zeigte weiter B9, BBC, IVY,
     Kugl, Sektor 11, The Q, Ultrawild Festival. */
  const namen = (c) => c.sections.references.items.map((i) => i.name);

  // Jeder hinterlegte Altstand muss die Ersetzung ausloesen.
  korr.alteReferenzen.forEach((stand, nr) => {
    const db = JSON.parse(JSON.stringify(template));
    db.sections.references.items = stand.map((n) => ({ name: n, city: "?" }));
    nachziehen(db, korr);
    if (namen(db).length !== korr.referenzen.length)
      meckern(`Altstand ${nr} (${stand.length} Eintraege) loest die Ersetzung nicht aus`);
  });

  // Auch in anderer Reihenfolge — die Verwaltung sortiert beim Speichern um.
  const gedreht = JSON.parse(JSON.stringify(template));
  gedreht.sections.references.items = [...korr.alteReferenzen[0]]
    .sort()
    .map((n) => ({ name: n, city: "?" }));
  nachziehen(gedreht, korr);
  if (namen(gedreht).length !== korr.referenzen.length)
    meckern("Umsortierter Altstand loest die Ersetzung nicht aus");

  // Die vier ausdruecklich genannten Events stehen oben, in dieser Reihenfolge.
  const oben = korr.referenzen.filter((i) => i.highlight).map((i) => i.name);
  const SOLL = ["Kugl", "Sektor 11", "Ultrawild Festival", "BBC"];
  if (oben.join(" | ") !== SOLL.join(" | "))
    meckern("Hervorgehobene Gruppe ist " + oben.join(", ") + " statt " + SOLL.join(", "));

  /* Der Entscheid vom 10.08.2026: "Club Eden SG ersetzt IVY", Picante bleibt,
     und das Jugendopenair St. Gallen kommt als eigener Eintrag dazu — der
     Wattwiler bleibt daneben stehen, es sind zwei verschiedene Anlaesse. */
  const alle = korr.referenzen.map((i) => i.name);
  for (const n of ["Aftersun Festival", "Picante", "Club Eden"])
    if (!alle.includes(n)) meckern(`"${n}" fehlt in der Referenzliste`);
  if (alle.includes("IVY")) meckern('"IVY" steht noch da — Club Eden sollte ersetzen');

  const jugend = korr.referenzen.filter((i) => i.name === "Jugendopenair");
  const jugendOrte = jugend.map((i) => i.city).sort();
  if (jugendOrte.join(" | ") !== "St. Gallen | Wattwil")
    meckern("Jugendopenair: erwartet St. Gallen und Wattwil, da steht " + (jugendOrte.join(", ") || "nichts"));

  // Keine Dublette: derselbe Name am selben Ort darf nur einmal vorkommen.
  const paare = korr.referenzen.map((i) => `${i.name} — ${i.city}`);
  const doppelt = paare.filter((p, idx) => paare.indexOf(p) !== idx);
  if (doppelt.length) meckern("Referenz doppelt: " + [...new Set(doppelt)].join(", "));

  // Keine erfundene fuenfte Hervorhebung.
  if (korr.referenzen.filter((i) => i.highlight).length !== 4)
    meckern("Es sollen genau vier Referenzen hervorgehoben sein");

  // Zu jedem Eintrag gehoert ein uebersetzter Ort — sonst rutschen die
  // Ortsnamen auf der deutschen und franzoesischen Seite um einen Platz.
  for (const lang of ["de", "fr"]) {
    const orte = korr.i18n[lang].referenzen;
    if (Object.keys(orte).length !== korr.referenzen.length)
      meckern(`i18n ${lang}: ${Object.keys(orte).length} Orte zu ${korr.referenzen.length} Referenzen`);
  }

  // Der Rest traegt keine Buendel mehr — eine durchgehend alphabetische Liste.
  if (korr.referenzen.some((i) => !i.highlight && i.group))
    meckern("Der Rest soll ohne Buendel-Ueberschriften alphabetisch stehen");
}

{
  /* Die Zahl neben "Shows" wird immer gesetzt — genau darum geht es: in der
     Datenbank stand 2, die Seite zeigte "2+ SHOWS". Geprueft wird beides,
     der Weg ueber die Aufschrift und der ueber den Platz in der Liste. */
  const db = JSON.parse(JSON.stringify(template));
  db.hero.stats = [
    { value: "2021", label: "First set" },
    { value: "2", label: "Shows" },
    { value: "150", label: "BPM home base" },
  ];
  nachziehen(db, korr);
  if (db.hero.stats[1].value !== "30")
    meckern('Kennzahl Shows steht auf "' + db.hero.stats[1].value + '" statt "30"');
  if (db.hero.stats[0].value !== "2021" || db.hero.stats[2].value !== "150")
    meckern("Die anderen Kennzahlen wurden mitveraendert");

  const verschoben = JSON.parse(JSON.stringify(template));
  verschoben.hero.stats = [
    { value: "2", label: "Shows" },
    { value: "2021", label: "First set" },
  ];
  nachziehen(verschoben, korr);
  if (verschoben.hero.stats[0].value !== "30")
    meckern("Kennzahl an anderer Stelle nicht ueber die Aufschrift gefunden");

  // Auch mit der alten Aufschrift, falls die Umbenennung nicht mehr greift.
  const alt = JSON.parse(JSON.stringify(template));
  alt.hero.stats = [{ value: "2", label: "Clubs & Festivals" }];
  nachziehen(alt, korr);
  if (alt.hero.stats[0].value !== "30")
    meckern("Kennzahl mit alter Aufschrift nicht gefunden");

  // Eine fremde Kennzahl an derselben Stelle bleibt unberuehrt — kein
  // Rueckfall auf den Platz in der Liste.
  const fremd = JSON.parse(JSON.stringify(template));
  fremd.hero.stats = [
    { value: "2021", label: "First set" },
    { value: "9", label: "Eigene Zahl" },
    { value: "150", label: "BPM home base" },
  ];
  nachziehen(fremd, korr);
  if (fremd.hero.stats[1].value !== "9")
    meckern("Fremde Kennzahl an Platz 2 wurde ueberschrieben");
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
  eigen.pages = [
    { slug: "", navLabel: "Home", sections: ["about"] },
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
  /* "First set 2021" soll ganz weg — im Hero und in der Faktenzeile von
     "Ueber mich". Entscheidend ist, WIE: die Kennzahl wird markiert, nicht
     aus der Liste geloescht. Die Uebersetzungen haengen am Platz in der
     Liste; wer kuerzt, schiebt jede Uebersetzung dahinter um einen Platz
     (auf der deutschen Seite stand dann "Erstes Set" ueber der Zahl 30). */
  const db = JSON.parse(JSON.stringify(template));
  db.hero.stats = [
    { label: "First set", value: "2021" },
    { label: "Shows", value: "30" },
    { label: "BPM home base", value: "150" },
  ];
  db.sections.about.facts = [
    { label: "First set", value: "2021" },
    { label: "Clubs & festivals", value: "7+" },
  ];
  db.i18n = db.i18n || {};
  db.i18n.de = db.i18n.de || {};
  db.i18n.de.hero = { stats: { 0: { label: "Erstes Set" }, 1: { label: "Shows" }, 2: { label: "BPM Zuhause" } } };

  nachziehen(db, korr);

  if (db.hero.stats.length !== 3)
    meckern("Kennzahl wurde geloescht statt markiert — die Uebersetzungen verrutschen dadurch");
  if (db.hero.stats[0].entfernt !== true) meckern('Hero-Kennzahl "First set" nicht stillgelegt');
  if (db.sections.about.facts[0].entfernt !== true)
    meckern('Faktenzeile "First set" in "Ueber mich" nicht stillgelegt');
  if (db.hero.stats.some((s) => s.label === "Shows" && s.entfernt))
    meckern("Es wurde die falsche Kennzahl stillgelegt");
  // Die Uebersetzung sitzt weiter auf demselben Platz wie ihre Kennzahl.
  if (db.i18n.de.hero.stats["1"].label !== "Shows")
    meckern("Uebersetzung der Kennzahlen ist verrutscht");

  // Wiederholbar: ein zweiter Lauf darf nichts mehr melden und nichts kippen.
  const nochmal = nachziehen(db, korr);
  if (nochmal.some((m) => /Kennzahl\(en\) entfernt/.test(m)))
    meckern("Die Stilllegung meldet sich beim zweiten Lauf erneut");
  if (db.hero.stats.length !== 3 || db.hero.stats[0].entfernt !== true)
    meckern("Zweiter Lauf veraendert die Kennzahlen");
}

if (fehler) {
  console.error(`\n${fehler} Fehler.`);
  process.exit(1);
}
console.log("adoptTexts: Orte, Kanäle und Einträge bleiben unangetastet; gleich lange Listen werden weiter übernommen.");
console.log("localize: Kanal-Namen bleiben in jeder Sprache stehen, auch bei veralteten Übersetzungen.");
console.log("nachziehen: Schreibweise immer; Listen, Kanaele und Bilder nur solange sie in der\n            Verwaltung unangetastet sind. Schalter und eigene Eintraege bleiben unberuehrt.");
console.log("nachziehen: Kennzahl \"Shows\", Aftersun in Luzern, Instagram aus dem Kopf, Waehrung\n            CHF, eigene Seiten fuer Booking und Shop — jeweils nur auf dem alten Stand.");
console.log("nachziehen: Referenzen — jeder bekannte Altstand loest die Ersetzung aus, auch\n            umsortiert; oben Kugl, Sektor 11, Ultrawild, BBC; Club Eden statt IVY,\n            Jugendopenair in St. Gallen UND Wattwil, keine Dublette.");
console.log("nachziehen: Die Zahl neben \"Shows\" steht auf 30 — gefunden ueber die Aufschrift\n            (auch die alte), nie ueber den Platz in der Liste.");
console.log("nachziehen: TikTok und Spotify werden genannt, aber ohne geratene Adresse;\n            Instagram bleibt einmalig.");
console.log("nachziehen: \"First set 2021\" wird stillgelegt statt geloescht — die Kennzahlen\n            behalten ihren Platz, damit die Uebersetzungen nicht verrutschen.");
