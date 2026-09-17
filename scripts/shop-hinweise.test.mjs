/**
 * Der Informationsstreifen im Shop darf der Ware nicht widersprechen.
 *
 * BEFUND (Kundenmeldung 15.09.2026, an der veröffentlichten Seite nachgesehen):
 * Unter dem Katalog stand
 *
 *     „Der Versand wird nach der Bestellung persönlich abgesprochen.
 *      Vorher geht nichts raus."
 *
 * während beide Artikel des Kunden daneben ausdrücklich
 * „Gratis Versand innerhalb der Schweiz!" sagen — und der Stripe-Checkout
 * dasselbe führt. Der generische Streifen widersprach also der Ware, auf die
 * er sich bezieht. Beim Punkt „Zahlung" dasselbe: er verwies auf ein
 * Bestellformular, das am 12.08.2026 entfernt worden ist.
 *
 * ENTSCHEID (17.09.2026): Keine neuen Bedingungen erfinden. Der Streifen ist
 * der GENERISCHE Hinweis und verweist neutral auf die Angaben beim Artikel.
 * Was der Kunde am Artikel und im Checkout hinterlegt hat, bleibt unangetastet
 * — das ist die Quelle, und sie sagt „Gratis Versand innerhalb der Schweiz".
 *
 * Dazu kam beim Nachmessen ein zweiter Befund: Grundsprache ist Deutsch
 * (`site.lang = "de"`), und der Generator zeigt auf der Hauptseite den
 * GRUNDTEXT. Der stand hier auf Englisch — die DEUTSCHE Seite zeigte also den
 * englischen Streifen, während die deutsche Fassung ungenutzt unter `i18n.de`
 * lag. Geprüft wird deshalb jede der drei Sprachen einzeln.
 *
 * Aufruf:  node --test scripts/shop-hinweise.test.mjs
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

/* `realpathSync`: auf macOS liefert mkdtemp `/var/folders/…`, und `/var` ist
   eine Verknüpfung auf `/private/var`. Node löst Symlinks beim Laden eines
   Moduls auf — ohne das rechnen Test und Generator mit zwei Namen für
   dasselbe Verzeichnis. Siehe scripts/vorfuehrung.test.mjs. */
async function repoKopie() {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "s-mi-shop-")));
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
      env: { ...process.env, BUILD_DATE: "2026-09-17", ...env },
    });
    let stdout = "", stderr = "";
    kind.stdout.on("data", (d) => (stdout += d));
    kind.stderr.on("data", (d) => (stderr += d));
    kind.on("close", (status) => fertig({ status, stdout, stderr }));
  });
}

/** Die Zeilen des Streifens einer gebauten Seite, als [Titel, Text]. */
function streifen(dir, rel) {
  const datei = join(dir, rel);
  if (!existsSync(datei)) return null;
  const html = readFileSync(datei, "utf8");
  const i = html.indexOf("shop-info");
  if (i < 0) return null;
  const teil = html.slice(i, i + 3000);
  /* Der Streifen ist eine <ul class="shop-info">; je Punkt ein <strong> mit
     der Aufschrift und ein <p> mit dem Text. */
  return [...teil.matchAll(/<strong>([\s\S]*?)<\/strong>\s*<p[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => [m[1].replace(/<[^>]*>/g, "").trim(), m[2].replace(/<[^>]*>/g, "").trim()]);
}

/* Der veröffentlichte Stand vom 15.09.2026, Zeichen für Zeichen — so stand er
   in content/site.json und so sah ihn der Kunde. */
const ALT_GRUND = [
  { icon: "zahlung", title: "Payment",
    text: "How to pay is shown on the item itself. If no payment link is set, the order comes in through the form and is confirmed personally." },
  { icon: "versand", title: "Shipping",
    text: "Shipping is agreed personally after the order. Nothing is sent before that is settled." },
  { icon: "fragen", title: "Questions",
    text: "Size, colour, availability — write to info@samsparking.ch." },
];
const ALT_DE = {
  0: { title: "Zahlung", text: "Wie bezahlt wird, steht am Artikel. Ist kein Zahlungslink hinterlegt, kommt die Bestellung über das Formular und wird persönlich bestätigt." },
  1: { title: "Versand", text: "Der Versand wird nach der Bestellung persönlich abgesprochen. Vorher geht nichts raus." },
  2: { title: "Fragen", text: "Grösse, Farbe, Verfügbarkeit — schreib an info@samsparking.ch." },
};

/** Der alte Stand in einer Repo-Kopie — so, wie er am 15.09. live war. */
async function mitAltemStreifen(dir, aenderung = (s) => s) {
  const stand = JSON.parse(await readFile(join(dir, "content/site.json"), "utf8"));
  stand.sections.shop.info = JSON.parse(JSON.stringify(ALT_GRUND));
  stand.i18n = stand.i18n || {};
  stand.i18n.de = stand.i18n.de || {};
  stand.i18n.de.sections = stand.i18n.de.sections || {};
  stand.i18n.de.sections.shop = stand.i18n.de.sections.shop || {};
  stand.i18n.de.sections.shop.info = JSON.parse(JSON.stringify(ALT_DE));
  await writeFile(join(dir, "content/site.json"), JSON.stringify(aenderung(stand), null, 2) + "\n");
}

test("der Streifen verweist auf den Artikel — in allen drei Sprachen", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitAltemStreifen(dir);

  const lauf = await baue(dir);
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  const erwartet = {
    "shop/index.html": [
      ["Zahlung", "Wie bezahlt wird, steht beim jeweiligen Artikel. Bei Fragen: info@samsparking.ch."],
      ["Versand", "Die Versandbedingungen stehen beim jeweiligen Artikel. Bei Fragen: info@samsparking.ch."],
      ["Fragen", "Grösse, Farbe, Verfügbarkeit — schreib an info@samsparking.ch."],
    ],
    "en/shop/index.html": [
      ["Payment", "How to pay is shown on the item itself. Questions: info@samsparking.ch."],
      ["Shipping", "Shipping terms are shown on the item itself. Questions: info@samsparking.ch."],
      ["Questions", "Size, colour, availability — write to info@samsparking.ch."],
    ],
    "fr/shop/index.html": [
      ["Paiement", "Le mode de paiement est indiqué sur l&#39;article. Questions : info@samsparking.ch."],
      ["Expédition", "Les conditions d&#39;expédition sont indiquées sur l&#39;article. Questions : info@samsparking.ch."],
      ["Questions", "Taille, couleur, disponibilité — écris à info@samsparking.ch."],
    ],
  };

  for (const [rel, soll] of Object.entries(erwartet)) {
    const ist = streifen(dir, rel);
    assert.ok(ist, `${rel}: kein Informationsstreifen gefunden`);
    assert.deepEqual(ist, soll, `${rel}: der Streifen sagt etwas anderes`);
  }
});

test("die alten Behauptungen stehen nirgends mehr", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitAltemStreifen(dir);
  assert.equal((await baue(dir)).status, 0);

  /* Der Widerspruch, wörtlich, in jeder Sprache — und der Verweis auf das
     Formular, das es seit dem 12.08.2026 nicht mehr gibt. */
  const verboten = [
    "Shipping is agreed personally after the order",
    "Der Versand wird nach der Bestellung persönlich abgesprochen",
    "L&#39;expédition est convenue personnellement après la commande",
    "the order comes in through the form",
    "kommt die Bestellung über das Formular",
    "la commande passe par le formulaire",
  ];
  for (const rel of ["shop/index.html", "en/shop/index.html", "fr/shop/index.html",
                     "index.html", "en/index.html", "fr/index.html"]) {
    if (!existsSync(join(dir, rel))) continue;
    const html = readFileSync(join(dir, rel), "utf8");
    for (const satz of verboten) {
      assert.ok(!html.includes(satz), `${rel}: „${satz}…" steht immer noch da`);
    }
  }
});

test("die Angaben AM ARTIKEL bleiben unangetastet", async (t) => {
  /* Das ist die Quelle, auf die der Streifen jetzt verweist. Sie sagt „Gratis
     Versand innerhalb der Schweiz" — daran wird nichts gedreht, weder hier
     noch im Schnappschuss. */
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitAltemStreifen(dir, (stand) => {
    stand.sections.shop.items = [
      { name: "Pruefartikel", price: "25",
        src: "https://beispiel.invalid/pruefartikel.jpg",
        alt: "Pruefartikel mit Angabe - Gratis Versand innerhalb der Schweiz!" },
    ];
    return stand;
  });
  assert.equal((await baue(dir)).status, 0);

  const html = readFileSync(join(dir, "shop/index.html"), "utf8");
  assert.ok(html.includes("Gratis Versand innerhalb der Schweiz!"),
    "die Versandangabe am Artikel ist verschwunden");

  const schnappschuss = JSON.parse(readFileSync(join(dir, "content/site.json"), "utf8"));
  assert.equal(schnappschuss.sections.shop.items[0].alt,
    "Pruefartikel mit Angabe - Gratis Versand innerhalb der Schweiz!",
    "die Angabe am Artikel wurde in den Daten geändert");
});

test("was der Kunde selbst hinschreibt, gewinnt — und bleibt stehen", async (t) => {
  /* Die Sicherung: ersetzt wird NUR, was wörtlich einem der bekannten alten
     Texte entspricht. Sonst stünde hier eine Regel, die dem Kunden bei jedem
     Bau seine eigene Formulierung wegnimmt. */
  const eigener = "Versand nach Absprache für Bestellungen ausserhalb der Schweiz.";
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitAltemStreifen(dir, (stand) => {
    stand.sections.shop.info[1].text = eigener;
    stand.i18n.de.sections.shop.info["1"].text = eigener;
    return stand;
  });

  const lauf = await baue(dir);
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  const zeilen = streifen(dir, "shop/index.html");
  assert.equal(zeilen[1][1], eigener, "der eigene Text des Kunden wurde überschrieben");
  // Die andere Stelle ist trotzdem umgestellt — es wird nicht alles blockiert.
  assert.match(zeilen[0][1], /steht beim jeweiligen Artikel/, "die Zahlungszeile wurde nicht umgestellt");
  // Und der Bau sagt, dass er etwas stehen gelassen hat.
  assert.match(lauf.stdout, /unveraendert gelassen/,
    "der Bau schweigt darüber, dass er eine Stelle stehen gelassen hat");
});

test("ein zweiter Bau ändert nichts mehr", async (t) => {
  /* Eine Umstellung, die bei jedem Bau erneut zuschlägt, würde nach der ersten
     Runde nur noch den eigenen Text wiederfinden — und den nicht mehr
     erkennen. Geprüft wird deshalb der Lauf auf dem bereits umgestellten
     Stand: er darf nichts mehr melden und nichts mehr ändern. */
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitAltemStreifen(dir);

  assert.equal((await baue(dir)).status, 0);
  const nachEins = streifen(dir, "shop/index.html");

  const zweiter = await baue(dir);
  assert.equal(zweiter.status, 0);
  assert.deepEqual(streifen(dir, "shop/index.html"), nachEins, "der zweite Bau hat den Streifen verändert");
  assert.ok(!/Shop-Hinweis\(e\) auf die Angaben am Artikel umgestellt/.test(zweiter.stdout),
    "der zweite Bau stellt noch einmal um, obwohl schon alles umgestellt ist");
});
