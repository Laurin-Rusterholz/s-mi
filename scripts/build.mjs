#!/usr/bin/env node
/**
 * Sam Sparkling — Website-Generator
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
function adoptTexts(live, template) {
  for (const [path, text] of collectStrings(template)) {
    const keys = path.split(".");
    let cur = live;
    for (let i = 0; i < keys.length - 1 && cur != null; i++) cur = cur[keys[i]];
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
        <span class="num">${num(n)}</span>
        <h2 id="${esc(key)}-h">${esc(s.title)}<i>${esc(s.titleAccent)}</i></h2>
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

function picture(media, { className = "", eager = false, sizes = "", widths = [480, 800, 1200] } = {}) {
  const raw = String(media?.src || "").trim();
  if (!raw || !safeUrl(raw)) return "";
  const srcset = CDN
    ? ` srcset="${widths.map((w) => `${esc(cdnUrl(raw, w))} ${w}w`).join(", ")}"`
    : "";
  const attrs = [
    `src="${esc(cdnUrl(raw, widths[widths.length - 1]))}"`,
    `alt="${esc(media?.alt || "")}"`,
    eager ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"',
    sizes ? `sizes="${esc(sizes)}"` : "",
    className ? `class="${esc(className)}"` : "",
  ].filter(Boolean);
  return `<img ${attrs.join(" ")}${srcset}>`;
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
 * Sparkling. Position, Grösse, Tempo und Drift jedes Funkens sind fest
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
function heroMedia(hero, site) {
  const m = hero.media || {};
  if (m.type === "video" && safeUrl(m.src)) {
    const posterSrc = safeUrl(m.poster) || safeUrl(site?.ogImage) || safeUrl(site?.backgroundImage);
    const poster = posterSrc ? esc(cdnUrl(posterSrc, 1600)) : "";
    return `<video class="hero-video" autoplay muted loop playsinline preload="auto"${
      poster ? ` poster="${poster}"` : ""
    } aria-hidden="true" tabindex="-1"><source src="${href(m.src)}"></video>`;
  }
  return picture(m, { eager: true, sizes: "100vw" });
}

function renderAbout(n, s) {
  const facts = list(s.facts).filter((f) => str(f?.value));
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
          ${list(s.paragraphs)
            .filter((p) => str(p))
            .map((p) => `<p>${inline(p)}</p>`)
            .join("\n          ")}
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
          : `<p class="live-note rv">${inline(
              str(s.emptyText, "No dates announced right now.")
            )}</p>`
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
            return `<li><a href="${esc(url)}"${ext}><span class="venue-idx">${num(
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

function renderGallery(n, s) {
  const items = list(s.items).filter((i) => safeUrl(i?.src));
  // Bilder zählen für die Lightbox-Beschriftung; Videos laufen dort nicht mit.
  const photos = items.filter((i) => !isVideoUrl(i.src));

  const cell = (g, i) => {
    if (isVideoUrl(g.src)) {
      return `<figure class="gal-video">
          <video src="${href(g.src)}" muted loop playsinline autoplay preload="metadata"${
        g.poster ? ` poster="${href(g.poster)}"` : ""
      } aria-label="${esc(g.alt || "")}"></video>
          ${g.credit ? `<figcaption>${esc(g.credit)}</figcaption>` : ""}
        </figure>`;
    }
    const idx = photos.indexOf(g) + 1;
    return `<figure>
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
      <div class="gal rv" id="gal">
        ${items.map(cell).join("\n        ")}
      </div>
    </div>
  </section>`;
}

/** Preis huebsch ausgeben: "45" + "CHF" -> "CHF 45.—" */
function priceTag(price, currency) {
  const v = String(price ?? "").trim();
  if (!v) return "";
  return /[A-Za-z]/.test(v) ? v : `${currency} ${v}${/[.,]/.test(v) ? "" : ".—"}`;
}

function renderShop(n, s, contactEmail) {
  const items = list(s.items).filter((p) => str(p?.name));
  const cur = str(s.currency, "CHF");
  const buy = str(s.buyLabel, UI.buy);
  const twint = str(s.twint);
  const cards = items
    .map((p) => {
      const sold = p.status === "soldout";
      // Nur echte Adressen zaehlen als Bezahl-Link — Tippreste wie "asd"
      // fallen sonst als toter Kauf-Knopf auf die Website
      const link = /^https?:\/\//i.test(String(p.linkUrl || "")) ? safeUrl(p.linkUrl) : "";
      const price = priceTag(p.price, cur);
      const order = contactEmail
        ? `mailto:${contactEmail}?subject=${encodeURIComponent(`${UI.orderSubject}: ${str(p.name)}`)}` +
          `&body=${encodeURIComponent(UI.orderMailBody.replace("{product}", [str(p.name), price].filter(Boolean).join(" — ")))}`
        : "";
      // TWINT-Zahlung: aufklappbares Feld mit Nummer, Vermerk und Bestaetigung
      const twintPanel =
        twint && !link
          ? `<details class="pay">
            <summary class="btn sm">${esc(buy)} · TWINT</summary>
            <div class="pay-panel">
              <p class="mono">${esc(UI.twintSend)}</p>
              <strong class="pay-nr">${esc(twint)}</strong>
              <p>${esc(UI.twintRef)}: <b>${esc(p.name)}</b>${price ? ` · ${esc(price)}` : ""}</p>
              <p class="pay-note">${esc(UI.twintNote)}</p>
              ${order ? `<a class="btn sm ghost" href="${esc(order)}">${esc(UI.twintConfirm)}</a>` : ""}
            </div>
          </details>`
          : "";
      const cta = sold
        ? `<span class="mono">${esc(UI.soldOut)}</span>`
        : link
        ? `<a class="btn sm" href="${esc(link)}" target="_blank" rel="noopener">${esc(buy)} ↗</a>`
        : twintPanel
        ? ""
        : order
        ? `<a class="btn sm ghost" href="${esc(order)}">${esc(UI.orderByMail)}</a>`
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
            ${sold ? "" : twintPanel}
          </div>
        </article>`;
    })
    .join("\n        ");

  return `
  <section class="pad shop-sec" id="shop" aria-labelledby="shop-h">
    <div class="wrap">${sectionHead(n, s, "shop")}
      ${str(s.note) ? `<p class="shop-note rv">${inline(s.note)}</p>` : ""}
      ${
        items.length
          ? `<div class="shop-grid">
        ${cards}
      </div>`
          : `<p class="empty-note rv">${esc(str(s.emptyText, "Merch ist in Arbeit."))}</p>`
      }
    </div>
  </section>`;
}

function renderBooking(n, s, site) {
  const f = s.form || {};
  const formEnabled = f.enabled !== false && !!safeUrl(site.bookingApi);
  return `
  <section class="booking pad" id="booking" aria-labelledby="booking-h">
    <div class="wrap">${sectionHead(n, s, "booking")}
      <div class="booking-grid">
        <div class="rv">
          <span class="mono">${esc(str(s.availableKicker, "Available for"))}</span>
          <ul class="avail">
            ${list(s.available)
              .filter((a) => str(a))
              .map(
                (a, i) =>
                  `<li><span class="mono">${String.fromCharCode(65 + i)}</span>${esc(a)}</li>`
              )
              .join("\n            ")}
          </ul>
          <div class="btn-row">
            <a class="btn solid" href="${
              formEnabled ? "#booking-form" : anchorHref("#contact")
            }">${esc(
    str(f.submitLabel, "Request a date")
  )}</a>
            ${
              safeUrl(s.presskitUrl)
                ? `<a class="btn" href="${href(s.presskitUrl)}" download>${esc(
                    str(s.presskitLabel, "Presskit (PDF)")
                  )}</a>`
                : ""
            }
          </div>
        </div>
        <div class="rider rv">
          <span class="mono">${esc(str(s.rider?.kicker, "Preferred Setup"))}</span>
          ${list(s.rider?.groups)
            .map(
              (g) => `<h3>${esc(g.title)}</h3>
          <ul>
            ${list(g.items)
              .filter((i) => str(i?.name))
              .map((i) => `<li><span>${esc(i.name)}</span><span>${esc(i.meta)}</span></li>`)
              .join("\n            ")}
          </ul>`
            )
            .join("\n          ")}
          ${str(s.rider?.note) ? `<p class="note">${inline(s.rider.note)}</p>` : ""}
        </div>
      </div>
      ${
        formEnabled
          ? `
      <form class="bform rv" id="booking-form" data-endpoint="${href(
        site.bookingApi
      )}" data-sending="${esc(UI.sending)}" data-invalid="${esc(UI.formInvalid)}" novalidate>
        <div class="bform-head">
          <span class="mono">${esc(str(f.kicker, "Booking request"))}</span>
          <h3>${esc(str(f.title, "Tell me about your event"))}</h3>
        </div>
        <div class="bform-grid">
          <label>${esc(UI.fName)} <span aria-hidden="true">*</span>
            <input name="name" type="text" required maxlength="120" autocomplete="name">
          </label>
          <label>${esc(UI.fEmail)} <span aria-hidden="true">*</span>
            <input name="email" type="email" required maxlength="160" autocomplete="email">
          </label>
          <label>${esc(UI.fEvent)}
            <input name="event" type="text" maxlength="160">
          </label>
          <label>${esc(UI.fCity)}
            <input name="city" type="text" maxlength="120">
          </label>
          <label>${esc(UI.fDate)}
            <input name="date" type="date">
          </label>
          <label>${esc(UI.fSetLength)}
            <input name="setLength" type="text" maxlength="60" placeholder="${esc(UI.fSetLengthHint)}">
          </label>
          <label class="span-2">${esc(UI.fMessage)}
            <textarea name="message" rows="4" maxlength="4000"></textarea>
          </label>
          <label class="hp" aria-hidden="true" tabindex="-1">${esc(UI.fHoneypot)}
            <input name="website" type="text" tabindex="-1" autocomplete="off">
          </label>
          <div class="bform-cal span-2" id="bform-cal"
               data-weekdays="${esc(UI.weekdays)}" data-hint="${esc(UI.pickDay)}"
               data-busy="${esc(UI.dayBusy)}" hidden></div>
        </div>
        <div class="bform-foot">
          <button class="btn solid" type="submit">${esc(str(f.submitLabel, "Send request"))}</button>
          <p class="bform-msg" role="status" aria-live="polite"
             data-success="${esc(str(f.successText, "Thanks — your request landed."))}"
             data-error="${esc(str(f.errorText, "Something went wrong. Please e-mail instead."))}"></p>
        </div>
      </form>`
          : ""
      }
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

function renderContact(n, s) {
  const mail = str(s.email);
  const parts = mail.split("@");
  const socials = list(s.socials).filter((x) => str(x?.label) && safeUrl(x?.url));
  return `
  <section class="pad contact accent-block" id="contact" aria-labelledby="contact-h">
    <div class="wrap">${sectionHead(n, s, "contact")}
      <div class="rv">
        ${str(s.kicker) ? `<span class="mono">${esc(s.kicker)}</span>` : ""}
        ${
          mail
            ? `<a class="big-mail" href="mailto:${esc(mail)}">${esc(mail)}</a>`
            : ""
        }
        ${
          socials.length
            ? `<div class="social-cards">
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
        </div>`
            : ""
        }
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
        </div>
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
  twintSend: "Per TWINT bezahlen an",
  twintRef: "Vermerk",
  twintNote: "Nach der Zahlung kurz per Mail bestätigen und die Lieferadresse angeben — dann geht dein Teil in den Versand.",
  twintConfirm: "Bestellung per Mail bestätigen",
  orderMailBody: "Hoi Sam\n\nIch bestelle: {product}\nLieferadresse:\n\nDanke!",
  notFoundTitle: "Nichts hier.",
  notFoundText: "Diese Seite gibt es nicht (mehr). Zurück zum Start — dort steht alles Aktuelle.",
  notFoundCta: "Zur Startseite",
  prevMonth: "Vorheriger Monat",
  nextMonth: "Nächster Monat",
  weekdays: "Mo,Di,Mi,Do,Fr,Sa,So",
  sending: "Wird gesendet …",
  formInvalid: "Bitte die markierten Felder prüfen.",
  fName: "Dein Name",
  fEmail: "E-Mail",
  fEvent: "Event / Club",
  fCity: "Ort",
  fDate: "Datum",
  fSetLength: "Set-Länge",
  fSetLengthHint: "z. B. 60 Min.",
  fMessage: "Nachricht",
  fHoneypot: "Bitte leer lassen",
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
]);

const looksTechnical = (v) =>
  /^(https?:|mailto:|tel:|#|\/)/i.test(v) ||
  /^#[0-9a-f]{3,8}$/i.test(v) ||
  /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Pfade, die technische Schlüssel enthalten (Abschnitts-Namen, keine Texte). */
const NO_TRANSLATE_PATH = /^layout\.|^pages\.\d+\.sections\.|^pages\.\d+\.hero$/;

/** Alle übersetzbaren Textstellen als [pfad, text]. */
export function collectStrings(node, prefix = "", out = []) {
  if (prefix && NO_TRANSLATE_PATH.test(prefix)) return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectStrings(v, `${prefix}.${i}`, out));
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (NO_TRANSLATE.has(k) || k === "i18n" || k === "i18nHash") continue;
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
function localize(content, lang) {
  const master = String(content.site?.lang || "de");
  if (lang === master) return content;
  const table = flattenI18n((content.i18n && content.i18n[lang]) || {});
  const copy = JSON.parse(JSON.stringify(content));
  for (const [path, value] of Object.entries(table)) {
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
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(u)) return u;
  return "/" + u.replace(/^\.?\//, "");
}

/* --------------------------------------------------------------- dokument */

function renderPage(c, page, pages, lang, langs) {
  const master = langs[0];
  UI = { ...UI_DEFAULTS, ...(c.ui || {}) };
  const ui = UI;
  CTX = { page, pages, hideHead: null, prefix: langPrefix(lang, master) };
  const site = c.site;
  const base = site.domain.replace(/\/+$/, "");
  const sections = c.sections || {};
  const order = page.sections;
  const isHome = !page.slug;

  const renderers = {
    about: renderAbout,
    sound: renderSound,
    shows: renderShows,
    references: renderReferences,
    gallery: renderGallery,
    shop: (n, s) => renderShop(n, s, str(sections.contact?.email)),
    booking: (n, s) => renderBooking(n, s, site),
    contact: renderContact,
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
          .map(
            (key) =>
              `<li><a href="#${esc(key)}">${esc(
                str(sections[key]?.navLabel, str(sections[key]?.title, key))
              )}</a></li>`
          )
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

  const accent = color(site.accentColor, "#2e6bff");
  const ink = color(site.themeColor, "#05070e");
  const ogImage = absolute(base, rooted(site.ogImage));
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
      <h1>${
        c.hero?.nameSpaced ? `<span class="sp">${esc(c.hero.nameSpaced)}</span>` : ""
      }${esc(c.hero?.nameMain || site.artist)}</h1>
      <div class="hero-sub">
        ${c.hero?.tagline ? `<span class="tag">${esc(c.hero.tagline)}</span>` : ""}
        ${c.hero?.meta ? `<span class="mono">${esc(c.hero.meta)}</span>` : ""}
        ${
          c.hero?.ctaLabel
            ? `<a class="hero-cta" href="${anchorHref(str(c.hero.ctaHref, "#booking"))}">${esc(
                c.hero.ctaLabel
              )}</a>`
            : ""
        }
      </div>
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

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
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='${encodeURIComponent(
    ink
  )}'/%3E%3Cpath d='M36 6 14 38h14l-4 20 26-34H34z' fill='${encodeURIComponent(
    accent
  )}'/%3E%3C/svg%3E">

  <link rel="preconnect" href="https://firebasestorage.googleapis.com" crossorigin>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
${heroPreload}
  <link rel="stylesheet" href="/assets/site.css">
  <style>:root{--ink:${ink};--spark:${accent};}</style>
</head>
<body data-page="${esc(page.slug || "home")}">
${pageBackground(site)}
  <a class="skip" href="#${esc(order[0] || "top")}">${esc(ui.skip)}</a>

  <header>
    <div class="progress" id="progress" aria-hidden="true"></div>
    <a class="logo" href="/">${esc(str(site.logoText, site.artist))}</a>
    <button class="burger" id="burger" aria-label="${esc(ui.menu)}" aria-expanded="false" aria-controls="nav" data-open="${esc(ui.menu)}" data-close="${esc(ui.close)}">${esc(ui.menu)}</button>
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
                    langPrefix(l, master) + (page.slug ? `/${page.slug}/` : "/")
                  )}" lang="${esc(l)}"${l === lang ? ' aria-current="true"' : ""}>${esc(l.toUpperCase())}</a>`
              )
              .join("")}</div>`
          : ""
      }
    </nav>
  </header>
${hero}${tickerBlock}${subNav}
${body}

  <div class="lb" id="lb" role="dialog" aria-modal="true" aria-label="${esc(ui.imageViewer)}" hidden>
    <button class="lb-close" id="lb-close" aria-label="${esc(ui.close)}">✕</button>
    <button class="lb-nav lb-prev" id="lb-prev" aria-label="${esc(ui.prevImage)}">‹</button>
    <figure class="lb-fig"><img id="lb-img" src="" alt=""><figcaption id="lb-cap" class="mono"></figcaption></figure>
    <button class="lb-nav lb-next" id="lb-next" aria-label="${esc(ui.nextImage)}">›</button>
  </div>

  <a class="totop" href="#top" aria-label="${esc(ui.toTop || "Nach oben")}">↑</a>

  <aside class="cookie" id="cookie" hidden aria-label="Cookies">
    <p>${esc(ui.cookieText)}</p>
    <button class="btn sm solid" id="cookie-ok" type="button">${esc(ui.cookieOk)}</button>
  </aside>

  <footer>
    <div class="wrap foot">
      ${
        langs.length > 1
          ? `<nav class="langs" aria-label="${esc(ui.language)}">
        <span class="mono">${esc(ui.language)}</span>
        ${langs
          .map(
            (l) =>
              `<a href="${esc(
                langPrefix(l, master) + (page.slug ? `/${page.slug}/` : "/")
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
      ${site.claim ? `<span class="claim">${esc(site.claim)}</span>` : ""}
      ${
        site.photoCredit
          ? `<span class="mono">${esc(ui.photography)} — ${esc(site.photoCredit)}</span>`
          : ""
      }
    </div>
  </footer>
${showsData}
  <script src="/assets/site.js" defer></script>
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
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>404 — ${esc(site.artist)}</title>
  <meta name="robots" content="noindex, follow">
  <link rel="stylesheet" href="/assets/site.css">
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
      <a class="btn" href="/">${esc(str(ui.notFoundCta, "Zur Startseite"))}</a>
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

  await writeFile(resolve(ROOT, "sitemap.xml"), renderSitemap(content, pages, langs));
  await writeFile(resolve(ROOT, "robots.txt"), renderRobots(content));
  await writeFile(resolve(ROOT, "404.html"), render404(content, langs));
  console.log("[build] sitemap.xml, robots.txt, 404.html");

  // Verzeichnisse aufräumen, die zu keiner Seite mehr gehören
  const wanted = new Set(written.map((r) => r.split("/")[0]).filter((d) => d !== "index.html"));
  for (const entry of await readdir(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || KEEP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    if (wanted.has(entry.name)) continue;
    if (existsSync(resolve(ROOT, entry.name, "index.html"))) {
      await rm(resolve(ROOT, entry.name), { recursive: true, force: true });
      console.log(`[build] entfernt: ${entry.name}/ (keine Seite mehr)`);
    }
  }

  // Dasselbe innerhalb der Sprachverzeichnisse (en/, fr/, …)
  const keepSlugs = new Set(pages.map((p) => p.slug).filter(Boolean));
  for (const lang of langs.slice(1)) {
    const dir = resolve(ROOT, lang);
    if (!existsSync(dir)) continue;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (keepSlugs.has(entry.name)) continue;
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

main().catch((err) => {
  console.error("[build] FEHLER:", err.message);
  process.exit(1);
});
