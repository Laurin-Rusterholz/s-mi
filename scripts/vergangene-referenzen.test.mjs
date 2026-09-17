/**
 * Ein vergangener Auftritt fällt nicht ersatzlos von der Seite.
 *
 * WUNSCH AUS DEM VIDEO (25.08.2026, Sek. 29–50): Sämi zeigt auf die
 * Referenzen und sagt, vergangene Auftritte sollen dort automatisch landen —
 * er ging davon aus, dass es schon so sei.
 *
 * Das stimmte einmal: `showsNachReferenzen` tat genau das. Am 07.09.2026 wurde
 * es entfernt, WEIL es unter „Shows" einen Rückblick gab und derselbe Abend
 * sonst zweimal auf derselben Seite stand. Am 15.09.2026 ist der Rückblick auf
 * ausdrücklichen Wunsch verschwunden — damit war die Begründung weg, der
 * Schritt aber nicht nachgezogen. Seither fällt ein Termin, dessen Datum
 * verstreicht, ersatzlos von der Seite.
 *
 * Die Regeln, unter denen es zurückkommt — jede davon hat hier ihren Fall:
 *
 *   1. angehängt, nie einsortiert (die gepflegten ersten vier bleiben)
 *   2. keine Dubletten, verglichen über Name UND Ort
 *   3. abwählbar je Termin (`nichtAlsReferenz`)
 *   4. in die Verwaltung wird nichts geschrieben
 *   5. auch OHNE neuen Build — verstreicht ein Datum zwischen zwei Bauten,
 *      trägt der Browser nach (assets/site.js)
 *   6. kein Datum wird angefasst
 *
 * Aufruf:  node --test scripts/vergangene-referenzen.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, cp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { vergangeneAlsReferenz } = await import(resolve(ROOT, "scripts/build.mjs"));

const HEUTE = "2026-09-17";

async function repoKopie() {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "s-mi-vergangene-")));
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

/** Die Referenzen einer gebauten Seite, in der Reihenfolge der Seite. */
function referenzen(dir, rel) {
  const datei = join(dir, rel);
  if (!existsSync(datei)) return null;
  const html = readFileSync(datei, "utf8");
  const block = html.match(/<ul class="venue-list rv"[\s\S]*?<\/ul>/);
  if (!block) return null;
  return [...block[0].matchAll(/<li([^>]*)><a[\s\S]*?class="venue-name">([^<]*)<\/span><span class="venue-city">([^<]*)</g)]
    .map(([, attr, name, ort]) => ({
      name: name.trim(),
      ort: ort.trim(),
      extra: /\bdata-extra\b/.test(attr),
      ausShow: (attr.match(/data-aus-show="([^"]*)"/) || [])[1] || "",
    }));
}

/* Ein überschaubarer Stand: vier gepflegte Referenzen (die Handy-Vorschau),
   dazu Termine — vergangene, einen kommenden, einen abgewählten und einen,
   der schon als Referenz gepflegt ist. Beispielnamen, keine Kundendaten. */
async function mitStand(dir, aenderung = (s) => s) {
  const stand = JSON.parse(await readFile(join(dir, "content/site.json"), "utf8"));
  stand.sections.references.items = [
    { name: "Erste Referenz", city: "Beispielstadt" },
    { name: "Zweite Referenz", city: "Beispielstadt" },
    { name: "Dritte Referenz", city: "Beispielstadt" },
    { name: "Vierte Referenz", city: "Beispielstadt" },
    { name: "Gepflegter Club", city: "Chur" },
  ];
  stand.sections.shows.items = [
    { date: "2026-09-16", name: "Gestern Abend", city: "Herisau", country: "CH", status: "confirmed" },
    { date: "2026-08-01", name: "Lange her", city: "Luzern", country: "CH", status: "confirmed" },
    { date: "2026-12-24", name: "Kommt noch", city: "Chur", country: "CH", status: "confirmed" },
    { date: "2026-07-07", name: "Abgewaehlt", city: "Wattwil", country: "CH", status: "confirmed",
      nichtAlsReferenz: true },
    // Derselbe Auftritt steht schon gepflegt in der Liste — kein zweites Mal.
    { date: "2026-06-06", name: "Gepflegter Club", city: "Chur", country: "CH", status: "confirmed" },
  ];
  await writeFile(join(dir, "content/site.json"), JSON.stringify(aenderung(stand), null, 2) + "\n");
}

test("vergangene Auftritte stehen hinten bei den Referenzen", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitStand(dir);

  const lauf = await baue(dir);
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  for (const rel of ["shows/index.html", "en/shows/index.html", "fr/shows/index.html"]) {
    const refs = referenzen(dir, rel);
    assert.ok(refs, `${rel}: keine Referenzliste`);

    /* 1. DIE GEPFLEGTEN ERSTEN VIER BLEIBEN, wo sie sind — auf dem Handy sind
          sie die einzigen sichtbaren. */
    assert.deepEqual(refs.slice(0, 4).map((r) => r.name),
      ["Erste Referenz", "Zweite Referenz", "Dritte Referenz", "Vierte Referenz"],
      `${rel}: die ersten vier sind nicht mehr die gepflegten`);
    assert.deepEqual(refs.slice(0, 4).map((r) => r.extra), [false, false, false, false],
      `${rel}: eine der ersten vier ist eingeklappt`);

    /* Angehängt, das Jüngste zuerst — und nur Vergangenes. */
    const neu = refs.filter((r) => r.ausShow);
    assert.deepEqual(neu.map((r) => `${r.name}|${r.ausShow}`),
      ["Gestern Abend|2026-09-16", "Lange her|2026-08-01"],
      `${rel}: die nachgetragenen Auftritte stimmen nicht`);
    assert.ok(refs.indexOf(neu[0]) >= 5, `${rel}: nachgetragen wurde nicht hinten`);

    /* 2. KEINE DUBLETTE: "Gepflegter Club — Chur" steht einmal, und zwar als
          gepflegter Eintrag (ohne data-aus-show). */
    const club = refs.filter((r) => r.name === "Gepflegter Club");
    assert.equal(club.length, 1, `${rel}: "Gepflegter Club" steht doppelt`);
    assert.equal(club[0].ausShow, "", `${rel}: der gepflegte Eintrag wurde durch einen automatischen ersetzt`);

    /* 3. ABGEWÄHLT bleibt draussen. */
    assert.ok(!refs.some((r) => r.name === "Abgewaehlt"),
      `${rel}: ein abgewählter Termin steht trotzdem in den Referenzen`);

    /* Und Kommendes gehört nicht hierher — das steht unter „Shows". */
    assert.ok(!refs.some((r) => r.name === "Kommt noch"),
      `${rel}: ein kommender Termin steht schon bei den Referenzen`);
  }

  /* Unter „Shows" steht weiterhin nur, was kommt. */
  const showsSeite = readFileSync(join(dir, "shows/index.html"), "utf8");
  const abschnitt = (showsSeite.match(/<section class="[^"]*shows-sec"[\s\S]*?<\/section>/) || [""])[0];
  assert.ok(abschnitt.includes("Kommt noch"), "der kommende Termin fehlt unter „Shows“");
  assert.ok(!abschnitt.includes("Gestern Abend"), "ein vergangener Termin steht unter „Shows“");
});

test("in die Verwaltung wird nichts geschrieben — und kein Datum angefasst", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitStand(dir);
  assert.equal((await baue(dir)).status, 0);

  const stand = JSON.parse(readFileSync(join(dir, "content/site.json"), "utf8"));

  /* 4. Die Referenzliste im Inhalt ist unverändert — fünf Einträge, keiner
        davon aus einem Termin. */
  assert.deepEqual(stand.sections.references.items.map((r) => r.name),
    ["Erste Referenz", "Zweite Referenz", "Dritte Referenz", "Vierte Referenz", "Gepflegter Club"],
    "die gepflegte Referenzliste wurde verändert");

  /* 6. Und die Termine behalten ihr Datum. */
  assert.deepEqual(stand.sections.shows.items.map((i) => `${i.name}|${i.date}`),
    ["Gestern Abend|2026-09-16", "Lange her|2026-08-01", "Kommt noch|2026-12-24",
     "Abgewaehlt|2026-07-07", "Gepflegter Club|2026-06-06"],
    "ein Termin wurde umdatiert, verschoben oder entfernt");
  assert.equal(stand.sections.shows.items[3].nichtAlsReferenz, true,
    "die Abwahl am Termin ist verschwunden");
});

test("der Knopf „weitere anzeigen“ zählt die nachgetragenen mit", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitStand(dir);
  assert.equal((await baue(dir)).status, 0);

  const html = readFileSync(join(dir, "shows/index.html"), "utf8");
  const refs = referenzen(dir, "shows/index.html");
  const eingeklappt = refs.filter((r) => r.extra).length;
  assert.equal(eingeklappt, refs.length - 4, "es sind nicht genau die Einträge ab dem fünften eingeklappt");
  const knopf = html.match(/data-more="([^"]*)"/);
  assert.ok(knopf, "es gibt keinen Knopf zum Aufklappen");
  assert.ok(knopf[1].includes(String(eingeklappt)),
    `der Knopf nennt nicht ${eingeklappt}, sondern „${knopf[1]}“`);
});

/* ── Die Auswahl für sich, ohne Bau ────────────────────────────────────── */
test("vergangeneAlsReferenz: die Regeln einzeln", () => {
  const shows = {
    items: [
      { date: "2026-09-16", name: "Gestern", city: "Herisau" },
      { date: "2026-08-01", name: "Lange her", city: "Luzern" },
      { date: "2026-12-24", name: "Kommt noch", city: "Chur" },
      { date: "2026-07-07", name: "Abgewaehlt", city: "Wattwil", nichtAlsReferenz: true },
      { date: "2026-06-06", name: "Schon da", city: "Chur" },
      { date: "2026-05-05", name: "", city: "Ohne Namen" },
      // Zweimal derselbe Auftritt unter den Terminen: einmal nachtragen.
      { date: "2026-04-04", name: "Gestern", city: "Herisau" },
      // Gleicher Name, anderer Ort: ein anderer Auftritt.
      { date: "2026-03-03", name: "Gestern", city: "Wattwil" },
      // Ohne Datum ist nichts vorbei.
      { date: "", name: "Irgendwann", city: "Chur" },
    ],
  };
  const schonDa = new Set(["schon da|chur"]);
  const raus = vergangeneAlsReferenz(shows, schonDa, HEUTE);

  assert.deepEqual(raus.map((r) => `${r.name}|${r.city}`),
    ["Gestern|Herisau", "Lange her|Luzern", "Gestern|Wattwil"],
    "die Auswahl stimmt nicht");
  assert.deepEqual(raus.map((r) => r.ausShow), ["2026-09-16", "2026-08-01", "2026-03-03"],
    "die Reihenfolge ist nicht das Jüngste zuerst");

  // Ein Termin von HEUTE ist nicht vorbei — er steht noch unter „Shows".
  const heuteAbend = vergangeneAlsReferenz(
    { items: [{ date: HEUTE, name: "Heute Abend", city: "Chur" }] }, new Set(), HEUTE);
  assert.deepEqual(heuteAbend, [], "ein Termin von heute wandert schon zu den Referenzen");

  // Ohne Termine passiert nichts.
  assert.deepEqual(vergangeneAlsReferenz(undefined, new Set(), HEUTE), []);
  assert.deepEqual(vergangeneAlsReferenz({ items: [] }, new Set(), HEUTE), []);
});

/* ══════════════════════════════════════════════════════════════════════════
   5. OHNE NEUEN BUILD — der Datumswechsel im Browser

   Die Seite ist statisch gebaut. Verstreicht ein Datum zwischen zwei Bauten,
   nimmt assets/site.js die Zeile aus der Terminliste. Ohne Gegenstück wäre der
   Auftritt damit bis zum nächsten Bau NIRGENDS mehr zu sehen — genau die
   Lücke, um die es hier geht.

   Geprüft wird die echte Funktion aus der Datei, ausgeführt gegen ein
   Stub-DOM: derselbe Weg, den die übrigen Prüfungen dieses Repos gehen.
   ══════════════════════════════════════════════════════════════════════════ */
function stubDom() {
  const mk = (tag) => ({
    tagName: String(tag).toUpperCase(),
    children: [],
    attrs: {},
    className: "",
    textContent: "",
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(k) { this.children.push(k); return k; },
    remove() {},
    querySelector(sel) {
      /* Genug für das, was die Funktion wirklich fragt: ".klasse", "tag" und
         der Nachfahren-Ausdruck "li a". */
      const letzter = sel.trim().split(/\s+/).pop();
      const treffer = (n) =>
        letzter.startsWith(".") ? n.className === letzter.slice(1) : n.tagName === letzter.toUpperCase();
      const suche = (n) => {
        for (const k of n.children) {
          if (treffer(k)) return k;
          const tiefer = suche(k);
          if (tiefer) return tiefer;
        }
        return null;
      };
      return suche(this);
    },
    querySelectorAll(sel) {
      const raus = [];
      const attr = (sel.match(/^li\[([a-z-]+)\]$/) || [])[1];
      const suche = (n) => n.children.forEach((k) => {
        if (attr ? k.tagName === "LI" && k.getAttribute(attr) !== null : k.className === sel.replace(/^\./, "")) raus.push(k);
        suche(k);
      });
      suche(this);
      return raus;
    },
  });

  const liste = mk("ul");
  liste.setAttribute("data-mobil", "4");
  for (let i = 1; i <= 5; i++) {
    const li = mk("li");
    if (i > 4) li.setAttribute("data-extra", "true");
    const a = mk("a");
    a.setAttribute("href", "/booking/#booking-form");
    const n = mk("span"); n.className = "venue-name"; n.textContent = `Referenz ${i}`;
    const o = mk("span"); o.className = "venue-city"; o.textContent = "Beispielstadt";
    a.appendChild(n); a.appendChild(o); li.appendChild(a);
    liste.appendChild(li);
  }
  const knopf = mk("button");
  knopf.className = "venue-more";
  knopf.setAttribute("data-more", "1 weitere anzeigen");
  knopf.setAttribute("aria-expanded", "false");
  knopf.textContent = "1 weitere anzeigen";

  return {
    liste,
    knopf,
    document: {
      getElementById: (id) => (id === "venue-list" ? liste : null),
      querySelector: (sel) => (sel === ".venue-more" ? knopf : null),
      createElement: mk,
    },
  };
}

/** Die echte Funktion aus assets/site.js schneiden und bauen. */
function nachtragen(dom) {
  const quelle = readFileSync(join(ROOT, "assets/site.js"), "utf8");
  const i = quelle.indexOf("  function refSchluesselJS(");
  const j = quelle.indexOf('  var showList = document.getElementById("show-list");', i);
  assert.ok(i > 0 && j > i, "die Nachtrage-Funktion ist in assets/site.js nicht zu finden");
  return new Function("document", quelle.slice(i, j) + "; return alsReferenzNachtragen;")(dom.document);
}

function zeile(attrs) {
  return { getAttribute: (k) => (k in attrs ? attrs[k] : null) };
}

test("ohne neuen Build trägt der Browser den Auftritt nach", (t) => {
  const dom = stubDom();
  const fn = nachtragen(dom);

  fn(zeile({ "data-name": "Gestern Abend", "data-city": "Herisau", "data-date": "2026-09-16" }));

  assert.equal(dom.liste.children.length, 6, "es wurde nichts nachgetragen");
  const neu = dom.liste.children[5];
  assert.equal(neu.querySelector(".venue-name").textContent, "Gestern Abend", "der Name fehlt");
  assert.equal(neu.querySelector(".venue-city").textContent, "Herisau", "der Ort fehlt");
  assert.equal(neu.getAttribute("data-aus-show"), "2026-09-16", "der Eintrag ist nicht als Termin erkennbar");
  assert.equal(neu.getAttribute("data-extra"), "true", "der sechste Eintrag ist auf dem Handy nicht eingeklappt");
  assert.equal(neu.querySelector("a").getAttribute("href"), "/booking/#booking-form",
    "der nachgetragene Eintrag führt nirgendwohin");

  /* Der Knopf nennt eine Zahl — sie muss stimmen, sonst verspricht er mehr
     oder weniger, als dahintersteckt. */
  assert.equal(dom.knopf.getAttribute("data-more"), "2 weitere anzeigen", "der Knopf zählt nicht mit");
  assert.equal(dom.knopf.textContent, "2 weitere anzeigen", "die Aufschrift des Knopfes stimmt nicht");
});

test("ohne neuen Build: dieselben Regeln wie im Generator", (t) => {
  const dom = stubDom();
  const fn = nachtragen(dom);
  const vorher = dom.liste.children.length;

  // Abgewählt bleibt draussen.
  fn(zeile({ "data-name": "Abgewaehlt", "data-city": "Wattwil", "data-date": "2026-07-07", "data-ref": "nein" }));
  // Schon in der Liste (andere Schreibweise, anderer Fall): keine Dublette.
  fn(zeile({ "data-name": "  referenz 2 ", "data-city": "BEISPIELSTADT", "data-date": "2026-08-08" }));
  // Ohne Namen gibt es nichts anzuschreiben.
  fn(zeile({ "data-name": "", "data-city": "Chur", "data-date": "2026-08-09" }));

  assert.equal(dom.liste.children.length, vorher, "es wurde etwas nachgetragen, das draussen bleiben sollte");

  // Gleicher Name, anderer Ort: ein anderer Auftritt, der nachkommt.
  fn(zeile({ "data-name": "Referenz 2", "data-city": "Wattwil", "data-date": "2026-08-10" }));
  assert.equal(dom.liste.children.length, vorher + 1, "ein anderer Ort wurde als Dublette behandelt");
});

test("ohne neuen Build: ohne Referenzliste passiert einfach nichts", (t) => {
  const dom = stubDom();
  dom.document.getElementById = () => null;      // die Seite trägt keine Referenzen
  const fn = nachtragen(dom);
  assert.doesNotThrow(() => fn(zeile({ "data-name": "Gestern", "data-city": "Chur", "data-date": "2026-09-16" })),
    "ohne Referenzliste wirft das Nachtragen");
});
