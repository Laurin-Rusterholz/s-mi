/**
 * Welche Seite ist gemeint? — der Platz in der Liste genügt nicht.
 *
 * LIVE-BEFUND (Sprachprüfung 17.09.2026, an der öffentlichen Fassung gesehen):
 * Auf `/fr/` hiessen die Menüpunkte
 *
 *     ACCUEIL · BOOKING → /fr/shows/ · BOUTIQUE → /fr/gallery/
 *              · BOOKING → /fr/booking/ · SHOP → /fr/shop/
 *
 * „Boutique" stand also über der Galerie und „Booking" über den Shows, während
 * die Shop-Seite unübersetzt „Shop" hiess. Kein Tippfehler, sondern eine
 * Zuordnung, die sich verschoben hat: Die Übersetzungen der Seiten liegen unter
 * `i18n.<lang>.pages.<NUMMER>` — am PLATZ in der Liste. Als sie entstanden,
 * hatte die Website DREI Seiten:
 *
 *     0 = ""        1 = "booking"       2 = "shop"
 *
 * Heute sind es fünf: "", "shows", "gallery", "booking", "shop". Jede später
 * eingefügte Seite schiebt alle Übersetzungen dahinter um einen Platz weiter.
 *
 * Die Kennung, die das überlebt, ist der SLUG. Trägt ein Übersetzungseintrag
 * einen, ordnet `localize()` über ihn zu; der Platz zählt dann nicht mehr.
 * Die Einträge selbst kommen aus `content/korrekturen.json`
 * (`i18n.<lang>.seiten`) und werden von `nachziehen` mit der Liste übernommen;
 * dort steht der Slug jetzt daneben. Gibt es ihn heute nicht mehr, fällt genau
 * diese Übersetzung weg, statt irgendwo anders zu landen.
 *
 * Geprüft wird am wirklich gebauten Stand, in allen drei Sprachen.
 *
 * Aufruf:  node --test scripts/seiten-uebersetzung.test.mjs
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
const { localize, seitenZuordnung } = await import(resolve(ROOT, "scripts/build.mjs"));

/* realpathSync: auf macOS liefert mkdtemp /var/folders/…, und /var ist eine
   Verknüpfung auf /private/var — sonst rechnen Test und Generator mit zwei
   Namen für dasselbe Verzeichnis (siehe scripts/vorfuehrung.test.mjs). */
async function repoKopie() {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "s-mi-seiten-")));
  await cp(ROOT, dir, {
    recursive: true,
    filter: (q) => !/(^|\/)(\.git|media|node_modules)(\/|$)/.test(q.slice(ROOT.length)),
  });
  await mkdir(join(dir, "media"), { recursive: true });
  return dir;
}

function baue(dir) {
  return new Promise((fertig) => {
    const kind = spawn(process.execPath, [join(dir, "scripts/build.mjs")], {
      cwd: dir,
      env: { ...process.env, BUILD_DATE: "2026-09-17" },
    });
    let stdout = "", stderr = "";
    kind.stdout.on("data", (d) => (stdout += d));
    kind.stderr.on("data", (d) => (stderr += d));
    kind.on("close", (status) => fertig({ status, stdout, stderr }));
  });
}

/** Die Menüpunkte einer gebauten Seite als { adresse: aufschrift }. */
function menue(dir, rel) {
  const datei = join(dir, rel);
  if (!existsSync(datei)) return null;
  const html = readFileSync(datei, "utf8");
  const nav = html.match(/<nav[\s\S]*?<\/nav>/);
  if (!nav) return null;
  const raus = {};
  for (const [, adresse, text] of nav[0].matchAll(/href="([^"]+)"[^>]*>([^<]{2,40})</g)) {
    if (adresse.startsWith("#")) continue;
    if (!(adresse in raus)) raus[adresse] = text.trim();
  }
  return raus;
}

/* Der Stand, wie er live lag: Übersetzungen am PLATZ, aus der Zeit der drei
   Seiten — und heute fünf Seiten. */
const ALT_I18N = {
  de: { 0: { navLabel: "Start" }, 1: { navLabel: "Booking" }, 2: { navLabel: "Shop" } },
  en: [{ navLabel: "Home" }],
  fr: { 0: { navLabel: "Accueil" }, 1: { navLabel: "Booking" }, 2: { navLabel: "Boutique" } },
};

async function mitAltenUebersetzungen(dir, aenderung = (s) => s) {
  const stand = JSON.parse(await readFile(join(dir, "content/site.json"), "utf8"));
  stand.i18n = stand.i18n || {};
  for (const [lang, pages] of Object.entries(ALT_I18N)) {
    stand.i18n[lang] = stand.i18n[lang] || {};
    stand.i18n[lang].pages = JSON.parse(JSON.stringify(pages));
  }
  await writeFile(join(dir, "content/site.json"), JSON.stringify(aenderung(stand), null, 2) + "\n");
}

test("der Live-Befund: „Boutique“ steht wieder über dem Shop", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitAltenUebersetzungen(dir);

  const lauf = await baue(dir);
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  const fr = menue(dir, "fr/index.html");
  assert.ok(fr, "keine Navigation auf /fr/");
  assert.equal(fr["/fr/"], "Accueil", "die Startseite heisst nicht Accueil");
  assert.equal(fr["/fr/shop/"], "Boutique", "„Boutique“ steht nicht über dem Shop");
  assert.equal(fr["/fr/booking/"], "Booking", "über /fr/booking/ steht etwas anderes");

  /* DER BEFUND, als Gegenrichtung: „Boutique“ darf NICHT mehr über der Galerie
     stehen, und „Booking“ nicht über den Shows. */
  assert.notEqual(fr["/fr/gallery/"], "Boutique", "„Boutique“ steht immer noch über der Galerie");
  assert.notEqual(fr["/fr/shows/"], "Booking", "„Booking“ steht immer noch über den Shows");

  /* Was der Kunde nicht übersetzt hat, bleibt in der Grundsprache stehen —
     das ist kein Fehler, sondern eine fehlende Übersetzung. */
  assert.equal(fr["/fr/shows/"], "Shows", "der unübersetzte Menüpunkt wurde ersetzt");
  assert.equal(fr["/fr/gallery/"], "Gallery", "der unübersetzte Menüpunkt wurde ersetzt");

  // Und die englische Seite: die einzige Übersetzung sitzt auf der Startseite.
  const en = menue(dir, "en/index.html");
  assert.equal(en["/en/"], "Home", "die englische Startseite heisst nicht Home");
});

test("der Slug steht in der Übersetzung — und NICHT in der Seite", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitAltenUebersetzungen(dir);
  assert.equal((await baue(dir)).status, 0);

  /* Die Slugs stehen in content/korrekturen.json (i18n.<lang>.seiten) und
     werden von `nachziehen` mit der Liste übernommen — die Nummern daneben
     sind nur noch Schlüssel. */
  const stand = JSON.parse(readFileSync(join(dir, "content/site.json"), "utf8"));
  assert.deepEqual(
    Object.entries(stand.i18n.fr.pages).map(([k, v]) => [k, v.slug]),
    [["0", ""], ["1", "booking"], ["2", "shop"]],
    "die französischen Übersetzungen tragen nicht die richtigen Slugs"
  );

  /* Der Slug ist ein Anker, kein Text: er darf niemals in die Seitenliste
     zurückgeschrieben werden (NO_TRANSLATE_PATH). Sonst hiesse /fr/shop/
     plötzlich anders als /shop/. */
  const slugs = stand.pages.map((p) => String(p.slug ?? ""));
  assert.deepEqual(slugs, ["", "shows", "gallery", "booking", "shop"],
    "die Slugs der Seiten wurden durch die Übersetzung verändert");
});

test("eine neu eingefügte Seite verschiebt nichts mehr", async (t) => {
  /* Der Kern der Sache. Genau so ist der Fehler entstanden: zwei Seiten kamen
     dazu, und alle Übersetzungen dahinter rutschten mit. */
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitAltenUebersetzungen(dir, (stand) => {
    stand.pages.splice(1, 0, {
      slug: "presse", navLabel: "Press", title: "Press", sections: [],
      hero: "compact", inNav: true, enabled: true,
    });
    return stand;
  });

  const lauf = await baue(dir);
  assert.equal(lauf.status, 0, `Build fehlgeschlagen:\n${lauf.stdout}\n${lauf.stderr}`);

  const fr = menue(dir, "fr/index.html");
  assert.equal(fr["/fr/shop/"], "Boutique", "nach dem Einfügen sitzt „Boutique“ wieder falsch");
  assert.equal(fr["/fr/"], "Accueil", "nach dem Einfügen sitzt „Accueil“ falsch");
});

test("ein zweiter Bau ändert nichts mehr", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitAltenUebersetzungen(dir);

  assert.equal((await baue(dir)).status, 0);
  const nachEins = menue(dir, "fr/index.html");

  const zweiter = await baue(dir);
  assert.equal(zweiter.status, 0);
  assert.deepEqual(menue(dir, "fr/index.html"), nachEins, "der zweite Bau hat das Menü verändert");
  const stand = JSON.parse(readFileSync(join(dir, "content/site.json"), "utf8"));
  assert.equal(stand.i18n.fr.pages["2"].slug, "shop", "der Slug ist nach dem zweiten Bau weg");
});

/* ── Die Zuordnung für sich, ohne Bau ──────────────────────────────────── */
test("seitenZuordnung: Slug schlägt Platz, fehlender Slug fällt weg", () => {
  const inhalt = { pages: [{ slug: "" }, { slug: "shows" }, { slug: "gallery" }, { slug: "booking" }, { slug: "shop" }] };

  const karte = seitenZuordnung(inhalt, {
    pages: {
      0: { navLabel: "Accueil", slug: "" },
      1: { navLabel: "Booking", slug: "booking" },
      2: { navLabel: "Boutique", slug: "shop" },
    },
  });
  assert.equal(karte.get("0"), 0, "die Startseite wird falsch zugeordnet");
  assert.equal(karte.get("1"), 3, "„booking“ wird nicht auf Platz 3 gelegt");
  assert.equal(karte.get("2"), 4, "„shop“ wird nicht auf Platz 4 gelegt");

  /* Ohne Slug bleibt es beim Platz — sonst würde eine noch ungestempelte
     Fassung gar nicht mehr übersetzt. */
  const ohne = seitenZuordnung(inhalt, { pages: { 1: { navLabel: "Irgendwas" } } });
  assert.equal(ohne.get("1"), 1, "ohne Slug wird nicht mehr über den Platz zugeordnet");

  /* Slug gibt es nicht mehr (Seite gelöscht): die Übersetzung fällt weg,
     statt irgendwo anders zu landen. */
  const weg = seitenZuordnung(inhalt, { pages: { 1: { navLabel: "Presse", slug: "presse" } } });
  assert.equal(weg.has("1"), false, "eine Übersetzung ohne Seite landet trotzdem irgendwo");
});

test("localize setzt die Aufschrift an der richtigen Stelle ein", () => {
  const inhalt = {
    site: { lang: "de", languages: ["fr"] },
    pages: [
      { slug: "", navLabel: "Home" },
      { slug: "shows", navLabel: "Shows" },
      { slug: "gallery", navLabel: "Gallery" },
      { slug: "booking", navLabel: "Booking" },
      { slug: "shop", navLabel: "Shop" },
    ],
    i18n: {
      fr: {
        pages: {
          0: { navLabel: "Accueil", slug: "" },
          2: { navLabel: "Boutique", slug: "shop" },
        },
      },
    },
  };
  const fr = localize(inhalt, "fr");
  assert.deepEqual(fr.pages.map((p) => p.navLabel),
    ["Accueil", "Shows", "Gallery", "Booking", "Boutique"],
    "die Aufschriften sitzen nicht dort, wo ihr Slug hinzeigt");
  // Und die Slugs selbst bleiben, wie sie waren.
  assert.deepEqual(fr.pages.map((p) => p.slug), ["", "shows", "gallery", "booking", "shop"],
    "localize hat die Slugs der Seiten verändert");
  // Der Grundstand bleibt unberührt — localize arbeitet auf einer Kopie.
  assert.equal(inhalt.pages[4].navLabel, "Shop", "der Grundstand wurde verändert");
});
