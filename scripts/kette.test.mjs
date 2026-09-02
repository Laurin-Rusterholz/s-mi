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
import { readFileSync, existsSync } from "node:fs";
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

test("eine neu erfasste Show steht nach dem Bauen auf allen Sprachseiten", async (t) => {
  const stand = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));

  /* So sieht der Stand aus, nachdem jemand in der Verwaltung einen Termin
     angelegt und einen Text geaendert hat. Der Termin kommt ans Ende der
     Liste — genau so legt die Verwaltung ihn an ("Termin hinzufuegen"). */
  stand.sections.shows.items = [...stand.sections.shows.items, { ...NEUER_TERMIN }];
  stand.hero.tagline = "Aus der Verwaltung, nicht aus der Vorlage.";

  const db = await starteDatenbank({ inhalt: wieDatenbank(stand) });
  const dir = await repoKopie();
  t.after(async () => {
    await db.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const lauf = await baue(dir, {
    CONTENT_API_URL: db.contentUrl,
    CONTENT_API_REQUIRED: "1",
  });

  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);
  assert.match(
    lauf.stdout,
    /Inhalt von der Verwaltung geladen/,
    "Der Build ist auf den eingecheckten Stand zurueckgefallen, statt die Verwaltung zu lesen"
  );

  for (const seite of ["index.html", "de/index.html", "fr/index.html"]) {
    const html = lies(dir, seite);
    assert.ok(
      html.includes(NEUER_TERMIN.name),
      `${seite}: der neue Termin "${NEUER_TERMIN.name}" fehlt`
    );
    assert.ok(html.includes(NEUER_TERMIN.city), `${seite}: der Ort des neuen Termins fehlt`);
    assert.ok(
      html.includes(`data-date="${NEUER_TERMIN.date}"`),
      `${seite}: der neue Termin steht nicht als Zeile in der Liste`
    );
    assert.ok(html.includes('id="shows"'), `${seite}: der Shows-Abschnitt fehlt ganz`);
    assert.ok(html.includes('href="#shows"'), `${seite}: der Menuepunkt zu den Shows fehlt`);

    /* Der Ort gehoert zum Termin, nicht zu seiner Position: auf /de/ und /fr/
       darf keine alte Uebersetzung eines anderen Termins an seiner Stelle
       stehen (sections.shows.items ist darum in NO_TRANSLATE_PATH). */
    const zeile = html.match(
      new RegExp(`data-date="${NEUER_TERMIN.date}"[\\s\\S]*?</li>`)
    );
    assert.ok(zeile, `${seite}: die Zeile des neuen Termins ist nicht zu finden`);
    assert.ok(
      zeile[0].includes(NEUER_TERMIN.city),
      `${seite}: beim neuen Termin steht ein fremder Ort — ${zeile[0]}`
    );
  }

  /* Das Terminblatt speist den Booking-Kalender: der neue Tag muss als belegt
     erkennbar sein, sonst laesst sich der Termin doppelt buchen. */
  const blatt = lies(dir, "index.html").match(
    /<script type="application\/json" id="shows-data">([\s\S]*?)<\/script>/
  );
  assert.ok(blatt, "Das Terminblatt (shows-data) fehlt auf der Startseite");
  const termine = JSON.parse(blatt[1]);
  assert.ok(
    termine.some((s) => s.date === NEUER_TERMIN.date && s.name === NEUER_TERMIN.name),
    "Der neue Termin fehlt im Terminblatt"
  );

  /* Und die Gegenprobe zur zweiten Ursache: ein in der Verwaltung geaenderter
     Text darf nicht von der eingecheckten Vorlage ueberschrieben werden.
     Bis zum 02.09.2026 lief adoptTexts bei JEDEM Build und holte Texte,
     Uebersetzungen, `ui` und sogar `pages`/`layout` aus der Vorlage zurueck. */
  assert.ok(
    lies(dir, "index.html").includes("Aus der Verwaltung, nicht aus der Vorlage."),
    "Der Text aus der Verwaltung wurde von der Vorlage ueberschrieben"
  );
  assert.doesNotMatch(
    lauf.stdout,
    /Datenbank trägt noch den alten Stand/,
    "Die einmalige Text-Umstellung ist wieder gelaufen"
  );
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
