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
import { readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
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

/* Der echte Pfad, nicht der geliehene.
 *
 * BEFUND vom Mac (17.09.2026): Dort musste `TMPDIR=/private/tmp` gesetzt
 * werden, sonst meldete der Lauf 15 Fehler, die keine waren. Grund ist ein
 * Symlink: `mkdtemp(tmpdir())` liefert auf macOS `/var/folders/…`, und `/var`
 * ist eine Verknuepfung auf `/private/var`. Node loest Symlinks beim Laden
 * eines Moduls UND bei `process.cwd()` auf — der Generator rechnet drinnen
 * also mit `/private/var/…`, waehrend der Test draussen `/var/…` festhaelt.
 * Zwei Namen fuer dasselbe Verzeichnis, und jeder Vergleich der beiden geht
 * schief.
 *
 * `realpathSync` macht daraus wieder einen Namen — auf jedem System, auch da,
 * wo es gar keinen Symlink gibt (dann kommt derselbe Pfad zurueck). Damit
 * braucht es auf dem Mac kein TMPDIR mehr. */
/** Eine Kopie des Repos, in der gebaut werden darf. Ohne media/ (7 MB Video). */
async function repoKopie() {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "s-mi-kette-")));
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

/**
 * Nur der Shows-Abschnitt einer Seite.
 *
 * Gebraucht, seit dort ausschliesslich Kommendes stehen darf: ein vergangener
 * Auftritt DARF weiter auf der Seite vorkommen — bei den Referenzen. Geprueft
 * wird deshalb dieser Ausschnitt, nicht die ganze Seite.
 */
function showsAbschnitt(html) {
  const m = html.match(/<section class="[^"]*shows-sec"[\s\S]*?<\/section>/);
  return m ? m[0] : "";
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

test("unter Shows steht nur, was kommt — auf allen Sprachseiten", async (t) => {
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

    /* KUNDENENTSCHEID 15.09.2026: Der vergangene Termin steht NICHT unter
       "Shows" — weder in der Liste noch in einem Rueckblick darunter. Auf dem
       veroeffentlichten Stand stand dort "PLAYED BEFORE" mit NOX CLUB
       (05.09.2026) und AFTERSUN FESTIVAL (29.08.2026), noch dazu unter dem
       Hinweis, es sei gerade nichts angekuendigt. Wo Sam gespielt hat, steht
       bei den Referenzen. */
    const abschnitt = showsAbschnitt(html);
    assert.ok(abschnitt, `${seite}: der Shows-Abschnitt ist nicht zu finden`);
    assert.ok(
      !abschnitt.includes(VERGANGENER_TERMIN.name),
      `${seite}: der vergangene Termin "${VERGANGENER_TERMIN.name}" steht unter "Shows"`
    );
    assert.ok(
      !abschnitt.includes(VERGANGENER_TERMIN.date),
      `${seite}: ein vergangenes Datum steht unter "Shows"`
    );
    assert.ok(!/past-show|past-title|PLAYED BEFORE/i.test(html), `${seite}: der Rueckblick ist wieder da`);

    /* Und die Liste selbst: chronologisch, ohne ein einziges vergangenes
       Datum — auch nicht am Ende. */
    const obenDaten = oben.map(([d]) => d).filter(Boolean);
    assert.ok(
      obenDaten.every((d) => d >= HEUTE),
      `${seite}: unter den Terminen steht Vergangenes: ${obenDaten.join(", ")}`
    );
    assert.deepEqual(obenDaten, [...obenDaten].sort(), `${seite}: kommende Termine nicht aufsteigend`);

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

test("sind alle Termine vorbei, bleibt der Abschnitt — leer, ohne Rueckblick", async (t) => {
  /* Zwei Befunde an derselben Stelle, beide muessen gleichzeitig gelten:

     07.09.2026 — Nox Club (05.09.) und Aftersun (29.08.) waren vorbei, und
     damit verschwanden der ganze Shows-Bereich und sein Menuepunkt. Der
     Abschnitt muss also stehen bleiben.

     15.09.2026 — die Loesung von damals war ein "PLAYED BEFORE"-Rueckblick;
     der stand dann unter dem Hinweis "gerade nichts angekuendigt" und zeigte
     genau diese beiden vergangenen Abende. Unter "Shows" gehoert nur, was
     bevorsteht. Also: Abschnitt und Menuepunkt bleiben, der Leerzustand ist zu
     sehen — und kein vergangener Termin steht darin. */
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
    const abschnitt = showsAbschnitt(html);
    assert.ok(abschnitt, `${seite}: der Shows-Abschnitt ist nicht zu finden`);

    /* Der Leerzustand ist SICHTBAR — nicht `hidden`. */
    assert.doesNotMatch(abschnitt, /id="show-empty"[^>]*\shidden/, `${seite}: der Hinweis "keine Termine" fehlt`);

    /* Und darunter steht nichts mehr: kein Rueckblick, keine Terminliste,
       keiner der beiden vergangenen Abende. */
    assert.ok(!/past-show|past-title|PLAYED BEFORE/i.test(html), `${seite}: der Rueckblick ist wieder da`);
    assert.ok(!abschnitt.includes('id="show-list"'), `${seite}: eine leere Terminliste steht im Abschnitt`);
    for (const name of [VERGANGENER_TERMIN.name, "Aftersun Rueckblick"])
      assert.ok(!abschnitt.includes(name), `${seite}: der vergangene Termin "${name}" steht unter "Shows"`);
    for (const datum of [VERGANGENER_TERMIN.date, "2026-08-29"])
      assert.ok(!abschnitt.includes(datum), `${seite}: das vergangene Datum ${datum} steht unter "Shows"`);
  }

  /* Der Menuepunkt fuehrt weiterhin zu den Shows. */
  const start = lies(dir, "index.html");
  assert.match(
    start,
    /href="[^"]*(#shows|\/shows\/)"/,
    "Die Startseite verlinkt die Shows nicht mehr im Menue"
  );

  /* Und die Daten sind unberuehrt: beide vergangenen Termine stehen weiter im
     Schnappschuss. Nicht gezeigt heisst nicht geloescht. */
  const schnappschuss = JSON.parse(readFileSync(join(dir, "content/site.json"), "utf8"));
  const gespeichert = (schnappschuss.sections.shows.items || []).map((i) => String(i.name).trim());
  assert.deepEqual(
    gespeichert,
    [VERGANGENER_TERMIN.name, "Aftersun Rueckblick"],
    "Vergangene Termine wurden aus den Daten entfernt"
  );
});

test("der Screenshot vom 15.09.2026: kein PLAYED BEFORE, Referenz bleibt dritte", async (t) => {
  /* Der gemeldete Stand, eins zu eins nachgestellt — mit dem Tag, an dem er
     entstanden ist (15.09.2026), damit beide Abende wirklich vorbei sind:

       Shows      NOX CLUB 05.09.2026, AFTERSUN FESTIVAL 29.08.2026
       darunter   "No dates announced right now."
       und dann   PLAYED BEFORE mit genau diesen beiden Abenden

     Verlangt ist: der Rueckblick verschwindet, der Hinweis bleibt — und die
     Referenz "NOX CLUB", die in der Verwaltung an dritter Stelle gepflegt ist,
     steht weiterhin an dritter Stelle. Auf dem Handy zaehlt genau das: dort
     sind zuerst nur die obersten vier zu sehen. */
  const HEUTE_SCREENSHOT = "2026-09-15";
  const stand = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));
  stand.sections.shows.items = [
    { date: "2026-09-05", name: "NOX CLUB", city: "Chur", country: "CH", status: "confirmed" },
    { date: "2026-08-29", name: "AFTERSUN FESTIVAL", city: "Luzern", country: "CH", status: "confirmed" },
  ];
  stand.sections.references.items = [
    { name: "Kugl", city: "St. Gallen" },
    { name: "Sektor 11", city: "Zurich" },
    { name: "NOX CLUB ", city: "Chur" },
    { name: "Eden", city: "St. Gallen" },
    { name: "BBC", city: "Buchs" },
  ];

  const db = await starteDatenbank({ inhalt: wieDatenbank(stand) });
  const dir = await repoKopie();
  t.after(async () => {
    await db.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const lauf = await baue(dir, {
    BUILD_DATE: HEUTE_SCREENSHOT,
    CONTENT_API_URL: db.contentUrl,
    CONTENT_API_REQUIRED: "1",
  });
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  const seiten = seitenMitShows(dir);
  assert.ok(seiten.length >= 3, "Der Shows-Abschnitt fehlt auf mindestens einer Sprachseite");

  for (const [seite, html] of seiten) {
    const abschnitt = showsAbschnitt(html);
    assert.ok(abschnitt, `${seite}: der Shows-Abschnitt ist nicht zu finden`);

    /* 1. Keine vergangenen Shows — in keiner Form. */
    assert.ok(!/PLAYED BEFORE|past-show|past-title/i.test(html), `${seite}: "PLAYED BEFORE" steht noch da`);
    for (const name of ["NOX CLUB", "AFTERSUN FESTIVAL"])
      assert.ok(!abschnitt.includes(name), `${seite}: "${name}" steht unter "Shows"`);
    for (const datum of ["2026-09-05", "2026-08-29"])
      assert.ok(!abschnitt.includes(datum), `${seite}: das vergangene Datum ${datum} steht unter "Shows"`);

    /* 2. Der Leerzustand stimmt: sichtbarer Hinweis, keine leere Liste. */
    assert.doesNotMatch(abschnitt, /id="show-empty"[^>]*\shidden/, `${seite}: der Hinweis "keine Termine" fehlt`);
    assert.ok(!abschnitt.includes('id="show-list"'), `${seite}: eine leere Terminliste steht im Abschnitt`);

    /* 3. Die Referenzen bleiben — und "NOX CLUB" an dritter Stelle. */
    const refBlock = (html.match(/<ul class="venue-list rv" id="venue-list">[\s\S]*?<\/ul>/) || [""])[0];
    if (!refBlock) continue; // Referenzen stehen auf dieser Seite nicht
    const namen = Array.from(refBlock.matchAll(/class="venue-name">([^<]+)</g)).map((m) => m[1].trim());
    assert.deepEqual(
      namen,
      ["Kugl", "Sektor 11", "NOX CLUB", "Eden", "BBC"],
      `${seite}: die Referenzen stehen nicht so da wie in der Verwaltung`
    );
    assert.equal(namen[2], "NOX CLUB", `${seite}: NOX CLUB ist nicht mehr die dritte Referenz`);
    assert.ok(
      namen.slice(0, 4).includes("NOX CLUB"),
      `${seite}: NOX CLUB fehlt unter den ersten vier — auf dem Handy waere er damit weg`
    );
  }

  /* Die Termine selbst sind unberuehrt: nicht gezeigt heisst nicht geloescht. */
  const schnappschuss = JSON.parse(readFileSync(join(dir, "content/site.json"), "utf8"));
  assert.deepEqual(
    (schnappschuss.sections.shows.items || []).map((i) => `${String(i.name).trim()} ${i.date}`),
    ["NOX CLUB 2026-09-05", "AFTERSUN FESTIVAL 2026-08-29"],
    "Die vergangenen Termine wurden aus den Daten entfernt"
  );
});

test("ein Termin von HEUTE bleibt den ganzen Tag stehen (Europe/Zurich)", async (t) => {
  /* Die Tagesgrenze ist die der Website, nicht die von UTC — und sie liegt am
     Ende des Tages. Ein Abend, der heute stattfindet, darf nicht schon am
     Morgen aus der Liste fallen; eine Show endet ohnehin erst nach Mitternacht.
     Gegenprobe im selben Lauf: der Vortag ist weg. */
  const HEUTE_TEST = "2026-09-15";
  const stand = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));
  stand.sections.shows.items = [
    { date: HEUTE_TEST, name: "Heute Abend", city: "Chur", country: "CH", status: "confirmed" },
    { date: "2026-09-14", name: "Gestern Abend", city: "Chur", country: "CH", status: "confirmed" },
  ];

  const db = await starteDatenbank({ inhalt: wieDatenbank(stand) });
  const dir = await repoKopie();
  t.after(async () => {
    await db.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const lauf = await baue(dir, {
    BUILD_DATE: HEUTE_TEST,
    CONTENT_API_URL: db.contentUrl,
    CONTENT_API_REQUIRED: "1",
  });
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  for (const [seite, html] of seitenMitShows(dir)) {
    const abschnitt = showsAbschnitt(html);
    assert.ok(abschnitt.includes("Heute Abend"), `${seite}: der heutige Termin wurde zu frueh ausgeblendet`);
    assert.ok(!abschnitt.includes("Gestern Abend"), `${seite}: der Termin von gestern steht noch unter "Shows"`);
  }
});

test("gepflegte Referenzen bleiben vollstaendig — auch bei einem kommenden Auftritt", async (t) => {
  /* ABNAHME 07.09.2026: "Aftersun Festival" stand im Rueckblick der Shows und
     zwei Bloecke tiefer noch einmal bei den Referenzen. Daraufhin liess der
     Generator jeden Auftritt weg, der auf derselben Seite schon als Termin
     stand.

     KUNDENBEFUND 15.09.2026: Genau das nimmt eine gepflegte Referenz weg.
     "Nox Club" steht in der Verwaltung an dritter Stelle; weil derselbe Abend
     als Termin gefuehrt wird, verschwand er aus der Liste — und auf dem Handy,
     wo zuerst nur die obersten vier stehen, rutschte ein anderer Club an seinen
     Platz. Die Anweisung dazu ist eindeutig: "auch ein erneuter kommender
     Auftritt darf die Referenz nicht entfernen".

     Also wird hier GAR NICHT mehr gegen die Termine gefiltert — weder gegen
     vergangene noch gegen kommende. Doppelt steht trotzdem nichts: unter
     "Shows" ist nur Kommendes, bei den Referenzen nur Gewesenes. Was bleibt:
     eine echte Dublette INNERHALB der Referenzliste erscheint einmal. */
  const stand = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));
  stand.sections.shows.items = [{ ...VERGANGENER_TERMIN }, { ...NEUER_TERMIN }];
  stand.sections.references.items = [
    { city: "St. Gallen", name: "Kugl" },
    { city: "Zurich", name: "Sektor 11" },
    // Derselbe Abend wie der VERGANGENE Termin — andere Schreibweise, Leerzeichen.
    { city: "Herisau", name: "Sommerfest Rueckblick " },
    { city: "St. Gallen", name: "Eden" },
    // Gleicher Name, anderer Ort: ein anderer Auftritt, der bleiben muss.
    { city: "Wattwil", name: "Sommerfest Rueckblick" },
    // Derselbe Ort wie der KOMMENDE Termin — die Referenz bleibt trotzdem.
    { city: "Winterthur", name: "Testhalle Regressionsfest" },
    // Echte Dublette in DIESER Liste: einmal drucken, erster Platz gilt.
    { city: "St. Gallen", name: "Kugl" },
  ];

  const db = await starteDatenbank({ inhalt: wieDatenbank(stand) });
  const dir = await repoKopie();
  t.after(async () => {
    await db.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const lauf = await baue(dir, { CONTENT_API_URL: db.contentUrl, CONTENT_API_REQUIRED: "1" });
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  for (const [seite, html] of seitenMitShows(dir)) {
    const refBlock = (html.match(/<ul class="venue-list rv" id="venue-list">[\s\S]*?<\/ul>/) || [""])[0];
    if (!refBlock) continue; // Referenzen stehen auf dieser Seite nicht
    const namen = Array.from(refBlock.matchAll(/class="venue-name">([^<]+)</g)).map((m) => m[1].trim());

    /* Der vergangene Abend steht NICHT unter "Shows" — aber die gepflegte
       Referenz dazu steht an ihrem Platz. */
    assert.ok(
      !showsAbschnitt(html).includes(VERGANGENER_TERMIN.name),
      `${seite}: der vergangene Termin steht unter "Shows"`
    );
    assert.ok(/Herisau/.test(refBlock),
      `${seite}: eine gepflegte Referenz verschwindet, weil der Abend vorbei ist`);

    /* Die Liste steht vollstaendig und in der Reihenfolge der Verwaltung — nur
       die echte Dublette ("Kugl" zweimal) erscheint einmal. */
    assert.deepEqual(
      namen,
      ["Kugl", "Sektor 11", "Sommerfest Rueckblick", "Eden", "Sommerfest Rueckblick", "Testhalle Regressionsfest"],
      `${seite}: die Referenzen stehen nicht in der Reihenfolge der Verwaltung`
    );
    // Die dritte Stelle gehoert dem Eintrag, der in der Verwaltung dritter ist.
    assert.equal(namen[2], "Sommerfest Rueckblick", `${seite}: der dritte Eintrag ist nicht der dritte der Verwaltung`);

    /* DIE NEUE REGEL: ein KOMMENDER Auftritt am selben Ort nimmt die Referenz
       nicht weg. "Testhalle Regressionsfest" steht als Termin UND als Referenz —
       beides ist gepflegt, beides bleibt. */
    assert.ok(/Winterthur/.test(refBlock),
      `${seite}: ein kommender Termin entfernt die gepflegte Referenz`);
    assert.ok(
      showsAbschnitt(html).includes(NEUER_TERMIN.name),
      `${seite}: der kommende Termin fehlt unter "Shows"`
    );

    /* Und die echte Dublette erscheint genau einmal. */
    assert.equal(namen.filter((n) => n === "Kugl").length, 1, `${seite}: dieselbe Referenz steht zweimal da`);
    assert.ok(refBlock.includes("Wattwil"), `${seite}: eine echte Referenz wurde mit weggeraeumt`);
  }

  /* Und der Generator hat die Liste in der Datenquelle NICHT angefasst — nur
     die Anzeige. Der Schnappschuss ist der Beweis. */
  const schnappschuss = JSON.parse(readFileSync(join(dir, "content/site.json"), "utf8"));
  const namen = (schnappschuss.sections.references.items || []).map((r) => String(r.name).trim());
  assert.deepEqual(
    namen,
    ["Kugl", "Sektor 11", "Sommerfest Rueckblick", "Eden", "Sommerfest Rueckblick", "Testhalle Regressionsfest", "Kugl"],
    "Die Referenzliste in den Daten wurde veraendert"
  );
  assert.doesNotMatch(
    lauf.stdout,
    /jetzt Referenz/,
    "Vergangene Termine wandern wieder automatisch in die Referenzen"
  );
});

test("die Kennzahl \"Shows\" wird aus den Daten gezaehlt", async (t) => {
  /* Sie stand als feste 30 in der Korrekturdatei — nach jeder neuen Show waere
     sie falsch gewesen. Jetzt zaehlt sie Termine und Referenzen ohne Dubletten;
     der bestaetigte Gesamtstand aus der Korrekturdatei ist nur noch ein
     Mindestwert, solange die Daten weniger hergeben. */
  const stand = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));
  const korr = JSON.parse(await readFile(resolve(ROOT, "content/korrekturen.json"), "utf8"));
  const mindestens = Number(korr.heroShows?.mindestens) || 0;
  assert.ok(mindestens > 0, "heroShows.mindestens fehlt");

  // Mehr Auftritte als der Mindestwert: die Zahl folgt den Daten.
  stand.sections.references.items = Array.from({ length: mindestens + 4 }, (_, i) => ({
    city: "St. Gallen",
    name: `Club ${i}`,
  }));
  stand.sections.shows.items = [{ ...VERGANGENER_TERMIN }, { ...NEUER_TERMIN }];
  stand.hero.stats = [
    { value: "2021", label: "First set" },
    { value: "2", label: "Shows" },
    { value: "150", label: "BPM home base" },
  ];

  const db = await starteDatenbank({ inhalt: wieDatenbank(stand) });
  const dir = await repoKopie();
  t.after(async () => {
    await db.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const lauf = await baue(dir, { CONTENT_API_URL: db.contentUrl, CONTENT_API_REQUIRED: "1" });
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  const erwartet = String(mindestens + 4 + 2); // Referenzen + zwei Termine
  for (const seite of ["index.html", "en/index.html", "fr/index.html"]) {
    const html = lies(dir, seite);
    const leiste = html.match(/<div class="hero-stats">[\s\S]*?<\/div>\s*<\/div>/);
    assert.ok(leiste, `${seite}: keine Kennzahlen-Leiste`);
    const shows = leiste[0].match(
      /data-to="(\d+)"[^>]*>[^<]*<\/strong>\s*<span class="hstat-label">(?:Shows|Concerts)</
    );
    assert.ok(shows, `${seite}: die Kennzahl "Shows" ist nicht zu finden`);
    assert.equal(
      shows[1],
      erwartet,
      `${seite}: die Kennzahl zaehlt nicht mit — ${shows[1]} statt ${erwartet}`
    );
  }
});

test("der leere Hinweis steht versteckt im HTML — der Vertrag mit site.js", async (t) => {
  /* Die Seite ist statisch gebaut. Verstreicht ein Termin zwischen zwei Builds,
     nimmt assets/site.js die Zeile im Browser aus der Liste — und wenn danach
     nichts mehr uebrig ist, blendet es den Hinweis "keine Termine" ein. Dafuer
     muss dieser Hinweis im HTML stehen, auch wenn beim Bauen noch Termine da
     waren: `hidden`, aber vorhanden.

     Einen Rueckblick-Kasten gibt es dagegen NICHT mehr (Kundenentscheid
     15.09.2026) — auch keinen leeren, in den etwas hineinrutschen koennte. */
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
    assert.match(html, /id="show-empty"[^>]*\shidden/, `${seite}: der versteckte Hinweis "keine Termine" fehlt`);
    assert.match(html, /id="show-list"/, `${seite}: die Terminliste fehlt`);
    assert.ok(!/past-show|past-title|PLAYED BEFORE/i.test(html), `${seite}: ein Rueckblick-Kasten steht wieder im HTML`);
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

/* ══════════════════════════════════════════════════════════════════════════
   Die Startseite ohne Auftritte — Kundenbefund vom 13.09.2026

   Auf der Startseite ging es von „Ueber mich" direkt zum Shop; Shows und
   Referenzen fehlten. Nichts war geloescht: beide standen vollstaendig auf
   /shows/ und auf der Startseite gar nicht. Bis zum 02.09.2026 hatte die
   eingecheckte Vorlage die Seitenaufteilung bei JEDEM Bauen ueberschrieben und
   die Startseite damit immer wieder bestueckt; seit #29 gilt die Aufteilung
   aus der Verwaltung — und damit wurde sichtbar, was dort gespeichert war.

   Geprueft wird beides, am echten Generator:
     · der Generator traegt NICHTS von selbst nach (sonst waere die Zuordnung
       in der Verwaltung wieder eine Attrappe — genau der Fehler von #29) —
       er sagt es aber laut;
     · steht die Zuordnung richtig, stehen Shows UND Referenzen auf der
       Startseite, mit ihren Eintraegen, und /shows/ behaelt sie ebenfalls.
   ══════════════════════════════════════════════════════════════════════════ */
function standMitEigenerShowSeite(vorlage) {
  const stand = JSON.parse(JSON.stringify(vorlage));
  stand.pages = [
    { slug: "", navLabel: "Home", title: "", hero: "full", ticker: true, inNav: true, enabled: true,
      sections: ["about", "sound", "shop"] },
    { slug: "shows", navLabel: "Shows", title: "Shows", hero: "compact", ticker: false, inNav: true, enabled: true,
      sections: ["shows", "references"] },
    { slug: "booking", navLabel: "Booking", title: "Booking", hero: "compact", ticker: false, inNav: true, enabled: true,
      sections: ["booking", "contact"] },
    { slug: "shop", navLabel: "Shop", title: "Shop", hero: "compact", ticker: false, inNav: true, enabled: true,
      sections: ["shop"] },
  ];
  stand.sections.shows.items = [{ ...NEUER_TERMIN }, { ...VERGANGENER_TERMIN }];
  stand.sections.references.items = [
    { name: "Beispielhalle", city: "Beispielstadt" },
    { name: "Beispielclub", city: "Zweitstadt" },
  ];
  return stand;
}

test("Startseite ohne Auftritte: der Generator sagt es, erzwingt aber nichts", async (t) => {
  const vorlage = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));
  const stand = standMitEigenerShowSeite(vorlage);

  const db = await starteDatenbank({ inhalt: wieDatenbank(stand) });
  const dir = await repoKopie();
  t.after(async () => {
    await db.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const lauf = await baue(dir, { CONTENT_API_URL: db.contentUrl, CONTENT_API_REQUIRED: "1" });
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  const start = lies(dir, "index.html");
  assert.ok(!start.includes('id="shows"'), "Der Generator hat die Shows von selbst auf die Startseite geholt");
  assert.ok(!start.includes('id="references"'), "Der Generator hat die Referenzen von selbst auf die Startseite geholt");

  // Und er sagt genau das — samt Weg zur Korrektur in der Verwaltung.
  const protokoll = lauf.stdout + lauf.stderr;
  assert.match(protokoll, /Startseite zeigt shows und references nicht/,
    "Der Build meldet die leere Startseite nicht");
  assert.match(protokoll, /shows → \/shows\//, "Der Build sagt nicht, wo die Abschnitte stattdessen stehen");
  assert.match(protokoll, /Auf die Startseite holen/, "Der Build nennt den Weg zur Korrektur nicht");
  assert.match(protokoll, /nicht baubar: sound \(Startseite\)/,
    "Ein nicht baubarer Abschnitt auf der Startseite wird nicht gemeldet");

  // Die Eintraege sind da — auf ihrer Seite.
  const showsSeite = lies(dir, "shows/index.html");
  assert.ok(showsSeite.includes("Testhalle Regressionsfest"), "Der kommende Termin fehlt auf /shows/");
  assert.ok(showsSeite.includes("Beispielhalle"), "Die Referenzen fehlen auf /shows/");
});

test("mit richtiger Zuordnung stehen Auftritte auf der Startseite UND auf /shows/", async (t) => {
  const vorlage = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));
  const stand = standMitEigenerShowSeite(vorlage);
  /* Genau das, was der Knopf „Auf die Startseite holen" in der Verwaltung
     schreibt: hinter „about", ohne die eigene Seite anzutasten. */
  stand.pages[0].sections = ["about", "shows", "references", "sound", "shop"];

  const db = await starteDatenbank({ inhalt: wieDatenbank(stand) });
  const dir = await repoKopie();
  t.after(async () => {
    await db.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const lauf = await baue(dir, { CONTENT_API_URL: db.contentUrl, CONTENT_API_REQUIRED: "1" });
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  const start = lies(dir, "index.html");
  assert.ok(start.includes('id="shows"'), "Die Shows stehen trotz Zuordnung nicht auf der Startseite");
  assert.ok(start.includes('id="references"'), "Die Referenzen stehen trotz Zuordnung nicht auf der Startseite");
  assert.ok(start.includes("Testhalle Regressionsfest"), "Der kommende Termin fehlt auf der Startseite");
  assert.ok(
    !showsAbschnitt(start).includes("Sommerfest Rueckblick"),
    "Ein vergangener Termin steht unter \"Shows\" auf der Startseite"
  );
  assert.ok(start.includes("Beispielhalle"), "Die Referenzen fehlen auf der Startseite");
  assert.ok(
    start.indexOf('id="shows"') < start.indexOf('id="shop"'),
    "Die Auftritte stehen hinter dem Shop statt davor"
  );

  // Die eigene Seite bleibt, wie sie war.
  const showsSeite = lies(dir, "shows/index.html");
  assert.ok(showsSeite.includes('id="shows"') && showsSeite.includes('id="references"'),
    "/shows/ hat seine Abschnitte verloren");

  // Und jetzt schweigt der Build darueber.
  assert.ok(
    !/Startseite zeigt shows/.test(lauf.stdout + lauf.stderr),
    "Der Build meldet eine leere Startseite, obwohl die Abschnitte darauf stehen"
  );
});

/* ══════════════════════════════════════════════════════════════════════════
   Was nicht ankommt, wird gesagt — und welcher Stand live ist, steht fest

   Rueckmeldungen des Kunden (15.09.2026): „Fotos aus der Verwaltung erscheinen
   nicht zuverlaessig" und „Aenderungen erscheinen nicht zuverlaessig". Am
   veroeffentlichten Stand nachgemessen waren es zwei verschiedene Dinge —
   Bilder ohne Datei und Texte, die seit dem Sprachwechsel vom 07.09.2026 noch
   in der alten Hauptsprache stehen, obwohl die deutsche Fassung im Inhalt
   liegt. Beides geschah stumm. Dazu die Stand-Datei, mit der sich von aussen
   pruefen laesst, WELCHER Inhalt gerade live ist.
   ══════════════════════════════════════════════════════════════════════════ */

test("stand.json sagt, aus welchem Inhalt gebaut wurde", async (t) => {
  const stand = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));
  stand.updatedAt = "2026-09-15T08:30:00.000Z";
  stand.contentRevision = 7;

  const db = await starteDatenbank({ inhalt: wieDatenbank(stand) });
  const dir = await repoKopie();
  t.after(async () => { await db.stop(); await rm(dir, { recursive: true, force: true }); });

  const lauf = await baue(dir, { CONTENT_API_URL: db.contentUrl, CONTENT_API_REQUIRED: "1" });
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  const datei = JSON.parse(lies(dir, "stand.json"));
  assert.equal(datei.inhaltVon, "2026-09-15T08:30:00.000Z", "stand.json nennt den Inhalt nicht");
  assert.equal(datei.inhaltVersion, 7, "die Version des Inhalts fehlt");
  assert.equal(datei.quelle, "verwaltung", "stand.json verschweigt, woher der Inhalt kam");
  assert.ok(Date.parse(datei.gebautAm) > 0, "der Bauzeitpunkt fehlt");

  /* Die Verwaltung liegt auf einer anderen Adresse — ohne CORS kann sie die
     Datei nicht lesen, und „live bestaetigt" bliebe eine Behauptung. */
  const toml = await readFile(resolve(ROOT, "netlify.toml"), "utf8");
  const block = toml.slice(toml.indexOf('for = "/stand.json"'));
  assert.match(block.slice(0, 220), /Access-Control-Allow-Origin\s*=\s*"\*"/, "stand.json ist fuer die Verwaltung nicht lesbar");
  assert.match(block.slice(0, 220), /Cache-Control\s*=\s*"no-store"/, "stand.json darf nicht zwischengespeichert werden");
});

test("Bilder ohne Datei werden benannt, nicht stumm uebersprungen", async (t) => {
  const stand = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));
  stand.sections.gallery.items = [
    { src: "https://firebasestorage.googleapis.com/v0/b/beispiel/o/eins.jpg?alt=media", alt: "Eins" },
    { src: "", alt: "Zweites Bild ohne Datei" },
    { src: "   ", alt: "" },
  ];

  const db = await starteDatenbank({ inhalt: wieDatenbank(stand) });
  const dir = await repoKopie();
  t.after(async () => { await db.stop(); await rm(dir, { recursive: true, force: true }); });

  const lauf = await baue(dir, { CONTENT_API_URL: db.contentUrl, CONTENT_API_REQUIRED: "1" });
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);
  const protokoll = lauf.stdout + lauf.stderr;
  assert.match(protokoll, /Bild\(er\) ohne Datei/, "leere Bildeintraege werden nicht gemeldet");
  assert.match(protokoll, /Galerie #2/, "der leere Eintrag wird nicht benannt");
  assert.match(protokoll, /erscheinen NICHT auf der Website/, "die Folge wird nicht gesagt");
  // Und sie werden trotzdem nicht geloescht: das Bild MIT Datei steht da.
  assert.ok(lies(dir, "gallery/index.html").includes("eins.jpg"), "das vorhandene Bild fehlt");
});

test("Texte in der alten Hauptsprache werden gemeldet — und nicht umgeschrieben", async (t) => {
  const stand = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));
  stand.site.lang = "de";
  stand.hero.tagline = "Turning energy into euphoria.";         // Grundtext englisch
  stand.i18n = stand.i18n || {};
  stand.i18n.de = { hero: { tagline: "Aus Energie wird Euphorie." } };
  stand.i18n.en = { hero: { tagline: "Turning energy into euphoria." } };

  const db = await starteDatenbank({ inhalt: wieDatenbank(stand) });
  const dir = await repoKopie();
  t.after(async () => { await db.stop(); await rm(dir, { recursive: true, force: true }); });

  const lauf = await baue(dir, { CONTENT_API_URL: db.contentUrl, CONTENT_API_REQUIRED: "1" });
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);
  const protokoll = lauf.stdout + lauf.stderr;
  assert.match(protokoll, /in der alten Hauptsprache/, "der Sprachstand wird nicht gemeldet");
  assert.match(protokoll, /hero\.tagline/, "die betroffene Stelle wird nicht benannt");
  assert.match(protokoll, /der Generator schreibt hier nichts um/, "es fehlt die Zusage, nichts zu ueberschreiben");

  /* Und genau daran haelt er sich: auf der Seite steht weiterhin der
     Grundtext aus der Verwaltung, nicht die Uebersetzung. */
  const start = lies(dir, "index.html");
  assert.ok(start.includes("Turning energy into euphoria."), "der Generator hat den Grundtext ersetzt");
  assert.ok(!start.includes("Aus Energie wird Euphorie."), "der Generator hat die Uebersetzung eingesetzt");
});

test("die Referenzen stehen in der Reihenfolge der Verwaltung — auf jeder Breite", async (t) => {
  const stand = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));
  /* Beispielnamen, keine Kundendaten. Die Reihenfolge ist die Zusage: was in
     der Verwaltung oben steht, steht auf der Seite oben — und auf dem Handy
     sind es die OBERSTEN vier, nicht irgendwelche. */
  stand.sections.references.items = [
    { name: "Erste Referenz", city: "Beispielstadt" },
    { name: "Zweite Referenz", city: "Beispielstadt" },
    { name: "Dritte Referenz", city: "Beispielstadt" },
    { name: "Vierte Referenz", city: "Beispielstadt" },
    { name: "Fuenfte Referenz", city: "Beispielstadt" },
    { name: "Sechste Referenz", city: "Beispielstadt" },
  ];
  stand.sections.shows.items = [];           // keine Dubletten im Spiel

  const db = await starteDatenbank({ inhalt: wieDatenbank(stand) });
  const dir = await repoKopie();
  t.after(async () => { await db.stop(); await rm(dir, { recursive: true, force: true }); });

  const lauf = await baue(dir, { CONTENT_API_URL: db.contentUrl, CONTENT_API_REQUIRED: "1" });
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  const html = lies(dir, "index.html");
  const liste = html.slice(html.indexOf('id="venue-list"'), html.indexOf("</ul>", html.indexOf('id="venue-list"')));
  const namen = Array.from(liste.matchAll(/class="venue-name">([^<]+)</g)).map((m) => m[1]);
  assert.deepEqual(
    namen,
    ["Erste Referenz", "Zweite Referenz", "Dritte Referenz", "Vierte Referenz", "Fuenfte Referenz", "Sechste Referenz"],
    "die Reihenfolge auf der Seite ist nicht die der Verwaltung"
  );

  /* Auf dem Handy zeigt die Seite die ersten vier; der Rest haengt an
     data-extra und kommt ueber den Knopf. Entscheidend: es sind die ERSTEN
     vier der Verwaltung, und die Reihenfolge bleibt auch dahinter. */
  const zeilen = Array.from(liste.matchAll(/<li([^>]*)>[\s\S]*?class="venue-name">([^<]+)</g));
  const vorschau = zeilen.filter(([, attr]) => !/data-extra/.test(attr)).map(([, , name]) => name);
  const rest = zeilen.filter(([, attr]) => /data-extra/.test(attr)).map(([, , name]) => name);
  assert.deepEqual(vorschau, ["Erste Referenz", "Zweite Referenz", "Dritte Referenz", "Vierte Referenz"],
    "auf dem Handy stehen nicht die obersten vier der Verwaltung");
  assert.deepEqual(rest, ["Fuenfte Referenz", "Sechste Referenz"], "der Rest steht nicht in der Reihenfolge der Verwaltung");
  assert.match(html, /data-more="2 weitere anzeigen"/, "der Knopf nennt die Zahl der verborgenen Referenzen nicht");
});
