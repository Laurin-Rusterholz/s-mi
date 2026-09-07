/**
 * Die ganze Kette, an einem Stueck: Verwaltung -> Datenbank -> Build -> Seite.
 *
 * Anlass (02.09.2026): "Ich erfasse eine Show in der Verwaltung, publiziere —
 * und im Frontend steht sie nicht." Geprueft wurde bis dahin nur in Stuecken:
 * die Sortierung an der gebauten Seite, die Regeln von nachziehen an
 * Beispieldaten. Was dazwischen passiert — der Weg vom Stand der Verwaltung
 * durch loadContent bis in das fertige HTML — hat niemand nachgestellt. Genau
 * dort sassen die Fehler.
 *
 * Dieser Test stellt die Datenbank nach: ein kleiner HTTP-Server liefert den
 * Stand so aus, wie ihn die Realtime Database ueber ihre REST-Adresse liefert.
 * Der ECHTE Generator laeuft dagegen — in einer Kopie des Repos, damit der
 * Arbeitsstand unberuehrt bleibt.
 *
 * Aufruf:  node --test scripts/kette.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, cp, rm, mkdir } from "node:fs/promises";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* Der Tag, an dem gebaut wird, steht fest — sonst haengt der Test daran, wie
   lange er in der Schublade liegt: ein Termin "in zwei Wochen" waere irgendwann
   vorbei, und der Shows-Abschnitt verschwaende (ohne kommenden Termin gibt es
   ihn nicht). BUILD_DATE ist dafuer schon im Generator vorgesehen. */
const HEUTE = "2026-09-02";
const NEUER_TERMIN = {
  date: "2026-10-24",
  name: "Testhalle Regressionsfest",
  venue: "Halle 7",
  city: "Winterthur",
  country: "CH",
  status: "confirmed",
  ticketLabel: "Tickets",
  ticketUrl: "https://tickets.example/regressionsfest",
};

/** Eine Kopie des Repos, in der gebaut werden darf. Ohne media/ (7 MB Video). */
async function repoKopie() {
  const dir = await mkdtemp(join(tmpdir(), "s-mi-kette-"));
  await cp(ROOT, dir, {
    recursive: true,
    filter: (quelle) => !/(^|\/)(\.git|media|node_modules)(\/|$)/.test(quelle.slice(ROOT.length)),
  });
  await mkdir(join(dir, "media"), { recursive: true });
  return dir;
}

/**
 * Den Stand so ausliefern, wie die Realtime Database es tut — inklusive ihrer
 * Eigenheiten: leere Zeichenketten und leere Objekte speichert sie nicht, sie
 * fehlen in der Antwort schlicht. Genau daran ist die Verwaltung schon einmal
 * vorbeigelaufen, darum wird hier nicht der rohe Inhalt gereicht, sondern der
 * durch dieselbe Muehle gedrehte.
 */
function wieDatenbank(wert) {
  if (Array.isArray(wert)) {
    const liste = wert.map(wieDatenbank).filter((v) => v !== null && v !== undefined);
    return liste.length ? liste : null;
  }
  if (wert && typeof wert === "object") {
    const raus = {};
    for (const [k, v] of Object.entries(wert)) {
      const w = wieDatenbank(v);
      if (w !== null && w !== undefined) raus[k] = w;
    }
    return Object.keys(raus).length ? raus : null;
  }
  return wert === "" ? null : wert;
}

/** Kleiner Server, der content.json und media.json beantwortet. */
async function starteDatenbank({ inhalt, status = 200 }) {
  const server = createServer((req, res) => {
    if (status !== 200) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Permission denied" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(/media\.json/.test(req.url || "") ? {} : inhalt));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  return {
    contentUrl: `http://127.0.0.1:${port}/samsparking/content.json`,
    stop: () => new Promise((ok) => server.close(ok)),
  };
}

/**
 * Den Generator starten und auf ihn warten — ASYNCHRON, das ist hier keine
 * Geschmacksfrage: spawnSync haelt die Event-Loop an, und der Server oben
 * laeuft in derselben. Der Build wartet dann ewig auf eine Antwort, die
 * niemand geben kann.
 */
function baue(dir, env) {
  return new Promise((fertig) => {
    const kind = spawn(process.execPath, [resolve(dir, "scripts/build.mjs")], {
      cwd: dir,
      env: { ...process.env, BUILD_DATE: HEUTE, ...env },
    });
    let stdout = "";
    let stderr = "";
    kind.stdout.on("data", (d) => (stdout += d));
    kind.stderr.on("data", (d) => (stderr += d));
    kind.on("close", (status) => fertig({ status, stdout, stderr }));
  });
}

const lies = (dir, datei) => readFileSync(join(dir, datei), "utf8");

/**
 * Die gebauten Seiten, die den Shows-Abschnitt tragen — je Sprache eine.
 *
 * Bewusst gesucht statt behauptet: ob die Shows auf der Startseite stehen oder
 * auf einer eigenen Seite (/shows/), und welche Sprache an der Wurzel liegt,
 * entscheidet der Kunde in der Verwaltung. Am 07.09.2026 hat er beides
 * umgestellt — Deutsch an die Wurzel, Shows auf eine eigene Seite — und dieser
 * Test suchte weiter unter "de/index.html".
 */
function seitenMitShows(dir) {
  const gefunden = [];
  const suche = (rel, tiefe) => {
    const abs = rel ? join(dir, rel) : dir;
    const datei = join(abs, "index.html");
    if (existsSync(datei)) {
      const html = readFileSync(datei, "utf8");
      if (html.includes('id="shows"')) gefunden.push([rel ? `${rel}/index.html` : "index.html", html]);
    }
    if (tiefe <= 0) return;
    for (const eintrag of readdirSync(abs, { withFileTypes: true })) {
      if (!eintrag.isDirectory()) continue;
      if (["scripts", "content", "media", "img", "assets", "presskit", "netlify"].includes(eintrag.name)) continue;
      if (eintrag.name.startsWith(".")) continue;
      suche(rel ? `${rel}/${eintrag.name}` : eintrag.name, tiefe - 1);
    }
  };
  suche("", 2);
  return gefunden;
}

/** Die Zeilen einer Liste, als [datum, html] — in der Reihenfolge der Seite. */
function zeilen(html, listenId) {
  const liste = html.match(new RegExp(`<ul class="[^"]*" id="${listenId}">[\\s\\S]*?<\\/ul>`));
  if (!liste) return null;
  return [...liste[0].matchAll(/<li [\s\S]*?<\/li>/g)].map((m) => [
    (m[0].match(/data-date="([^"]*)"/) || [])[1] || "",
    m[0],
  ]);
}

const VERGANGENER_TERMIN = {
  date: "2026-07-04",
  name: "Sommerfest Rueckblick",
  city: "Herisau",
  country: "CH",
  status: "confirmed",
  ticketLabel: "Tickets",
  ticketUrl: "https://tickets.example/sommerfest",
};

test("kommende und vergangene Shows stehen auf allen Sprachseiten", async (t) => {
  const stand = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));

  /* So sieht der Stand aus, nachdem jemand in der Verwaltung zwei Termine
     angelegt und einen Text geaendert hat — einer kommt, einer ist vorbei.
     Beide ans Ende der Liste, genau so legt die Verwaltung sie an. */
  stand.sections.shows.items = [
    ...stand.sections.shows.items,
    { ...NEUER_TERMIN },
    { ...VERGANGENER_TERMIN },
  ];
  stand.hero.tagline = "Aus der Verwaltung, nicht aus der Vorlage.";

  const db = await starteDatenbank({ inhalt: wieDatenbank(stand) });
  const dir = await repoKopie();
  t.after(async () => {
    await db.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const lauf = await baue(dir, { CONTENT_API_URL: db.contentUrl, CONTENT_API_REQUIRED: "1" });

  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);
  assert.match(
    lauf.stdout,
    /Inhalt von der Verwaltung geladen/,
    "Der Build ist auf den eingecheckten Stand zurueckgefallen, statt die Verwaltung zu lesen"
  );

  const seiten = seitenMitShows(dir);
  assert.ok(seiten.length >= 3, `Nicht jede Sprache traegt die Shows: ${seiten.map(([d]) => d).join(", ")}`);

  for (const [seite, html] of seiten) {
    /* Der kommende Termin steht oben, mit Ort und Ticket-Knopf. */
    const oben = zeilen(html, "show-list");
    assert.ok(oben, `${seite}: die Liste der kommenden Termine fehlt`);
    const kommend = oben.find(([d]) => d === NEUER_TERMIN.date);
    assert.ok(kommend, `${seite}: der kommende Termin "${NEUER_TERMIN.name}" fehlt`);
    assert.ok(kommend[1].includes(NEUER_TERMIN.name), `${seite}: der Name des kommenden Termins fehlt`);
    assert.ok(kommend[1].includes(NEUER_TERMIN.city), `${seite}: beim kommenden Termin steht ein fremder Ort`);
    assert.match(kommend[1], /<a class="btn btn-sm"/, `${seite}: der Ticket-Knopf fehlt am kommenden Termin`);

    /* Der vergangene Termin steht im Rueckblick — sichtbar, nicht zugeklappt,
       und ohne Ticket-Knopf. Das ist die Anforderung vom 07.09.2026: was
       publiziert wurde, bleibt sichtbar. */
    const unten = zeilen(html, "past-show-list");
    assert.ok(unten, `${seite}: der Rueckblick auf vergangene Shows fehlt`);
    const vorbei = unten.find(([d]) => d === VERGANGENER_TERMIN.date);
    assert.ok(vorbei, `${seite}: der vergangene Termin "${VERGANGENER_TERMIN.name}" fehlt im Rueckblick`);
    assert.ok(vorbei[1].includes(VERGANGENER_TERMIN.name), `${seite}: der Name des vergangenen Termins fehlt`);
    assert.ok(vorbei[1].includes(VERGANGENER_TERMIN.city), `${seite}: beim vergangenen Termin steht ein fremder Ort`);
    assert.doesNotMatch(vorbei[1], /<a class="btn btn-sm"/, `${seite}: vergangener Termin mit Ticket-Knopf`);
    assert.doesNotMatch(
      html,
      /id="past-shows"[^>]*\shidden/,
      `${seite}: der Rueckblick ist versteckt, obwohl vergangene Termine da sind`
    );
    assert.doesNotMatch(html, /<details[^>]*class="[^"]*past-shows/, `${seite}: der Rueckblick ist wieder zugeklappt`);

    /* Keine Vermischung, beide Listen chronologisch: oben aufsteigend, unten
       das Juengste zuerst. */
    const obenDaten = oben.map(([d]) => d).filter(Boolean);
    assert.ok(
      obenDaten.every((d) => d >= HEUTE),
      `${seite}: unter den kommenden Terminen steht Vergangenes: ${obenDaten.join(", ")}`
    );
    assert.deepEqual(obenDaten, [...obenDaten].sort(), `${seite}: kommende Termine nicht aufsteigend`);
    const untenDaten = unten.map(([d]) => d).filter(Boolean);
    assert.ok(
      untenDaten.every((d) => d < HEUTE),
      `${seite}: im Rueckblick steht Kommendes: ${untenDaten.join(", ")}`
    );
    assert.deepEqual(untenDaten, [...untenDaten].sort().reverse(), `${seite}: Rueckblick nicht absteigend`);

    assert.ok(html.includes('id="shows"'), `${seite}: der Shows-Abschnitt fehlt ganz`);
  }

  /* Das Terminblatt speist den Booking-Kalender: der kommende Tag muss als
     belegt erkennbar sein, der vergangene gehoert nicht hinein. */
  const [, ersteSeite] = seiten[0];
  const blatt = ersteSeite.match(/<script type="application\/json" id="shows-data">([\s\S]*?)<\/script>/);
  assert.ok(blatt, "Das Terminblatt (shows-data) fehlt");
  const termine = JSON.parse(blatt[1]);
  assert.ok(
    termine.some((s) => s.date === NEUER_TERMIN.date && s.name === NEUER_TERMIN.name),
    "Der kommende Termin fehlt im Terminblatt"
  );
  assert.ok(
    !termine.some((s) => s.date === VERGANGENER_TERMIN.date),
    "Ein vergangener Tag steht im Terminblatt — buchen laesst sich da nichts mehr"
  );

  /* Die Gegenprobe zur zweiten Ursache: ein in der Verwaltung geaenderter Text
     darf nicht von der eingecheckten Vorlage ueberschrieben werden. */
  const irgendwo = [...seiten.map(([, h]) => h), lies(dir, "index.html")];
  assert.ok(
    irgendwo.some((h) => h.includes("Aus der Verwaltung, nicht aus der Vorlage.")),
    "Der Text aus der Verwaltung wurde von der Vorlage ueberschrieben"
  );
  assert.doesNotMatch(
    lauf.stdout,
    /Datenbank trägt noch den alten Stand/,
    "Die einmalige Text-Umstellung ist wieder gelaufen"
  );
});

test("auch wenn ALLE Termine vorbei sind, bleiben Abschnitt und Menuepunkt", async (t) => {
  /* Das ist der Befund der Abnahme vom 07.09.2026, eins zu eins: Nox Club
     (05.09.) und Aftersun (29.08.) waren vorbei — und damit verschwanden der
     ganze Shows-Bereich und sein Menuepunkt. Publizierte Shows waren im
     Frontend nirgends mehr zu finden. */
  const stand = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));
  stand.sections.shows.items = [
    { ...VERGANGENER_TERMIN },
    { ...VERGANGENER_TERMIN, date: "2026-08-29", name: "Aftersun Rueckblick", city: "Luzern" },
  ];

  const db = await starteDatenbank({ inhalt: wieDatenbank(stand) });
  const dir = await repoKopie();
  t.after(async () => {
    await db.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const lauf = await baue(dir, { CONTENT_API_URL: db.contentUrl, CONTENT_API_REQUIRED: "1" });
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  const seiten = seitenMitShows(dir);
  assert.ok(
    seiten.length >= 3,
    "Ohne kommenden Termin verschwindet der Shows-Abschnitt — genau der Fehler vom 07.09.2026"
  );

  for (const [seite, html] of seiten) {
    const unten = zeilen(html, "past-show-list");
    assert.ok(unten && unten.length === 2, `${seite}: nicht beide vergangenen Termine im Rueckblick`);
    for (const name of [VERGANGENER_TERMIN.name, "Aftersun Rueckblick"])
      assert.ok(html.includes(name), `${seite}: "${name}" fehlt`);
    /* Und der Hinweis, dass gerade nichts ansteht, statt einer leeren Liste. */
    assert.doesNotMatch(html, /id="show-empty"[^>]*\shidden/, `${seite}: der Hinweis "keine Termine" fehlt`);
  }

  /* Der Menuepunkt fuehrt weiterhin zu den Shows. */
  const start = lies(dir, "index.html");
  assert.match(
    start,
    /href="[^"]*(#shows|\/shows\/)"/,
    "Die Startseite verlinkt die Shows nicht mehr im Menue"
  );
});

test("der Rueckblick-Kasten steht auch leer im HTML", async (t) => {
  /* Der Vertrag, auf den sich assets/site.js stuetzt: verstreicht ein Termin
     zwischen zwei Builds, schiebt der Browser ihn aus der oberen Liste in den
     Rueckblick — dafuer muss es den Kasten geben, auch wenn beim Bauen noch
     nichts drin war. Dasselbe fuer den Hinweis "keine Termine": er wird
     eingeblendet, sobald der letzte kommende Termin weggerutscht ist.

     Ohne diese beiden Huellen faellt site.js auf seinen alten Weg zurueck und
     blendet den Termin einfach aus — dann ist er wieder verschwunden. */
  const stand = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));
  stand.sections.shows.items = [{ ...NEUER_TERMIN }];

  const db = await starteDatenbank({ inhalt: wieDatenbank(stand) });
  const dir = await repoKopie();
  t.after(async () => {
    await db.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const lauf = await baue(dir, { CONTENT_API_URL: db.contentUrl, CONTENT_API_REQUIRED: "1" });
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  for (const [seite, html] of seitenMitShows(dir)) {
    assert.match(html, /id="past-shows"[^>]*\shidden/, `${seite}: der leere Rueckblick fehlt oder ist nicht versteckt`);
    assert.match(html, /id="past-show-list"/, `${seite}: die Liste im Rueckblick fehlt`);
    assert.match(html, /id="show-empty"[^>]*\shidden/, `${seite}: der versteckte Hinweis "keine Termine" fehlt`);
  }
});

test("ein Termin ohne Namen faellt auf, statt still zu verschwinden", async (t) => {
  /* Die Website zeigt nur Termine mit Namen — ohne "Event / Club" gibt es
     nichts anzuschreiben. Das ist in Ordnung, darf aber nicht lautlos
     geschehen: sonst sucht der Kunde den Termin auf der Seite und findet
     nichts, waehrend er in der Verwaltung steht. */
  const stand = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));
  stand.sections.shows.items = [
    { ...NEUER_TERMIN },
    { date: "2026-11-11", city: "Chur", country: "CH", status: "confirmed" },
  ];

  const db = await starteDatenbank({ inhalt: wieDatenbank(stand) });
  const dir = await repoKopie();
  t.after(async () => {
    await db.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const lauf = await baue(dir, { CONTENT_API_URL: db.contentUrl, CONTENT_API_REQUIRED: "1" });
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);
  assert.match(
    lauf.stdout + lauf.stderr,
    /Termin\(e\) ohne Namen — sie werden NICHT angezeigt/,
    "Der Build sagt nicht, dass ein Termin ohne Namen nicht angezeigt wird"
  );
  assert.ok(
    !lies(dir, "index.html").includes('data-date="2026-11-11"'),
    "Ein Termin ohne Namen steht auf der Seite"
  );
});

test("verweigerter Lesezugriff wird nicht als Erfolg gemeldet", async (t) => {
  /* Der Fall vom 13.08. bis 01.09.2026: die Datenbank antwortet mit HTTP 401,
     der Build nimmt den eingecheckten Stand und meldet Erfolg. Drei Wochen
     lang lieferte die Website denselben alten Stand aus, waehrend jeder Lauf
     gruen war. Wo die echte Website gebaut wird (CONTENT_API_REQUIRED=1), muss
     das ein Fehler sein — und es darf keine Seite dabei herauskommen. */
  const db = await starteDatenbank({ inhalt: {}, status: 401 });
  const dir = await repoKopie();
  t.after(async () => {
    await db.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const vorher = lies(dir, "index.html");
  const lauf = await baue(dir, { CONTENT_API_URL: db.contentUrl, CONTENT_API_REQUIRED: "1" });

  assert.notEqual(lauf.status, 0, "Der Build meldet Erfolg, obwohl er den Stand nicht lesen konnte");
  assert.match(
    lauf.stdout + lauf.stderr,
    /HTTP 401/,
    "Der Abbruch nennt den Grund nicht"
  );
  assert.match(
    lauf.stdout + lauf.stderr,
    /\.read/,
    "Der Abbruch sagt nicht, was zu tun ist (Firebase-Regeln)"
  );
  assert.equal(lies(dir, "index.html"), vorher, "Trotz Abbruch wurde eine Seite geschrieben");

  /* Ohne das Kennzeichen bleibt der Rueckfall erlaubt — Vorschau und
     Vorfuehrung sollen auch ohne Datenbank bauen. */
  const locker = await baue(dir, { CONTENT_API_URL: db.contentUrl });
  assert.equal(locker.status, 0, "Ohne CONTENT_API_REQUIRED darf der Build zurueckfallen");
  assert.match(locker.stdout, /Inhalt aus content\/site\.json geladen/);
});

test("die echte Website baut streng — das Kennzeichen ist gesetzt", async () => {
  /* Die Absicherung oben nuetzt nur, wenn sie dort auch eingeschaltet ist, wo
     die echte Website entsteht: im Netlify-Build und im Zeitplan-Workflow. */
  const netlify = await readFile(resolve(ROOT, "netlify.toml"), "utf8");
  assert.match(netlify, /CONTENT_API_REQUIRED\s*=\s*"1"/, "netlify.toml baut nicht streng");
  const workflow = await readFile(resolve(ROOT, ".github/workflows/inhalt.yml"), "utf8");
  assert.match(workflow, /CONTENT_API_REQUIRED:\s*"1"/, "Der Zeitplan-Workflow baut nicht streng");
  assert.ok(existsSync(resolve(ROOT, "content/site.json")), "Der Schnappschuss fehlt");
});
