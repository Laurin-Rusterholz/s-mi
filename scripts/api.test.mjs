#!/usr/bin/env node
/**
 * Prueft die Server-Endpunkte Ende zu Ende — ohne Netz.
 *
 * Warum dieser Test existiert: Ein Formular, das "Danke" sagt und nichts
 * verschickt, ist schlimmer als eines, das gar nicht erst da ist. Genau das
 * war der Stand vor August 2026. Der Test haelt deshalb den ganzen Weg fest:
 * Ein vollstaendig ausgefuelltes Formular MUSS zu einem Eintrag im Eingang
 * UND zu einer E-Mail an info@samsparking.ch fuehren; ein unvollstaendiges
 * darf keine Erfolgsmeldung bekommen; und faellt beides aus, muss der
 * Endpunkt das offen sagen (kein 200).
 *
 * Aufruf:  node scripts/api.test.mjs
 */
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";

process.env.MAIL_TO = "info@samsparking.ch";
process.env.RESEND_API_KEY = "re_test";
process.env.INBOX_API_URL = "https://beispiel.example/samsparking/inquiries.json";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";

/** Alle ausgehenden Aufrufe mitschneiden, statt sie wirklich zu machen. */
let rufe = [];
let antwort = () => ({ ok: true, status: 200, json: async () => ({ name: "-Abc" }), text: async () => "" });
globalThis.fetch = async (url, init = {}) => {
  rufe.push({ url: String(url), method: init.method || "GET", body: init.body });
  return antwort(String(url), init);
};
const zurücksetzen = () => {
  rufe = [];
  antwort = () => ({ ok: true, status: 200, json: async () => ({ name: "-Abc" }), text: async () => "" });
};

const post = (body) =>
  new Request("https://samsparking.ch/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const mails = () => rufe.filter((r) => r.url.includes("api.resend.com"));
const eingaenge = () => rufe.filter((r) => r.url.includes("inquiries.json") && r.method === "POST");

const { default: booking } = await import("../netlify/functions/booking.mjs");
const { default: order } = await import("../netlify/functions/order.mjs");
const { default: webhook } = await import("../netlify/functions/stripe-webhook.mjs");
const { default: zaehler, seitenSchluessel } = await import("../netlify/functions/zaehler.mjs");

const BOOKING_OK = {
  name: "Lea Muster",
  email: "lea@example.ch",
  phone: "+41 79 000 00 00",
  event: "Sommerfest",
  city: "Luzern",
  date: "2026-09-12",
  setLength: "90 Minuten",
  message: "Wir wuerden dich gerne buchen.",
  elapsedMs: 45000,
  website: "",
};

const BESTELLUNG_OK = {
  product: "Sam Sparking Shirt",
  quantity: "2",
  name: "Lea Muster",
  email: "lea@example.ch",
  street: "Musterweg 1",
  zip: "9000",
  city: "St. Gallen",
  country: "Schweiz",
  elapsedMs: 45000,
  website: "",
};

/* ------------------------------------------------------------------ booking */

zurücksetzen();
let res = await booking(post(BOOKING_OK));
let out = await res.json();
assert.equal(res.status, 200, "vollstaendige Anfrage wird angenommen");
assert.equal(out.ok, true);
assert.equal(eingaenge().length, 1, "Anfrage landet im Eingang");
assert.equal(mails().length, 1, "Anfrage loest genau eine E-Mail aus");
{
  const mail = JSON.parse(mails()[0].body);
  assert.deepEqual(mail.to, ["info@samsparking.ch"], "E-Mail geht an info@samsparking.ch");
  assert.equal(mail.reply_to, "lea@example.ch", "Antwort geht an die anfragende Person");
  assert.match(mail.text, /Sommerfest/);
  assert.match(mail.text, /2026-09-12/);
  const eintrag = JSON.parse(eingaenge()[0].body);
  assert.equal(eintrag.kind, "booking");
  assert.equal(eintrag.city, "Luzern");
  assert.ok(eintrag.ref, "Eintrag traegt eine Referenz");
}

// Unvollstaendig: keine Erfolgsmeldung, nichts verschickt.
for (const [feld, wert] of [
  ["email", "keine-adresse"],
  ["name", "L"],
  ["date", "irgendwann"],
  ["message", ""],
]) {
  zurücksetzen();
  res = await booking(post({ ...BOOKING_OK, [feld]: wert }));
  out = await res.json();
  assert.equal(res.status, 422, `${feld}="${wert}" wird abgewiesen`);
  assert.ok(out.felder.includes(feld), `${feld} wird als fehlerhaft gemeldet`);
  assert.equal(rufe.length, 0, `bei fehlerhaftem ${feld} geht nichts raus`);
}

// Spam: nach aussen unauffaellig, aber nichts wird abgelegt oder gemailt.
for (const spam of [{ website: "http://spam.example" }, { elapsedMs: 40 }]) {
  zurücksetzen();
  res = await booking(post({ ...BOOKING_OK, ...spam }));
  assert.equal(res.status, 200, "Spam bekommt eine unauffaellige Antwort");
  assert.equal(rufe.length, 0, "Spam loest weder Eintrag noch E-Mail aus");
}

// Faellt BEIDES aus, darf der Endpunkt nicht "ok" melden.
zurücksetzen();
antwort = () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "kaputt" });
res = await booking(post(BOOKING_OK));
assert.equal(res.status, 502, "ohne Zustellung gibt es kein Danke");
assert.equal((await res.json()).ok, false);

// Faellt nur die Datenbank aus, ist die E-Mail der Weg — die Anfrage gilt.
zurücksetzen();
antwort = (url) =>
  url.includes("inquiries.json")
    ? { ok: false, status: 500, json: async () => ({}), text: async () => "" }
    : { ok: true, status: 200, json: async () => ({}), text: async () => "" };
res = await booking(post(BOOKING_OK));
assert.equal(res.status, 200);
out = await res.json();
assert.equal(out.gespeichert, false);
assert.equal(out.gemailt, true, "die E-Mail traegt die Anfrage allein");

// GET ist die Zustandsabfrage (siehe unten), alles andere ausser POST nicht.
zurücksetzen();
res = await booking(new Request("https://samsparking.ch/api/booking", { method: "PUT" }));
assert.equal(res.status, 405);

/* -------------------------------------------------------------- bestellung */

// Ohne Stripe-Link: Bestellung wird aufgenommen und gemeldet, aber es gibt
// KEINE erfundene Bezahladresse.
zurücksetzen();
delete process.env.STRIPE_PAYMENT_LINK_URL;
res = await order(post(BESTELLUNG_OK));
out = await res.json();
assert.equal(res.status, 200);
assert.equal(out.paymentUrl, undefined, "ohne echten Link gibt es keine Bezahladresse");
assert.equal(eingaenge().length, 1);
assert.equal(mails().length, 1);
assert.match(JSON.parse(mails()[0].body).text, /NOCH OFFEN/);
assert.match(JSON.parse(eingaenge()[0].body).street, /Musterweg 1/);

// Mit Stripe-Link: Bezahladresse mit Bestellnummer und vorbelegter E-Mail.
zurücksetzen();
process.env.STRIPE_PAYMENT_LINK_URL = "https://buy.stripe.com/test_abc123";
res = await order(post(BESTELLUNG_OK));
out = await res.json();
assert.equal(res.status, 200);
{
  const url = new URL(out.paymentUrl);
  assert.equal(url.hostname, "buy.stripe.com");
  assert.equal(url.searchParams.get("client_reference_id"), out.ref, "Bestellnummer faehrt mit");
  assert.equal(url.searchParams.get("prefilled_email"), "lea@example.ch");
}

// Eine fremde Adresse in der Umgebungsvariable schickt niemanden irgendwohin.
zurücksetzen();
process.env.STRIPE_PAYMENT_LINK_URL = "https://boese.example/zahlen";
res = await order(post(BESTELLUNG_OK));
assert.equal((await res.json()).paymentUrl, undefined, "nur echte Stripe-Adressen zaehlen");
process.env.STRIPE_PAYMENT_LINK_URL = "https://buy.stripe.com/test_abc123";

// Fehlende Kundendaten: keine Bestellung, keine Bezahlseite.
for (const feld of ["street", "zip", "city", "country", "email", "name", "product"]) {
  zurücksetzen();
  const kaputt = { ...BESTELLUNG_OK, [feld]: "" };
  res = await order(post(kaputt));
  assert.equal(res.status, 422, `ohne ${feld} keine Bestellung`);
  assert.equal(rufe.length, 0);
}
zurücksetzen();
res = await order(post({ ...BESTELLUNG_OK, quantity: "99" }));
assert.equal(res.status, 422, "Anzahl ausserhalb 1–20 wird abgewiesen");

/* ----------------------------------------------------------------- webhook */

const ereignis = (id, extra = {}) =>
  JSON.stringify({
    id,
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        payment_status: "paid",
        amount_total: 3500,
        currency: "chf",
        client_reference_id: "BE-20260810-XYZ12",
        customer_details: { name: "Lea Muster", email: "lea@example.ch" },
        ...extra,
      },
    },
  });

const unterschrieben = (roh, secret = "whsec_test", t = Math.floor(Date.now() / 1000)) => {
  const sig = createHmac("sha256", secret).update(`${t}.${roh}`, "utf8").digest("hex");
  return new Request("https://samsparking.ch/api/stripe-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` },
    body: roh,
  });
};

// Gueltige Meldung: Zahlung wird vermerkt und gemeldet.
zurücksetzen();
antwort = (url, init) =>
  url.includes("stripeEvents") && (!init.method || init.method === "GET")
    ? { ok: true, status: 200, json: async () => null, text: async () => "null" }
    : { ok: true, status: 200, json: async () => ({ name: "-A" }), text: async () => "" };
res = await webhook(unterschrieben(ereignis("evt_1")));
out = await res.json();
assert.equal(res.status, 200);
assert.equal(out.ref, "BE-20260810-XYZ12");
assert.equal(mails().length, 1, "die Zahlung wird per E-Mail gemeldet");
assert.match(JSON.parse(mails()[0].body).text, /35\.00 CHF/);
assert.ok(
  rufe.some((r) => r.url.includes("stripeEvents") && r.method === "PUT"),
  "die Ereignis-Id wird vermerkt"
);

// Falsche Unterschrift: 400, nichts passiert.
zurücksetzen();
res = await webhook(unterschrieben(ereignis("evt_2"), "whsec_falsch"));
assert.equal(res.status, 400, "falsche Unterschrift wird abgewiesen");
assert.equal(rufe.length, 0);

// Fehlende Unterschrift: ebenso.
zurücksetzen();
res = await webhook(
  new Request("https://samsparking.ch/api/stripe-webhook", { method: "POST", body: ereignis("evt_3") })
);
assert.equal(res.status, 400);

// Zu alte Meldung (Wiedereinspielen): abgewiesen.
zurücksetzen();
res = await webhook(unterschrieben(ereignis("evt_4"), "whsec_test", Math.floor(Date.now() / 1000) - 3600));
assert.equal(res.status, 400, "eine Stunde alte Meldung wird abgewiesen");

// Wiederholung derselben Meldung: quittiert, aber nicht noch einmal ausgefuehrt.
zurücksetzen();
antwort = (url, init) =>
  url.includes("stripeEvents") && (!init.method || init.method === "GET")
    ? { ok: true, status: 200, json: async () => ({ status: "paid" }), text: async () => "" }
    : { ok: true, status: 200, json: async () => ({}), text: async () => "" };
res = await webhook(unterschrieben(ereignis("evt_1")));
out = await res.json();
assert.equal(res.status, 200);
assert.equal(out.doppelt, true, "dieselbe Zahlung wird nur einmal verarbeitet");
assert.equal(mails().length, 0, "keine zweite E-Mail zur selben Zahlung");

// Unbezahlte Kasse loest keine Bestaetigung aus.
zurücksetzen();
antwort = (url, init) =>
  url.includes("stripeEvents") && (!init.method || init.method === "GET")
    ? { ok: true, status: 200, json: async () => null, text: async () => "null" }
    : { ok: true, status: 200, json: async () => ({}), text: async () => "" };
res = await webhook(unterschrieben(ereignis("evt_5", { payment_status: "unpaid" })));
assert.equal((await res.json()).unbezahlt, true);
assert.equal(mails().length, 0);

// Ohne Geheimnis wird gar nichts angenommen.
zurücksetzen();
delete process.env.STRIPE_WEBHOOK_SECRET;
res = await webhook(unterschrieben(ereignis("evt_6")));
assert.equal(res.status, 503, "ohne STRIPE_WEBHOOK_SECRET wird nichts angenommen");
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";

/* ------------------------------------------------------------------------
   Routen der Functions.

   Der Grund fuer diesen Test: Die drei Endpunkte trugen ein
   `export const config = { path: "/api/..." }`. Deklariert eine Function
   ihren eigenen Pfad, bedient Netlify sie NUR dort — die Standardadresse
   /.netlify/functions/<name> bleibt leer. In netlify.toml steht aber eine
   erzwungene Umschreibung /api/* -> /.netlify/functions/:splat. Jede Anfrage
   landete damit auf einer Adresse ohne Handler, und das Formular meldete
   "Something went wrong". Genau diese Kombination darf nie zurueckkommen.
   ------------------------------------------------------------------------ */
{
  const { readFileSync, readdirSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const ORDNER = resolve(dirname(fileURLToPath(import.meta.url)), "../netlify/functions");

  const toml = readFileSync(resolve(ORDNER, "../../netlify.toml"), "utf8");
  const umschreibung = /from\s*=\s*"\/api\/\*"[\s\S]{0,120}?to\s*=\s*"\/\.netlify\/functions\/:splat"/.test(toml);

  for (const datei of readdirSync(ORDNER).filter((f) => f.endsWith(".mjs") && f !== "_lib.mjs")) {
    const quelle = readFileSync(resolve(ORDNER, datei), "utf8");
    const eigenerPfad = /^\s*export\s+const\s+config\s*=/m.test(quelle);
    assert.ok(
      !(eigenerPfad && umschreibung),
      `${datei}: eigener config.path UND die /api/*-Umschreibung — die Anfrage ` +
        `landet auf einer Adresse ohne Handler (das war der 404 im Booking-Formular).`
    );
  }
}

/* Zustandsabfrage: GET meldet, ob die Variablen gesetzt sind — nie ihren Wert. */
{
  zurücksetzen();
  const res = await booking(new Request("https://samsparking.ch/api/booking"));
  assert.equal(res.status, 200, "GET muss den Zustand melden statt 405");
  const z = await res.json();
  assert.equal(z.mailAn, "info@samsparking.ch");
  assert.equal(z.mailSchluesselGesetzt, true, "Schluessel ist im Test gesetzt");
  const alsText = JSON.stringify(z);
  assert.ok(!alsText.includes(process.env.RESEND_API_KEY), "Der Schluessel darf nie in der Antwort stehen");
  assert.ok(!alsText.includes("re_"), "Auch kein Bruchstueck des Schluessels");
  assert.equal(rufe.length, 0, "Eine Zustandsabfrage darf nichts verschicken");
}

/* Ein einzelner Aussetzer des Eingangs darf keine Anfrage kosten. */
{
  zurücksetzen();
  let n = 0;
  antwort = (url) => {
    if (url.includes("inquiries")) {
      n++;
      if (n === 1) throw new Error("fetch failed");
    }
    return { ok: true, status: 200, json: async () => ({ name: "-Abc" }), text: async () => "" };
  };
  const res = await booking(post(BOOKING_OK));
  assert.equal(res.status, 200, "nach dem zweiten Versuch muss es klappen");
  assert.equal((await res.json()).gespeichert, true);
  assert.ok(n >= 2, "der Eingang wird ein zweites Mal versucht");
}

{
  /* Der Zaehler (12.08.2026). Er darf ausschliesslich Summen anlegen — keine
     Adresse, keine Kennung, kein Cookie. Und er muss sich gegen Muell aus dem
     Browser wehren: die Adresse kommt von aussen. */
  zurücksetzen();
  const res = await zaehler(
    post({ pfad: "/de/shop/", sprache: "de", geraet: "handy", neu: true })
  );
  assert.equal(res.status, 200);
  const rufe2 = rufe.filter((r) => r.url.includes("stats.json"));
  assert.equal(rufe2.length, 1, "genau ein Aufruf an die Datenbank");
  assert.equal(rufe2[0].method, "PATCH", "hochgezaehlt wird mit PATCH");
  const patch = JSON.parse(rufe2[0].body);

  // Die Sprache steckt separat drin, der Seitenname ist sprachfrei.
  assert.ok(patch["seiten/shop/aufrufe"], "die Seite wird gezaehlt: " + Object.keys(patch).join(", "));
  assert.ok(patch["sprachen/de/aufrufe"], "die Sprache wird gezaehlt");
  assert.ok(patch["geraete/handy/aufrufe"], "das Geraet wird gezaehlt");
  assert.ok(patch["gesamt/aufrufe"], "die Gesamtzahl wird gezaehlt");
  assert.ok(patch["gesamt/besuche"], "ein neuer Besuch wird gezaehlt");
  // Hochgezaehlt wird mit dem Server-Wert, nicht mit einer selbst gerechneten Zahl.
  for (const [feld, wert] of Object.entries(patch)) {
    if (feld === "zuletzt") continue;
    assert.deepEqual(wert, { ".sv": { increment: 1 } }, `${feld} zaehlt nicht mit dem Server-Wert`);
  }
  // Und nichts Persoenliches: kein Feld traegt Adresse, Kennung oder Browser.
  const alsText = JSON.stringify(patch).toLowerCase();
  for (const wort of ["ip", "agent", "referer", "cookie", "id"]) {
    const treffer = Object.keys(patch).filter((k) => k.toLowerCase().split(/[^a-z]+/).includes(wort));
    assert.equal(treffer.length, 0, `der Zaehler speichert "${wort}": ${treffer.join(", ")}`);
  }
  assert.ok(!alsText.includes("mozilla"), "kein Browser-Kennzeichen in den Zaehlern");

  // Ohne "neu" wird der Aufruf gezaehlt, aber kein zweiter Besuch.
  zurücksetzen();
  await zaehler(post({ pfad: "/", sprache: "en", geraet: "rechner" }));
  const ohneBesuch = JSON.parse(rufe.filter((r) => r.url.includes("stats.json"))[0].body);
  assert.ok(ohneBesuch["seiten/start/aufrufe"], "die Startseite heisst \"start\"");
  assert.equal(ohneBesuch["gesamt/besuche"], undefined, "ohne \"neu\" kein zweiter Besuch");

  // Weissliste: eine erfundene Adresse landet in einem Sammeltopf.
  assert.equal(seitenSchluessel("/de/../etwas/boeses"), "andere");
  assert.equal(seitenSchluessel("/fr/booking/"), "booking");
  assert.equal(seitenSchluessel("/site/shop/"), "shop");
  assert.equal(seitenSchluessel("/index.html"), "start");
  assert.equal(seitenSchluessel(""), "start");

  // Kein POST, kein Zaehlen. Und nichts Riesiges annehmen.
  zurücksetzen();
  const get = await zaehler(new Request("https://samsparking.ch/api/zaehler"));
  assert.equal(get.status, 405);
  const gross = await zaehler(
    new Request("https://samsparking.ch/api/zaehler", { method: "POST", body: "x".repeat(600) })
  );
  assert.equal(gross.status, 413);

  /* Faellt die Datenbank aus, darf der Besucher nichts merken — aber der
     Endpunkt darf auch nicht "ok" behaupten. */
  zurücksetzen();
  antwort = () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" });
  const kaputt = await zaehler(post({ pfad: "/", sprache: "en", geraet: "rechner" }));
  assert.equal(kaputt.status, 202);
  assert.equal((await kaputt.json()).ok, false);
}

console.log(`booking:  vollstaendig → Eingang + E-Mail an ${process.env.MAIL_TO}; unvollstaendig → 422;
          Spam still verworfen; Zustellung komplett aus → 502 statt "Danke".
order:    alle Kundendaten Pflicht; Bezahladresse nur aus einem echten
          Stripe-Link, mit Bestellnummer und vorbelegter E-Mail.
webhook:  Unterschrift, Alter und Doppelmeldung geprueft; ohne Geheimnis 503.\nrouten:   keine Function deklariert einen eigenen Pfad neben der /api/*-Regel.\nzustand:  GET meldet die Konfiguration als ja/nein, ohne einen Schluessel.
zaehler:  nur Summen (Server-Wert increment), Seitenname nach Weissliste,
          kein POST -> 405, zu gross -> 413, Datenbank aus -> 202 statt "ok".`);
