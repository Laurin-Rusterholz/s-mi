/**
 * Die Galerie: was gezeigt wird, was gezaehlt wird — und was gar nicht erst
 * auf die Seite kommt.
 *
 * LIVE-BEFUND 17.09.2026 (samsparking.ch/gallery/): zuerst 6 Bilder, Knopf
 * „SHOW 31 MORE“, nach dem Ausklappen zaehlt die Bildansicht bis „32“. Der
 * Verdacht: der Knopf zaehle die 5 Galerie-Plaetze mit, zu denen im CMS keine
 * Datei gehoert.
 *
 * NACHGEMESSEN — der Verdacht trifft nicht zu, und die 5 ist ein Zufall:
 *
 *     42 Eintraege im CMS
 *   –  5 ohne Datei          → fallen ueberall heraus, auch aus den
 *                              strukturierten Daten und der Sitemap
 *   = 37 Kacheln             → 32 Fotos + 5 VIDEOS
 *      6 sofort sichtbar, 31 hinter dem Knopf  (6 + 31 = 37)
 *     die Bildansicht zaehlt nur Fotos: „von 32“
 *
 * Beide Zahlen stimmen also — sie zaehlen nur Verschiedenes: der Knopf
 * KACHELN (die klappt er auf), die Bildansicht FOTOS (Videos laufen dort
 * nicht). Dass auch genau 5 Plaetze leer sind, macht die Rechnung von aussen
 * ununterscheidbar.
 *
 * Dieser Test haelt die ganze Kette fest, damit eine kuenftige Verschiebung um
 * fuenf sofort auffaellt statt bei der naechsten Abnahme:
 *
 *   1. Leere Plaetze erscheinen NIRGENDS — und werden trotzdem nicht geloescht.
 *   2. Die Zahl im Knopf ist genau die Zahl der eingeklappten Kacheln.
 *   3. Die Zahl in der Bildansicht ist genau die Zahl der Foto-Kacheln.
 *   4. Kein leeres `src` auf der Seite — ausser in der verborgenen Bildansicht,
 *      die ihr Bild erst beim Oeffnen bekommt.
 *
 *   node --test scripts/galerie-zaehlung.test.mjs
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

async function repoKopie() {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "s-mi-galerie-")));
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

/** Die Galerie einer gebauten Seite, aufgeschluesselt. */
function galerie(dir, rel) {
  const html = readFileSync(join(dir, rel), "utf8");
  const anfang = html.indexOf('id="gal"');
  if (anfang < 0) return null;
  const block = html.slice(anfang, html.indexOf("</section>", anfang));
  const kacheln = [...block.matchAll(/<figure([^>]*)>/g)].map((m) => m[1]);
  const knopf = (block.match(/data-more="([^"]*)"/) || [])[1] || "";
  const gesamt = [...block.matchAll(/von (\d+) gross/g)].map((m) => Number(m[1]));
  return {
    kacheln: kacheln.length,
    videos: kacheln.filter((a) => /gal-video/.test(a)).length,
    fotos: kacheln.filter((a) => !/gal-video/.test(a)).length,
    eingeklappt: kacheln.filter((a) => /\bdata-extra\b/.test(a)).length,
    sichtbar: kacheln.filter((a) => !/\bdata-extra\b/.test(a)).length,
    knopfZahl: Number((knopf.match(/\d+/) || [])[0] ?? NaN),
    bildansichtGesamt: [...new Set(gesamt)],
    html,
  };
}

/* Ein ueberschaubarer Stand, der GENAU den Live-Fall nachbaut: Fotos, Videos
   und Plaetze ohne Datei, gemischt wie im CMS. Beispieldaten. */
const PLAETZE = [
  { src: "img/a1.jpg", alt: "Foto 1" },
  { src: "img/a2.jpg", alt: "Foto 2" },
  { src: "", alt: "Platz ohne Datei" },            // leer, mittendrin
  { src: "img/v1.mp4", alt: "Video 1" },
  { src: "img/a3.jpg", alt: "Foto 3" },
  { src: "", alt: "" },                             // leer, ganz ohne Angabe
  { src: "img/a4.jpg", alt: "Foto 4" },
  { src: "img/v2.mp4", alt: "Video 2" },
  { src: "img/a5.jpg", alt: "Foto 5" },
  { src: "img/a6.jpg", alt: "Foto 6" },
  { src: "", alt: "" },                             // leer, am Schluss der Mitte
  { src: "img/a7.jpg", alt: "Foto 7" },
];
// 12 Plaetze: 3 leer -> 9 Kacheln (7 Fotos + 2 Videos).

async function mitPlaetzen(dir, plaetze = PLAETZE) {
  const stand = JSON.parse(await readFile(join(dir, "content/site.json"), "utf8"));
  stand.sections.gallery.items = plaetze;
  await writeFile(join(dir, "content/site.json"), JSON.stringify(stand, null, 2) + "\n");
  return stand;
}

test("leere Plaetze erscheinen nirgends — und bleiben trotzdem im Inhalt stehen", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitPlaetzen(dir);
  const bau = await baue(dir);
  assert.equal(bau.status, 0, `der Bau ist gescheitert:\n${bau.stderr}`);

  const g = galerie(dir, "gallery/index.html");
  assert.equal(g.kacheln, 9, "die leeren Plaetze stehen als Kacheln auf der Seite");
  assert.equal(g.fotos, 7, "es sind nicht die erwarteten Fotos");
  assert.equal(g.videos, 2, "es sind nicht die erwarteten Videos");

  /* GELOESCHT WIRD NICHTS: die drei leeren Plaetze stehen unveraendert im
     Inhalt — sie sollen in der Verwaltung ja noch belegt werden koennen. */
  const stand = JSON.parse(readFileSync(join(dir, "content/site.json"), "utf8"));
  assert.equal(stand.sections.gallery.items.length, 12, "im Inhalt wurden Plaetze entfernt");
  assert.equal(stand.sections.gallery.items[2].alt, "Platz ohne Datei", "ein Platz wurde umgeschrieben");

  /* Und der Bau sagt beim Bauen, welche Plaetze leer sind — sonst faellt es
     niemandem auf. */
  assert.match(bau.stderr + bau.stdout, /3 Bild\(er\) ohne Datei/,
    "der Bau meldet die leeren Plaetze nicht mehr");
});

test("die Zahl im Knopf ist die Zahl der eingeklappten Kacheln", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitPlaetzen(dir);
  assert.equal((await baue(dir)).status, 0);

  for (const rel of ["gallery/index.html", "en/gallery/index.html", "fr/gallery/index.html"]) {
    const g = galerie(dir, rel);
    assert.equal(g.knopfZahl, g.eingeklappt, `${rel}: der Knopf verspricht etwas anderes, als dahinter steckt`);
    assert.equal(g.sichtbar + g.eingeklappt, g.kacheln, `${rel}: sichtbar + eingeklappt ergibt nicht alle Kacheln`);
    /* Die leeren Plaetze zaehlen nirgends mit — genau der Verdacht vom
       17.09.2026, hier ausgeschlossen. */
    assert.equal(g.knopfZahl, 9 - g.sichtbar, `${rel}: die Zahl im Knopf enthaelt leere Plaetze`);
  }
});

test("die Bildansicht zaehlt Fotos — und zwar alle", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitPlaetzen(dir);
  assert.equal((await baue(dir)).status, 0);

  const g = galerie(dir, "gallery/index.html");
  assert.deepEqual(g.bildansichtGesamt, [g.fotos],
    "die Bildansicht nennt eine andere Gesamtzahl als es Foto-Kacheln gibt");
  /* Videos gehoeren NICHT dazu: sie laufen in der Bildansicht nicht. Dass die
     beiden Zahlen darum auseinandergehen, ist richtig — nur muss jede fuer
     sich stimmen. */
  assert.notEqual(g.fotos, g.kacheln, "der Fall mit Videos wird gar nicht mehr geprueft");
});

test("kein leeres src auf der Seite — ausser in der verborgenen Bildansicht", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitPlaetzen(dir);
  assert.equal((await baue(dir)).status, 0);

  for (const rel of ["gallery/index.html", "index.html", "en/gallery/index.html", "fr/gallery/index.html"]) {
    const html = readFileSync(join(dir, rel), "utf8");
    const leer = [...html.matchAll(/<[a-z]+[^>]*src=""[^>]*>/g)].map((m) => m[0]);
    /* Erlaubt ist genau eines: das Bild der Bildansicht. Es steht in einem
       Dialog mit `hidden` und bekommt seine Adresse erst beim Oeffnen. */
    assert.deepEqual(leer, ['<img id="lb-img" src="" alt="">'],
      `${rel}: es steht ein leeres src auf der Seite`);
    const dialog = (html.match(/<div class="lb" id="lb"[^>]*>/) || [])[0] || "";
    assert.match(dialog, /\bhidden\b/, `${rel}: die Bildansicht steht offen auf der Seite`);
  }
});

test("leere Plaetze stehen auch nicht in Sitemap und strukturierten Daten", async (t) => {
  const dir = await repoKopie();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mitPlaetzen(dir);
  assert.equal((await baue(dir)).status, 0);

  /* Eine leere Adresse in der Bilder-Sitemap oder in den strukturierten Daten
     waere fuer Besucher unsichtbar — Google bekaeme sie trotzdem. */
  const sitemap = readFileSync(join(dir, "sitemap.xml"), "utf8");
  assert.ok(!/<image:loc>\s*<\/image:loc>/.test(sitemap), "die Sitemap nennt ein Bild ohne Adresse");

  const html = readFileSync(join(dir, "gallery/index.html"), "utf8");
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => JSON.parse(m[1]))
    .flatMap((d) => d["@graph"] || [d]);
  const galerien = ld.filter((d) => d["@type"] === "ImageGallery");
  for (const gal of galerien) {
    const bilder = [].concat(gal.image || []);
    assert.ok(bilder.every((b) => String(b?.contentUrl || b || "").trim()),
      "in den strukturierten Daten steht ein Bild ohne Adresse");
    /* Nur Fotos, keine Videos und keine leeren Plaetze. */
    assert.equal(bilder.length, 7, "die strukturierten Daten nennen eine andere Zahl Fotos");
  }
});
