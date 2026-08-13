/**
 * POST /api/zaehler — ein Seitenaufruf wird gezaehlt.
 *
 * Warum es das gibt: die Website hatte keine Zahlen. Der Kunde wollte in der
 * Verwaltung sehen, wie oft die Seite besucht wird — es gab dafuer nichts, und
 * rueckwirkend laesst sich nichts rekonstruieren. Gezaehlt wird darum ab jetzt.
 *
 * WAS GEZAEHLT WIRD, und nur das:
 *
 *   - die Zahl der Aufrufe, insgesamt und pro Tag (Europe/Zurich)
 *   - welche Seite (Startseite, /booking/, /shop/ …)
 *   - welche Sprache (en, de, fr)
 *   - Handy oder Rechner
 *
 * WAS NICHT GESPEICHERT WIRD: keine IP-Adresse, kein Cookie, keine Kennung,
 * kein Browser-Kennzeichen, nichts, was einen Besucher wiedererkennbar macht.
 * Es entstehen ausschliesslich Summen. Darum gibt es hier auch keine
 * Auswertung "welcher Besucher hat was getan" — die Daten dafuer sind gar nicht
 * vorhanden, und das ist Absicht.
 *
 * Hochgezaehlt wird mit dem Server-Wert `{".sv":{"increment":1}}` der Realtime
 * Database: ein PATCH, mehrere Zaehler, und zwei gleichzeitige Aufrufe koennen
 * sich nicht gegenseitig ueberschreiben (ein Lesen-Rechnen-Schreiben von hier
 * aus koennte das).
 */
import { json, INBOX_URL } from "./_lib.mjs";

const ZEITZONE = "Europe/Zurich";

/** Heutiges Datum in der Schweiz — "2026-08-12". */
const heute = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: ZEITZONE }).format(new Date());

/**
 * Der Zaehler-Knoten neben dem Eingang: …/samsparking/stats.json
 * Dieselbe Datenbank, dieselbe Wurzel — nur ein anderer Zweig.
 */
function statsUrl() {
  const basis = INBOX_URL().replace(/\/[^/]*\.json.*$/, "");
  const token = (process.env.INBOX_API_TOKEN || "").trim();
  return `${basis}/stats.json${token ? `?auth=${encodeURIComponent(token)}` : ""}`;
}

/**
 * Aus der Adresse einen kurzen Schluessel machen: "/de/shop/" -> "shop",
 * "/" -> "start". Die Sprache steckt separat im Aufruf, sie gehoert nicht in
 * den Seitennamen — sonst zaehlt jede Seite dreimal getrennt.
 *
 * Streng nach Weissliste: alles andere wird zu "andere". Die Adresse kommt aus
 * dem Browser, also von aussen; ohne Weissliste liesse sich der Zaehler mit
 * beliebigen Schluesseln zumuellen.
 */
const SEITEN = new Set(["start", "booking", "shop", "impressum", "legal", "rechtliches", "mentions-legales", "presskit"]);

export function seitenSchluessel(pfad) {
  const rein = String(pfad || "/")
    .toLowerCase()
    .split(/[?#]/)[0]
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/\/index\.html$/, "/")
    .replace(/^\/(site\/)?/, "/")
    .replace(/^\/(en|de|fr)(\/|$)/, "/");
  const teil = rein.replace(/^\/+|\/+$/g, "").split("/")[0] || "start";
  return SEITEN.has(teil) ? teil : "andere";
}

/** Nur die drei Sprachen der Website. */
const spracheVon = (v) => (["en", "de", "fr"].includes(String(v || "").toLowerCase()) ? String(v).toLowerCase() : "andere");

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, fehler: "Nur POST" }, 405);

  let body = {};
  try {
    const text = await req.text();
    // Ein Zaehl-Aufruf ist winzig. Alles Groessere ist nichts, was hierher gehoert.
    if (text.length > 500) return json({ ok: false, fehler: "Zu gross" }, 413);
    body = text ? JSON.parse(text) : {};
  } catch (e) {
    return json({ ok: false, fehler: "Kein gueltiges JSON" }, 400);
  }

  const tag = heute();
  const seite = seitenSchluessel(body.pfad);
  const sprache = spracheVon(body.sprache);
  const geraet = body.geraet === "handy" ? "handy" : "rechner";
  // "neu" heisst: erster Aufruf in diesem Browser-Tab-Besuch. Der Browser merkt
  // sich dafuer nur ein Haekchen ohne Kennung (sessionStorage).
  const neu = body.neu === true;

  const eins = { ".sv": { increment: 1 } };
  const patch = {
    "gesamt/aufrufe": eins,
    [`tage/${tag}/aufrufe`]: eins,
    [`seiten/${seite}/aufrufe`]: eins,
    [`sprachen/${sprache}/aufrufe`]: eins,
    [`geraete/${geraet}/aufrufe`]: eins,
    ...(neu ? { "gesamt/besuche": eins, [`tage/${tag}/besuche`]: eins } : {}),
    zuletzt: new Date().toISOString(),
  };

  try {
    const res = await fetch(statsUrl(), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    /* Ein verlorener Zaehler ist kein Grund, den Besucher etwas zu merken zu
       lassen. Der Fehler steht im Protokoll der Funktion. */
    console.error("[zaehler] nicht gezaehlt:", err.message);
    return json({ ok: false }, 202);
  }

  return json({ ok: true });
};

/*
 * KEIN `export const config = { path: ... }` — die Route kommt aus
 * netlify.toml, wie bei den anderen Endpunkten. Der Grund steht in order.mjs.
 */
