/**
 * POST /api/order — Bestellung aus dem Shop (/shop/).
 *
 * Der Ablauf ist bewusst zweistufig:
 *
 *   1. Hier werden die Kundendaten vollstaendig aufgenommen (Name, E-Mail,
 *      Lieferadresse, Artikel, Anzahl), abgelegt und per E-Mail gemeldet.
 *      Ohne diese Angaben kann niemand etwas verschicken — deshalb ist jedes
 *      Feld Pflicht und die Bestellung gilt erst danach als aufgenommen.
 *   2. Die Antwort enthaelt die Adresse der Stripe-Bezahlseite. Der Browser
 *      geht dort hin, bezahlt wird bei Stripe. Dass das Geld wirklich kam,
 *      meldet nicht der Browser, sondern der Webhook (stripe-webhook.mjs) —
 *      nur der ist faelschungssicher.
 *
 * Ohne STRIPE_PAYMENT_LINK_URL laeuft Schritt 1 vollstaendig, Schritt 2
 * entfaellt: die Bestellung ist dann aufgenommen und gemeldet, aber noch
 * nicht bezahlt. Die Seite sagt das auch so. Ein erfundener Bezahl-Link
 * waere schlimmer als keiner.
 */
import { json, readJson, pruefe, istSpam, referenz, inEingang, sendeMail, zeilen, MAIL_TO } from "./_lib.mjs";

const REGELN = {
  product: { min: 1, max: 160 },
  quantity: { min: 1, max: 3, zahl: [1, 20] },
  name: { min: 2, max: 120 },
  email: { min: 5, max: 160, email: true },
  street: { min: 2, max: 160 },
  zip: { min: 3, max: 12 },
  city: { min: 2, max: 120 },
  country: { min: 2, max: 80 },
};

/**
 * Bezahlseite. Der Payment Link kommt aus der Umgebung; die Bestellnummer
 * faehrt als client_reference_id mit, damit der Webhook die Zahlung genau
 * einer Bestellung zuordnen kann. prefilled_email spart der Kundin das
 * zweite Tippen.
 */
function bezahlAdresse(ref, email) {
  const roh = (process.env.STRIPE_PAYMENT_LINK_URL || "").trim();
  if (!/^https:\/\/[^\s]+$/i.test(roh)) return "";
  try {
    const url = new URL(roh);
    // Nur echte Stripe-Adressen — sonst schickt eine falsch gesetzte
    // Umgebungsvariable die Kundschaft irgendwohin.
    if (!/(^|\.)stripe\.com$/i.test(url.hostname) && !/(^|\.)link\.com$/i.test(url.hostname)) {
      console.error("[order] STRIPE_PAYMENT_LINK_URL zeigt nicht auf Stripe:", url.hostname);
      return "";
    }
    url.searchParams.set("client_reference_id", ref);
    if (email) url.searchParams.set("prefilled_email", email);
    return url.toString();
  } catch (e) {
    console.error("[order] STRIPE_PAYMENT_LINK_URL ist keine Adresse:", e.message);
    return "";
  }
}

export default async (req) => {
  const gelesen = await readJson(req);
  if (gelesen.fehler) return json({ ok: false, fehler: gelesen.fehler }, gelesen.status);
  const body = gelesen.body;

  const { werte, fehler } = pruefe(body, REGELN);
  if (fehler.length) return json({ ok: false, fehler: "Unvollstaendig", felder: fehler }, 422);

  if (istSpam(body)) return json({ ok: true, ref: referenz("BE") });

  const ref = referenz("BE");
  const paymentUrl = bezahlAdresse(ref, werte.email);

  const eintrag = {
    ...werte,
    kind: "order",
    ref,
    status: "new",
    payment: paymentUrl ? "stripe" : "offen",
    paymentStatus: "unbezahlt",
    createdAt: new Date().toISOString(),
    source: String(body.source || "website").slice(0, 120),
  };

  const text =
    `Neue Bestellung über die Website.\n\n` +
    zeilen([
      ["Referenz", ref],
      ["Artikel", werte.product],
      ["Anzahl", werte.quantity],
      ["Name", werte.name],
      ["E-Mail", werte.email],
      ["Strasse", werte.street],
      ["PLZ / Ort", `${werte.zip} ${werte.city}`],
      ["Land", werte.country],
      ["Bezahlung", paymentUrl ? "Stripe — Bestätigung folgt per Webhook" : "NOCH OFFEN (kein Stripe-Link hinterlegt)"],
    ]) + "\n";

  const [eingang, mail] = await Promise.all([
    inEingang(eintrag),
    sendeMail({
      betreff: `Bestellung ${ref}: ${werte.quantity}× ${werte.product}`,
      text,
      antwortAn: werte.email,
    }),
  ]);

  if (!eingang.ok && !mail.ok) {
    console.error("[order] weder gespeichert noch gemailt", { eingang, mail });
    return json({ ok: false, fehler: "Zustellung fehlgeschlagen", mailTo: MAIL_TO() }, 502);
  }

  return json({
    ok: true,
    ref,
    gespeichert: eingang.ok,
    gemailt: mail.ok,
    ...(paymentUrl ? { paymentUrl } : {}),
  });
};

export const config = { path: "/api/order" };
