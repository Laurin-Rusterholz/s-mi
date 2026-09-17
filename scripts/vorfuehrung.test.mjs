/**
 * Die Vorführ-Fassung darf kein Geld einnehmen.
 *
 * BEFUND (17.09.2026, an der ausgelieferten Vorführung nachgesehen):
 * Im Repo `Beispiel-Sami` liegt dieselbe Website noch einmal, zum Herzeigen.
 * Gebaut wird sie mit DIESEM Generator und aus DEMSELBEN Inhalt wie die echte
 * Website. Der Kauf-Knopf im Shop trug deshalb dieselben Stripe Payment Links:
 *
 *     site/shop/index.html  →  https://buy.stripe.com/14A14gepW8FCffs2vm7bW01
 *                              https://buy.stripe.com/dRm9AM6Xu3li2sGfi87bW02
 *
 * Wer in der Vorführung darauf klickte, stand in einer ECHTEN Kasse. Dasselbe
 * galt für den Ticket-Knopf unter „Shows" (echter Ticketverkauf) und für den
 * Ersatzweg „per E-Mail bestellen" (echte Adresse). Der Schalter `FORMS_DEMO`
 * gab es schon — er betraf aber nur die Formulare, nicht die Kasse, und die
 * Vorführung setzte ihn ohnehin nicht.
 *
 * Geprüft wird hier am WIRKLICH GEBAUTEN Stand, zweimal: einmal ohne Schalter
 * (die echte Website — dort MUSS die Kasse funktionieren) und einmal mit
 * VORFUEHRUNG=1. Ein Schalter, der nichts ändert, fiele damit auf.
 *
 * Aufruf:  node --test scripts/vorfuehrung.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, cp, rm, mkdir, readFile } from "node:fs/promises";
import { readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* Ein Stand mit allem, was Geld kosten kann: ein Artikel mit Stripe-Link, ein
   Artikel ohne (der fiele sonst auf die Bestellmail zurück) und ein KOMMENDER
   Termin mit Ticket-Adresse. Erfunden wird dabei nichts, was live stünde —
   diese Daten leben nur im Prüfstand. */
const HEUTE = "2026-09-17";
const STRIPE = "https://buy.stripe.com/TESTLINKtestlinkTESTlink01";

async function standMitKasse() {
  const stand = JSON.parse(await readFile(resolve(ROOT, "content/site.json"), "utf8"));
  stand.sections.shop = stand.sections.shop || {};
  stand.sections.shop.enabled = true;
  stand.sections.shop.items = [
    { name: "Pruefartikel mit Kasse", price: "25", paymentLink: STRIPE },
    { name: "Pruefartikel ohne Kasse", price: "5" },
  ];
  stand.sections.shows.items = [
    {
      date: "2026-12-24", name: "Pruefauftritt Vorfuehrung", city: "Chur", country: "CH",
      status: "confirmed", ticketLabel: "Tickets",
      ticketUrl: "https://tickets.example/pruefauftritt",
    },
  ];
  return stand;
}

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
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "s-mi-vorfuehrung-")));
  await cp(ROOT, dir, {
    recursive: true,
    filter: (quelle) => !/(^|\/)(\.git|media|node_modules)(\/|$)/.test(quelle.slice(ROOT.length)),
  });
  await mkdir(join(dir, "media"), { recursive: true });
  return dir;
}

function baue(dir, env) {
  return new Promise((fertig) => {
    const kind = spawn(process.execPath, [resolve(dir, "scripts/build.mjs")], {
      cwd: dir,
      env: { ...process.env, BUILD_DATE: HEUTE, ...env },
    });
    let stdout = "", stderr = "";
    kind.stdout.on("data", (d) => (stdout += d));
    kind.stderr.on("data", (d) => (stderr += d));
    kind.on("close", (status) => fertig({ status, stdout, stderr }));
  });
}

/** Alle gebauten Seiten als [pfad, html] — je Sprache und je Unterseite. */
function alleSeiten(dir) {
  const gefunden = [];
  const suche = (rel, tiefe) => {
    const abs = rel ? join(dir, rel) : dir;
    const datei = join(abs, "index.html");
    if (existsSync(datei)) gefunden.push([rel ? `${rel}/index.html` : "index.html", readFileSync(datei, "utf8")]);
    if (tiefe <= 0) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (["scripts", "content", "media", "img", "assets", "presskit", "netlify", "node_modules"].includes(e.name)) continue;
      if (e.name.startsWith(".")) continue;
      suche(rel ? `${rel}/${e.name}` : e.name, tiefe - 1);
    }
  };
  suche("", 2);
  return gefunden;
}

/** Den Stand in die Repo-Kopie legen, damit der Generator ihn liest. */
async function mitStand(dir, stand) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "content/site.json"), JSON.stringify(stand, null, 2) + "\n");
}

test("die ECHTE Website behält ihre Kasse — der Schalter ist aus", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitStand(dir, await standMitKasse());

  const lauf = await baue(dir, {});
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  const seiten = alleSeiten(dir);
  /* Gesucht ist der KATALOG (Kacheln mit Kauf-Knopf) — nicht die Einladung
     auf der Startseite und nicht die strukturierten Daten, die den Namen des
     Artikels ebenfalls tragen. */
  const mitShop = seiten.filter(([, h]) => /class="prod rv/.test(h) && h.includes("Pruefartikel mit Kasse"));
  assert.ok(mitShop.length >= 3, `Der Shop steht nicht auf jeder Sprachseite: ${mitShop.length}`);

  for (const [seite, html] of mitShop) {
    assert.ok(html.includes(STRIPE), `${seite}: der echte Kauf-Knopf fehlt`);
    assert.ok(!/shop-demo/.test(html), `${seite}: die echte Website trägt einen Vorführ-Vermerk`);
  }

  const mitShow = seiten.filter(([, h]) => /class="show-list rv/.test(h));
  assert.ok(mitShow.length >= 3, "Der Termin steht nicht auf jeder Sprachseite");
  for (const [seite, html] of mitShow) {
    assert.ok(html.includes("https://tickets.example/pruefauftritt"),
      `${seite}: der echte Ticket-Knopf fehlt`);
  }

  // Und das Formular sendet wirklich.
  for (const [seite, html] of seiten) {
    if (!html.includes('id="booking-form"')) continue;
    assert.ok(html.includes('data-endpoint="/api/booking"'), `${seite}: das Formular hat keinen Endpunkt`);
    assert.ok(!/data-demo="true"/.test(html), `${seite}: das echte Formular ist als Vorführung markiert`);
  }
});

test("VORFUEHRUNG=1: keine echte Kasse, kein echtes Ticket, kein echtes Formular", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitStand(dir, await standMitKasse());

  const lauf = await baue(dir, { VORFUEHRUNG: "1" });
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  const seiten = alleSeiten(dir);
  let shopSeiten = 0, showSeiten = 0, formulare = 0;

  for (const [seite, html] of seiten) {
    /* DER BEFUND: nirgends eine Adresse, an deren Ende jemand zahlen kann. */
    assert.ok(!html.includes("buy.stripe.com"),
      `${seite}: die Vorführung führt in eine echte Stripe-Kasse`);
    assert.ok(!html.includes("https://tickets.example/pruefauftritt"),
      `${seite}: die Vorführung führt in einen echten Ticketverkauf`);
    assert.ok(!/class="[^"]*buy-mail/.test(html),
      `${seite}: die Vorführung bietet eine echte Bestellmail an`);

    if (/class="prod rv/.test(html) && html.includes("Pruefartikel mit Kasse")) {
      shopSeiten++;
      /* Statt des Knopfes steht da, was hier gälte — in der Sprache der Seite. */
      assert.ok(/class="mono shop-demo"/.test(html), `${seite}: der Vorführ-Vermerk im Shop fehlt`);
      // Preis und Name bleiben: die Vorführung soll zeigen, wie der Shop aussieht.
      assert.ok(html.includes("Pruefartikel ohne Kasse"), `${seite}: der zweite Artikel fehlt`);
    }
    if (/class="show-list rv/.test(html)) {
      showSeiten++;
      assert.ok(/show-cta"><span class="mono shop-demo"/.test(html),
        `${seite}: der Ticket-Knopf ist nicht als Vorführung gekennzeichnet`);
    }
    if (html.includes('id="booking-form"')) {
      formulare++;
      assert.ok(html.includes('data-demo="true"'), `${seite}: das Formular sendet in der Vorführung wirklich`);
      assert.ok(/class="bform-demo mono"/.test(html), `${seite}: der Hinweis am Formular fehlt`);
    }
  }

  assert.ok(shopSeiten >= 3, `Der Shop wurde nicht auf jeder Sprachseite geprüft: ${shopSeiten}`);
  assert.ok(showSeiten >= 3, `Die Termine wurden nicht auf jeder Sprachseite geprüft: ${showSeiten}`);
  assert.ok(formulare >= 3, `Das Formular wurde nicht auf jeder Sprachseite geprüft: ${formulare}`);

  /* Der Vermerk steht in der Sprache der Seite — nicht dreimal deutsch. */
  const text = (pfad) => (alleSeiten(dir).find(([p]) => p === pfad) || ["", ""])[1];
  const de = text("shop/index.html") || text("index.html");
  assert.ok(/Vorführung — hier ginge es zur Kasse/.test(de), "der deutsche Vermerk fehlt");
  assert.ok(/Demo — checkout would open here/.test(text("en/shop/index.html") || text("en/index.html")),
    "der englische Vermerk fehlt");
  /* Der Apostroph steht im HTML als `&#39;` — esc() maskiert ihn. Geprüft wird
     deshalb die Zeichenkette, die wirklich in der Seite steht. */
  assert.ok(/Démonstration — la caisse s&#39;ouvrirait ici/.test(text("fr/shop/index.html") || text("fr/index.html")),
    "der französische Vermerk fehlt");
});

test("der alte Name FORMS_DEMO=1 schaltet dasselbe", async (t) => {
  /* Die Vorführung hat den Schalter bisher unter diesem Namen gekannt. Er
     bleibt gültig — sonst fiele beim Umbenennen still die halbe Absicherung
     aus, und zwar genau die, die schon da war. */
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitStand(dir, await standMitKasse());

  const lauf = await baue(dir, { FORMS_DEMO: "1" });
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  for (const [seite, html] of alleSeiten(dir)) {
    assert.ok(!html.includes("buy.stripe.com"), `${seite}: FORMS_DEMO=1 lässt die echte Kasse stehen`);
    if (html.includes('id="booking-form"'))
      assert.ok(html.includes('data-demo="true"'), `${seite}: FORMS_DEMO=1 schaltet das Formular nicht ab`);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   Der Bau muss auch dann laufen, wenn der Weg dorthin über einen Symlink geht

   BEFUND vom Mac (17.09.2026): Der Prüflauf meldete 15 Fehler, die keine
   waren, und ging erst mit `TMPDIR=/private/tmp` durch. Ursache war der
   Schalter am Ende von scripts/build.mjs („nur bauen, wenn direkt
   aufgerufen"): Er verglich `process.argv[1]` (den Pfad, wie er auf der
   Kommandozeile stand) mit `fileURLToPath(import.meta.url)` (dem Pfad, den
   Node beim Laden AUFGELÖST hat). Auf macOS liefert `mkdtemp(tmpdir())`
   `/var/folders/…`, und `/var` ist eine Verknüpfung auf `/private/var` —
   zwei Namen für dieselbe Datei, der Vergleich schlug fehl, `main()` lief
   nie, es wurde nichts gebaut.

   Nachgestellt wird das hier auf JEDEM System: das Repo wird kopiert, daneben
   eine Verknüpfung auf die Kopie gelegt, und der Generator über die
   Verknüpfung gestartet. Auf Linux ist das dieselbe Lage wie auf dem Mac —
   nur absichtlich herbeigeführt statt vom Betriebssystem geerbt.
   ══════════════════════════════════════════════════════════════════════════ */
test("über einen Symlink gestartet baut der Generator trotzdem", async (t) => {
  const { symlink } = await import("node:fs/promises");
  const dir = await repoKopie();
  const ueber = dir + "-verknuepft";
  await symlink(dir, ueber, "dir");
  t.after(async () => {
    await rm(ueber, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  /* Der Pfad, über den gestartet wird, ist WIRKLICH ein anderer Name als der,
     den Node beim Laden auflöst — sonst stellt dieser Test nichts nach. */
  assert.notEqual(ueber, dir, "die Verknüpfung trägt denselben Namen wie das Ziel");
  assert.equal(realpathSync(ueber), dir, "die Verknüpfung zeigt nicht auf die Kopie");

  const lauf = await new Promise((fertig) => {
    const kind = spawn(process.execPath, [join(ueber, "scripts/build.mjs")], {
      cwd: ueber,
      env: { ...process.env, BUILD_DATE: HEUTE },
    });
    let stdout = "", stderr = "";
    kind.stdout.on("data", (d) => (stdout += d));
    kind.stderr.on("data", (d) => (stderr += d));
    kind.on("close", (status) => fertig({ status, stdout, stderr }));
  });

  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);
  /* DER BEFUND: vorher lief `main()` gar nicht — der Bau schwieg und schrieb
     nichts. Beides wird geprüft, die Meldung UND das Ergebnis. */
  assert.match(lauf.stdout, /\[build\] fertig/,
    "der Generator hat gar nicht gebaut (der Schalter am Dateiende hat ihn abgewiesen)");
  const seiten = alleSeiten(dir);
  assert.ok(seiten.length >= 5, `es wurden kaum Seiten gebaut: ${seiten.length}`);
  assert.ok(seiten.some(([p]) => p === "index.html"), "die Startseite fehlt");
});
