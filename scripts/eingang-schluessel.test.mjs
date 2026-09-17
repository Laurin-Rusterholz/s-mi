/**
 * Warum nichts ankommt, muss dastehen — nicht „HTTP 401".
 *
 * LIVEBELEG (Netlify, Production, Functions/zaehler, 17.09.2026):
 *
 *     14:46:15  ERROR  [zaehler] nicht gezaehlt: HTTP 401
 *     14:48:10  ERROR  [zaehler] nicht gezaehlt: HTTP 401
 *     14:48:23  ERROR  [zaehler] nicht gezaehlt: HTTP 401
 *
 * Der Aufruf des Browsers kam also an. Abgewiesen hat die REALTIME DATABASE,
 * und zwar den Schreibzugriff. Geschrieben wird mit `?auth=<INBOX_API_TOKEN>`;
 * fehlt der, ist der Zugriff nicht angemeldet und die Regeln lehnen ab — zu
 * Recht, denn die Datenbank ist nicht öffentlich beschreibbar und soll es
 * nicht werden.
 *
 * Betroffen ist nicht nur der Zähler. Booking-Anfragen (`ablegen`),
 * Bestellungen und der Stripe-Beleg gehen denselben Weg — dieselbe Datenbank,
 * derselbe Schlüssel. Dass es niemandem auffiel, liegt an der E-Mail: die
 * hängt an RESEND_API_KEY und geht weiterhin raus.
 *
 * Und die Auskunft `GET /api/booking` half nicht weiter: sie meldete
 * `eingangGesetzt` — das ist die ADRESSE (INBOX_API_URL), nicht der
 * SCHLÜSSEL. Genau die Angabe, an der es hängt, fehlte.
 *
 * Geprüft wird hier, was der Code daraus macht. Gelöst ist der Befund damit
 * NICHT: den Schlüssel kann nur setzen, wer Zugriff auf die Netlify-Variablen
 * hat. Diese Prüfungen sorgen dafür, dass es beim nächsten Mal in Sekunden
 * dasteht statt in Stunden.
 *
 * Aufruf:  node --test scripts/eingang-schluessel.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { zustand, dbFehler } = await import(resolve(ROOT, "netlify/functions/_lib.mjs"));

/** Eine Umgebungsvariable für die Dauer eines Falls setzen. */
function mitUmgebung(werte, fn) {
  const vorher = {};
  for (const [k, v] of Object.entries(werte)) {
    vorher[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(vorher)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("die Auskunft sagt, ob der SCHLÜSSEL gesetzt ist — nicht nur die Adresse", () => {
  const ohne = mitUmgebung({ INBOX_API_TOKEN: undefined }, () => zustand());
  assert.equal(ohne.eingangSchluesselGesetzt, false,
    "ohne INBOX_API_TOKEN meldet die Auskunft trotzdem einen Schlüssel");

  const mit = mitUmgebung({ INBOX_API_TOKEN: "ein-wert-der-hier-nichts-tut" }, () => zustand());
  assert.equal(mit.eingangSchluesselGesetzt, true,
    "mit INBOX_API_TOKEN meldet die Auskunft keinen Schlüssel");

  /* Nur ja/nein — nie der Wert. Sonst stünde ein Zugangsschlüssel in einer
     offen abrufbaren Antwort. */
  const alsText = JSON.stringify(mit);
  assert.ok(!alsText.includes("ein-wert-der-hier-nichts-tut"),
    "die Auskunft gibt den Schlüssel selbst preis");

  /* Und der Hinweis sagt, was ein `false` bedeutet — sonst ist die Angabe
     zwar da, aber niemand weiss, was zu tun ist. */
  assert.match(mit.hinweis, /INBOX_API_TOKEN/, "der Hinweis nennt die Variable nicht");
  assert.match(mit.hinweis, /Mailweg haengt nicht\s+daran|Mailweg haengt nicht daran/,
    "der Hinweis sagt nicht, dass der Mailweg an einem anderen Schlüssel hängt");
  assert.match(mit.hinweis, /AUDIT\.md/, "der Hinweis sagt nicht, wo das Ganze steht");

  /* REVIEW 17.09.2026: der Hinweis darf NICHT mehr sagen, als gemessen ist.
     Gemessen ist ein abgewiesener Pfad (der Zähler). „Jeder Schreibzugriff“
     und „die E-Mail geht trotzdem raus“ gingen darüber hinaus — das eine ist
     für Anfragen und Bestellungen nie gemessen worden, das andere verwechselt
     eine gesetzte Variable mit einer Zustellung. */
  assert.ok(!/jeden Schreibzugriff/.test(mit.hinweis),
    "der Hinweis behauptet wieder, JEDER Schreibzugriff werde abgewiesen");
  assert.ok(!/trotzdem raus/.test(mit.hinweis),
    "der Hinweis behauptet wieder, die E-Mail gehe trotzdem raus");
});

test("ein abgewiesener Schreibzugriff wird im Klartext gemeldet", () => {
  const ohne = dbFehler(401, "");
  assert.match(ohne, /HTTP 401/, "der Statuscode fehlt");
  assert.match(ohne, /KEIN INBOX_API_TOKEN gesetzt/, "es steht nicht da, dass der Schlüssel fehlt");
  assert.match(ohne, /Netlify/, "es steht nicht da, wo er hingehört");

  const mit = dbFehler(403, "vorhanden");
  assert.match(mit, /HTTP 403/, "der Statuscode fehlt");
  assert.match(mit, /passt nicht|Regeln erlauben/, "es steht nicht da, was dann los ist");
  assert.ok(!/KEIN INBOX_API_TOKEN/.test(mit),
    "mit gesetztem Schlüssel wird trotzdem behauptet, er fehle");

  /* Nicht raten: ein Serverfehler ist kein Rechteproblem und wird auch nicht
     als eines gemeldet. */
  assert.equal(dbFehler(500, ""), "HTTP 500", "ein 500er wird als Rechteproblem ausgegeben");
  assert.equal(dbFehler(404, "x"), "HTTP 404", "ein 404er wird als Rechteproblem ausgegeben");
});

test("alle vier Schreibwege melden es gleich", () => {
  /* Zähler, Eingang (Booking/Bestellung) und Stripe-Beleg schreiben in
     dieselbe Datenbank mit demselben Schlüssel. Ein Weg, der weiter nur
     „HTTP 401" sagt, schickt den Nächsten wieder auf die Suche. */
  for (const datei of ["netlify/functions/_lib.mjs",
                       "netlify/functions/zaehler.mjs",
                       "netlify/functions/stripe-webhook.mjs"]) {
    const quelle = readFileSync(join(ROOT, datei), "utf8");
    assert.ok(/dbFehler\(/.test(quelle), `${datei}: meldet den Statuscode noch nackt`);
    assert.ok(!/new Error\(`HTTP \$\{res\.status\}`\)/.test(quelle),
      `${datei}: wirft immer noch den nackten Statuscode`);
  }
});

test("die Datenbank wird NICHT geöffnet, um das Problem zu umgehen", () => {
  /* Der naheliegende falsche Weg wäre, `samsparking/stats` öffentlich
     beschreibbar zu machen. Dann zählte es wieder — und jeder könnte
     hineinschreiben. Geprüft wird, dass der Schreibweg weiterhin einen
     Schlüssel mitschickt, statt ohne auszukommen. */
  for (const datei of ["netlify/functions/_lib.mjs", "netlify/functions/zaehler.mjs"]) {
    const quelle = readFileSync(join(ROOT, datei), "utf8");
    assert.ok(/INBOX_API_TOKEN/.test(quelle), `${datei}: schickt gar keinen Schlüssel mehr mit`);
    assert.ok(/auth=/.test(quelle), `${datei}: meldet den Zugriff nicht mehr an`);
  }
});

test("der Zähler hält die Seite nicht auf, auch wenn er nicht schreiben darf", () => {
  /* Das war schon vorher richtig und soll es bleiben: ein verlorener Zähler
     ist kein Grund, dem Besucher etwas zu zeigen. Antwort 202, kein Fehler. */
  const quelle = readFileSync(join(ROOT, "netlify/functions/zaehler.mjs"), "utf8");
  assert.match(quelle, /return json\(\{ ok: false \}, 202\)/,
    "ein abgewiesener Zähler meldet dem Browser jetzt einen Fehler");
});

test("der Browser gibt nicht nach dem ersten Weg auf", () => {
  /* KEINE Ursachenbehauptung: der 401 kommt vom Server, daran ändert der
     Browser nichts. Aber der Weg dorthin hatte eine Lücke — `sendBeacon` kann
     `false` zurückgeben oder werfen, und beides wurde nicht angesehen. Dann
     ging schlicht nichts raus, ohne dass irgendwo etwas fehlte. */
  const quelle = readFileSync(join(ROOT, "assets/site.js"), "utf8");
  const i = quelle.indexOf("window.zaehlSenden = function");
  assert.ok(i > 0, "es gibt keine prüfbare Weiche für den Zählaufruf");
  const block = quelle.slice(i, i + 1400);
  assert.match(block, /catch \(e\) \{\s*angenommen = false;/, "ein Wurf von sendBeacon wird nicht aufgefangen");
  assert.match(block, /if \(angenommen\) return "beacon";/, "der Rückgabewert von sendBeacon wird nicht angesehen");
  assert.match(block, /keepalive: true/, "es gibt keinen Rückfall auf fetch");

  /* Die Weiche wirklich ausführen — dreimal, für jeden Ausgang. */
  const bauen = new Function("fenster", "navigator", "fetch", "Blob",
    "const window = fenster; " + block.slice(0, block.indexOf("\n      };") + 9) + " return fenster.zaehlSenden;");

  const ruf = { beacon: 0, fetch: 0 };
  const Blob0 = function () {};
  const fetch0 = () => { ruf.fetch++; return { catch() {} }; };

  const jaSager = bauen({}, { sendBeacon: () => { ruf.beacon++; return true; } }, fetch0, Blob0);
  assert.equal(jaSager("{}"), "beacon", "der angenommene Beacon wird nicht als solcher gemeldet");
  assert.equal(ruf.fetch, 0, "obwohl der Beacon ankam, wurde zusätzlich gefetcht");

  const neinSager = bauen({}, { sendBeacon: () => false }, fetch0, Blob0);
  assert.equal(neinSager("{}"), "fetch", "ein abgelehnter Beacon führt nicht zum Rückfall");
  assert.equal(ruf.fetch, 1, "der Rückfall hat nicht gesendet");

  const werfer = bauen({}, { sendBeacon: () => { throw new Error("nope"); } }, fetch0, Blob0);
  assert.equal(werfer("{}"), "fetch", "ein werfender Beacon führt nicht zum Rückfall");
  assert.equal(ruf.fetch, 2, "der Rückfall hat nicht gesendet");

  const ohneBeacon = bauen({}, {}, fetch0, Blob0);
  assert.equal(ohneBeacon("{}"), "fetch", "ohne sendBeacon wird gar nicht gesendet");
});

test("gezählt wird weiterhin nur, was gezählt werden darf", () => {
  /* Datensparsamkeit unverändert: DNT wird beachtet, es gibt keine Kennung,
     kein Cookie, keine Adresse — und an den vier Angaben ändert sich nichts. */
  const quelle = readFileSync(join(ROOT, "assets/site.js"), "utf8");
  assert.match(quelle, /navigator\.doNotTrack === "1"/, "Do Not Track wird nicht mehr beachtet");
  const i = quelle.indexOf("var zaehlDaten = JSON.stringify(");
  const block = quelle.slice(i, i + 400);
  for (const feld of ["pfad", "sprache", "geraet", "neu"]) {
    assert.ok(block.includes(feld + ":"), `die Angabe „${feld}" fehlt`);
  }
  assert.ok(!/localStorage|document\.cookie|kennung|userId/i.test(block),
    "es wird mehr mitgeschickt als die vier Angaben");
});

test("die Anleitung trennt Gemessenes von Vermutetem — und sagt nicht mehr „nein“", () => {
  /* RESTABNAHME 17.09.2026: In AUDIT.md stand `INBOX_API_TOKEN` in der Spalte
     „Pflicht" auf **nein**, mit der Begründung „falls der Eingang später nicht
     mehr öffentlich beschreibbar sein soll". Genau das ist er aber längst
     nicht mehr — die Datenbank weist seit dem 13.08./01.09.2026 jeden nicht
     angemeldeten Schreibzugriff ab. Wer nach dem 401 in dieser Tabelle
     nachsah, las das Gegenteil dessen, was der Code meldet.

     Geprüft wird die Zeile, nicht die Wortwahl drumherum. */
  const audit = readFileSync(join(ROOT, "AUDIT.md"), "utf8");
  const zeile = audit.split("\n").find((z) => z.startsWith("| `INBOX_API_TOKEN`"));
  assert.ok(zeile, "die Zeile zu INBOX_API_TOKEN fehlt in AUDIT.md");

  const spalten = zeile.split("|").map((x) => x.trim());
  assert.ok(!/^\**nein\**$/i.test(spalten[2]), "die Pflicht-Spalte steht wieder auf „nein“");
  assert.match(zeile, /401/, "die Zeile nennt den gemessenen Befund (HTTP 401) nicht");
  /* Und sie verspricht nicht, dass es mit dieser einen Variablen getan wäre. */
  assert.match(zeile, /nicht getan|offen/i, "die Zeile tut so, als genüge die Variable");

  /* Und die Frage, die beim 401 wirklich zu klären ist, steht im Dokument:
     welches Anmeldeverfahren überhaupt unterstützt wird — und dass ein
     dauerhafter Dienstzugang mit kleinsten Rechten heute NICHT vorgesehen
     ist. Ohne diesen Absatz endet die Suche wieder bei „Token setzen". */
  assert.match(audit, /Server-Zugang zur Datenbank/, "der Abschnitt zum Server-Zugang fehlt");
  assert.match(audit, /Implementierungslücke/, "die fehlende Erneuerung steht nicht als Lücke im Code da");
  assert.match(audit, /Legacy-Datenbankgeheimnis/, "die Anmeldeverfahren sind nicht benannt");
  assert.match(audit, /Rules Playground|Regelsimulation/, "die Regelsimulation fehlt als Beleg");

  /* REVIEW 17.09.2026, drei Punkte — jeder davon war im Text falsch oder zu
     weit gefasst. Sie stehen hier, weil so etwas beim nächsten Umformulieren
     sonst unbemerkt zurückkommt. */

  // (a) Die beiden Wege der REST-Schnittstelle gehören auseinandergehalten:
  //     OAuth2 läuft NICHT über ?auth=, sondern über Authorization: Bearer
  //     bzw. ?access_token=.
  assert.match(audit, /access_token=/, "der OAuth2-Weg wird nicht genannt");
  assert.match(audit, /Authorization: Bearer/, "der Kopfzeilen-Weg wird nicht genannt");
  const oauthZeile = audit.split("\n").find((z) => /OAuth2-Zugriffstoken/.test(z) && z.startsWith("|"));
  assert.ok(oauthZeile, "die Zeile zum OAuth2-Token fehlt");
  assert.ok(!/\?auth=/.test(oauthZeile),
    "AUDIT.md behauptet wieder, ein OAuth2-Token gehöre in ?auth=");

  // (b) Ein Dienstkonto wird durch Regeln nicht automatisch eingegrenzt.
  assert.match(audit, /IAM/, "IAM und Sicherheitsregeln werden nicht getrennt");
  assert.match(audit, /kein Zugangsschutz/, "ein Regelentwurf wird als Schutz verkauft");

  // (c) Gemessenes, Gefolgertes und Unbelegtes stehen getrennt da.
  assert.match(audit, /gemessen wurde es nicht|nicht gemessen/,
    "es steht nicht da, was NICHT gemessen wurde");
  assert.ok(!/E-Mails gehen raus/.test(audit), "AUDIT.md behauptet wieder, es gingen E-Mails raus");
  assert.match(audit, /nicht belegt/, "der ungeprüfte Mailversand wird nicht als solcher benannt");

  /* LIVESTAND 17.09.2026 (Firebase Console, nur gelesen): unter `samsparking`
     stehen `.read`/`.write` auf "auth != null", dazu `content` und `media`
     öffentlich lesbar — und sonst nichts. Keine Unterregeln, keine
     `.validate`. Die Vorlage im anderen Repository beschreibt das NICHT.
     Diese vier Prüfungen halten fest, dass die Doku vom Livestand ausgeht
     und nicht von der Vorlage. */
  assert.match(audit, /auth != null/, "der Livestand der Regeln steht nicht da");
  assert.match(audit, /beschreibt den Livezustand NICHT/,
    "die abgelegte Regelvorlage wird wieder als Livezustand geführt");
  for (const pfad of ["stats", "stripeEvents", "inquiries"]) {
    assert.ok(audit.includes(pfad), `der Pfad „${pfad}“ kommt nicht vor`);
  }
  assert.ok(!/kein Knoten|standardmässig verboten/.test(audit),
    "es wird wieder behauptet, für stats fehle ein Knoten — live gilt die Elternregel");

  /* Und die beiden Sätze, ohne die jemand doch „nur schnell einen Token“
     setzt: das Projekt ist gemeinsam, und ein einmal gesetzter Wert genügt
     nicht, weil beide brauchbaren Merkmale ablaufen. */
  assert.match(audit, /mehr als Sämis Daten/, "die Reichweite im gemeinsamen Projekt fehlt");
  assert.match(audit, /erneuern/, "es steht nicht da, dass der Betrieb erneuern muss");
  assert.match(audit, /ohne\s+ausdrückliche Freigabe|ausdrückliche Freigabe/,
    "es steht nicht da, dass das eine Freigabe braucht");

  /* Der ausgearbeitete Vorschlag (17.09.2026) — drei Sätze daraus dürfen nicht
     verloren gehen, weil ohne sie der bequemste Weg gewählt würde. */
  assert.match(audit, /Vorschlag: dauerhaft erneuerter Serverzugriff/, "der Vorschlag fehlt");
  assert.match(audit, /erfüllt die Anforderung nicht/,
    "es steht nicht da, dass der bequemste Weg die Anforderung verfehlt");
  assert.match(audit, /Nichts davon ist\s+umgesetzt|Nichts davon ist umgesetzt/,
    "der Vorschlag liest sich, als wäre er schon umgesetzt");
  assert.match(audit, /erneuern/, "die Erneuerung fehlt im Vorschlag");

  /* KEIN Geheimnis im Dokument — weder echt noch als Beispiel. */
  assert.ok(!/AIza[0-9A-Za-z_-]{20,}/.test(audit), "in AUDIT.md steht ein Schlüssel");
  assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(audit), "in AUDIT.md steht ein privater Schlüssel");
});
