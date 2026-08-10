/**
 * POST /api/booking — Booking-Anfrage von der Seite /booking/.
 *
 * Was hier passiert, in dieser Reihenfolge:
 *   1. Angaben pruefen. Fehlt etwas, kommt 422 mit den beanstandeten Feldern
 *      zurueck — die Seite meldet dann NICHT "Danke".
 *   2. Anfrage in den Eingang legen (Verwaltung → Eingang, wie bisher).
 *   3. E-Mail an MAIL_TO (info@samsparking.ch), Antwortadresse ist die des
 *      Absenders — eine Antwort geht damit direkt an die anfragende Person.
 *
 * "Angekommen" heisst: mindestens einer der beiden Wege hat geklappt. Sind
 * beide fehlgeschlagen, gibt es 502 und die Seite zeigt den Fehlertext mit
 * der E-Mail-Adresse zum direkten Schreiben. Ein "Danke" ohne Zustellung
 * darf es nicht geben.
 */
import { json, readJson, pruefe, istSpam, referenz, inEingang, sendeMail, zeilen, MAIL_TO } from "./_lib.mjs";

const REGELN = {
  name: { min: 2, max: 120 },
  email: { min: 5, max: 160, email: true },
  phone: { min: 6, max: 40 },
  event: { min: 2, max: 160 },
  city: { min: 2, max: 120 },
  date: { min: 10, max: 10, datum: true },
  setLength: { min: 1, max: 60 },
  message: { min: 2, max: 4000 },
};

export default async (req) => {
  const gelesen = await readJson(req);
  if (gelesen.fehler) return json({ ok: false, fehler: gelesen.fehler }, gelesen.status);
  const body = gelesen.body;

  const { werte, fehler } = pruefe(body, REGELN);
  if (fehler.length) return json({ ok: false, fehler: "Unvollstaendig", felder: fehler }, 422);

  // Spam bekommt eine normale Antwort, aber nichts wird abgelegt oder gemailt.
  if (istSpam(body)) return json({ ok: true, ref: referenz("BK") });

  const ref = referenz("BK");
  const eintrag = {
    ...werte,
    kind: "booking",
    ref,
    status: "new",
    createdAt: new Date().toISOString(),
    source: String(body.source || "website").slice(0, 120),
  };

  const text =
    `Neue Booking-Anfrage über die Website.\n\n` +
    zeilen([
      ["Referenz", ref],
      ["Name", werte.name],
      ["E-Mail", werte.email],
      ["Telefon", werte.phone],
      ["Event", werte.event],
      ["Ort", werte.city],
      ["Datum", werte.date],
      ["Set-Länge", werte.setLength],
    ]) +
    `\n\nNachricht:\n${werte.message}\n`;

  // Beide Wege gleichzeitig — der eine wartet nicht auf den anderen.
  const [eingang, mail] = await Promise.all([
    inEingang(eintrag),
    sendeMail({
      betreff: `Booking-Anfrage: ${werte.event} — ${werte.date} (${werte.city})`,
      text,
      antwortAn: werte.email,
    }),
  ]);

  if (!eingang.ok && !mail.ok) {
    console.error("[booking] weder gespeichert noch gemailt", { eingang, mail });
    return json({ ok: false, fehler: "Zustellung fehlgeschlagen", mailTo: MAIL_TO() }, 502);
  }

  return json({ ok: true, ref, gespeichert: eingang.ok, gemailt: mail.ok });
};

export const config = { path: "/api/booking" };
