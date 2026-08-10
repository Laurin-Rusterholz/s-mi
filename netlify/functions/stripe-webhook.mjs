/**
 * POST /api/stripe-webhook — Stripe meldet eine erfolgreiche Zahlung.
 *
 * Das ist die einzige Stelle, an der eine Bestellung als bezahlt gilt. Der
 * Browser darf das nicht melden: wer die Bezahlseite einfach schliesst und
 * die Erfolgsadresse von Hand aufruft, haette sonst gratis bestellt.
 *
 * Drei Dinge macht dieser Endpunkt richtig, und alle drei sind noetig:
 *
 *   SIGNATUR — Stripe unterschreibt jede Meldung mit STRIPE_WEBHOOK_SECRET.
 *   Geprueft wird ueber dem ROHEN Rumpf (nicht ueber dem geparsten JSON, das
 *   waere eine andere Bytefolge) und mit einem zeitkonstanten Vergleich.
 *   Ohne gueltige Unterschrift: 400, nichts passiert. Fehlt das Geheimnis
 *   ganz, wird ebenfalls nichts angenommen — ein ungeprueftes Zahlungs-
 *   signal ist schlimmer als gar keines.
 *
 *   ALTER — eine mitgeschnittene Meldung darf nicht Tage spaeter erneut
 *   eingespielt werden. Aelter als TOLERANZ: abgelehnt.
 *
 *   IDEMPOTENZ — Stripe wiederholt Meldungen, bis sie mit 2xx quittiert
 *   werden; dieselbe Zahlung kommt also durchaus mehrfach. Jede Ereignis-Id
 *   wird darum vermerkt, und ein schon vermerktes Ereignis wird nur noch
 *   quittiert, nicht noch einmal ausgefuehrt. Sonst kaeme zu einer Zahlung
 *   ein Stapel gleicher E-Mails.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { json, inEingang, sendeMail, zeilen, INBOX_URL } from "./_lib.mjs";

/** Wie alt eine Meldung hoechstens sein darf (Sekunden). Stripe empfiehlt 300. */
const TOLERANZ = 300;

/** Unterschrift pruefen. Gibt true nur bei gueltiger, frischer Meldung. */
function unterschriftStimmt(roh, header, secret) {
  const teile = String(header || "")
    .split(",")
    .map((p) => p.split("="))
    .filter((p) => p.length === 2);
  const t = teile.find((p) => p[0].trim() === "t")?.[1]?.trim();
  const v1 = teile.filter((p) => p[0].trim() === "v1").map((p) => p[1].trim());
  if (!t || !v1.length) return false;

  const alter = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (!Number.isFinite(alter) || alter > TOLERANZ) {
    console.error("[stripe] Meldung zu alt:", alter, "s");
    return false;
  }

  const erwartet = createHmac("sha256", secret).update(`${t}.${roh}`, "utf8").digest();
  return v1.some((kandidat) => {
    let gegeben;
    try {
      gegeben = Buffer.from(kandidat, "hex");
    } catch (e) {
      return false;
    }
    return gegeben.length === erwartet.length && timingSafeEqual(gegeben, erwartet);
  });
}

/**
 * Schon einmal verarbeitet? Der Vermerk liegt neben dem Eingang, unter
 * stripeEvents/<id>. Erst lesen, dann schreiben — die Realtime Database
 * kennt kein "nur schreiben, wenn noch nichts da ist". Stripe wiederholt
 * seine Meldungen nacheinander und nicht gleichzeitig, damit reicht das;
 * im schlimmsten Fall geht eine Bestaetigung doppelt raus, es wird aber
 * nie doppelt kassiert.
 */
function vermerkUrl(id) {
  const basis = INBOX_URL().replace(/\/[^/]*\.json.*$/, "");
  const token = (process.env.INBOX_API_TOKEN || "").trim();
  const q = token ? `?auth=${encodeURIComponent(token)}` : "";
  return `${basis}/stripeEvents/${encodeURIComponent(id)}.json${q}`;
}

async function schonVerarbeitet(id) {
  try {
    const res = await fetch(vermerkUrl(id));
    if (!res.ok) return false;
    const out = await res.json();
    return out !== null && out !== undefined;
  } catch (err) {
    console.error("[stripe] Vermerk nicht lesbar:", err.message);
    return false;
  }
}

async function vermerken(id, daten) {
  try {
    await fetch(vermerkUrl(id), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...daten, at: new Date().toISOString() }),
    });
  } catch (err) {
    console.error("[stripe] Vermerk nicht geschrieben:", err.message);
  }
}

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, fehler: "Nur POST" }, 405);

  const secret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    console.error("[stripe] STRIPE_WEBHOOK_SECRET fehlt — Meldung nicht angenommen.");
    return json({ ok: false, fehler: "Webhook nicht eingerichtet" }, 503);
  }

  // Roher Rumpf, unveraendert — die Unterschrift gilt genau fuer diese Bytes.
  const roh = await req.text();
  if (!unterschriftStimmt(roh, req.headers.get("stripe-signature"), secret)) {
    return json({ ok: false, fehler: "Unterschrift ungueltig" }, 400);
  }

  let ereignis;
  try {
    ereignis = JSON.parse(roh);
  } catch (e) {
    return json({ ok: false, fehler: "Kein gueltiges JSON" }, 400);
  }

  const id = String(ereignis?.id || "");
  const typ = String(ereignis?.type || "");
  if (!id) return json({ ok: false, fehler: "Ereignis ohne Id" }, 400);

  // Alles ausser der bezahlten Kasse quittieren und liegen lassen — sonst
  // wiederholt Stripe Meldungen, die uns gar nicht betreffen.
  if (typ !== "checkout.session.completed") return json({ ok: true, ignoriert: typ });

  if (await schonVerarbeitet(id)) return json({ ok: true, doppelt: true, id });

  const sitzung = ereignis?.data?.object || {};
  if (sitzung.payment_status && sitzung.payment_status !== "paid") {
    await vermerken(id, { typ, status: sitzung.payment_status });
    return json({ ok: true, unbezahlt: true });
  }

  const ref = String(sitzung.client_reference_id || "").slice(0, 60);
  const betrag =
    typeof sitzung.amount_total === "number"
      ? `${(sitzung.amount_total / 100).toFixed(2)} ${String(sitzung.currency || "chf").toUpperCase()}`
      : "";
  const kunde = sitzung.customer_details || {};

  // Erst vermerken, dann melden: bricht der Versand ab, wiederholt Stripe die
  // Meldung — und die Wiederholung darf nicht noch einmal alles ausloesen.
  await vermerken(id, { typ, ref, betrag, status: "paid" });

  const text =
    `Zahlung eingegangen.\n\n` +
    zeilen([
      ["Bestellung", ref || "(keine Referenz mitgeschickt)"],
      ["Betrag", betrag],
      ["Name", kunde.name],
      ["E-Mail", kunde.email],
      ["Stripe-Sitzung", sitzung.id],
      ["Ereignis", id],
    ]) +
    `\n\nDie Bestelldaten mit Lieferadresse stehen unter dieser Referenz im Eingang.\n`;

  const [eingang, mail] = await Promise.all([
    inEingang({
      kind: "payment",
      ref,
      amount: betrag,
      email: String(kunde.email || ""),
      name: String(kunde.name || ""),
      stripeSession: String(sitzung.id || ""),
      stripeEvent: id,
      status: "paid",
      createdAt: new Date().toISOString(),
    }),
    sendeMail({ betreff: `Zahlung eingegangen: ${ref || sitzung.id} (${betrag})`, text }),
  ]);

  // 200 auch dann, wenn die Meldung an uns klemmte: die Zahlung ist vermerkt,
  // und eine Wiederholung durch Stripe wuerde daran nichts mehr aendern. Der
  // Fehler steht im Protokoll der Funktion.
  if (!eingang.ok || !mail.ok) console.error("[stripe] Nachbereitung unvollstaendig", { eingang, mail });

  return json({ ok: true, ref, gespeichert: eingang.ok, gemailt: mail.ok });
};

/*
 * KEIN `export const config = { path: ... }`.
 *
 * Deklariert eine Function ihren eigenen Pfad, bedient Netlify sie unter
 * genau diesem Pfad — die Standardadresse /.netlify/functions/<name> ist
 * dann nicht mehr belegt. In netlify.toml steht aber eine erzwungene
 * Umschreibung /api/* -> /.netlify/functions/:splat. Die Anfrage landete
 * damit auf einer Adresse ohne Handler: 404, und das Formular meldete
 * "Something went wrong".
 *
 * Die Route kommt deshalb ausschliesslich aus netlify.toml. Das ist die
 * Variante, die unabhaengig von der Function-Generation funktioniert, und
 * genau die, die scripts/routen.test.mjs prueft.
 */
