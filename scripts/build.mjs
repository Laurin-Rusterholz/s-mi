#!/usr/bin/env node
/**
 * Sam Sparking — Website-Generator
 *
 * Baut `index.html`, `sitemap.xml` und `robots.txt` aus dem Inhalt.
 *
 * Inhaltsquelle (in dieser Reihenfolge):
 *   1. CONTENT_API_URL  — Endpoint der Verwaltung (JSON), z. B.
 *      https://<verwaltung>.netlify.app/api/content
 *      Optional mit CONTENT_API_TOKEN als Bearer-Token.
 *   2. content/site.json — im Repo eingecheckter Stand (Fallback).
 *
 * Aufruf:  node scripts/build.mjs
 */

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_CONTENT = resolve(ROOT, "content/site.json");
/** Schnappschuss der Bildmasse aus der Medienbibliothek (siehe ladeBildmasse). */
const LOCAL_MASSE = resolve(ROOT, "content/bildmasse.json");

/** Verzeichnisse, die der Generator nie anfasst. */
const KEEP_DIRS = new Set(["assets", "img", "media", "content", "scripts", "presskit", "node_modules"]);

/* ------------------------------------------------------------------ utils */

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Sicheres href: nur http(s), mailto, tel, relative Pfade und #anker. */
const safeUrl = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return ""; // javascript:, data:, …
  return s;
};

const href = (v) => esc(rooted(v));

/** Mini-Markdown im Fliesstext: **fett** und [Label](url). */
const inline = (v) =>
  esc(v)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
      const u = safeUrl(url.replace(/&amp;/g, "&"));
      if (!u) return label;
      const ext = /^https?:/i.test(u) ? ' target="_blank" rel="noopener"' : "";
      return `<a href="${esc(u)}"${ext}>${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

const jsonScript = (obj) =>
  JSON.stringify(obj, null, 2).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

const list = (v) => (Array.isArray(v) ? v : []);
const str = (v, fallback = "") => (typeof v === "string" && v.trim() ? v : fallback);
const num = (n) => String(n).padStart(2, "0");

/** Absolute URL für og:image & Co. */
const absolute = (base, path) => {
  const p = String(path ?? "").trim();
  if (!p) return "";
  if (/^https?:/i.test(p)) return p;
  return `${base.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`;
};

/** Farbe für CSS/Meta absichern (nur Hex oder rgb/hsl-Funktionen). */
const color = (v, fallback) => {
  const s = String(v ?? "").trim();
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
  if (/^(rgb|hsl)a?\([0-9,.%\s/]+\)$/i.test(s)) return s;
  return fallback;
};

const isoDate = (v) => {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
};

const today = () => (process.env.BUILD_DATE || new Date().toISOString()).slice(0, 10);

/**
 * Unterverzeichnis, in dem die fertige Website ausgeliefert wird.
 * Leer (Normalfall) = direkt an der Wurzel der Domain. Gesetzt (SITE_BASE=/site)
 * wandern alle seiteninternen Adressen — Bilder, CSS, Sprachwechsel, Menü —
 * unter dieses Verzeichnis. Gebraucht wird das von der Präsentations-Fassung
 * (Repo Beispiel-Sami), die Website und Verwaltung nebeneinander ausliefert.
 * Die absoluten Adressen für Suchmaschinen (canonical, hreflang, sitemap)
 * bleiben bewusst unberührt — sie zeigen weiter auf die echte Website.
 */
const BASE = String(process.env.SITE_BASE || "")
  .trim()
  .replace(/\/+$/, "")
  .replace(/^(?!$|\/)/, "/");

/* ------------------------------------------------------------------ laden */

/**
 * Fehlendes aus der Vorlage ergänzen — der Stand aus der Verwaltung gewinnt,
 * aber Felder, die es dort noch gar nicht gibt (neu dazugekommene Bausteine
 * wie Sprachen, Oberflächentexte oder das Hintergrundbild), kommen aus der
 * eingecheckten content/site.json. Sonst müsste nach jeder Erweiterung erst
 * jemand in der Verwaltung speichern, bevor sie auf der Website ankommt.
 */
function withDefaults(target, defaults) {
  if (Array.isArray(defaults)) return Array.isArray(target) ? target : defaults;
  if (defaults && typeof defaults === "object") {
    const out = target && typeof target === "object" && !Array.isArray(target) ? target : {};
    for (const [k, v] of Object.entries(defaults)) out[k] = withDefaults(out[k], v);
    return out;
  }
  return target === undefined ? defaults : target;
}

/**
 * Texte der Vorlage übernehmen — nur dort, wo es das Feld im Live-Inhalt schon
 * gibt. Bilder, Videos, Termine, Farben und Links bleiben unangetastet.
 * Dieselbe Regel wie der Knopf „Texte umstellen" in der Verwaltung.
 */
export function adoptTexts(live, template) {
  for (const [path, text] of collectStrings(template)) {
    const keys = path.split(".");
    let cur = live;
    let tpl = template;
    let mismatch = false;
    for (let i = 0; i < keys.length - 1 && cur != null; i++) {
      // Übernommen wird Feld für Feld über den Pfad. In Listen zählt dabei nur
      // die Position — stehen dort unterschiedlich viele Einträge, gehört
      // Position 2 der Vorlage nicht zu Position 2 des Live-Inhalts. Genau so
      // ist "Luzern" schon einmal auf "Sektor 11" gerutscht. Solche Pfade
      // bleiben deshalb unangetastet.
      if (Array.isArray(cur) && Array.isArray(tpl) && cur.length !== tpl.length) {
        mismatch = true;
        break;
      }
      cur = cur[keys[i]];
      tpl = tpl == null ? null : tpl[keys[i]];
    }
    if (mismatch) continue;
    if (Array.isArray(cur) && Array.isArray(tpl) && cur.length !== tpl.length) continue;
    const last = keys[keys.length - 1];
    if (cur && typeof cur === "object" && cur[last] !== undefined) cur[last] = text;
  }
  live.site.lang = template.site.lang;
  live.site.languages = list(template.site.languages).slice();
  live.i18n = template.i18n;
  live.i18nHash = template.i18nHash;
  if (template.ui) live.ui = template.ui;
  // Seitenaufteilung und Reihenfolge der Vorlage übernehmen — die alten
  // englischen Stände tragen noch die Vier-Seiten-Struktur mit sich.
  if (template.pages !== undefined) live.pages = JSON.parse(JSON.stringify(template.pages));
  if (template.layout !== undefined) live.layout = list(template.layout).slice();
}

/**
 * Steckt in der Datenbank noch der englische Werks-Stand? Verglichen wird
 * Text für Text mit den alten Auslieferungs-Texten (content/legacy-en.json).
 * Ab 10 Treffern gilt der Stand als "nie inhaltlich angefasst" — eigene
 * Bilder, Videos, Termine und Links zählen nicht mit und bleiben erhalten.
 */
function looksLikeLegacy(live, legacy) {
  if (!legacy) return 0;
  let hits = 0;
  for (const [path, text] of collectStrings(legacy)) {
    const keys = path.split(".");
    let cur = live;
    for (let i = 0; i < keys.length - 1 && cur != null; i++) cur = cur[keys[i]];
    if (cur && typeof cur === "object" && String(cur[keys[keys.length - 1]] ?? "").trim() === text.trim()) hits++;
  }
  return hits;
}

/**
 * Stand der Vorlage. Wird erhöht, wenn im Repo etwas geändert wurde, das die
 * Verwaltung noch nicht kennt — die Datenbank gewinnt sonst über `withDefaults`
 * gegen jede Korrektur im Repo, und der Build würde den alten Stand
 * wiederherstellen.
 *
 * Solange die Datenbank eine kleinere Zahl trägt, zieht `nachziehen()` die
 * betroffenen Stellen aus der Vorlage nach. Sobald in der Verwaltung einmal
 * gespeichert wurde, steht die Zahl auch dort und der Build lässt die
 * Datenbank wieder unangetastet gewinnen.
 *
 *   2  Schreibweise "Sam Sparking", vollständige Referenzliste, Instagram als
 *      Kanal, Kennzahlen im Hero statt Fakten unter About, Shop/Sound/Erlebnis
 *      ausgeschaltet.
 *   3  Bild im Booking-Abschnitt.
 */
const VORLAGEN_STAND = 3;

/**
 * "Sam Sparkling" war jahrelang falsch geschrieben. Ausgenommen ist der
 * Hostname djsamsparkling.netlify.app — das ist eine Adresse: wird sie
 * mitkorrigiert, zeigen Canonical, hreflang und Sitemap ins Leere. Er wird
 * darum vor der Ersetzung beiseitegelegt und danach unveraendert zurueck-
 * geschrieben.
 */
const HOST_MARKE = "\u0001";
function schreibweise(v) {
  if (typeof v !== "string" || !v.includes("parkling")) return v;
  const hosts = [];
  return v
    .replace(/djsamsparkling/gi, (m) => {
      hosts.push(m);
      return HOST_MARKE;
    })
    .replace(/Sparkling/g, "Sparking")
    .replace(/sparkling/g, "sparking")
    .replace(new RegExp(HOST_MARKE, "g"), () => hosts.shift());
}

/**
 * Schreibweise in jedem Text des Baums korrigieren — auch in Listen aus
 * reinem Text (Absaetze, Keywords, Stichworte). Die werden ueber den Index
 * zurueckgeschrieben; ein blosses forEach wuerde den Ersatz verwerfen.
 */
function schreibweiseTief(node) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      if (typeof v === "string") node[i] = schreibweise(v);
      else schreibweiseTief(v);
    });
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === "string") node[k] = schreibweise(v);
    else schreibweiseTief(v);
  }
}

/**
 * Holt die Stellen aus der Vorlage nach, die in der Datenbank noch den Stand
 * von vor dieser Änderung tragen. Alles andere — Bilder, Videos, Termine,
 * Texte, Links — bleibt unangetastet: die Verwaltung behält die Hoheit.
 */
const kopie = (v) => JSON.parse(JSON.stringify(v));

/**
 * Jeder Schritt gehört genau zu der Fassung, die ihn gebracht hat, und läuft
 * nur einmal. Das ist der springende Punkt: würde bei jeder neuen Fassung
 * wieder der ganze Satz laufen, käme mit Fassung 3 auch die Sichtbarkeit aus
 * Fassung 2 zurück — ein in der Verwaltung eingeschalteter Shop wäre beim
 * nächsten Build wieder aus, ohne dass jemand etwas dagegen tun kann.
 */
const NACHZIEH_SCHRITTE = [
  {
    ab: 2,
    tun(live, template) {
      schreibweiseTief(live);

      const ls = live.sections || (live.sections = {});
      const ts = template.sections || {};

      // Listen: die Datenbank gewinnt bei Listen immer, darum gezielt setzen.
      if (ts.references?.items) ls.references = { ...ls.references, items: kopie(ts.references.items) };
      if (ts.contact?.socials) ls.contact = { ...ls.contact, socials: kopie(ts.contact.socials) };
      if (ts.about) ls.about = { ...ls.about, facts: kopie(ts.about.facts || []) };
      if (template.hero?.stats) live.hero = { ...live.hero, stats: kopie(template.hero.stats) };

      // Einmalig: Shop, Sound und Erlebnis standen in der Datenbank noch auf
      // "an", der Kunde will sie aus. Danach entscheidet allein die Verwaltung.
      for (const [k, sec] of Object.entries(ts)) {
        if (ls[k] && typeof sec?.enabled === "boolean") ls[k].enabled = sec.enabled;
      }
      if (template.layout) live.layout = list(template.layout).slice();
      if (Array.isArray(template.pages) && Array.isArray(live.pages)) {
        live.pages.forEach((p, i) => {
          const t = template.pages[i];
          if (p && t && Array.isArray(t.sections)) p.sections = t.sections.slice();
        });
      }
    },
  },
  {
    ab: 3,
    tun(live, template) {
      // Nur setzen, wenn in der Verwaltung noch kein Bild gewählt wurde.
      const tp = template.sections?.booking?.photo;
      const ls = live.sections || (live.sections = {});
      if (tp?.src && !ls.booking?.photo?.src) ls.booking = { ...ls.booking, photo: kopie(tp) };
    },
  },
];

export function nachziehen(live, template) {
  const stand = Number(live?.contentRevision || 0);
  const ziel = Number(template?.contentRevision) || VORLAGEN_STAND;
  if (stand >= ziel) return null;

  NACHZIEH_SCHRITTE.filter((s) => stand < s.ab && s.ab <= ziel).forEach((s) => s.tun(live, template));

  live.contentRevision = ziel;
  return stand;
}

/**
 * Bildmasse aus der Medienbibliothek der Verwaltung. Sie stehen dort seit dem
 * Hochladen (width/height je Datei), kamen bisher aber nie in der Website an.
 *
 * Die Masse liegen bewusst NICHT im Inhalt: dort müssten sie bei jedem
 * Bildwechsel mitgepflegt werden und wären schnell falsch. Der Generator
 * schlägt sie stattdessen über die Bild-Adresse nach und schreibt einen
 * Schnappschuss mit, damit ein Build ohne API (und die lokale Vorschau)
 * dieselben Zahlen hat.
 */
async function ladeBildmasse() {
  const api = process.env.MEDIA_API_URL || process.env.CONTENT_API_URL?.replace(/content\.json/, "media.json");
  const map = new Map();

  if (api && /media\.json/.test(api)) {
    try {
      const res = await fetch(api, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) || {};
      for (const m of Object.values(data)) {
        const url = str(m?.url);
        const w = Number(m?.width) || 0;
        const h = Number(m?.height) || 0;
        if (url && w > 0 && h > 0) map.set(url, { w, h });
      }
      if (map.size) {
        await writeFile(LOCAL_MASSE, JSON.stringify(Object.fromEntries(map), null, 2) + "\n");
        console.log(`[build] Bildmasse aus der Medienbibliothek: ${map.size} Bild(er)`);
        return map;
      }
    } catch (err) {
      console.warn("[build] Medienbibliothek nicht lesbar:", err.message);
    }
  }

  try {
    const roh = JSON.parse(await readFile(LOCAL_MASSE, "utf8"));
    for (const [url, m] of Object.entries(roh)) {
      if (Number(m?.w) > 0 && Number(m?.h) > 0) map.set(url, { w: Number(m.w), h: Number(m.h) });
    }
    if (map.size) console.log(`[build] Bildmasse aus dem Schnappschuss: ${map.size} Bild(er)`);
  } catch (e) {
    /* noch kein Schnappschuss — dann bleiben die Bilder ohne width/height */
  }
  return map;
}

async function loadContent() {
  const apiUrl = process.env.CONTENT_API_URL;
  if (apiUrl) {
    try {
      const headers = { Accept: "application/json" };
      const token = process.env.CONTENT_API_TOKEN;
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(apiUrl, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const live = data && data.content ? data.content : data;
      if (!live || typeof live !== "object" || !live.site) {
        throw new Error("Antwort enthält kein site-Objekt");
      }
      let content = live;
      try {
        const template = JSON.parse(await readFile(LOCAL_CONTENT, "utf8"));
        let legacy = null;
        try {
          legacy = JSON.parse(await readFile(resolve(ROOT, "content/legacy-en.json"), "utf8"));
        } catch (e) {
          /* keine Legacy-Datei — dann entscheidet nur die Sprach-Einstellung */
        }
        // Alter Stand in der Datenbank? Zwei Anzeichen: (a) die Hauptsprache
        // weicht von der Vorlage ab, oder (b) die Texte sind noch die alten
        // englischen Werkstexte — auch wenn in der Verwaltung längst
        // "Deutsch" eingestellt wurde. In beiden Fällen kommen Texte,
        // Übersetzungen und Seitenaufteilung aus der Vorlage; Bilder, Videos,
        // Termine und Links bleiben unangetastet.
        const legacyHits = looksLikeLegacy(live, legacy);
        if (String(live.site?.lang || "") !== String(template.site?.lang || "") || legacyHits >= 10) {
          console.log(
            `[build] Datenbank trägt noch den alten Stand ` +
              `(Sprache "${live.site?.lang}", ${legacyHits} Werkstexte erkannt) — ` +
              `Texte, Übersetzungen und Seitenaufteilung aus der Vorlage übernommen.`
          );
          adoptTexts(live, template);
        }
        const vorher = nachziehen(live, template);
        if (vorher !== null) {
          console.log(
            `[build] Datenbank trägt Stand ${vorher} < ${VORLAGEN_STAND} — ` +
              `Schreibweise, Referenzen, Kanäle und Sichtbarkeit aus der Vorlage ` +
              `nachgezogen. Nach dem ersten Speichern in der Verwaltung entfällt das.`
          );
        }
        content = withDefaults(live, template);
      } catch (e) {
        console.warn("[build] Vorlage content/site.json nicht lesbar:", e.message);
      }
      console.log(`[build] Inhalt von der Verwaltung geladen: ${apiUrl}`);
      // Snapshot mitschreiben, damit der Build ohne API reproduzierbar bleibt.
      await writeFile(LOCAL_CONTENT, JSON.stringify(content, null, 2) + "\n");
      return content;
    } catch (err) {
      console.warn(
        "\n" +
          "########################################################\n" +
          "#  WARNUNG: Verwaltungs-API nicht erreichbar!           #\n" +
          `#  ${String(err.message).slice(0, 50).padEnd(50)}#\n` +
          "#  Es wird der eingecheckte Stand content/site.json     #\n" +
          "#  verwendet — evtl. NICHT der aktuellste Inhalt.       #\n" +
          "########################################################\n"
      );
    }
  }
  const raw = await readFile(LOCAL_CONTENT, "utf8");
  console.log("[build] Inhalt aus content/site.json geladen");
  return JSON.parse(raw);
}

/* --------------------------------------------------------------- bausteine */

function sectionHead(n, s, key) {
  if (CTX.hideHead === key) return "";
  return `
      <div class="shead rv">
        <span class="num" aria-hidden="true">${num(n)}</span>
        <h2 id="${esc(key)}-h">${esc(s.title)}<i>${esc(s.titleAccent)}</i></h2>
        <span class="shead-rule" aria-hidden="true"></span>
      </div>`;
}

/*
 * Bilder über das Netlify-Image-CDN ausliefern: verkleinert, als WebP/AVIF,
 * am Netz-Rand zwischengespeichert. Die Uploads aus der Verwaltung sind
 * Handyfotos in Originalgrösse (mehrere MB) — direkt aus Firebase geladen
 * fühlt sich das auf dem Handy wie "Bilder laden nicht" an.
 *
 * Aktiv nur, wenn der Build bei Netlify läuft (oder IMAGE_CDN=1 gesetzt ist);
 * lokal bleiben die Originalpfade, damit Vorschau und Tests ohne CDN laufen.
 */
const CDN = !!(process.env.NETLIFY || process.env.IMAGE_CDN);

function cdnUrl(src, w) {
  const clean = String(src || "").trim();
  if (!CDN || !clean || isVideoUrl(clean)) return rooted(clean);
  if (/^data:/i.test(clean)) return clean;
  return `/.netlify/images?url=${encodeURIComponent(rooted(clean))}&w=${w}&q=72`;
}

/**
 * Bildmasse aus der Medienbibliothek, nach Adresse. Wird in ladeBildmasse()
 * gefüllt. Ohne Eintrag bleibt das Bild ohne width/height — dann verhält es
 * sich wie bisher.
 */
let BILDMASSE = new Map();

/** Masse eines Bildes: erst am Inhalt, sonst aus der Medienbibliothek. */
function masseVon(media, raw) {
  const w = Number(media?.width) || 0;
  const h = Number(media?.height) || 0;
  if (w > 0 && h > 0) return { w, h };
  const m = BILDMASSE.get(raw);
  return m && m.w > 0 && m.h > 0 ? m : null;
}

function picture(media, { className = "", eager = false, sizes = "", widths = [480, 800, 1200], style = "" } = {}) {
  const raw = String(media?.src || "").trim();
  if (!raw || !safeUrl(raw)) return "";
  const srcset = CDN
    ? ` srcset="${widths.map((w) => `${esc(cdnUrl(raw, w))} ${w}w`).join(", ")}"`
    : "";
  // width/height reservieren den Platz, bevor das Bild da ist — ohne sie
  // springt der Text beim Nachladen nach unten (Layout Shift). Die Zahlen
  // sind nur das Seitenverhältnis; die tatsächliche Grösse macht das CSS.
  const masse = masseVon(media, raw);
  const attrs = [
    `src="${esc(cdnUrl(raw, widths[widths.length - 1]))}"`,
    `alt="${esc(media?.alt || "")}"`,
    masse ? `width="${masse.w}" height="${masse.h}"` : "",
    eager ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"',
    sizes ? `sizes="${esc(sizes)}"` : "",
    className ? `class="${esc(className)}"` : "",
  ].filter(Boolean);
  return `<img ${attrs.join(" ")}${srcset}${style}>`;
}

/** MIME-Typ aus der Dateiendung (Firebase-URLs tragen die Endung im Pfad). */
const videoType = (url) => {
  const u = String(url || "").toLowerCase();
  if (/\.webm(\?|#|$)/.test(u)) return "video/webm";
  if (/\.(mov|m4v)(\?|#|$)/.test(u)) return "video/quicktime";
  return "video/mp4";
};

const isVideoUrl = (url) => /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(String(url || ""));

/**
 * Ortsangaben für Suchmaschinen. Alte, aber weiterhin gelesene Signale für
 * lokale Suchen ("DJ St. Gallen").
 */
function geoMeta(contact) {
  const place = str(contact?.base);
  if (!place) return "";
  const region = /st\.?\s*gallen/i.test(place) ? "CH-SG" : "CH";
  return `  <meta name="geo.region" content="${esc(region)}">
  <meta name="geo.placename" content="${esc(place)}">
`;
}

/**
 * Aufsteigende Funken — das bewegte Element der Seite, passend zum Namen
 * Sparking. Position, Grösse, Tempo und Drift jedes Funkens sind fest
 * eingerechnet, damit jeder Build dieselbe Datei erzeugt; animiert wird rein
 * in CSS, negative Verzögerungen lassen die Funken schon beim Laden fliegen.
 */
function sparks(n = 16) {
  let out = "";
  for (let i = 0; i < n; i++) {
    const x = ((i * 61) % 97) + 2;
    const size = 2 + ((i * 7) % 3);
    const t = (7 + ((i * 13) % 8)).toFixed(1);
    const d = (-(((i * 17) % 20) / 20) * 7).toFixed(2);
    const dx = ((i * 29) % 11) - 5;
    out += `<span style="--x:${x}%;--s:${size}px;--t:${t}s;--d:${d}s;--dx:${dx}vw"></span>`;
  }
  return out;
}

/**
 * Hintergrundbild der ganzen Seite. Liegt hinter allem, bewegt sich nicht mit
 * und ist stark abgedunkelt — die Inhalte stehen darauf frei, ohne dass der
 * Text an Kontrast verliert.
 */
function pageBackground(site) {
  if (!safeUrl(site.backgroundImage)) return "";
  const small = esc(cdnUrl(site.backgroundImage, 800));
  const big = esc(cdnUrl(site.backgroundImage, 1600));
  const style = CDN
    ? `background-image:url('${small}');background-image:image-set(url('${small}') 1x,url('${big}') 2x)`
    : `background-image:url('${big}')`;
  return `  <div class="page-bg" aria-hidden="true" style="${style}"></div>`;
}

/**
 * Hero-Hintergrund. Video läuft stumm in Dauerschleife — anders erlaubt kein
 * Browser Autoplay. Das Poster wird sofort angezeigt (und bleibt stehen, wenn
 * jemand „Bewegung reduzieren" eingestellt hat, siehe assets/site.js).
 */
/**
 * Anzeige-Art eines Mediums:
 *   fill (Standard) – fuellt die Flaeche, Raender werden abgeschnitten
 *   full            – das ganze Bild/Video ist zu sehen, ggf. mit Rand
 * Dazu der Bildausschnitt (welcher Teil sichtbar bleibt, wenn beschnitten wird).
 */
const FOCUS = new Set(["center", "top", "bottom", "left", "right"]);

function fitAttrs(m) {
  const full = str(m?.fit) === "full";
  const focus = FOCUS.has(str(m?.focus)) ? str(m.focus) : "center";
  return {
    cls: full ? " fit-full" : "",
    style: !full && focus !== "center" ? ` style="object-position:${esc(focus)}"` : "",
  };
}

/**
 * Zuschnitt eines Videos: ab welcher und bis zu welcher Sekunde abgespielt
 * wird. Beide Angaben sind freiwillig — ohne sie läuft das ganze Video.
 * Geschnitten wird nicht die Datei, sondern die Wiedergabe (assets/site.js);
 * die Sekunden stehen darum als data-Attribute am <video>.
 */
function clipAttrs(m) {
  const sec = (v) => {
    const n = Number.parseFloat(String(v ?? "").replace(",", "."));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  };
  const start = sec(m?.clipStart);
  const end = sec(m?.clipEnd);
  let out = "";
  if (start !== null) out += ` data-clip-start="${start}"`;
  if (end !== null && (start === null || end > start)) out += ` data-clip-end="${end}"`;
  return out;
}

function heroMedia(hero, site) {
  const m = hero.media || {};
  if (m.type === "video" && safeUrl(m.src)) {
    const posterSrc = safeUrl(m.poster) || safeUrl(site?.ogImage) || safeUrl(site?.backgroundImage);
    const poster = posterSrc ? esc(cdnUrl(posterSrc, 1600)) : "";
    const f = fitAttrs(m);
    return `<video class="hero-video${f.cls}" autoplay muted loop playsinline preload="auto"${
      poster ? ` poster="${poster}"` : ""
    }${f.style}${clipAttrs(m)} aria-hidden="true" tabindex="-1"><source src="${href(m.src)}"></video>`;
  }
  const f = fitAttrs(m);
  return picture(m, {
    eager: true,
    sizes: "100vw",
    className: f.cls.trim(),
    style: f.style,
  });
}

/**
 * Kennzahlen auf dem ersten Bildschirm. Im HTML steht immer der fertige Wert —
 * ohne JavaScript, bei „Bewegung reduzieren“ und für Suchmaschinen ist die
 * Zahl damit sofort da. Der Zähl-Effekt (assets/site.js) zerlegt sie in
 * Vorsatz, Ziffern und Nachsatz; darum stehen diese Teile als data-Attribute
 * daneben statt sie im Browser noch einmal aus dem Text zu raten.
 */
function heroStats(hero) {
  const items = list(hero?.stats).filter((s) => str(s?.value));
  if (!items.length) return "";
  const rows = items
    .map((s) => {
      const value = str(s.value).trim();
      // "7+" → Ziffern "7", Nachsatz "+";  "CHF 5" → Vorsatz "CHF ", Ziffern "5"
      const m = value.match(/^([^\d]*)(\d[\d'’.,]*)(.*)$/);
      const data = m
        ? ` data-to="${esc(m[2].replace(/[^\d]/g, ""))}"` +
          ` data-pre="${esc(m[1])}" data-post="${esc(m[3])}"`
        : "";
      return `<div class="hstat">
          <strong class="hstat-value"${data}>${esc(value)}</strong>
          ${str(s.label) ? `<span class="hstat-label">${esc(s.label)}</span>` : ""}
        </div>`;
    })
    .join("\n        ");
  return `<div class="hero-stats">
        ${rows}
      </div>`;
}

function renderAbout(n, s) {
  const facts = list(s.facts).filter((f) => str(f?.value));
  const paragraphs = list(s.paragraphs).filter((p) => str(p));
  const firstParagraph = paragraphs[0];
  const moreParagraphs = paragraphs.slice(1);
  return `
  <section class="pad" id="about" aria-labelledby="about-h">
    <div class="wrap">${sectionHead(n, s, "about")}
      <div class="about-grid">
        <div class="about-photo rv">
          ${picture(s.photo, { sizes: "(max-width:860px) 90vw, 40vw" })}
          ${str(s.photo?.credit) ? `<span class="mono">${esc(s.photo.credit)}</span>` : ""}
        </div>
        <div class="about-copy rv">
          ${str(s.lede) ? `<p class="lede">${inline(s.lede)}</p>` : ""}
          ${firstParagraph ? `<p>${inline(firstParagraph)}</p>` : ""}
          ${
            moreParagraphs.length
              ? `<div class="about-more" id="about-more">
            ${moreParagraphs.map((p) => `<p>${inline(p)}</p>`).join("\n            ")}
          </div>
          <button class="about-toggle mono" type="button" aria-controls="about-more" aria-expanded="false"
                  data-more="${esc(UI.moreStory)}" data-less="${esc(UI.lessStory)}">${esc(
                    UI.moreStory
                  )}</button>`
              : ""
          }
          ${
            list(s.words).length
              ? `<div class="three-words">${list(s.words)
                  .map((w) => `<span>${esc(w)}</span>`)
                  .join("")}</div>`
              : ""
          }
        </div>
      </div>
      ${
        facts.length
          ? `<dl class="facts rv">${facts
              .map(
                (f) =>
                  `<div><dt class="mono">${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`
              )
              .join("")}</dl>`
          : ""
      }
    </div>
  </section>`;
}

function renderSound(n, s) {
  const mixes = list(s.mixes).filter((m) => str(m?.title));
  return `
  <section class="sound pad" id="sound" aria-labelledby="sound-h">
    <div class="wrap">${sectionHead(n, s, "sound")}
      <div class="sound-grid">
        <div class="rv">
          <ul class="genre-list">
            ${list(s.genres)
              .filter((g) => str(g?.name))
              .map(
                (g) =>
                  `<li>${esc(g.name)} <span class="mono">${esc(str(g.meta, "Genre"))}</span></li>`
              )
              .join("\n            ")}
          </ul>
          ${str(s.note) ? `<p class="live-note">${inline(s.note)}</p>` : ""}
        </div>
        <div class="mix-stack rv">
          ${mixes
            .map(
              (m) => `<article class="mix-card">
            ${str(m.kicker) ? `<span class="mono">${esc(m.kicker)}</span>` : ""}
            <h3>${esc(m.title)}</h3>
            ${str(m.text) ? `<p>${inline(m.text)}</p>` : ""}
            ${
              safeUrl(m.embedUrl)
                ? `<div class="mix-embed"><iframe src="${href(m.embedUrl)}" title="${esc(
                    m.title
                  )}" loading="lazy" allow="autoplay" frameborder="0"></iframe></div>`
                : ""
            }
            ${
              safeUrl(m.linkUrl)
                ? `<a class="btn" href="${href(m.linkUrl)}" target="_blank" rel="noopener">${esc(
                    str(m.linkLabel, "Listen")
                  )}</a>`
                : ""
            }
          </article>`
            )
            .join("\n          ")}
        </div>
      </div>
    </div>
  </section>`;
}

function renderExperience(n, s) {
  const moments = list(s.moments).filter((m) => str(m?.title));
  return `
  <section class="pad" id="experience" aria-labelledby="experience-h">
    <div class="wrap">${sectionHead(n, s, "experience")}
      ${str(s.lede) ? `<p class="lede rv">${inline(s.lede)}</p>` : ""}
      ${
        moments.length
          ? `<div class="experience-composition rv">
        <div class="speaker-model" aria-hidden="true">
          <span class="speaker-aura"></span>
          <span class="sound-ring ring-one"></span>
          <span class="sound-ring ring-two"></span>
          <span class="speaker-beam beam-left"></span>
          <span class="speaker-beam beam-right"></span>
          <span class="speaker-levels">
            <i style="--level:28%"></i><i style="--level:54%"></i><i style="--level:82%"></i>
            <i style="--level:46%"></i><i style="--level:70%"></i><i style="--level:38%"></i>
          </span>
          <div class="speaker-rig">
            <span class="rig-hook"></span>
            <div class="line-array">
              <span class="array-module"><i></i><i></i></span>
              <span class="array-module"><i></i><i></i></span>
              <span class="array-module"><i></i><i></i></span>
              <span class="array-module"><i></i><i></i></span>
            </div>
            <div class="sub-cabinet">
              <span class="speaker-brand">SAM SPARKLING<small>LIVE SYSTEM</small></span>
              <span class="sub-driver"><i></i></span>
              <span class="speaker-port"></span>
            </div>
          </div>
          <span class="speaker-floor"></span>
        </div>
        <div class="moment-grid">${moments
              .map(
                (m, index) => `<article class="mix-card" data-step="${String(index + 1).padStart(
                  2,
                  "0"
                )}">
            ${str(m.kicker) ? `<span class="mono">${esc(m.kicker)}</span>` : ""}
            <h3>${esc(m.title)}</h3>
            ${str(m.text) ? `<p>${inline(m.text)}</p>` : ""}
          </article>`
              )
              .join("\n          ")}</div>
      </div>`
          : ""
      }
      ${
        safeUrl(s.embedUrl)
          ? `<div class="mix-embed rv"><iframe src="${href(s.embedUrl)}" title="${esc(
              str(s.embedLabel, "Aftermovie")
            )}" loading="lazy" allow="autoplay" frameborder="0"></iframe></div>`
          : ""
      }
      ${
        str(s.quote?.text)
          ? `<blockquote class="lede rv">${inline(s.quote.text)}${
              [str(s.quote.name), str(s.quote.venue)].filter(Boolean).length
                ? `<footer class="mono">— ${[esc(s.quote.name), esc(s.quote.venue)]
                    .filter(Boolean)
                    .join(", ")}</footer>`
                : ""
            }</blockquote>`
          : ""
      }
    </div>
  </section>`;
}

function showRow(sh, idx) {
  const date = isoDate(sh.date);
  const booked = sh.status === "booked";
  const d = date ? new Date(date + "T12:00:00Z") : null;
  const day = d ? String(d.getUTCDate()).padStart(2, "0") : "";
  const month = d
    ? d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase()
    : "";
  const year = d ? d.getUTCFullYear() : "";
  const soldOut = sh.status === "soldout";
  const label = soldOut ? UI.soldOut : booked ? UI.booked : str(sh.ticketLabel, UI.tickets);
  return `<li class="show${soldOut ? " soldout" : ""}${booked ? " booked" : ""}"${date ? ` data-date="${esc(date)}"` : ""}>
          <span class="show-date"><b>${esc(day)}</b><span class="mono">${esc(month)} ${esc(
    year
  )}</span></span>
          <span class="show-main">
            <span class="show-name">${esc(sh.name)}</span>
            <span class="mono show-where">${[str(sh.venue), str(sh.city), str(sh.country)]
              .filter(Boolean)
              .map(esc)
              .join(" · ")}</span>
          </span>
          <span class="show-cta">${
            safeUrl(sh.ticketUrl) && !soldOut && !booked
              ? `<a class="btn btn-sm" href="${href(
                  sh.ticketUrl
                )}" target="_blank" rel="noopener">${esc(label)}</a>`
              : `<span class="mono">${esc(soldOut || booked ? label : "")}</span>`
          }</span>
        </li>`;
}

function renderShows(n, s) {
  const t = today();
  const items = list(s.items).filter((i) => str(i?.name));
  if (!items.length) return "";
  const upcoming = items
    .filter((i) => !isoDate(i.date) || isoDate(i.date) >= t)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const past = items
    .filter((i) => isoDate(i.date) && isoDate(i.date) < t)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));


  return `
  <section class="pad shows-sec" id="shows" aria-labelledby="shows-h">
    <div class="wrap">${sectionHead(n, s, "shows")}
      ${
        upcoming.length
          ? `<ul class="show-list rv" id="show-list">
        ${upcoming.map(showRow).join("\n        ")}
      </ul>`
          : `<div class="empty-state rv"><span class="mono">${esc(UI.calShow)}</span><p>${inline(
              str(s.emptyText, "No dates announced right now.")
            )}</p></div>`
      }
      ${
        past.length
          ? `<details class="past-shows rv">
        <summary class="mono">${esc(str(s.pastLabel, "Played before"))} (${past.length})</summary>
        <ul class="show-list past">
        ${past.map(showRow).join("\n        ")}
        </ul>
      </details>`
          : ""
      }
    </div>
  </section>`;
}

function renderReferences(n, s) {
  const items = list(s.items).filter((i) => str(i?.name));
  return `
  <section class="pad" id="references" aria-labelledby="references-h">
    <div class="wrap">${sectionHead(n, s, "references")}
      <ul class="venue-list rv">
        ${items
          .map((v, i) => {
            const url = safeUrl(v.url) || anchor("#booking");
            const ext = /^https?:/i.test(url) ? ' target="_blank" rel="noopener"' : "";
            // Die Liste ist nach Wichtigkeit sortiert. Die oben stehenden
            // Referenzen tragen "highlight" und bekommen die ganze Zeilenbreite
            // — so ist die Reihenfolge auch optisch eine Rangfolge.
            return `<li${v.highlight ? ' class="lead"' : ""}><a href="${esc(url)}"${ext}><span class="venue-idx">${num(
              i + 1
            )}</span><span class="venue-name">${esc(v.name)}</span><span class="venue-city">${esc(
              v.city
            )}</span></a></li>`;
          })
          .join("\n        ")}
      </ul>
      ${
        str(s.note)
          ? `<p class="live-note rv">${inline(s.note)} <a class="accent" href="${anchorHref(
              "#contact"
            )}">${esc(
              str(s.noteLinkLabel, "Get in touch →")
            )}</a></p>`
          : ""
      }
    </div>
  </section>`;
}

/**
 * After Movies — die Rückblick-Videos zu gespielten Events. Anders als die
 * stummen Schleifen in der Bilderwand werden sie bewusst angeschaut: mit
 * Bedienelementen, Ton und Vorschaubild, nichts startet von allein.
 * Fremdvideos (YouTube/Vimeo) kommen über embedUrl, eigene Dateien über src.
 */
function afterMovies(s) {
  const movies = list(s.aftermovies).filter(
    (m) => str(m?.title) && (safeUrl(m?.src) || safeUrl(m?.embedUrl))
  );
  const head = `<div class="after-head">
          <span class="mono">${esc(UI.afterMovies)}</span>
          ${str(s.aftermoviesNote) ? `<p>${inline(s.aftermoviesNote)}</p>` : ""}
        </div>`;
  if (!movies.length) {
    return `<div class="after rv">
        <!-- TODO Kunde: Aftermovie-Dateien oder YouTube-/Vimeo-Adressen liefern.
             Eintragen in der Verwaltung unter Galerie → After Movies je Video:
             Titel, Event, Video (src oder embedUrl) und Vorschaubild (poster).
             Solange nichts hinterlegt ist, steht hier der Platzhaltertext. -->
        ${head}
        <div class="empty-state"><span class="mono">${esc(UI.afterMovies)}</span><p>${esc(
      str(s.aftermoviesEmpty, UI.afterMoviesEmpty)
    )}</p></div>
      </div>`;
  }
  const cards = movies
    .map((m) => {
      const media = safeUrl(m.embedUrl)
        ? `<iframe src="${href(m.embedUrl)}" title="${esc(m.title)}" loading="lazy"
              allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture; fullscreen"
              referrerpolicy="strict-origin-when-cross-origin" allowfullscreen frameborder="0"></iframe>`
        : `<video src="${href(m.src)}" controls playsinline preload="none"${
            safeUrl(m.poster) ? ` poster="${esc(cdnUrl(m.poster, 800))}"` : ""
          }></video>`;
      return `<article class="after-card">
          <div class="after-media">${media}</div>
          <h3>${esc(m.title)}</h3>
          ${str(m.event) ? `<span class="mono">${esc(m.event)}</span>` : ""}
        </article>`;
    })
    .join("\n        ");
  return `<div class="after rv">
        ${head}
        <div class="after-grid">
        ${cards}
        </div>
      </div>`;
}

function renderGallery(n, s) {
  const items = list(s.items).filter((i) => safeUrl(i?.src));
  // Bilder zählen für die Lightbox-Beschriftung; Videos laufen dort nicht mit.
  const photos = items.filter((i) => !isVideoUrl(i.src));
  // Wie viele Bilder ohne Zutun zu sehen sind — auf allen Bildschirmbreiten
  // gleich, damit die Zahl im Knopf ("6 weitere Bilder") überall stimmt.
  const limit = Math.max(2, Math.min(12, Number.parseInt(s.mobileLimit, 10) || 6));
  const remaining = Math.max(0, items.length - limit);

  const cell = (g, i) => {
    const extra = i >= limit ? ' data-extra="true"' : "";
    if (isVideoUrl(g.src)) {
      const gf = fitAttrs(g);
      // Die Kachel zeigt zunächst nur das Vorschaubild; abgespielt wird erst,
      // wenn der Zeiger darauf liegt (auf dem Handy: sobald sie im Bild ist).
      // Darum kein autoplay und nur `metadata` vorladen — sonst zieht eine
      // Galerie voller Videos beim Seitenaufruf zig Megabyte.
      return `<figure class="gal-video${gf.cls}"${extra}>
          <video src="${href(g.src)}" muted loop playsinline preload="metadata"${
        g.poster ? ` poster="${href(cdnUrl(g.poster, 800))}"` : ""
      }${gf.style}${clipAttrs(g)} aria-label="${esc(g.alt || "")}"></video>
          <span class="gal-play" aria-hidden="true"></span>
          ${g.credit ? `<figcaption>${esc(g.credit)}</figcaption>` : ""}
        </figure>`;
    }
    const idx = photos.indexOf(g) + 1;
    return `<figure${extra}>
          <button type="button" class="gal-btn" aria-label="${esc(
            UI.openImage.replace("{n}", idx).replace("{total}", photos.length)
          )}">
            ${picture(g, { sizes: "(max-width:700px) 100vw, 33vw", widths: [480, 800] })}
            ${g.credit ? `<figcaption>${esc(g.credit)}</figcaption>` : ""}
          </button>
        </figure>`;
  };

  return `
  <section class="pad" id="gallery" aria-labelledby="gallery-h">
    <div class="wrap">${sectionHead(n, s, "gallery")}
      ${afterMovies(s)}
      <div class="gal rv" id="gal">
        ${items.map(cell).join("\n        ")}
      </div>
      ${
        remaining
          ? `<button class="gal-more btn" type="button" aria-controls="gal" aria-expanded="false"
                  data-more="${esc(UI.showMoreImages.replace("{n}", remaining))}"
                  data-less="${esc(UI.showLessImages)}">${esc(
                    UI.showMoreImages.replace("{n}", remaining)
                  )}</button>`
          : ""
      }
    </div>
  </section>`;
}

/** Preis huebsch ausgeben: "45" + "CHF" -> "CHF 45.—" */
function priceTag(price, currency) {
  const v = String(price ?? "").trim();
  if (!v) return "";
  return /[A-Za-z]/.test(v) ? v : `${currency} ${v}${/[.,]/.test(v) ? "" : ".—"}`;
}

/**
 * Bezahlmöglichkeiten: TWINT und Banküberweisung, dazu — sofern hinterlegt —
 * der QR-Code zum Abscannen. Alles rein statisch; es wird nichts eingezogen,
 * die Kundin überweist selbst und der Versand geht nach Zahlungseingang raus.
 */
function payMethods(s) {
  const twint = str(s.twint);
  const bank = s.bank || {};
  const hasBank = str(bank.iban);
  // Fehlen Nummer und IBAN noch, steht hier bewusst der Platzhalter statt
  // nichts — sonst faellt beim Abnehmen niemandem auf, dass die Angaben fehlen.
  const missing = !twint && !hasBank;
  const qr = safeUrl(s.qr?.src)
    ? `<figure class="pay-qr">
            ${picture(s.qr, { widths: [280, 560], sizes: "220px" })}
            <figcaption class="mono">${esc(str(s.qr.caption, UI.payQrCaption))}</figcaption>
          </figure>`
    : `<!-- TODO Kunde: QR-Code fehlt noch. Benötigt wird entweder der TWINT-QR
             (in der TWINT-App unter "Geld empfangen" → QR speichern) oder der
             Einzahlungsschein-QR der Bank (QR-Rechnung). Bild in der Verwaltung
             unter Shop → Bezahlung hochladen; es erscheint dann hier.
             Offene Frage: TWINT-QR, Bank-QR oder beide? -->
        <div class="pay-qr pay-qr-missing"><span class="mono">${esc(UI.payQrMissing)}</span></div>`;
  const details = missing
    ? `<li><b>TWINT</b><span>${esc(UI.payPending)}</span></li>
              <li><b>${esc(UI.payBank)}</b><span>${esc(UI.payPending)}</span></li>`
    : `${twint ? `<li><b>TWINT</b><span>${esc(twint)}</span></li>` : ""}
              ${hasBank ? `<li><b>${esc(str(bank.label, UI.payBank))}</b><span>${esc(bank.iban)}</span></li>` : ""}
              ${hasBank && str(bank.holder) ? `<li><b>${esc(UI.payHolder)}</b><span>${esc(bank.holder)}</span></li>` : ""}
              ${hasBank && str(bank.bank) ? `<li><b>${esc(UI.payBankName)}</b><span>${esc(bank.bank)}</span></li>` : ""}`;
  return `
      <div class="pay-methods rv">${
        missing
          ? `
        <!-- TODO Kunde: Zahlungsangaben fehlen noch. Benoetigt werden die
             TWINT-Nummer und/oder IBAN samt Empfaenger und Bank. Eintragen in
             der Verwaltung unter Shop → Bezahlung; sobald etwas hinterlegt ist,
             ersetzt es diesen Platzhalter und die Auswahl im Bestellformular. -->`
          : ""
      }
        <div class="pay-cols">
          <div>
            <span class="mono">${esc(UI.payTitle)}</span>
            <ul class="pay-list">
              ${details}
            </ul>
            <p class="pay-note">${esc(UI.payNote)}</p>
          </div>
          ${qr}
        </div>
      </div>`;
}

/**
 * Bestellformular. Der Shop verschickt Ware, deshalb sind Liefer- und
 * Kontaktangaben Pflicht — ohne sie kann nichts versendet werden. Die
 * Bestellung landet im selben Eingang wie die Booking-Anfragen (kind:"order").
 */
function orderForm(s, site, items, cur) {
  const endpoint = safeUrl(site.shopApi) || safeUrl(site.bookingApi);
  if (!endpoint || !items.length) return "";
  const options = items
    .filter((p) => p.status !== "soldout")
    .map((p) => {
      const price = priceTag(p.price, cur);
      return `<option value="${esc(p.name)}">${esc(
        [str(p.name), price].filter(Boolean).join(" — ")
      )}</option>`;
    })
    .join("\n              ");
  if (!options) return "";
  const pay = [
    str(s.twint) ? ["twint", "TWINT"] : null,
    str(s.bank?.iban) ? ["bank", str(s.bank?.label, UI.payBank)] : null,
  ].filter(Boolean);
  return `
      <form class="oform rv" id="order-form" data-endpoint="${esc(endpoint)}"
            data-sending="${esc(UI.sending)}" data-invalid="${esc(UI.formInvalid)}" novalidate>
        <div class="bform-head">
          <span class="mono">${esc(UI.orderTitle)}</span>
          <h3>${esc(UI.orderHeadline)}</h3>
          <p class="bform-required mono">${esc(UI.allRequired)}</p>
        </div>
        <div class="bform-grid">
          <label><span class="lbl">${esc(UI.oProduct)} <i aria-hidden="true">*</i></span>
            <select name="product" required>
              ${options}
            </select>
          </label>
          <label><span class="lbl">${esc(UI.oQuantity)} <i aria-hidden="true">*</i></span>
            <input name="quantity" type="number" required min="1" max="20" step="1" value="1" inputmode="numeric">
          </label>
          <label><span class="lbl">${esc(UI.fName)} <i aria-hidden="true">*</i></span>
            <input name="name" type="text" required maxlength="120" autocomplete="name">
          </label>
          <label><span class="lbl">${esc(UI.fEmail)} <i aria-hidden="true">*</i></span>
            <input name="email" type="email" required maxlength="160" autocomplete="email">
          </label>
          <label class="span-2"><span class="lbl">${esc(UI.oStreet)} <i aria-hidden="true">*</i></span>
            <input name="street" type="text" required maxlength="160" autocomplete="street-address">
          </label>
          <label><span class="lbl">${esc(UI.oZip)} <i aria-hidden="true">*</i></span>
            <input name="zip" type="text" required maxlength="12" autocomplete="postal-code">
          </label>
          <label><span class="lbl">${esc(UI.oCity)} <i aria-hidden="true">*</i></span>
            <input name="city" type="text" required maxlength="120" autocomplete="address-level2">
          </label>
          <label><span class="lbl">${esc(UI.oCountry)} <i aria-hidden="true">*</i></span>
            <input name="country" type="text" required maxlength="80" value="${esc(
              str(s.defaultCountry, "Schweiz")
            )}" autocomplete="country-name">
          </label>
          ${
            pay.length
              ? `<fieldset class="span-2 opay">
            <legend class="lbl">${esc(UI.oPayment)} <i aria-hidden="true">*</i></legend>
            ${pay
              .map(
                ([v, label], i) =>
                  `<label class="opay-opt"><input name="payment" type="radio" value="${esc(
                    v
                  )}" required${i === 0 ? " checked" : ""}><span>${esc(label)}</span></label>`
              )
              .join("\n            ")}
          </fieldset>`
              : ""
          }
          <label class="hp" aria-hidden="true" tabindex="-1"><span class="lbl">${esc(UI.fHoneypot)}</span>
            <input name="website" type="text" tabindex="-1" autocomplete="off">
          </label>
        </div>
        <div class="bform-foot">
          <button class="btn solid big" type="submit">${esc(UI.oSubmit)}<span class="cta-arr" aria-hidden="true">→</span></button>
          <span class="mono reply-note">${esc(UI.oReplyNote)}</span>
          <p class="bform-msg" role="status" aria-live="polite"
             data-success="${esc(UI.oSuccess)}" data-error="${esc(UI.oError)}"></p>
        </div>
      </form>`;
}

/**
 * Wie breit eine Ware-Kachel mindestens sein darf, je nachdem wie viel im Shop
 * steht. Je mehr Ware, desto kleiner die Kachel — damit auch ein voller Shop
 * ohne Wischen und ohne endloses Scrollen auf einmal zu sehen ist. Bei wenig
 * Ware bleiben die Kacheln gross, sonst sähen drei Artikel verloren aus.
 *
 * Die Zahl geht als `--tile` in die Seite; das Raster (`.shop-grid`) füllt
 * damit `auto-fill` und rechnet die Spalten selbst aus.
 */
function kachelbreite(anzahl) {
  if (anzahl <= 3) return 240;
  if (anzahl <= 6) return 196;
  if (anzahl <= 10) return 164;
  if (anzahl <= 16) return 136;
  return 116;
}

function renderShop(n, s, contactEmail, site) {
  const items = list(s.items).filter((p) => str(p?.name));
  const cur = str(s.currency, "CHF");
  const buy = str(s.buyLabel, UI.buy);
  const form = orderForm(s, site, items, cur);
  const hasOrderForm = !!form;
  const cards = items
    .map((p) => {
      const sold = p.status === "soldout";
      // Nur echte Adressen zaehlen als Bezahl-Link — Tippreste wie "asd"
      // fallen sonst als toter Kauf-Knopf auf die Website
      const link = /^https?:\/\//i.test(String(p.linkUrl || "")) ? safeUrl(p.linkUrl) : "";
      const price = priceTag(p.price, cur);
      const mail = contactEmail
        ? `mailto:${contactEmail}?subject=${encodeURIComponent(`${UI.orderSubject}: ${str(p.name)}`)}` +
          `&body=${encodeURIComponent(UI.orderMailBody.replace("{product}", [str(p.name), price].filter(Boolean).join(" — ")))}`
        : "";
      // Ohne eigenen Bezahl-Link fuehrt der Knopf ins Bestellformular weiter
      // unten und waehlt das Produkt dort schon aus. Gibt es kein Formular
      // (kein Endpunkt hinterlegt), bleibt die Bestellung per Mail.
      const cta = sold
        ? `<span class="mono">${esc(UI.soldOut)}</span>`
        : link
        ? `<a class="btn sm" href="${esc(link)}" target="_blank" rel="noopener">${esc(buy)} ↗</a>`
        : hasOrderForm
        ? `<a class="btn sm order-jump" href="#order-form" data-product="${esc(p.name)}">${esc(
            buy
          )}</a>`
        : mail
        ? `<a class="btn sm ghost" href="${esc(mail)}">${esc(UI.orderByMail)}</a>`
        : "";
      return `<article class="product rv${sold ? " soldout" : ""}">
          ${p.src ? `<div class="product-img">${picture(p, { sizes: "(max-width:700px) 46vw, 280px", widths: [480, 800] })}</div>` : ""}
          <div class="product-body">
            <h3>${esc(p.name)}</h3>
            ${str(p.note) ? `<p>${esc(p.note)}</p>` : ""}
            <div class="product-foot">
              ${str(p.price) ? `<span class="price">${esc(price)}</span>` : ""}
              ${cta}
            </div>
          </div>
        </article>`;
    })
    .join("\n        ");

  if (!items.length) {
    return `
  <section class="pad shop-sec" id="shop" aria-labelledby="shop-h">
    <div class="wrap">${sectionHead(n, s, "shop")}
      ${str(s.note) ? `<p class="shop-note rv">${inline(s.note)}</p>` : ""}
      <div class="empty-state rv"><span class="mono">Shop</span><p>${esc(
        str(s.emptyText, "Merch ist in Arbeit.")
      )}</p></div>
    </div>
  </section>`;
  }

  // Der ganze Shop ist auf einen Blick da — Bilder, Preise, Bezahlung und
  // Bestellung. Die Ware steht dafuer in kleineren Karten, damit mehr davon
  // gleichzeitig ins Bild passt.
  return `
  <section class="pad shop-sec" id="shop" aria-labelledby="shop-h">
    <div class="wrap">${sectionHead(n, s, "shop")}
      ${str(s.note) ? `<p class="shop-note rv">${inline(s.note)}</p>` : ""}
      <div class="shop-grid" style="--tile:${kachelbreite(items.length)}px">
      ${cards}
      </div>
${payMethods(s)}
${form}
    </div>
  </section>`;
}

/* Der technische Rider ("Preferred setup", CDJs, Mixer, Booth-Monitore) stand
   hier bis August 2026 eingeklappt unter dem Formular. Der Kunde wollte ihn
   ganz weg: die Geräteliste gehört ins Gespräch mit der Technik, nicht auf die
   Seite. Damit fallen auch die Rider-Felder in der Verwaltung weg — steht im
   Inhalt noch ein `rider`-Knoten, wird er schlicht nicht mehr gelesen. */

function renderBooking(n, s, site) {
  const f = s.form || {};
  const formEnabled = f.enabled !== false && !!safeUrl(site.bookingApi);
  // Anfragen ist der wichtigste Weg der Seite. Deshalb steht hier links die
  // Ansage und rechts gleich das Formular — ohne Umweg über einen Knopf.
  return `
  <section class="booking pad" id="booking" aria-labelledby="booking-h">
    <span class="section-mark" aria-hidden="true">${esc(str(s.title) + str(s.titleAccent))}</span>
    <div class="wrap">
      <div class="booking-grid">
      <div class="booking-lead rv">
        <span class="mono">${esc(str(s.navLabel, "Booking"))}</span>
        <h2 id="booking-h" class="booking-claim">${esc(str(s.claim, "Let's create"))} <i>${esc(
    str(s.claimAccent, "something.")
  )}</i></h2>
        ${str(s.lead) ? `<p class="lede">${inline(s.lead)}</p>` : ""}
        <span class="mono">${esc(str(s.availableKicker, "Available for"))}</span>
        <ul class="avail">
          ${list(s.available)
            .filter((a) => str(a))
            .map(
              (a, i) =>
                `<li><span class="mono">${String.fromCharCode(65 + i)}</span>${esc(a)}</li>`
            )
            .join("\n          ")}
        </ul>
        ${
          safeUrl(s.photo?.src)
            ? `<figure class="booking-photo rv">
          ${picture(s.photo, { sizes: "(max-width:900px) 92vw, 42vw", widths: [600, 1000] })}
          ${
            str(s.photo?.credit)
              ? `<figcaption class="mono">${esc(s.photo.credit)}</figcaption>`
              : ""
          }
        </figure>`
            : ""
        }
        ${
          safeUrl(s.presskitUrl)
            ? `<div class="btn-row">
          <a class="btn" href="${href(s.presskitUrl)}" download>${esc(
                str(s.presskitLabel, "Presskit (PDF)")
              )}</a>
        </div>`
            : ""
        }
        ${
          formEnabled
            ? ""
            : `<div class="btn-row">
          <a class="btn solid" href="${anchorHref("#contact")}">${esc(
                str(f.submitLabel, "Request a date")
              )}</a>
        </div>`
        }
      </div>
      ${
        formEnabled
          ? `
      <form class="bform rv" id="booking-form" data-endpoint="${href(
        site.bookingApi
      )}" data-sending="${esc(UI.sending)}" data-invalid="${esc(UI.formInvalid)}"
            data-captcha="${esc(UI.captchaWrong)}" novalidate>
        <div class="bform-head">
          <span class="mono">${esc(str(f.kicker, "Booking request"))}</span>
          <h3>${esc(str(f.title, "Tell me about your event"))}</h3>
        </div>
        <div class="bform-grid">
          <label><span class="lbl">${esc(UI.fName)} <i aria-hidden="true">*</i></span>
            <input name="name" type="text" required maxlength="120" autocomplete="name"
                   placeholder="${esc(UI.phName)}">
          </label>
          <label><span class="lbl">${esc(UI.fEmail)} <i aria-hidden="true">*</i></span>
            <input name="email" type="email" required maxlength="160" autocomplete="email"
                   placeholder="${esc(UI.phEmail)}">
          </label>
          <label><span class="lbl">${esc(UI.fPhone)} <i aria-hidden="true">*</i></span>
            <input name="phone" type="tel" required maxlength="40" autocomplete="tel"
                   placeholder="${esc(UI.phPhone)}">
          </label>
          <label><span class="lbl">${esc(UI.fEvent)} <i aria-hidden="true">*</i></span>
            <input name="event" type="text" required maxlength="160" placeholder="${esc(UI.phEvent)}">
          </label>
          <label><span class="lbl">${esc(UI.fCity)} <i aria-hidden="true">*</i></span>
            <input name="city" type="text" required maxlength="120" placeholder="${esc(UI.phCity)}">
          </label>
          <label><span class="lbl">${esc(UI.fDate)} <i aria-hidden="true">*</i></span>
            <input name="date" type="date" required>
          </label>
          <label><span class="lbl">${esc(UI.fSetLength)} <i aria-hidden="true">*</i></span>
            <input name="setLength" type="text" required maxlength="60" placeholder="${esc(UI.fSetLengthHint)}">
          </label>
          <label class="bform-captcha"><span class="lbl">${esc(UI.captcha)} <i aria-hidden="true">*</i></span>
            <span class="captcha-row">
              <span class="captcha-sum" aria-hidden="true"><b data-a></b> + <b data-b></b> =</span>
              <input name="captcha" type="text" required inputmode="numeric" maxlength="4"
                     autocomplete="off" aria-label="${esc(UI.captchaAria)}" placeholder="?">
            </span>
          </label>
          <label class="span-2"><span class="lbl">${esc(UI.fMessage)} <i aria-hidden="true">*</i></span>
            <textarea name="message" rows="3" required maxlength="4000"
                      placeholder="${esc(UI.phMessage)}"></textarea>
          </label>
          <label class="hp" aria-hidden="true" tabindex="-1"><span class="lbl">${esc(UI.fHoneypot)}</span>
            <input name="website" type="text" tabindex="-1" autocomplete="off">
          </label>
        </div>
        <div class="bform-cal" id="bform-cal"
             data-weekdays="${esc(UI.weekdays)}" data-hint="${esc(UI.pickDay)}"
             data-busy="${esc(UI.dayBusy)}" hidden></div>
        <div class="bform-foot">
          <button class="btn solid big wide" type="submit">${esc(
            str(f.submitLabel, "Send request")
          )}<span class="cta-arr" aria-hidden="true">→</span></button>
          <p class="bform-msg" role="status" aria-live="polite"
             data-success="${esc(str(f.successText, "Thanks — your request landed."))}"
             data-error="${esc(str(f.errorText, "Something went wrong. Please e-mail instead."))}"></p>
          <p class="bform-fine mono">${esc(UI.formFine)}</p>
        </div>
      </form>`
          : ""
      }
      </div>
    </div>
  </section>`;
}

/** Aus einer Profil-URL den Benutzernamen ziehen: …/samsparking/ → @samsparking */
function handleOf(url) {
  const clean = String(url || "").split(/[?#]/)[0].replace(/\/+$/, "");
  const last = clean.split("/").pop() || "";
  if (!last || /^https?:$/i.test(last) || last.includes(".")) return "";
  return last.startsWith("@") ? last : "@" + last;
}

/** Stilisiertes Kanal-Zeichen aus Label/URL — einfarbig, ohne Fremd-Dateien. */
function socialIcon(label, url) {
  const key = (String(label) + " " + String(url)).toLowerCase();
  const P = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  let body = "";
  if (key.includes("instagram"))
    body = `<rect x="3.5" y="3.5" width="17" height="17" rx="4.5" ${P}/><circle cx="12" cy="12" r="4" ${P}/><circle cx="17" cy="7" r="1.2" fill="currentColor"/>`;
  else if (key.includes("tiktok"))
    body = `<path d="M14 4v9.6a3.6 3.6 0 1 1-3-3.55" ${P}/><path d="M14 5.4c.7 1.9 2.3 3.2 4.4 3.4" ${P}/>`;
  else if (key.includes("youtube"))
    body = `<rect x="3" y="6" width="18" height="12" rx="3.5" ${P}/><path d="M10.5 9.5v5l4.5-2.5z" fill="currentColor"/>`;
  else if (key.includes("spotify"))
    body = `<circle cx="12" cy="12" r="8.5" ${P}/><path d="M8.5 10.2c2.6-.8 5-.6 7 .5M9 12.8c2-.6 3.9-.4 5.5.5M9.5 15.2c1.5-.4 2.9-.3 4 .3" ${P}/>`;
  else if (key.includes("soundcloud") || key.includes("mixcloud"))
    body = `<path d="M4 15v-3M6.5 15v-5M9 15V8M11.5 15V6.5M14 15V9" ${P}/><path d="M14 15h3.5a2.5 2.5 0 0 0 .4-4.97A4 4 0 0 0 14 9" ${P}/>`;
  else if (key.includes("facebook"))
    body = `<path d="M14.5 8H13c-.8 0-1.3.5-1.3 1.3V11h2.6l-.4 2.6h-2.2V20" ${P}/><rect x="3.5" y="3.5" width="17" height="17" rx="4.5" ${P}/>`;
  else body = `<path d="M7 17 17 7M9.5 7H17v7.5" ${P}/>`;
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

/** Kanäle mit Namen, aber noch ohne Adresse — die werden nicht verlinkt. */
const pendingSocials = (s) =>
  list(s?.socials).filter((x) => str(x?.label) && !safeUrl(x?.url));

function renderContact(n, s, bookingTarget) {
  const mail = str(s.email);
  const socials = list(s.socials).filter((x) => str(x?.label) && safeUrl(x?.url));
  const pending = pendingSocials(s);
  const meta = `
        <div class="contact-meta">
          ${
            str(s.phone)
              ? `<div><span class="mono">${esc(UI.phone)}</span><a href="tel:${esc(
                  s.phone.replace(/[^\d+]/g, "")
                )}">${esc(s.phone)}</a></div>`
              : ""
          }
          ${
            str(s.base)
              ? `<div><span class="mono">${esc(UI.base)}</span><span>${esc(s.base)}</span></div>`
              : ""
          }
        </div>`;
  return `
  <section class="pad contact accent-block" id="contact" aria-labelledby="contact-h">
    <span class="contact-mark" aria-hidden="true">${esc(str(s.title) + str(s.titleAccent))}</span>
    <div class="wrap">${sectionHead(n, s, "contact")}${
      pending.length
        ? `
      <!-- TODO Kunde: Fuer diese Kanaele fehlt noch die Adresse, sie werden
           deshalb weder hier noch im Fuss verlinkt: ${pending
             .map((x) => str(x.label))
             .join(", ")}.
           Eintragen in der Verwaltung unter Kontakt → Kanaele, jeweils die
           komplette Profil-Adresse (z. B. https://www.instagram.com/… bzw. das
           Spotify-Kuenstlerprofil ueber "Teilen → Link kopieren"). -->`
        : ""
    }
      <div class="contact-grid rv">
        <div class="contact-main">
          ${str(s.kicker) ? `<span class="mono">${esc(s.kicker)}</span>` : ""}
          ${
            mail
              ? `<a class="big-mail" href="mailto:${esc(mail)}">${esc(mail)}</a>
          <div class="mail-tools">
            <button class="copy-mail mono" type="button" data-mail="${esc(mail)}" data-done="${esc(
                  UI.copied
                )}">${esc(UI.copyMail)}</button>
            ${
              bookingTarget
                ? `<a class="btn ink" href="${esc(bookingTarget)}">${esc(UI.bookCta)}</a>`
                : ""
            }
          </div>`
              : ""
          }
          ${meta}
        </div>
        ${
          socials.length
            ? `<div class="contact-side">
          <span class="mono side-label">${esc(UI.follow)}</span>
          <div class="social-cards">
          ${socials
            .map((x) => {
              const handle = str(x.handle, handleOf(x.url));
              return `<a class="scard" href="${href(x.url)}" target="_blank" rel="noopener me">
            <span class="scard-ico" aria-hidden="true">${socialIcon(x.label, x.url)}</span>
            <span class="scard-arrow" aria-hidden="true">↗</span>
            <span class="scard-name">${esc(x.label)}</span>
            ${handle ? `<span class="mono">${esc(handle)}</span>` : ""}
          </a>`;
            })
            .join("\n          ")}
          </div>
        </div>`
            : ""
        }
      </div>
    </div>
  </section>`;
}

/* ------------------------------------------------------------ json-ld */

function structuredData(c, sections, page, pages) {
  const site = c.site;
  const base = site.domain.replace(/\/+$/, "");
  const contact = sections.contact || {};
  const sameAs = list(contact.socials)
    .map((s) => safeUrl(s.url))
    .filter(Boolean);

  const person = {
    "@type": "Person",
    "@id": `${base}/#artist`,
    name: site.artist,
    jobTitle: "DJ & Producer",
    url: `${base}/`,
    image: absolute(base, site.ogImage),
    description: site.description,
    knowsAbout: list(sections.sound?.genres)
      .map((g) => str(g?.name))
      .filter(Boolean),
    homeLocation: contact.base
      ? { "@type": "Place", name: contact.base }
      : undefined,
  };
  if (contact.email) person.email = `mailto:${contact.email}`;
  if (contact.phone) person.telephone = contact.phone.replace(/[^\d+]/g, "");
  if (sameAs.length) person.sameAs = sameAs;
  if (contact.base) {
    const [city, country] = String(contact.base).split(",").map((x) => x.trim());
    person.address = {
      "@type": "PostalAddress",
      addressLocality: city || contact.base,
      addressCountry: /schweiz|switzerland|suisse|ch/i.test(country || "") ? "CH" : country || "CH",
    };
  }
  if (contact.email || contact.phone) {
    person.contactPoint = {
      "@type": "ContactPoint",
      contactType: "booking",
      ...(contact.email ? { email: contact.email } : {}),
      ...(contact.phone ? { telephone: contact.phone.replace(/[^\d+]/g, "") } : {}),
      availableLanguage: languagesOf(c).map((l) => LANG_NAMES[l] || l),
    };
  }
  const genres = list(sections.sound?.genres)
    .map((g) => str(g?.name))
    .filter(Boolean);
  if (genres.length) person.genre = genres;

  const graph = [
    person,
    {
      "@type": "WebSite",
      "@id": `${base}/#website`,
      url: `${base}/`,
      name: `${site.artist} — Official Website`,
      inLanguage: languagesOf(c),
      publisher: { "@id": `${base}/#artist` },
      copyrightHolder: { "@id": `${base}/#artist` },
    },
    {
      "@type": "ImageObject",
      "@id": `${base}/#logo`,
      url: absolute(base, site.ogImage),
      caption: site.artist,
    },
  ];

  if (page) {
    const home = !page.slug;
    graph.push({
      "@type": home ? ["WebPage", "ProfilePage"] : "WebPage",
      "@id": `${base}${pagePath(page.slug)}#page`,
      url: `${base}${pagePath(page.slug)}`,
      name: home ? site.title : page.navLabel,
      description: home ? site.description : str(page.description, site.description),
      inLanguage: site.lang,
      isPartOf: { "@id": `${base}/#website` },
      about: { "@id": `${base}/#artist` },
      primaryImageOfPage: { "@id": `${base}/#logo` },
      breadcrumb: {
        "@type": "BreadcrumbList",
        itemListElement: home
          ? [{ "@type": "ListItem", position: 1, name: str(pages?.[0]?.navLabel, "Start"), item: `${base}/` }]
          : [
              { "@type": "ListItem", position: 1, name: str(pages?.[0]?.navLabel, "Start"), item: `${base}/` },
              { "@type": "ListItem", position: 2, name: page.navLabel, item: `${base}${pagePath(page.slug)}` },
            ],
      },
    });
  }

  // Galerie als Bilderliste — hilft der Google-Bildersuche
  if (!page || list(page.sections).includes("gallery")) {
    const images = list(sections.gallery?.items)
      .map((g) => ({ src: safeUrl(g?.src), alt: str(g?.alt) }))
      .filter((g) => g.src && !isVideoUrl(g.src));
    if (images.length) {
      graph.push({
        "@type": "ImageGallery",
        "@id": `${base}${page ? pagePath(page.slug) : "/"}#gallery`,
        name: str(sections.gallery?.navLabel, "Galerie"),
        isPartOf: { "@id": `${base}/#website` },
        image: images.map((g) => ({
          "@type": "ImageObject",
          contentUrl: absolute(base, g.src),
          caption: g.alt || site.artist,
          creditText: str(site.photoCredit),
        })),
      });
    }
  }

  // Produkte des Shops (nur mit Preis)
  if (!page || list(page.sections).includes("shop")) {
    const cur = str(sections.shop?.currency, "CHF");
    for (const p of list(sections.shop?.items)) {
      if (!str(p?.name) || !str(p?.price) || p.status === "soldout") continue;
      const amount = String(p.price).replace(/[^\d.]/g, "");
      if (!amount) continue;
      graph.push({
        "@type": "Product",
        name: str(p.name),
        ...(safeUrl(p.src) ? { image: absolute(base, p.src) } : {}),
        ...(str(p.note) ? { description: str(p.note) } : {}),
        brand: { "@type": "Brand", name: site.artist },
        offers: {
          "@type": "Offer",
          price: amount,
          priceCurrency: cur,
          availability: "https://schema.org/InStock",
          ...(safeUrl(p.linkUrl) ? { url: safeUrl(p.linkUrl) } : {}),
        },
      });
    }
  }

  // Termine nur auf der Seite auszeichnen, die sie auch anzeigt
  if (page && !list(page.sections).includes("shows")) return { "@context": "https://schema.org", "@graph": graph };

  const t = today();
  for (const sh of list(sections.shows?.items)) {
    const date = isoDate(sh.date);
    if (!str(sh.name) || !date || date < t) continue;
    graph.push({
      "@type": "MusicEvent",
      name: `${site.artist} @ ${sh.name}`,
      startDate: date,
      eventStatus:
        sh.status === "cancelled"
          ? "https://schema.org/EventCancelled"
          : "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      location: {
        "@type": "Place",
        name: str(sh.venue, sh.name),
        address: {
          "@type": "PostalAddress",
          addressLocality: str(sh.city),
          addressCountry: str(sh.country, "CH"),
        },
      },
      performer: { "@id": `${base}/#artist` },
      url: safeUrl(sh.ticketUrl) || `${base}${page ? pagePath(page.slug) : "/"}#shows`,
      ...(safeUrl(sh.ticketUrl)
        ? {
            offers: {
              "@type": "Offer",
              url: safeUrl(sh.ticketUrl),
              availability:
                sh.status === "soldout"
                  ? "https://schema.org/SoldOut"
                  : "https://schema.org/InStock",
            },
          }
        : {}),
    });
  }

  return { "@context": "https://schema.org", "@graph": graph };
}

/* ------------------------------------------------------------- dokument */

/* --------------------------------------------------------------- oberfläche
   Kurztexte der Oberfläche. Sie stehen im Inhalt (also übersetzbar); fehlt
   einer, greift der deutsche Vorgabewert. */
const UI_DEFAULTS = {
  skip: "Zum Inhalt springen",
  menu: "Menü",
  close: "Schliessen",
  scroll: "Scrollen ↓",
  imageViewer: "Bildansicht",
  prevImage: "Vorheriges Bild",
  nextImage: "Nächstes Bild",
  openImage: "Bild {n} von {total} gross öffnen",
  rights: "Alle Rechte vorbehalten",
  photography: "Fotografie",
  phone: "Telefon",
  base: "Standort",
  tickets: "Tickets",
  soldOut: "Ausverkauft",
  booked: "Gebucht",
  calShow: "Termin",
  language: "Sprache",
  buy: "Kaufen",
  orderByMail: "Per Mail bestellen",
  orderSubject: "Bestellung",
  bookDay: "Diesen Tag anfragen",
  pickDay: "Oder Wunschdatum direkt im Kalender antippen:",
  dayBusy: "Belegt",
  toTop: "Nach oben",
  cookieText: "Diese Website kommt ohne Tracking und Werbe-Cookies aus. Beim Abschicken einer Anfrage oder Bestellung werden nur die Angaben aus dem Formular gespeichert.",
  cookieOk: "Alles klar",
  replyNote: "Antwort meist innert 48 Stunden",
  copyMail: "E-Mail kopieren",
  copied: "Kopiert ✓",
  bookCta: "Booking anfragen",
  moreStory: "Ganze Story lesen",
  lessStory: "Weniger anzeigen",
  showMoreImages: "{n} weitere Bilder",
  showLessImages: "Weniger Bilder",
  afterMovies: "After Movies",
  afterMoviesEmpty: "Die Aftermovies der letzten Shows sind im Schnitt — sie erscheinen hier, sobald sie fertig sind.",
  allRequired: "Alle Felder sind Pflichtfelder.",
  payTitle: "Bezahlen",
  payBank: "Banküberweisung",
  payBankName: "Bank",
  payHolder: "Empfänger",
  payNote: "Nach dem Absenden kommt eine Bestätigung mit Betrag und Vermerk. Der Versand geht raus, sobald die Zahlung da ist.",
  payQrCaption: "QR-Code scannen und bezahlen",
  payQrMissing: "QR-Code folgt",
  payPending: "folgt",
  orderTitle: "Bestellung",
  orderHeadline: "Wohin darf es gehen?",
  oProduct: "Artikel",
  oQuantity: "Anzahl",
  oStreet: "Strasse und Nummer",
  oZip: "PLZ",
  oCity: "Ort",
  oCountry: "Land",
  oPayment: "Bezahlung",
  oSubmit: "Bestellung abschicken",
  oReplyNote: "Bestätigung mit Zahlungsangaben folgt per Mail",
  oSuccess: "Danke — deine Bestellung ist da. Die Zahlungsangaben kommen gleich per Mail.",
  oError: "Das hat nicht geklappt. Schreib mir bitte direkt eine Mail.",
  follow: "Kanäle",
  orderMailBody: "Hoi Sam\n\nIch bestelle: {product}\nLieferadresse:\n\nDanke!",
  notFoundTitle: "Nichts hier.",
  notFoundText: "Diese Seite gibt es nicht (mehr). Zurück zum Start — dort steht alles Aktuelle.",
  notFoundCta: "Zur Startseite",
  prevMonth: "Vorheriger Monat",
  nextMonth: "Nächster Monat",
  weekdays: "Mo,Di,Mi,Do,Fr,Sa,So",
  sending: "Wird gesendet …",
  formInvalid: "Bitte die markierten Felder prüfen.",
  fName: "Name",
  fEmail: "E-Mail",
  fPhone: "Telefon",
  fEvent: "Event / Club",
  fCity: "Ort",
  fDate: "Datum",
  fSetLength: "Set-Länge",
  fSetLengthHint: "z. B. 60 Min.",
  fMessage: "Nachricht",
  fHoneypot: "Bitte leer lassen",
  phName: "Max Muster",
  phEmail: "deine@email.ch",
  phPhone: "+41 79 123 45 67",
  phEvent: "Club, Festival, Firmenfest …",
  phCity: "St. Gallen",
  phMessage: "Deine Nachricht …",
  captcha: "Anti-Spam — bitte lösen",
  captchaAria: "Ergebnis der Rechenaufgabe",
  captchaWrong: "Die Rechnung stimmt noch nicht.",
  formFine:
    "* Pflichtfelder · Deine Angaben werden nur für die Bearbeitung deiner Anfrage verwendet.",
};

/* Die gerade gültigen Oberflächentexte — von renderPage je Sprache gesetzt. */
let UI = { ...UI_DEFAULTS };

/* ------------------------------------------------------------------- i18n */

/**
 * Mehrsprachigkeit: Deutsch ist der gepflegte Stand ("Master"), Englisch und
 * Französisch liegen als flache Übersetzungstabelle daneben —
 * i18n.en["sections.about.lede"] = "…".
 *
 * Vor dem Rendern wird der ganze Inhaltsbaum einmal in die Zielsprache
 * übersetzt (localize). Dadurch bleiben alle Bausteine unverändert; fehlt eine
 * Übersetzung, steht dort der deutsche Text — nie eine Lücke.
 */

/** Felder, die nie übersetzt werden (Technik, Adressen, Zahlen). */
const NO_TRANSLATE = new Set([
  "src", "poster", "url", "ticketUrl", "linkUrl", "embedUrl", "presskitUrl",
  "ogImage", "domain", "bookingApi", "themeColor", "accentColor", "lang",
  "slug", "date", "status", "email", "phone", "country", "createdAt",
  "updatedAt", "updatedBy", "schemaVersion", "type", "view",
  "value", "logoText", "artist", "languages", "nameSpaced", "nameMain",
  // Eigennamen: Clubs, Festivals, Geräte, Genre-Bezeichnungen
  "name", "venue", "inquiryId", "backgroundImage", "price", "currency", "twint",
  "fit", "focus", "mobileLimit",
]);

const looksTechnical = (v) =>
  /^(https?:|mailto:|tel:|#|\/)/i.test(v) ||
  /^#[0-9a-f]{3,8}$/i.test(v) ||
  /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Pfade, die technische Schlüssel enthalten (Abschnitts-Namen, keine Texte)
 * oder Eigennamen tragen.
 *
 * Kanäle gehören dazu: "Instagram", "Spotify" und "Mixcloud" heissen in jeder
 * Sprache gleich. Übersetzt man sie trotzdem, zeigt die Übersetzungstabelle
 * über die Position auf den Kanal — und sobald in der Verwaltung ein Kanal
 * gelöscht wird, rutscht der Name des gelöschten auf den nächsten Eintrag.
 * Genau so trug der Mixcloud-Link auf /de/ und /fr/ die Aufschrift "Instagram"
 * (dieselbe Falle wie "Luzern" auf "Sektor 11", siehe adoptTexts).
 */
const NO_TRANSLATE_PATH =
  /^layout\.|^pages\.\d+\.sections\.|^pages\.\d+\.hero$|^sections\.contact\.socials\./;

/** Alle übersetzbaren Textstellen als [pfad, text]. */
export function collectStrings(node, prefix = "", out = []) {
  if (prefix && NO_TRANSLATE_PATH.test(prefix)) return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectStrings(v, `${prefix}.${i}`, out));
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      // Unter ui.* stehen nur Oberflächentexte — dort gelten die technischen
      // Schlüsselnamen (phone, close, …) nicht als Sperre.
      if ((!prefix.startsWith("ui") && NO_TRANSLATE.has(k)) || k === "i18n" || k === "i18nHash") continue;
      collectStrings(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }
  if (typeof node === "string" && node.trim() && !looksTechnical(node)) {
    out.push([prefix, node]);
  }
  return out;
}

function setDeep(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return;
    cur = cur[keys[i]];
  }
  if (cur && typeof cur === "object") cur[keys[keys.length - 1]] = value;
}

/**
 * Übersetzungstabelle einer Sprache flach machen.
 *
 * Zwei Schreibweisen sind erlaubt und ergeben dasselbe:
 *   flach     i18n.en["sections.about.lede"] = "…"
 *   verschach i18n.en.sections.about.lede    = "…"
 *
 * Die Verwaltung schreibt die verschachtelte Form, weil Schlüssel in der
 * Realtime Database keine Punkte enthalten dürfen. Von Hand gepflegte
 * Dateien dürfen weiter Punkt-Pfade verwenden.
 */
export function flattenI18n(node, prefix = "", out = {}) {
  if (!node || typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flattenI18n(v, path, out);
    else if (typeof v === "string") out[path] = v;
  }
  return out;
}

/** Inhalt in eine Sprache übersetzen. Fehlende Stellen bleiben deutsch. */
export function localize(content, lang) {
  const master = String(content.site?.lang || "de");
  if (lang === master) return content;
  const table = flattenI18n((content.i18n && content.i18n[lang]) || {});
  const copy = JSON.parse(JSON.stringify(content));
  for (const [path, value] of Object.entries(table)) {
    // Dieselbe Sperre wie beim Einsammeln: was nie übersetzt werden durfte,
    // wird auch nicht eingesetzt. Ältere Stände in der Datenbank tragen solche
    // Einträge noch — sie dürfen die Kanäle nicht umbenennen.
    if (NO_TRANSLATE_PATH.test(path)) continue;
    if (typeof value === "string" && value.trim()) setDeep(copy, path, value);
  }
  copy.site.lang = lang;
  return copy;
}

/**
 * Welche Sprachen gebaut werden. Erste ist die Hauptsprache.
 * Eine Sprache ohne eigene Übersetzungstabelle wird übersprungen — sonst
 * entstünde ein kompletter Seitensatz, der nur die Hauptsprache wiederholt.
 */
function languagesOf(c) {
  const master = String(c.site?.lang || "de");
  const extra = list(c.site?.languages)
    .map((l) => String(l).toLowerCase())
    .filter((l) => /^[a-z]{2}$/.test(l) && l !== master)
    .filter((l) => Object.keys(flattenI18n((c.i18n && c.i18n[l]) || {})).length > 0);
  return [master, ...new Set(extra)];
}

/** Präfix einer Sprache: Hauptsprache ohne, andere mit /en, /fr */
const langPrefix = (lang, master) => (lang === master ? "" : `/${lang}`);

/** Dasselbe für Links auf der Seite selbst — inklusive Basis-Verzeichnis. */
const navPrefix = (lang, master) => BASE + langPrefix(lang, master);

const LANG_NAMES = { de: "Deutsch", en: "English", fr: "Français" };
const OG_LOCALE = { de: "de_CH", en: "en_US", fr: "fr_CH" };

/* ------------------------------------------------------------------ seiten */

/**
 * Seitenstruktur. Fehlt sie (alter Inhalt), wird aus dem bisherigen `layout`
 * eine einzelne Startseite gebaut — die Website bleibt damit eine One-Pager.
 */
function pagesOf(c) {
  const sections = c.sections || {};
  const known = (keys) => list(keys).filter((k) => sections[k] && sections[k].enabled !== false);

  const pages = list(c.pages)
    .filter((p) => p && p.enabled !== false)
    .map((p, i) => ({
      slug: i === 0 ? "" : slugify(p.slug),
      navLabel: str(p.navLabel, str(p.title, "Seite")),
      title: str(p.title, str(p.navLabel, "")),
      sections: known(p.sections),
      hero: str(p.hero, i === 0 ? "full" : "compact"),
      ticker: p.ticker !== undefined ? p.ticker !== false : i === 0,
      inNav: p.inNav !== false,
      seo: p.seo || {},
    }));

  if (pages.length) {
    // Doppelte Slugs entschärfen, sonst überschreiben sich die Dateien.
    const seen = new Set();
    pages.forEach((p, i) => {
      let sl = p.slug;
      while (sl !== "" && seen.has(sl)) sl += "-2";
      if (i > 0 && sl === "") sl = "seite-" + i;
      p.slug = sl;
      seen.add(sl);
    });
    return pages;
  }

  return [
    {
      slug: "",
      navLabel: "Start",
      title: "",
      sections: known(c.layout),
      hero: "full",
      ticker: true,
      inNav: true,
      seo: {},
    },
  ];
}

const slugify = (v) =>
  String(v || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 60);

/* Welche Seite und welche Sprache gerade gebaut werden — damit Sprungmarken
   wie #booking auch dann ankommen, wenn der Abschnitt inzwischen auf einer
   anderen Seite liegt, und damit Links in der Sprache bleiben. */
let CTX = { page: null, pages: [], prefix: "" };

/** Adresse einer Seite in der aktuellen Sprache: "/", "/shows/", "/en/shows/" */
const pagePath = (slug) => `${CTX.prefix}${slug ? `/${slug}/` : "/"}`;

/**
 * Verweis auf einen Abschnitt: auf derselben Seite ein Anker, sonst der Link
 * auf die Seite, die den Abschnitt zeigt. Findet sich der Abschnitt nirgends,
 * bleibt der Anker stehen (schadet nicht, springt nur nicht).
 */
function anchor(target) {
  const t = String(target || "").trim();
  if (!t.startsWith("#")) return rooted(t);
  const key = t.slice(1);
  const page = CTX.page;
  if (!page || list(page.sections).includes(key)) return t;
  const other = CTX.pages.find((p) => list(p.sections).includes(key));
  return other ? `${pagePath(other.slug)}${t}` : t;
}

const anchorHref = (v) => esc(anchor(v));

/**
 * Pfade in Inhalten sind relativ gedacht (img/hero.jpg). Auf Unterseiten
 * würden sie ins Leere zeigen, deshalb werden sie ab Wurzel geschrieben.
 */
function rooted(url) {
  const u = safeUrl(url);
  if (!u) return "";
  if (/^(https?:|mailto:|tel:|#)/i.test(u)) return u;
  if (u.startsWith("/")) return BASE + u;
  return BASE + "/" + u.replace(/^\.?\//, "");
}

/* --------------------------------------------------------------- dokument */

function renderPage(c, page, pages, lang, langs) {
  const master = langs[0];
  UI = { ...UI_DEFAULTS, ...(c.ui || {}) };
  const ui = UI;
  const site = c.site;
  const base = site.domain.replace(/\/+$/, "");
  const sections = c.sections || {};
  const isHome = !page.slug;
  const hasShows = list(sections.shows?.items).some((item) => str(item?.name));
  const order = list(page.sections).filter(
    (key) =>
      sections[key] &&
      sections[key].enabled !== false &&
      (key !== "shows" || hasShows)
  );
  const effectivePage = { ...page, sections: order };
  CTX = { page: effectivePage, pages, hideHead: null, prefix: navPrefix(lang, master) };
  const hasBooking = order.includes("booking");
  const hasBookingForm =
    hasBooking &&
    sections.booking?.form?.enabled !== false &&
    !!safeUrl(site.bookingApi);
  const bookingTarget = hasBooking ? (hasBookingForm ? "#booking-form" : "#booking") : "";

  const renderers = {
    about: renderAbout,
    sound: renderSound,
    experience: renderExperience,
    shows: renderShows,
    references: renderReferences,
    gallery: renderGallery,
    shop: (n, s) => renderShop(n, s, str(sections.contact?.email), site),
    booking: (n, s) => renderBooking(n, s, site),
    contact: (n, s) => renderContact(n, s, bookingTarget),
  };

  const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const firstKey = order[0];
  CTX.hideHead =
    page.hero === "compact" &&
    firstKey &&
    norm(str(sections[firstKey].navLabel, firstKey)) === norm(page.navLabel)
      ? firstKey
      : null;

  const body = order
    .map((key, i) => (renderers[key] ? renderers[key](i + 1, sections[key]) : ""))
    .join("\n");

  const navPages = pages.filter((p) => p.inNav);
  // Eine einzige Seite: das Menü springt direkt zu den Abschnitten.
  const nav =
    navPages.length > 1
      ? navPages
          .map(
            (p) =>
              `<li><a href="${esc(pagePath(p.slug))}"${
                p.slug === page.slug ? ' aria-current="page"' : ""
              }>${esc(p.navLabel)}</a></li>`
          )
          .join("\n          ")
      : order
          .map((key) => {
            const cls = key === "booking" ? ' class="nav-cta"' : key === "shop" ? ' class="nav-hot"' : "";
            return `<li${cls}><a href="#${esc(key)}">${esc(
              str(sections[key]?.navLabel, str(sections[key]?.title, key))
            )}</a></li>`;
          })
          .join("\n          ");

  // Auf einer Seite mit mehreren Abschnitten zusätzlich Sprungmarken anbieten
  // — nur im Mehrseiten-Betrieb; als Einseiter springt schon das Hauptmenü.
  const subNav =
    navPages.length > 1 && order.length > 1
      ? `
    <nav class="subnav" aria-label="Auf dieser Seite">
      <div class="wrap subnav-inner">
        ${order
          .map(
            (key) =>
              `<a href="#${esc(key)}">${esc(
                str(sections[key].navLabel, sections[key].title + sections[key].titleAccent)
              )}</a>`
          )
          .join("")}
      </div>
    </nav>`
      : "";

  // Die Kanäle stehen auf jeder Seite im Fuss, nicht nur im Kontakt-Abschnitt.
  const footSocials = list(sections.contact?.socials).filter(
    (x) => str(x?.label) && safeUrl(x?.url)
  );
  // Zusätzlich als reine Zeichen oben im Kopf — jeder Kanal hat sein eigenes
  // (socialIcon), Instagram sieht also anders aus als Mixcloud. In der
  // Verwaltung lässt sich das je Kanal abschalten.
  const headSocials = footSocials.filter((x) => x.inHeader !== false);
  const headSocialsBlock = headSocials.length
    ? `<div class="head-social">${headSocials
        .map(
          (x) =>
            `<a href="${href(x.url)}" target="_blank" rel="noopener me" aria-label="${esc(
              x.label
            )}" title="${esc(x.label)}">${socialIcon(x.label, x.url)}</a>`
        )
        .join("")}</div>`
    : "";

  const accent = color(site.accentColor, "#2e6bff");
  const ink = color(site.themeColor, "#05070e");
  const ogImage = absolute(base, cdnUrl(site.ogImage, 1200));
  const ticker = c.ticker || {};
  const tickerItems = list(ticker.items).filter((t) => str(t?.text) || str(t?.accent));

  const url = base + pagePath(page.slug);
  const title = str(
    page.seo?.title,
    isHome ? site.title : `${page.navLabel} — ${site.artist}`
  );
  const description = str(page.seo?.description, site.description);

  const tickerBlock =
    page.ticker && ticker.enabled !== false && tickerItems.length
      ? `
  <div class="ticker" aria-hidden="true">
    <div class="ticker-track">
      ${[0, 1]
        .map(() =>
          tickerItems
            .map(
              (t) =>
                `<span class="smash">${esc(t.text)}<i>${esc(t.accent)}</i></span><b>◆</b>`
            )
            .join("")
        )
        .join("")}
    </div>
  </div>`
      : "";

  const configuredHeroCta = str(c.hero?.ctaHref, "#booking");
  const heroCtaHref =
    configuredHeroCta === "#booking" &&
    sections.booking?.enabled !== false &&
    sections.booking?.form?.enabled !== false
      ? "#booking-form"
      : configuredHeroCta;

  const hero =
    page.hero === "none"
      ? ""
      : page.hero === "compact"
      ? `
  <section class="hero hero-compact" id="top">
    <div class="wrap">
      <p class="mono">${esc(str(c.hero?.kicker, site.artist))}</p>
      <h1>${esc(str(page.title, page.navLabel))}</h1>
      <div class="sparks" aria-hidden="true">${sparks(8)}</div>
    </div>
  </section>`
      : `
  <section class="hero" id="top">
    <div class="hero-bg">
      ${heroMedia(c.hero || {}, site)}
    </div>
    <div class="hero-inner">
      ${c.hero?.kicker ? `<p class="mono">${esc(c.hero.kicker)}</p>` : ""}
      <h1${
        c.hero?.nameSpaced ? ` aria-label="${esc(site.artist)}"` : ""
      }>${
        c.hero?.nameSpaced
          ? `<span class="sp">${esc(c.hero.nameSpaced)}</span> `
          : ""
      }${esc(c.hero?.nameMain || site.artist)}</h1>
      <div class="hero-sub">
        ${c.hero?.tagline ? `<span class="tag">${esc(c.hero.tagline)}</span>` : ""}
        ${c.hero?.meta ? `<span class="mono">${esc(c.hero.meta)}</span>` : ""}
        ${
          c.hero?.ctaLabel
            ? `<a class="hero-cta" href="${anchorHref(heroCtaHref)}">${esc(
                c.hero.ctaLabel
              )}<span class="cta-arr" aria-hidden="true">→</span></a>`
            : ""
        }
        ${
          sections.shop && sections.shop.enabled !== false && order.includes("shop")
            ? `<a class="hero-cta alt" href="#shop">${esc(str(sections.shop.navLabel, "Shop"))}</a>`
            : ""
        }
      </div>
      ${heroStats(c.hero)}
    </div>
    <div class="sparks" aria-hidden="true">${sparks()}</div>
    <a class="hero-scroll mono" href="#${esc(order[0] || "top")}" aria-hidden="true" tabindex="-1">${esc(ui.scroll)}</a>
  </section>`;

  const heroPreload = (() => {
    if (page.hero !== "full") return "";
    const m = c.hero?.media || {};
    const links = [];
    if (m.type === "video" && safeUrl(m.src)) {
      // Das Video selbst frueh anfordern — noch bevor der Parser beim
      // <video>-Element ankommt. Nur fuer die eigene, komprimierte Fassung.
      if (/^\/?media\//.test(String(m.src)))
        links.push(`  <link rel="preload" as="video" href="${esc(rooted(m.src))}" fetchpriority="high">`);
    }
    const first = m.type === "video" ? m.poster : m.src;
    if (safeUrl(first) && !isVideoUrl(first)) {
      if (CDN) {
        const set = [640, 1024, 1600]
          .map((w) => `${esc(cdnUrl(first, w))} ${w}w`)
          .join(", ");
        links.push(`  <link rel="preload" as="image" imagesrcset="${set}" imagesizes="100vw" fetchpriority="high">`);
      } else {
        links.push(`  <link rel="preload" as="image" href="${esc(rooted(first))}" fetchpriority="high">`);
      }
    }
    return links.length ? links.join("\n") + "\n" : "";
  })();

  // Termine als JSON für die Kalenderansicht (assets/site.js baut sie auf)
  const showsData =
    order.includes("shows")
      ? `
  <script type="application/json" id="shows-data">${jsonScript(
    list(sections.shows.items)
      .filter((i) => str(i?.name) && isoDate(i.date))
      .map((i) => ({
        date: isoDate(i.date),
        name: str(i.name),
        venue: str(i.venue),
        city: str(i.city),
        url: safeUrl(i.ticketUrl),
        status: str(i.status, "confirmed"),
      }))
  )}</script>`
      : "";

  return `<!DOCTYPE html>
<!--
  Diese Datei wird generiert — NICHT direkt bearbeiten.
  Inhalte pflegst du in der Verwaltung (oder in content/site.json),
  danach "node scripts/build.mjs" bzw. ein Netlify-Deploy.
-->
<html lang="${esc(site.lang || "en")}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">

  <!-- Primary SEO -->
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="keywords" content="${esc(list(site.keywords).join(", "))}">
  <link rel="canonical" href="${esc(url)}">
${langs
  .map(
    (l) =>
      `  <link rel="alternate" hreflang="${esc(l)}" href="${esc(
        base + langPrefix(l, master) + (page.slug ? `/${page.slug}/` : "/")
      )}">`
  )
  .join("\n")}
  <link rel="alternate" hreflang="x-default" href="${esc(
    base + (page.slug ? `/${page.slug}/` : "/")
  )}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
  <meta name="googlebot" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
  <meta name="author" content="${esc(site.artist)}">
  <meta name="publisher" content="${esc(site.artist)}">
  <meta name="creator" content="${esc(site.artist)}">
${geoMeta(sections.contact)}
  <!-- Open Graph / Social -->
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${esc(site.artist)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:title" content="${esc(isHome ? str(site.ogTitle, title) : title)}">
  <meta property="og:description" content="${esc(
    isHome ? str(site.ogDescription, description) : description
  )}">
  <meta property="og:image" content="${esc(ogImage)}">
  <meta property="og:image:alt" content="${esc(c.hero?.media?.alt || site.artist)}">
  <meta property="og:locale" content="${esc(OG_LOCALE[lang] || "de_CH")}">
${langs
  .filter((l) => l !== lang)
  .map((l) => `  <meta property="og:locale:alternate" content="${esc(OG_LOCALE[l] || l)}">`)
  .join("\n")}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(isHome ? str(site.ogTitle, title) : title)}">
  <meta name="twitter:description" content="${esc(
    isHome ? str(site.ogDescription, description) : description
  )}">
  <meta name="twitter:image" content="${esc(ogImage)}">
  <meta name="twitter:image:alt" content="${esc(c.hero?.media?.alt || site.artist)}">

  <!-- Structured data -->
  <script type="application/ld+json">
${jsonScript(structuredData(c, sections, page, pages))}
  </script>

  <meta name="theme-color" content="${esc(ink)}">
  <link rel="apple-touch-icon" href="${BASE}/img/icon-180.png">
  <link rel="icon" type="image/png" sizes="32x32" href="${BASE}/img/icon-32.png">
  <link rel="manifest" href="${BASE}/manifest.webmanifest">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='${encodeURIComponent(
    ink
  )}'/%3E%3Cpath d='M36 6 14 38h14l-4 20 26-34H34z' fill='${encodeURIComponent(
    accent
  )}'/%3E%3C/svg%3E">

  <link rel="preconnect" href="https://firebasestorage.googleapis.com" crossorigin>
  <link rel="preload" as="font" type="font/woff2" href="${BASE}/assets/fonts/archivo-latin.woff2" crossorigin>
  <link rel="preload" as="font" type="font/woff2" href="${BASE}/assets/fonts/plexmono-400-latin.woff2" crossorigin>
${heroPreload}
  <link rel="stylesheet" href="${BASE}/assets/site.css">
  <style>:root{--ink:${ink};--spark:${accent};}</style>
</head>
<body data-page="${esc(page.slug || "home")}">
${pageBackground(site)}
  <a class="skip" href="#${esc(order[0] || "top")}">${esc(ui.skip)}</a>

  <header>
    <div class="progress" id="progress" aria-hidden="true"></div>
    <a class="logo" href="${BASE}/">${esc(str(site.logoText, site.artist))}</a>
    <nav id="nav">
      <button class="nav-close" type="button" aria-label="${esc(ui.close)}">✕</button>
      <ul>
          ${nav}
      </ul>
      ${
        langs.length > 1
          ? `<div class="nav-langs">${langs
              .map(
                (l) =>
                  `<a href="${esc(
                    navPrefix(l, master) + (page.slug ? `/${page.slug}/` : "/")
                  )}" lang="${esc(l)}"${l === lang ? ' aria-current="true"' : ""}>${esc(l.toUpperCase())}</a>`
              )
              .join("")}</div>`
          : ""
      }
    </nav>
    ${headSocialsBlock}
    <button class="burger" id="burger" aria-label="${esc(ui.menu)}" aria-expanded="false" aria-controls="nav" data-open="${esc(ui.menu)}" data-close="${esc(ui.close)}">${esc(ui.menu)}</button>
  </header>
  <main id="main">
${hero}${tickerBlock}${subNav}
${body}
  </main>

  <div class="lb" id="lb" role="dialog" aria-modal="true" aria-label="${esc(ui.imageViewer)}" hidden>
    <button class="lb-close" id="lb-close" aria-label="${esc(ui.close)}">✕</button>
    <button class="lb-nav lb-prev" id="lb-prev" aria-label="${esc(ui.prevImage)}">‹</button>
    <figure class="lb-fig"><img id="lb-img" src="" alt=""><figcaption id="lb-cap" class="mono"></figcaption></figure>
    <button class="lb-nav lb-next" id="lb-next" aria-label="${esc(ui.nextImage)}">›</button>
  </div>

  <a class="totop" href="#top" aria-label="${esc(ui.toTop || "Nach oben")}">↑</a>
${
  hasBooking
    ? `  <div class="actbar" id="actbar" aria-hidden="true">
    <a class="btn solid" href="${esc(bookingTarget)}">${esc(ui.bookCta)}</a>
  </div>
`
    : ""
}

  <aside class="cookie" id="cookie" hidden aria-label="Cookies">
    <p>${esc(ui.cookieText)}</p>
    <button class="btn sm solid" id="cookie-ok" type="button">${esc(ui.cookieOk)}</button>
  </aside>

  <footer>${
    footSocials.length
      ? `
    <div class="wrap foot-social">
      <span class="mono">${esc(ui.follow)}</span>
      <ul>
        ${footSocials
          .map(
            (x) =>
              `<li><a href="${href(x.url)}" target="_blank" rel="noopener me" title="${esc(
                x.label
              )}"><span aria-hidden="true">${socialIcon(x.label, x.url)}</span><span>${esc(
                x.label
              )}</span></a></li>`
          )
          .join("\n        ")}
      </ul>
    </div>`
      : ""
  }
    <div class="wrap foot">
      ${
        langs.length > 1
          ? `<nav class="langs" aria-label="${esc(ui.language)}">
        <span class="mono">${esc(ui.language)}</span>
        ${langs
          .map(
            (l) =>
              `<a href="${esc(
                navPrefix(l, master) + (page.slug ? `/${page.slug}/` : "/")
              )}" lang="${esc(l)}"${l === lang ? ' aria-current="true"' : ""}>${esc(
                LANG_NAMES[l] || l.toUpperCase()
              )}</a>`
          )
          .join("")}
      </nav>`
          : ""
      }
      <span class="mono">© <span id="yr">${today().slice(0, 4)}</span> ${esc(
    site.artist
  )} — ${esc(ui.rights)}</span>
      <a class="mono" href="${esc(navPrefix(lang, master) + "/" + (LEGAL_SLUG[lang] || "legal") + "/")}">${esc(
    LEGAL_LABEL[lang] || LEGAL_LABEL.de
  )}</a>
      ${site.claim ? `<span class="claim">${esc(site.claim)}</span>` : ""}
      ${
        site.photoCredit
          ? `<span class="mono">${esc(ui.photography)} — ${esc(site.photoCredit)}</span>`
          : ""
      }
    </div>
  </footer>
${showsData}
  <script src="${BASE}/assets/site.js" defer></script>
</body>
</html>
`;
}

/* ------------------------------------------------------- rechtliches */

const LEGAL_LABEL = { de: "Impressum & Datenschutz", en: "Legal & privacy", fr: "Mentions légales" };
const LEGAL_SLUG = { de: "rechtliches", en: "legal", fr: "mentions-legales" };

const LEGAL_TEXT = {
  de: {
    title: "Impressum & Datenschutz",
    impressum: "Impressum",
    impressumBody: (artist, base, email) =>
      `<p>Verantwortlich für diese Website:</p><p><strong>${artist}</strong><br>${base}<br><a href="mailto:${email}">${email}</a></p>`,
    privacy: "Datenschutz",
    blocks: [
      ["Kurzfassung", "Diese Website kommt ohne Tracking, Werbe-Cookies und Analyse-Dienste aus. Personendaten fallen nur an, wenn du sie selbst über ein Formular schickst."],
      ["Hosting", "Die Website wird bei Netlify (Netlify Inc., USA) ausgeliefert. Beim Aufruf verarbeitet Netlify technisch notwendige Verbindungsdaten (z. B. IP-Adresse) in Server-Protokollen. Bilder werden über das Bild-CDN von Netlify verkleinert ausgeliefert."],
      ["Medien", "Bilder und Videos liegen bei Google Firebase (Google Ireland Ltd.). Beim Laden dieser Dateien wird deine IP-Adresse an Firebase übermittelt."],
      ["Booking-Anfragen und Bestellungen", "Schickst du eine Anfrage oder Bestellung ab, werden die Angaben aus dem Formular (Name, E-Mail, Nachricht, ggf. Datum und Ort) in einer Firebase-Datenbank gespeichert und ausschliesslich zur Bearbeitung deiner Anfrage verwendet. Sie werden nicht weitergegeben und auf Wunsch gelöscht."],
      ["Bezahlung", "Beim Kauf über einen Bezahl-Link (z. B. Stripe) oder per TWINT gelten die Datenschutzbestimmungen des jeweiligen Anbieters; diese Website selbst speichert keine Zahlungsdaten."],
      ["Lokaler Speicher", "Die Website merkt sich lediglich im Browser (localStorage), dass du den Hinweis unten bestätigt hast. Es werden keine Cookies zu Werbe- oder Analysezwecken gesetzt."],
      ["Deine Rechte", "Du hast das Recht auf Auskunft, Berichtigung und Löschung deiner Daten (DSG/DSGVO). Melde dich dafür per E-Mail."],
    ],
  },
  en: {
    title: "Legal notice & privacy",
    impressum: "Legal notice",
    impressumBody: (artist, base, email) =>
      `<p>Responsible for this website:</p><p><strong>${artist}</strong><br>${base}<br><a href="mailto:${email}">${email}</a></p>`,
    privacy: "Privacy",
    blocks: [
      ["In short", "This website uses no tracking, no advertising cookies and no analytics. Personal data is only processed when you submit it through a form yourself."],
      ["Hosting", "The site is served by Netlify (Netlify Inc., USA). When you visit, Netlify processes technically necessary connection data (e.g. IP address) in server logs. Images are resized and delivered via Netlify's image CDN."],
      ["Media", "Images and videos are stored with Google Firebase (Google Ireland Ltd.). Loading these files transmits your IP address to Firebase."],
      ["Booking requests and orders", "If you submit a request or an order, the form details (name, e-mail, message, date and place if given) are stored in a Firebase database and used solely to handle your request. They are not shared and will be deleted on request."],
      ["Payment", "Purchases via a payment link (e.g. Stripe) or TWINT are governed by the provider's privacy policy; this website itself stores no payment data."],
      ["Local storage", "The site only remembers in your browser (localStorage) that you confirmed the notice below. No advertising or analytics cookies are set."],
      ["Your rights", "You have the right to access, correct and delete your data (Swiss FADP / GDPR). Just send an e-mail."],
    ],
  },
  fr: {
    title: "Mentions légales & protection des données",
    impressum: "Mentions légales",
    impressumBody: (artist, base, email) =>
      `<p>Responsable de ce site :</p><p><strong>${artist}</strong><br>${base}<br><a href="mailto:${email}">${email}</a></p>`,
    privacy: "Protection des données",
    blocks: [
      ["En bref", "Ce site n'utilise ni traçage, ni cookies publicitaires, ni outils d'analyse. Des données personnelles ne sont traitées que si tu les envoies toi-même via un formulaire."],
      ["Hébergement", "Le site est servi par Netlify (Netlify Inc., USA). Lors de la visite, Netlify traite des données de connexion techniquement nécessaires (p. ex. adresse IP) dans ses journaux. Les images sont redimensionnées et livrées via le CDN d'images de Netlify."],
      ["Médias", "Les images et vidéos sont hébergées chez Google Firebase (Google Ireland Ltd.). Leur chargement transmet ton adresse IP à Firebase."],
      ["Demandes de booking et commandes", "Si tu envoies une demande ou une commande, les informations du formulaire (nom, e-mail, message, date et lieu le cas échéant) sont enregistrées dans une base Firebase et utilisées uniquement pour traiter ta demande. Elles ne sont pas transmises et seront supprimées sur demande."],
      ["Paiement", "Les achats via un lien de paiement (p. ex. Stripe) ou TWINT sont soumis aux règles de l'opérateur concerné ; ce site ne conserve aucune donnée de paiement."],
      ["Stockage local", "Le site retient uniquement dans ton navigateur (localStorage) que tu as confirmé l'avis en bas de page. Aucun cookie publicitaire ou d'analyse n'est déposé."],
      ["Tes droits", "Tu as le droit d'accéder à tes données, de les corriger et de les supprimer (LPD/RGPD). Il suffit d'envoyer un e-mail."],
    ],
  },
};

/** Impressum & Datenschutz — eine schlichte Seite je Sprache. */
function renderLegal(c, lang, langs) {
  const site = c.site;
  const master = langs[0];
  const t = LEGAL_TEXT[lang] || LEGAL_TEXT.de;
  const contact = c.sections?.contact || {};
  const email = esc(str(contact.email, "info@samsparking.ch"));
  const artist = esc(site.artist);
  const base = esc(str(contact.base, "St. Gallen, Schweiz"));
  const ink = color(site.themeColor, "#05070e");
  const accent = color(site.accentColor, "#2e6bff");
  const prefix = navPrefix(lang, master);
  return `<!DOCTYPE html>
<html lang="${esc(lang)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(t.title)} — ${artist}</title>
  <meta name="robots" content="noindex, follow">
  <link rel="stylesheet" href="${BASE}/assets/site.css">
  <style>:root{--ink:${ink};--spark:${accent};}
    .legal{max-width:720px;margin:0 auto;padding:clamp(90px,14vh,140px) 22px 80px;}
    .legal h1{font-size:clamp(1.6rem,5vw,2.6rem);margin-bottom:34px;}
    .legal h2{font-size:1.15rem;margin:38px 0 12px;}
    .legal h3{font-size:.95rem;margin:24px 0 6px;color:var(--bone);}
    .legal p{color:var(--bone-dim);margin-bottom:12px;}
    .legal a{color:var(--spark);}
    .legal .langs{border:0;padding:0;margin:22px 0 0;}
  </style>
</head>
<body>
  <main class="legal">
    <a class="mono" href="${esc(prefix || "/")}">← ${artist}</a>
    ${
      langs.length > 1
        ? `<nav class="langs" aria-label="${esc(LANG_NAMES[lang] || "Sprache")}">${langs
            .map(
              (l) =>
                `<a href="${esc(navPrefix(l, master) + "/" + (LEGAL_SLUG[l] || "legal") + "/")}" lang="${esc(
                  l
                )}"${l === lang ? ' aria-current="true"' : ""}>${esc(LANG_NAMES[l] || l)}</a>`
            )
            .join("")}</nav>`
        : ""
    }
    <h1>${esc(t.title)}</h1>
    <h2>${esc(t.impressum)}</h2>
    ${t.impressumBody(artist, base, email)}
    <h2>${esc(t.privacy)}</h2>
    ${t.blocks.map(([h, b]) => `<h3>${esc(h)}</h3><p>${esc(b)}</p>`).join("\n    ")}
  </main>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ main */

function renderSitemap(c, pages, langs) {
  const base = c.site.domain.replace(/\/+$/, "");
  const master = langs[0];
  // Bilder der Galerie mitschicken — sie kommen so in die Google-Bildersuche
  const galleryImages = list(c.sections?.gallery?.items)
    .map((g) => ({ src: safeUrl(g?.src), alt: str(g?.alt) }))
    .filter((g) => g.src && !isVideoUrl(g.src))
    .slice(0, 1000);
  const rows = [];
  for (const lang of langs) {
    for (const p of pages) {
      const path = langPrefix(lang, master) + (p.slug ? `/${p.slug}/` : "/");
      const alts = langs
        .map(
          (l) =>
            `      <xhtml:link rel="alternate" hreflang="${esc(l)}" href="${esc(
              base + langPrefix(l, master) + (p.slug ? `/${p.slug}/` : "/")
            )}"/>`
        )
        .join("\n");
      const images = list(p.sections).includes("gallery")
        ? galleryImages
            .map(
              (g) => `    <image:image>
      <image:loc>${esc(absolute(base, g.src))}</image:loc>${
                g.alt ? `\n      <image:title>${esc(g.alt)}</image:title>` : ""
              }
    </image:image>`
            )
            .join("\n")
        : "";
      rows.push(`  <url>
    <loc>${esc(base)}${esc(path)}</loc>
${alts}
    <lastmod>${today()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${!p.slug && lang === master ? "1.0" : "0.8"}</priority>${images ? "\n" + images : ""}
  </url>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${rows.join("\n")}
</urlset>
`;
}

/** Einfache 404-Seite im Look der Website. */
function render404(c, langs) {
  const site = c.site;
  const ink = color(site.themeColor, "#05070e");
  const accent = color(site.accentColor, "#2e6bff");
  const ui = { ...UI_DEFAULTS, ...(c.ui || {}) };
  return `<!DOCTYPE html>
<html lang="${esc(langs[0] || "de")}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>404 — ${esc(site.artist)}</title>
  <meta name="robots" content="noindex, follow">
  <link rel="stylesheet" href="${BASE}/assets/site.css">
  <style>:root{--ink:${ink};--spark:${accent};}
    .nf{min-height:100svh;display:flex;align-items:center;}
    .nf h1{font-size:clamp(3rem,14vw,9rem);font-variation-settings:'wdth' 122,'wght' 850;}
    .nf p{color:var(--bone-dim);margin:18px 0 30px;max-width:46ch;}
  </style>
</head>
<body data-page="404">
${pageBackground(site)}
  <main class="nf">
    <div class="wrap">
      <span class="mono">404</span>
      <h1>${esc(str(ui.notFoundTitle, "Nichts hier."))}</h1>
      <p>${esc(str(ui.notFoundText, "Diese Seite gibt es nicht (mehr). Zurück zum Start — dort steht alles Aktuelle."))}</p>
      <a class="btn" href="${BASE}/">${esc(str(ui.notFoundCta, "Zur Startseite"))}</a>
    </div>
  </main>
</body>
</html>
`;
}

function renderRobots(c) {
  const base = c.site.domain.replace(/\/+$/, "");
  return `User-agent: *
Allow: /

Sitemap: ${base}/sitemap.xml
`;
}

async function main() {
  const content = await loadContent();
  BILDMASSE = await ladeBildmasse();
  if (!content.site || !content.site.domain) {
    throw new Error("content: site.domain fehlt");
  }

  // Hero-Video: die Verwaltung liefert Originale in voller Bitrate (das
  // aktuelle: 15+ Mbit/s — auf Mobilfunk kommt der Puffer nie hinterher).
  // Die GitHub Action legt eine komprimierte Fassung unter media/ ab samt
  // Quelle-Marker; passt der Marker zur aktuellen Quelle, nimmt der Build
  // die schlanke Fassung. Laedt Sam ein neues Video hoch, greift wieder das
  // Original, bis die Action nachgezogen hat.
  try {
    const hv = content.hero?.media;
    if (hv?.type === "video" && /^https?:/i.test(String(hv.src || ""))) {
      const markerFile = resolve(ROOT, "media/hero-video.source");
      const localFile = resolve(ROOT, "media/hero-video.mp4");
      if (existsSync(markerFile) && existsSync(localFile)) {
        const known = (await readFile(markerFile, "utf8")).trim();
        if (known === String(hv.src).trim()) {
          hv.src = "media/hero-video.mp4";
          console.log("[build] Hero-Video: komprimierte lokale Fassung eingesetzt");
        }
      }
    }
  } catch (e) {
    console.warn("[build] Video-Optimierung uebersprungen:", e.message);
  }
  await mkdir(resolve(ROOT, "content"), { recursive: true });

  const langs = languagesOf(content);
  const master = langs[0];
  const pages = pagesOf(content);
  const written = [];

  for (const lang of langs) {
    const localized = localize(content, lang);
    const localizedPages = pagesOf(localized);
    for (const page of localizedPages) {
      const dir = [lang === master ? "" : lang, page.slug].filter(Boolean).join("/");
      const rel = dir ? `${dir}/index.html` : "index.html";
      const file = resolve(ROOT, rel);
      await mkdir(dirname(file), { recursive: true });
      const html = renderPage(localized, page, localizedPages, lang, langs);
      await writeFile(file, html);
      written.push(rel);
      console.log(
        `[build] ${rel.padEnd(30)} ${(html.length / 1024).toFixed(1).padStart(5)} kB  ` +
          `(${page.sections.join(", ") || "keine Abschnitte"})`
      );
    }
  }

  // Impressum & Datenschutz je Sprache
  for (const lang of langs) {
    const rel = (langPrefix(lang, master) + "/" + (LEGAL_SLUG[lang] || "legal") + "/index.html").replace(/^\//, "");
    const file = resolve(ROOT, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, renderLegal(content, lang, langs));
    written.push(rel);
  }
  console.log("[build] Rechtliches je Sprache");

  await writeFile(resolve(ROOT, "sitemap.xml"), renderSitemap(content, pages, langs));
  await writeFile(resolve(ROOT, "robots.txt"), renderRobots(content));
  await writeFile(resolve(ROOT, "404.html"), render404(content, langs));
  console.log("[build] sitemap.xml, robots.txt, 404.html");

  // Verzeichnisse aufräumen, die zu keiner Seite mehr gehören
  const wanted = new Set(written.map((r) => r.split("/")[0]).filter((d) => d !== "index.html"));
  langs.slice(1).forEach((l) => wanted.add(l));
  for (const entry of await readdir(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || KEEP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    if (wanted.has(entry.name)) continue;
    if (existsSync(resolve(ROOT, entry.name, "index.html"))) {
      await rm(resolve(ROOT, entry.name), { recursive: true, force: true });
      console.log(`[build] entfernt: ${entry.name}/ (keine Seite mehr)`);
    }
  }

  // Dasselbe innerhalb der Sprachverzeichnisse (en/, fr/, …)
  // Behalten wird, was dieser Lauf wirklich geschrieben hat
  const writtenDirs = new Set(
    written.map((r) => r.split("/").slice(0, -1).join("/")).filter(Boolean)
  );
  for (const lang of langs.slice(1)) {
    const dir = resolve(ROOT, lang);
    if (!existsSync(dir)) continue;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (writtenDirs.has(`${lang}/${entry.name}`)) continue;
      if (existsSync(resolve(dir, entry.name, "index.html"))) {
        await rm(resolve(dir, entry.name), { recursive: true, force: true });
        console.log(`[build] entfernt: ${lang}/${entry.name}/ (keine Seite mehr)`);
      }
    }
  }

  const shows = list(content.sections?.shows?.items).length;
  const gal = list(content.sections?.gallery?.items).length;
  const missing = langs
    .slice(1)
    .map((l) => {
      const have = Object.keys(flattenI18n((content.i18n && content.i18n[l]) || {})).length;
      const total = collectStrings(content).length;
      return `${l}: ${have}/${total}`;
    })
    .join(", ");
  console.log(
    `[build] fertig — ${langs.length} Sprache(n) (${langs.join(", ")}), ` +
      `${pages.length} Seite(n) je Sprache, ${shows} Show(s), ${gal} Galeriebild(er)`
  );
  if (missing) console.log(`[build] Übersetzungen: ${missing}`);
}

// Nur bauen, wenn die Datei direkt aufgerufen wurde — beim Importieren aus
// einem Test soll nichts geschrieben werden.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[build] FEHLER:", err.message);
    process.exit(1);
  });
}
