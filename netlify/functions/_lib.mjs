/**
 * Gemeinsames Werkzeug der Server-Endpunkte.
 *
 * Warum es diese Funktionen ueberhaupt gibt: Booking-Anfragen und
 * Bestellungen gingen bis August 2026 direkt aus dem Browser in die
 * Realtime Database. Das hiess zweierlei — die Schreib-Adresse der Datenbank
 * stand im Quelltext der Seite (jeder konnte hineinschreiben), und es ging
 * nie eine E-Mail raus. Wer eine Anfrage stellte, sah "Danke", und niemand
 * erfuhr davon, solange niemand die Verwaltung oeffnete.
 *
 * Seither laeuft beides ueber diese Endpunkte: sie pruefen die Angaben,
 * legen sie im selben Eingang ab wie bisher (die Verwaltung sieht also
 * nichts Neues) und schicken eine E-Mail an die Adresse aus MAIL_TO.
 *
 * Alle Zugangsdaten kommen aus Umgebungsvariablen und bleiben auf dem
 * Server. Welche das sind, steht in AUDIT.md.
 */

/** Adresse des Eingangs (Realtime Database). Ohne sie wird nichts abgelegt. */
export const INBOX_URL = () =>
  (process.env.INBOX_API_URL || "").trim() ||
  "https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app/samsparking/inquiries.json";

export const MAIL_TO = () => (process.env.MAIL_TO || "info@samsparking.ch").trim();
export const MAIL_FROM = () =>
  (process.env.MAIL_FROM || "Sam Sparking Website <onboarding@resend.dev>").trim();

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });

/** Nur POST, und nur mit JSON-Rumpf. */
export async function readJson(req) {
  if (req.method !== "POST") return { fehler: "Nur POST", status: 405 };
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return { fehler: "Kein gueltiges JSON", status: 400 };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { fehler: "Kein Objekt", status: 400 };
  }
  return { body };
}

const s = (v, max = 400) => String(v ?? "").trim().slice(0, max);

/** Feldpruefung. Gibt die Liste der beanstandeten Felder zurueck. */
export function pruefe(body, regeln) {
  const werte = {};
  const fehler = [];
  for (const [name, regel] of Object.entries(regeln)) {
    const wert = s(body[name], regel.max || 400);
    werte[name] = wert;
    if (wert.length < (regel.min ?? 1)) {
      fehler.push(name);
      continue;
    }
    if (regel.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(wert)) fehler.push(name);
    if (regel.zahl) {
      const n = Number(wert);
      if (!Number.isFinite(n) || n < regel.zahl[0] || n > regel.zahl[1]) fehler.push(name);
    }
    if (regel.datum && !/^\d{4}-\d{2}-\d{2}$/.test(wert)) fehler.push(name);
  }
  return { werte, fehler };
}

/**
 * Spam. Zwei stille Merkmale: das versteckte Feld "website" (Menschen sehen
 * es nicht, Bots fuellen es aus) und eine Ausfuellzeit unter einer Sekunde.
 *
 * Erkanntes Spam bekommt bewusst eine normale Antwort — ein Bot soll nicht
 * lernen, woran er gescheitert ist. Menschen trifft das nicht: ein Formular
 * mit acht Pflichtfeldern fuellt niemand in unter einer Sekunde aus, und die
 * Zeit ist nur ein zusaetzliches Merkmal, kein alleiniger Grund.
 */
export const istSpam = (body) =>
  !!s(body.website, 200) || Number(body.elapsedMs) < 1000;

/** Laufende Nummer fuer eine Bestellung/Anfrage — kurz und vorlesbar. */
export function referenz(prefix) {
  const zufall = Math.random().toString(36).slice(2, 7).toUpperCase();
  const tag = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${prefix}-${tag}-${zufall}`;
}

/**
 * Eintrag im Eingang ablegen. Schlaegt das fehl, ist das kein Grund, die
 * Anfrage zu verwerfen — die E-Mail ist der Weg, der ankommen muss. Der
 * Fehler wird gemeldet und mitgeschickt.
 */
export async function inEingang(eintrag, versuche = 2) {
  const url = INBOX_URL();
  const token = (process.env.INBOX_API_TOKEN || "").trim();
  let letzter = "";
  for (let n = 1; n <= versuche; n++) {
    try {
      const res = await fetch(token ? `${url}?auth=${encodeURIComponent(token)}` : url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(eintrag),
      });
      if (!res.ok) throw new Error(dbFehler(res.status, token));
      const out = await res.json().catch(() => ({}));
      return { ok: true, id: out?.name || "" };
    } catch (err) {
      letzter = err.message;
      console.error(`[eingang] Versuch ${n}/${versuche} fehlgeschlagen:`, letzter);
      // Kurz warten und ein zweites Mal versuchen: eine einzelne haengende
      // Verbindung darf keine Anfrage kosten.
      if (n < versuche) await new Promise((r) => setTimeout(r, 400));
    }
  }
  return { ok: false, fehler: letzter };
}

/**
 * Zustand der Konfiguration — NUR ja/nein, nie ein Wert. Damit laesst sich
 * von aussen in Sekunden feststellen, warum ein Formular nicht ankommt,
 * ohne dass irgendein Schluessel sichtbar wird.
 *
 * Aufruf: GET /api/booking
 */
export const zustand = () => ({
  ok: true,
  dienst: "erreichbar",
  mailSchluesselGesetzt: !!(process.env.RESEND_API_KEY || "").trim(),
  mailFromGesetzt: !!(process.env.MAIL_FROM || "").trim(),
  mailAn: MAIL_TO(),
  eingangGesetzt: !!(process.env.INBOX_API_URL || "").trim(),
  /* BEFUND 17.09.2026: In den Netlify-Protokollen stand dreimal
     „[zaehler] nicht gezaehlt: HTTP 401". Der Aufruf kam also an — die
     Datenbank hat den Schreibzugriff abgewiesen. Geschrieben wird mit
     `?auth=<INBOX_API_TOKEN>`; fehlt der, ist der Zugriff nicht angemeldet und
     die Regeln lehnen ab. Genau das stand bisher in keiner Auskunft: hier
     wurde nur die ADRESSE gemeldet (INBOX_API_URL), nicht der SCHLUESSEL.

     Betroffen ist nicht nur der Zaehler — Booking-Anfragen, Bestellungen und
     der Stripe-Beleg gehen denselben Weg. Deshalb steht das jetzt hier, in
     Sekunden von aussen ablesbar und ohne je einen Wert zu zeigen. */
  eingangSchluesselGesetzt: !!(process.env.INBOX_API_TOKEN || "").trim(),
  /* REVIEW 17.09.2026: Hier stand, ohne INBOX_API_TOKEN werde JEDER
     Schreibzugriff mit 401 abgewiesen und die E-Mail gehe trotzdem raus.
     Beides ging weiter, als gemessen ist. Belegt ist ein abgewiesener Pfad
     (der Zaehler, drei Protokollzeilen); fuer Anfragen und Bestellungen liegt
     keine Messung vor, und ob eine E-Mail wirklich ankommt, sagt eine
     gesetzte Variable nicht. Was hier steht, ist deshalb nur noch das, was
     diese Angaben wirklich hergeben. */
  hinweis:
    "Diese Angaben sind bewusst nur ja/nein — sie sagen, WAS GESETZT ist, " +
    "nicht, dass es funktioniert. Ohne RESEND_API_KEY wird gar keine E-Mail " +
    "verschickt; ist er gesetzt, ist damit noch keine Zustellung belegt. " +
    "INBOX_API_TOKEN ist die einzige Anmeldung, die dieser Code fuer die " +
    "Datenbank kennt (?auth=): fehlt er, ist der Schreibzugriff nicht " +
    "angemeldet, und die Regeln entscheiden je Pfad. Der Mailweg haengt nicht " +
    "daran — er laeuft ueber RESEND_API_KEY. Siehe AUDIT.md, Abschnitt " +
    "\"Server-Zugang zur Datenbank\".",
});

/**
 * Was ein abgewiesener Schreibzugriff bedeutet — im Klartext statt „HTTP 401".
 *
 * Ein nackter Statuscode im Protokoll sagt nicht, was zu tun ist. 401 und 403
 * von der Realtime Database heissen praktisch immer dasselbe: der Zugriff war
 * nicht angemeldet oder der Schluessel stimmt nicht. Ist gar keiner gesetzt,
 * steht das hier auch so da.
 *
 * Geraten wird dabei nichts: gemeldet wird der Statuscode UND ob ueberhaupt
 * ein Schluessel mitgeschickt wurde. Beides ist bekannt, nicht vermutet.
 */
export function dbFehler(status, token) {
  const basis = `HTTP ${status}`;
  if (status !== 401 && status !== 403) return basis;
  return token
    ? `${basis} — die Datenbank weist den Schreibzugriff ab. Es wurde ein `
      + `INBOX_API_TOKEN mitgeschickt; er passt nicht (abgelaufen, falsches Projekt) `
      + `oder die Regeln erlauben diesen Pfad nicht.`
    : `${basis} — die Datenbank weist den Schreibzugriff ab. Es ist KEIN `
      + `INBOX_API_TOKEN gesetzt, der Zugriff war also nicht angemeldet. `
      + `Er gehoert in die Netlify-Variablen der Produktion — womit es aber `
      + `nicht in jedem Fall getan ist, siehe AUDIT.md "Server-Zugang zur `
      + `Datenbank".`;
}

/**
 * E-Mail verschicken. Ueber Resend, weil das eine reine HTTP-Schnittstelle
 * ist — kein SMTP-Paket, keine Abhaengigkeit, nichts zu bauen.
 *
 * Fehlt der Schluessel, wird nichts verschickt und das offen gemeldet
 * (`{ok:false, grund:"kein-schluessel"}`). Der Aufrufer entscheidet dann, ob
 * die Anfrage trotzdem als angekommen gilt — sie liegt ja im Eingang.
 */
export async function sendeMail({ betreff, text, antwortAn }) {
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) {
    console.warn("[mail] RESEND_API_KEY fehlt — es wurde keine E-Mail verschickt.");
    return { ok: false, grund: "kein-schluessel" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: MAIL_FROM(),
        to: [MAIL_TO()],
        subject: betreff,
        text,
        ...(antwortAn ? { reply_to: antwortAn } : {}),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => "")}`);
    return { ok: true };
  } catch (err) {
    console.error("[mail] nicht verschickt:", err.message);
    return { ok: false, grund: err.message };
  }
}

/** Zeilen "Feld: Wert" fuer die E-Mail — leere Felder fallen weg. */
export const zeilen = (paare) =>
  paare
    .filter(([, v]) => String(v ?? "").trim())
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
