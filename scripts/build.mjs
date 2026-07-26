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

/** Verzeichnisse, die der Generator nie anfasst. */
const KEEP_DIRS = new Set(["assets", "img", "content", "scripts", "presskit", "node_modules"]);

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
      const content = data && data.content ? data.content : data;
      if (!content || typeof content !== "object" || !content.site) {
        throw new Error("Antwort enthält kein site-Objekt");
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

function picture(media, { className = "", eager = false, sizes = "" } = {}) {
  const src = href(media?.src);
  if (!src) return "";
  const attrs = [
    `src="${src}"`,
    `alt="${esc(media?.alt || "")}"`,
    eager ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"',
    sizes ? `sizes="${esc(sizes)}"` : "",
    className ? `class="${esc(className)}"` : "",
  ].filter(Boolean);
  return `<img ${attrs.join(" ")}>`;
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
 * Hero-Hintergrund. Video läuft stumm in Dauerschleife — anders erlaubt kein
 * Browser Autoplay. Das Poster wird sofort angezeigt (und bleibt stehen, wenn
 * jemand „Bewegung reduzieren" eingestellt hat, siehe assets/site.js).
 */
function heroMedia(hero) {
  const m = hero.media || {};
  if (m.type === "video" && safeUrl(m.src)) {
    const poster = href(m.poster);
    return `<video class="hero-video" autoplay muted loop playsinline preload="auto"${
      poster ? ` poster="${poster}"` : ""
    } aria-hidden="true" tabindex="-1"><source src="${href(m.src)}" type="${videoType(
      m.src
    )}"></video>`;
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
  const d = date ? new Date(date + "T12:00:00Z") : null;
  const day = d ? String(d.getUTCDate()).padStart(2, "0") : "";
  const month = d
    ? d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase()
    : "";
  const year = d ? d.getUTCFullYear() : "";
  const soldOut = sh.status === "soldout";
  const label = soldOut ? "Sold out" : str(sh.ticketLabel, "Tickets");
  return `<li class="show${soldOut ? " soldout" : ""}"${date ? ` data-date="${esc(date)}"` : ""}>
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
            safeUrl(sh.ticketUrl) && !soldOut
              ? `<a class="btn btn-sm" href="${href(
                  sh.ticketUrl
                )}" target="_blank" rel="noopener">${esc(label)}</a>`
              : `<span class="mono">${esc(soldOut ? label : "")}</span>`
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

  // Der Kalender wird von assets/site.js aufgebaut (aus #shows-data) und erst
  // dann eingeblendet — ohne JavaScript bleibt die Liste allein stehen.
  const calendar =
    str(s.view, "calendar") !== "list" && items.length
      ? `
      <div class="cal rv" id="shows-calendar" hidden>
        <div class="cal-head">
          <button type="button" class="cal-nav" data-cal="prev" aria-label="${esc(
            str(s.prevLabel, "Previous month")
          )}">‹</button>
          <strong class="cal-month" id="cal-month"></strong>
          <button type="button" class="cal-nav" data-cal="next" aria-label="${esc(
            str(s.nextLabel, "Next month")
          )}">›</button>
        </div>
        <div class="cal-grid" id="cal-grid" role="grid" aria-labelledby="cal-month"></div>
      </div>`
      : "";

  return `
  <section class="pad shows-sec" id="shows" aria-labelledby="shows-h">
    <div class="wrap">${sectionHead(n, s, "shows")}${calendar}
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
          <button type="button" class="gal-btn" aria-label="Open image ${idx} of ${photos.length} in full size">
            ${picture(g, { sizes: "(max-width:700px) 100vw, 33vw" })}
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
      )}" novalidate>
        <div class="bform-head">
          <span class="mono">${esc(str(f.kicker, "Booking request"))}</span>
          <h3>${esc(str(f.title, "Tell me about your event"))}</h3>
        </div>
        <div class="bform-grid">
          <label>Your name <span aria-hidden="true">*</span>
            <input name="name" type="text" required maxlength="120" autocomplete="name">
          </label>
          <label>E-mail <span aria-hidden="true">*</span>
            <input name="email" type="email" required maxlength="160" autocomplete="email">
          </label>
          <label>Event / club
            <input name="event" type="text" maxlength="160">
          </label>
          <label>City
            <input name="city" type="text" maxlength="120">
          </label>
          <label>Date
            <input name="date" type="date">
          </label>
          <label>Set length
            <input name="setLength" type="text" maxlength="60" placeholder="e.g. 60 min">
          </label>
          <label class="span-2">Message
            <textarea name="message" rows="4" maxlength="4000"></textarea>
          </label>
          <label class="hp" aria-hidden="true" tabindex="-1">Leave empty
            <input name="website" type="text" tabindex="-1" autocomplete="off">
          </label>
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

function renderContact(n, s) {
  const mail = str(s.email);
  const parts = mail.split("@");
  return `
  <section class="pad contact" id="contact" aria-labelledby="contact-h">
    <div class="wrap">${sectionHead(n, s, "contact")}
      <div class="rv">
        ${str(s.kicker) ? `<span class="mono">${esc(s.kicker)}</span>` : ""}
        ${
          mail
            ? `<a class="big-mail" href="mailto:${esc(mail)}">${esc(parts[0])}@<wbr>${esc(
                parts.slice(1).join("@")
              )}</a>`
            : ""
        }
        <div class="contact-meta">
          ${
            str(s.phone)
              ? `<div><span class="mono">Phone</span><a href="tel:${esc(
                  s.phone.replace(/[^\d+]/g, "")
                )}">${esc(s.phone)}</a></div>`
              : ""
          }
          ${list(s.socials)
            .filter((x) => str(x?.label) && safeUrl(x?.url))
            .map(
              (x) =>
                `<div><span class="mono">${esc(x.label)}</span><a href="${href(
                  x.url
                )}" target="_blank" rel="noopener me">${esc(x.label)}</a></div>`
            )
            .join("\n          ")}
          ${
            str(s.base)
              ? `<div><span class="mono">Base</span><span>${esc(s.base)}</span></div>`
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

  const graph = [
    person,
    {
      "@type": "WebSite",
      "@id": `${base}/#website`,
      url: `${base}/`,
      name: `${site.artist} — Official Website`,
      inLanguage: site.lang,
      publisher: { "@id": `${base}/#artist` },
    },
  ];

  if (page && page.slug) {
    graph.push({
      "@type": "WebPage",
      "@id": `${base}${pagePath(page.slug)}#page`,
      url: `${base}${pagePath(page.slug)}`,
      name: page.navLabel,
      isPartOf: { "@id": `${base}/#website` },
      about: { "@id": `${base}/#artist` },
      breadcrumb: {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Start", item: `${base}/` },
          { "@type": "ListItem", position: 2, name: page.navLabel },
        ],
      },
    });
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

/** Adresse einer Seite: "" → "/", "shows" → "/shows/" */
const pagePath = (slug) => (slug ? `/${slug}/` : "/");

/* Welche Seite wird gerade gebaut — damit Sprungmarken wie #booking auch dann
   ankommen, wenn der Abschnitt inzwischen auf einer anderen Seite liegt. */
let CTX = { page: null, pages: [] };

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

function renderPage(c, page, pages) {
  CTX = { page, pages, hideHead: null };
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
  const nav = navPages
    .map(
      (p) =>
        `<li><a href="${esc(pagePath(p.slug))}"${
          p.slug === page.slug ? ' aria-current="page"' : ""
        }>${esc(p.navLabel)}</a></li>`
    )
    .join("\n          ");

  // Auf einer Seite mit mehreren Abschnitten zusätzlich Sprungmarken anbieten
  const subNav =
    order.length > 1
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
    </div>
  </section>`
      : `
  <section class="hero" id="top">
    <div class="hero-bg">
      ${heroMedia(c.hero || {})}
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
    <a class="hero-scroll mono" href="#${esc(order[0] || "top")}" aria-hidden="true" tabindex="-1">Scroll ↓</a>
  </section>`;

  const heroPreload = (() => {
    if (page.hero !== "full") return "";
    const m = c.hero?.media || {};
    const first = m.type === "video" ? m.poster : m.src;
    return safeUrl(first)
      ? `  <link rel="preload" as="image" href="${esc(rooted(first))}" fetchpriority="high">\n`
      : "";
  })();

  // Termine als JSON für die Kalenderansicht (assets/site.js baut sie auf)
  const showsData =
    order.includes("shows") && list(sections.shows?.items).length
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
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="author" content="${esc(site.artist)}">

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
  <meta property="og:locale" content="${esc((site.lang || "en") === "de" ? "de_CH" : "en_US")}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(isHome ? str(site.ogTitle, title) : title)}">
  <meta name="twitter:description" content="${esc(
    isHome ? str(site.ogDescription, description) : description
  )}">
  <meta name="twitter:image" content="${esc(ogImage)}">

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

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
${heroPreload}
  <link rel="stylesheet" href="/assets/site.css">
  <style>:root{--ink:${ink};--spark:${accent};}</style>
</head>
<body data-page="${esc(page.slug || "home")}">
  <a class="skip" href="#${esc(order[0] || "top")}">Skip to content</a>
  <div class="progress" id="progress" aria-hidden="true"></div>

  <header>
    <a class="logo" href="/">${esc(str(site.logoText, site.artist))}</a>
    <button class="burger" id="burger" aria-label="Menu" aria-expanded="false" aria-controls="nav">Menu</button>
    <nav id="nav">
      <ul>
          ${nav}
      </ul>
    </nav>
  </header>
${hero}${tickerBlock}${subNav}
${body}

  <div class="lb" id="lb" role="dialog" aria-modal="true" aria-label="Image viewer" hidden>
    <button class="lb-close" id="lb-close" aria-label="Close">✕</button>
    <button class="lb-nav lb-prev" id="lb-prev" aria-label="Previous image">‹</button>
    <figure class="lb-fig"><img id="lb-img" src="" alt=""><figcaption id="lb-cap" class="mono"></figcaption></figure>
    <button class="lb-nav lb-next" id="lb-next" aria-label="Next image">›</button>
  </div>

  <footer>
    <div class="wrap foot">
      <span class="mono">© <span id="yr">${today().slice(0, 4)}</span> ${esc(
    site.artist
  )} — All rights reserved</span>
      ${site.claim ? `<span class="claim">${esc(site.claim)}</span>` : ""}
      ${
        site.photoCredit
          ? `<span class="mono">Photography — ${esc(site.photoCredit)}</span>`
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

function renderSitemap(c, pages) {
  const base = c.site.domain.replace(/\/+$/, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map(
    (p) => `  <url>
    <loc>${esc(base)}${esc(pagePath(p.slug))}</loc>
    <lastmod>${today()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${p.slug ? "0.8" : "1.0"}</priority>
  </url>`
  )
  .join("\n")}
</urlset>
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
  await mkdir(resolve(ROOT, "content"), { recursive: true });

  const pages = pagesOf(content);

  // Seiten schreiben: Start nach index.html, alle anderen nach <slug>/index.html
  for (const page of pages) {
    const rel = page.slug ? `${page.slug}/index.html` : "index.html";
    const file = resolve(ROOT, rel);
    await mkdir(dirname(file), { recursive: true });
    const html = renderPage(content, page, pages);
    await writeFile(file, html);
    console.log(
      `[build] ${rel.padEnd(28)} ${(html.length / 1024).toFixed(1).padStart(5)} kB  ` +
        `(${page.sections.join(", ") || "keine Abschnitte"})`
    );
  }

  await writeFile(resolve(ROOT, "sitemap.xml"), renderSitemap(content, pages));
  await writeFile(resolve(ROOT, "robots.txt"), renderRobots(content));
  console.log("[build] sitemap.xml, robots.txt");

  // Verzeichnisse aufräumen, die zu keiner Seite mehr gehören
  const wanted = new Set(pages.filter((p) => p.slug).map((p) => p.slug.split("/")[0]));
  for (const entry of await readdir(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || KEEP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    if (wanted.has(entry.name)) continue;
    // Nur entfernen, was eindeutig eine generierte Seite ist
    if (existsSync(resolve(ROOT, entry.name, "index.html"))) {
      await rm(resolve(ROOT, entry.name), { recursive: true, force: true });
      console.log(`[build] entfernt: ${entry.name}/ (keine Seite mehr)`);
    }
  }

  const shows = list(content.sections?.shows?.items).length;
  const gal = list(content.sections?.gallery?.items).length;
  console.log(
    `[build] fertig — ${pages.length} Seite(n), ${shows} Show(s), ${gal} Galeriebild(er)`
  );
}

main().catch((err) => {
  console.error("[build] FEHLER:", err.message);
  process.exit(1);
});
