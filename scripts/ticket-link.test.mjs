/**
 * Ein Ticket-Link ist ein Kaufaufruf — er muss stimmen.
 *
 * URSPRUNG (Sprachnachricht 12.08.2026, 21:12; lokal ausgewertet, Dialekt
 * teilweise unsicher): bei "Aftersun" stand im CMS ein gueltiger Ticket-Link,
 * oeffentlich erschien aber nur das Wort "Gebucht".
 *
 * Das ist GELOEST — `showRow` haengt den Knopf seit dem 12.08. an die Adresse
 * und nicht mehr an den Status. Der erste Fall unten haelt das fest, damit es
 * nicht wieder zurueckfaellt: "gebucht" heisst, dass Sam den Termin hat, nicht
 * dass es keine Tickets gibt.
 *
 * BEIM NACHGEHEN GEFUNDEN (17.09.2026): "abgesagt" hatte nie jemand angesehen.
 * Den Status gibt es in der Verwaltung, in den strukturierten Daten stand brav
 * `EventCancelled` — die sichtbare Zeile bot trotzdem einen Ticket-Knopf an,
 * der Kalender machte aus dem Tag sogar einen Link in den Verkauf. Dasselbe
 * galt im Kalender fuer "ausverkauft".
 *
 * Geprueft wird gebaut, nicht gelesen: echter Generator, echte Ausgabe.
 *
 *   node --test scripts/ticket-link.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEUTE = "2026-09-17";

async function repoKopie() {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "s-mi-ticket-")));
  await cp(ROOT, dir, {
    recursive: true,
    filter: (q) => !/(^|\/)(\.git|media|node_modules)(\/|$)/.test(q.slice(ROOT.length)),
  });
  await mkdir(join(dir, "media"), { recursive: true });
  return dir;
}

function baue(dir, env = {}) {
  return new Promise((fertig) => {
    const kind = spawn(process.execPath, [join(dir, "scripts/build.mjs")], {
      cwd: dir,
      env: { ...process.env, BUILD_DATE: HEUTE, ...env },
    });
    let stdout = "", stderr = "";
    kind.stdout.on("data", (d) => (stdout += d));
    kind.stderr.on("data", (d) => (stderr += d));
    kind.on("close", (status) => fertig({ status, stdout, stderr }));
  });
}

/* Vier kommende Termine — je einer pro Fall. Beispielnamen und Beispieladressen,
   keine Kundendaten und kein echter Verkauf. Die Daten liegen bewusst in der
   Zukunft: nur Kommendes steht unter "Shows". */
const TERMINE = [
  { date: "2026-10-01", name: "Gebucht mit Link", city: "Beispielstadt", country: "CH",
    status: "booked", ticketUrl: "https://tickets.example/abend-1", ticketLabel: "Tickets" },
  { date: "2026-10-02", name: "Gebucht ohne Link", city: "Beispielstadt", country: "CH",
    status: "booked", ticketUrl: "DM for Friendlist " },
  { date: "2026-10-03", name: "Ausverkauft mit Link", city: "Beispielstadt", country: "CH",
    status: "soldout", ticketUrl: "https://tickets.example/abend-3" },
  { date: "2026-10-04", name: "Abgesagt mit Link", city: "Beispielstadt", country: "CH",
    status: "cancelled", ticketUrl: "https://tickets.example/abend-4" },
];

async function mitTerminen(dir, termine = TERMINE) {
  const stand = JSON.parse(await readFile(join(dir, "content/site.json"), "utf8"));
  stand.sections.shows.items = termine;
  await writeFile(join(dir, "content/site.json"), JSON.stringify(stand, null, 2) + "\n");
}

/** Die Termin-Zeilen einer gebauten Seite, aufgeschluesselt. */
function zeilen(dir, rel) {
  const html = readFileSync(join(dir, rel), "utf8");
  return [...html.matchAll(/<li class="show([^"]*)"[\s\S]*?<\/li>/g)].map(([block, klassen]) => ({
    klassen: klassen.trim(),
    name: (block.match(/class="show-name">([^<]*)</) || [])[1] || "",
    /* Der Knopf: ein echter Link im Bedienbereich der Zeile. */
    knopf: (block.match(/<span class="show-cta"><a class="btn btn-sm" href="([^"]*)"[^>]*>([^<]*)</) || [])
      .slice(1),
    /* Oder eben nur ein Wort. */
    wort: (block.match(/<span class="show-cta"><span class="mono">([^<]*)</) || [])[1] || "",
  }));
}

const finde = (alle, name) => alle.find((z) => z.name === name);

test("gebucht heisst nicht ausverkauft: der Ticket-Knopf steht da", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitTerminen(dir);
  const bau = await baue(dir);
  assert.equal(bau.status, 0, `der Bau ist gescheitert:\n${bau.stderr}`);

  const alle = zeilen(dir, "shows/index.html");
  assert.equal(alle.length, 4, "es stehen nicht alle vier Termine auf der Seite");

  /* GENAU DER BEFUND VOM 12.08.2026: gueltige Adresse, Status "gebucht" —
     und trotzdem stand da nur das Wort "Gebucht". */
  const gebucht = finde(alle, "Gebucht mit Link");
  assert.deepEqual(gebucht.knopf, ["https://tickets.example/abend-1", "Tickets"],
    "ein gebuchter Abend mit gueltigem Ticket-Link zeigt keinen Knopf");
  assert.equal(gebucht.wort, "", "statt des Knopfes steht nur ein Wort da");
  assert.match(gebucht.klassen, /\bbooked\b/, "die Zeile ist nicht mehr als gebucht erkennbar");
});

test("aus Freitext wird kein Link erfunden", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitTerminen(dir);
  assert.equal((await baue(dir)).status, 0);

  const z = finde(zeilen(dir, "shows/index.html"), "Gebucht ohne Link");
  assert.deepEqual(z.knopf, [], "aus „DM for Friendlist“ wurde ein Kauflink gebaut");
  assert.equal(z.wort, "DM for Friendlist", "der Hinweis aus dem Ticket-Feld fehlt");
});

test("ausverkauft fordert nicht zum Kauf auf", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitTerminen(dir);
  assert.equal((await baue(dir)).status, 0);

  const z = finde(zeilen(dir, "shows/index.html"), "Ausverkauft mit Link");
  assert.deepEqual(z.knopf, [], "ein ausverkaufter Abend bietet Tickets an");
  assert.equal(z.wort, "Ausverkauft", "es steht nicht da, dass es ausverkauft ist");
});

test("ABGESAGT fordert nicht zum Kauf auf — und sagt es", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitTerminen(dir);
  assert.equal((await baue(dir)).status, 0);

  const z = finde(zeilen(dir, "shows/index.html"), "Abgesagt mit Link");
  assert.deepEqual(z.knopf, [],
    "ein abgesagter Abend bietet weiterhin Tickets an — das war der Befund vom 17.09.2026");
  assert.equal(z.wort, "Abgesagt", "am abgesagten Abend steht nicht, dass er abgesagt ist");
  assert.match(z.klassen, /\bcancelled\b/, "die Zeile ist nicht als abgesagt gekennzeichnet");

  /* Der Link bleibt im INHALT stehen — nur gezeigt wird er nicht. Nichts
     geloescht, nichts umgeschrieben. */
  const stand = JSON.parse(readFileSync(join(dir, "content/site.json"), "utf8"));
  const roh = stand.sections.shows.items.find((i) => i.name === "Abgesagt mit Link");
  assert.equal(roh.ticketUrl, "https://tickets.example/abend-4", "der Ticket-Link wurde im Inhalt angetastet");
  assert.equal(roh.status, "cancelled", "der Status wurde im Inhalt angetastet");
});

test("auch der Kalender fuehrt nicht in einen Verkauf, den es nicht gibt", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitTerminen(dir);
  assert.equal((await baue(dir)).status, 0);

  /* Der Kalender in assets/site.js macht aus `url` einen Link — ohne jede
     Ruecksicht auf den Status. Also darf dort bei abgesagt und ausverkauft
     gar nichts stehen. */
  const html = readFileSync(join(dir, "shows/index.html"), "utf8");
  const daten = JSON.parse(
    (html.match(/<script type="application\/json" id="shows-data">([\s\S]*?)<\/script>/) || [])[1]
  );
  const nach = (name) => daten.find((d) => d.name === name);

  assert.equal(nach("Gebucht mit Link").url, "https://tickets.example/abend-1",
    "der gebuchte Abend hat im Kalender keinen Ticket-Link mehr");
  assert.equal(nach("Abgesagt mit Link").url, "", "der abgesagte Abend verlinkt im Kalender in den Verkauf");
  assert.equal(nach("Ausverkauft mit Link").url, "", "der ausverkaufte Abend verlinkt im Kalender in den Verkauf");

  /* Die Termine selbst stehen weiterhin im Kalender — nur ohne Kauflink. */
  assert.equal(daten.length, 4, "ein Termin ist aus dem Kalender verschwunden");
  assert.equal(nach("Abgesagt mit Link").status, "cancelled", "der Status fehlt im Kalender");
});

test("die strukturierten Daten widersprechen sich nicht", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitTerminen(dir);
  assert.equal((await baue(dir)).status, 0);

  const html = readFileSync(join(dir, "shows/index.html"), "utf8");
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => JSON.parse(m[1]))
    .flatMap((d) => d["@graph"] || [d])
    .filter((d) => d["@type"] === "MusicEvent");
  const nach = (name) => ld.find((d) => String(d.name).includes(name));

  const abgesagt = nach("Abgesagt mit Link");
  assert.equal(abgesagt.eventStatus, "https://schema.org/EventCancelled", "der Abend gilt als planmaessig");
  assert.equal(abgesagt.offers, undefined,
    "zu einem abgesagten Abend steht ein Kaufangebot in den strukturierten Daten");

  const gebucht = nach("Gebucht mit Link");
  assert.equal(gebucht.offers?.availability, "https://schema.org/InStock",
    "zum gebuchten Abend fehlt das Angebot");
  assert.equal(nach("Ausverkauft mit Link").offers?.availability, "https://schema.org/SoldOut",
    "der ausverkaufte Abend gilt maschinell als verfuegbar");
});

test("„Abgesagt“ steht auf jeder Sprachseite in ihrer Sprache", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitTerminen(dir);
  assert.equal((await baue(dir)).status, 0);

  /* Der Text steht bewusst NICHT im Inhalt (content.ui): was dort steht, gilt
     unuebersetzt in allen Sprachen — so wie heute „Gebucht" auch auf /en/ und
     /fr/ steht. Ein neuer Text geht diesen Weg nicht mit. */
  for (const [rel, erwartet] of [
    ["shows/index.html", "Abgesagt"],
    ["en/shows/index.html", "Cancelled"],
    ["fr/shows/index.html", "Annulé"],
  ]) {
    const z = finde(zeilen(dir, rel), "Abgesagt mit Link");
    assert.equal(z.wort, erwartet, `${rel}: dort steht „${z.wort}“ statt „${erwartet}“`);
    assert.deepEqual(z.knopf, [], `${rel}: der abgesagte Abend bietet Tickets an`);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   Ein abgesagter Abend hat NICHT STATTGEFUNDEN

   Review-Befund 17.09.2026: `vergangeneAlsReferenz` sah nur aufs Datum, und
   `showVorbei` tut dasselbe. Ein abgesagter Termin waere am Tag danach als
   Referenz erschienen — als haette Sam dort gespielt. Das Abwaehlen von Hand
   reicht dafuer nicht: niemand denkt daran, an einem abgesagten Abend noch ein
   Haekchen zu setzen.
   ══════════════════════════════════════════════════════════════════════════ */

const { vergangeneAlsReferenz } = await import(resolve(ROOT, "scripts/build.mjs"));

test("abgesagt wird nie zur Referenz — auch nicht, wenn das Datum vorbei ist", () => {
  const shows = {
    items: [
      { date: "2026-09-01", name: "Fand statt", city: "Chur", status: "confirmed" },
      { date: "2026-09-02", name: "Fiel aus", city: "Wattwil", status: "cancelled" },
      { date: "2026-09-03", name: "Fiel auch aus", city: "Uzwil", status: "cancelled",
        ticketUrl: "https://tickets.example/abend-x" },
      // Ausverkauft heisst: es fand statt, und zwar voll. Das ist eine Referenz.
      { date: "2026-09-04", name: "War voll", city: "Luzern", status: "soldout" },
    ],
  };
  const namen = vergangeneAlsReferenz(shows, [], HEUTE).map((r) => r.name);
  assert.deepEqual(namen, ["War voll", "Fand statt"],
    "ein abgesagter Abend steht bei den Referenzen — als haette Sam dort gespielt");
});

test("ein KUENFTIGER abgesagter Termin bleibt sichtbar — nur eben nicht als Referenz", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitTerminen(dir);
  assert.equal((await baue(dir)).status, 0);

  const html = readFileSync(join(dir, "shows/index.html"), "utf8");
  const zeile = (html.match(/<li class="show[^"]*"[^>]*data-name="Abgesagt mit Link"[^>]*>/) || [])[0];
  assert.ok(zeile, "der abgesagte Termin steht gar nicht mehr unter „Shows“");

  /* DAS ist der Weg zum Browser: verstreicht das Datum zwischen zwei Bauten,
     nimmt assets/site.js die Zeile aus der Liste — und darf sie nicht bei den
     Referenzen nachtragen. Gesagt wird ihm das mit `data-ref="nein"`. */
  assert.match(zeile, /data-ref="nein"/,
    "der abgesagte Termin traegt kein data-ref=\"nein\" — der Browser wuerde ihn nachtragen");

  // Die uebrigen drei tragen es NICHT: sie haben stattgefunden bzw. finden statt.
  for (const name of ["Gebucht mit Link", "Gebucht ohne Link", "Ausverkauft mit Link"]) {
    const andere = (html.match(new RegExp(`<li class="show[^"]*"[^>]*data-name="${name}"[^>]*>`)) || [])[0];
    assert.ok(andere, `${name}: die Zeile fehlt`);
    assert.ok(!/data-ref="nein"/.test(andere), `${name}: wird faelschlich von den Referenzen ausgeschlossen`);
  }
});

test("und der Browser haelt sich daran", async (t) => {
  /* Die echte Funktion aus assets/site.js, gegen ein Stub-DOM — dieselbe
     Bauart wie in scripts/vergangene-referenzen.test.mjs. */
  const quelle = readFileSync(join(ROOT, "assets/site.js"), "utf8");
  const i = quelle.indexOf("  function refSchluesselJS(");
  const j = quelle.indexOf('  var showList = document.getElementById("show-list");', i);
  const liste = {
    children: [],
    attrs: { "data-mobil": "4", "data-booking": "/booking/#booking" },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    hasAttribute(k) { return k in this.attrs; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(k) { this.children.push(k); return k; },
    insertBefore(k) { this.children.push(k); return k; },
    querySelectorAll() { return []; },
  };
  const mk = () => ({
    children: [], attrs: {}, className: "", textContent: "",
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(k) { this.children.push(k); return k; },
    querySelector() { return null; },
  });
  const dokument = {
    getElementById: (id) => (id === "venue-list" ? liste : null),
    querySelector: () => null,
    createElement: mk,
  };
  const nachtragen = new Function("document", quelle.slice(i, j) + "; return alsReferenzNachtragen;")(dokument);

  nachtragen({ getAttribute: (k) => ({ "data-name": "Fiel aus", "data-city": "Wattwil",
    "data-date": "2026-09-16", "data-ref": "nein" }[k] ?? null) });
  assert.equal(liste.children.length, 0, "der Browser traegt einen abgesagten Abend als Referenz nach");

  // Gegenprobe: ohne die Marke kommt derselbe Abend sehr wohl nach.
  nachtragen({ getAttribute: (k) => ({ "data-name": "Fand statt", "data-city": "Chur",
    "data-date": "2026-09-16" }[k] ?? null) });
  assert.equal(liste.children.length, 1, "ein stattgefundener Abend wird nicht mehr nachgetragen");
});
