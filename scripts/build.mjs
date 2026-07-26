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

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_CONTENT = resolve(ROOT, "content/site.json");

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

const href = (v) => esc(safeUrl(v));

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

function heroMedia(hero) {
  const m = hero.media || {};
  if (m.type === "video" && safeUrl(m.src)) {
    const poster = href(m.poster);
    return `<video autoplay muted loop playsinline${poster ? ` poster="${poster}"` : ""} aria-label="${esc(
      m.alt || ""
    )}"><source src="${href(m.src)}" type="video/mp4"></video>`;
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
            const url = safeUrl(v.url) || "#booking";
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
          ? `<p class="live-note rv">${inline(s.note)} <a class="accent" href="#contact">${esc(
              str(s.noteLinkLabel, "Get in touch →")
            )}</a></p>`
          : ""
      }
    </div>
  </section>`;
}

function renderGallery(n, s) {
  const items = list(s.items).filter((i) => safeUrl(i?.src));
  return `
  <section class="pad" id="gallery" aria-labelledby="gallery-h">
    <div class="wrap">${sectionHead(n, s, "gallery")}
      <div class="gal rv" id="gal">
        ${items
          .map(
            (g, i) => `<figure>
          <button type="button" class="gal-btn" data-i="${i}" aria-label="Open image ${
              i + 1
            } of ${items.length} in full size">
            ${picture(g, { sizes: "(max-width:700px) 100vw, 33vw" })}
            ${g.credit ? `<figcaption>${esc(g.credit)}</figcaption>` : ""}
          </button>
        </figure>`
          )
          .join("\n        ")}
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
            <a class="btn solid" href="${formEnabled ? "#booking-form" : "#contact"}">${esc(
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

function structuredData(c, sections) {
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
      url: safeUrl(sh.ticketUrl) || `${base}/#shows`,
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

function renderPage(c) {
  const site = c.site;
  const base = site.domain.replace(/\/+$/, "");
  const sections = c.sections || {};
  const order = list(c.layout).filter((k) => sections[k] && sections[k].enabled !== false);

  const renderers = {
    about: renderAbout,
    sound: renderSound,
    shows: renderShows,
    references: renderReferences,
    gallery: renderGallery,
    booking: (n, s) => renderBooking(n, s, site),
    contact: renderContact,
  };

  const body = order
    .map((key, i) => (renderers[key] ? renderers[key](i + 1, sections[key]) : ""))
    .join("\n");

  const nav = order
    .map(
      (key) =>
        `<li><a href="#${esc(key)}">${esc(
          str(sections[key].navLabel, sections[key].title + sections[key].titleAccent)
        )}</a></li>`
    )
    .join("\n          ");

  const accent = color(site.accentColor, "#2e6bff");
  const ink = color(site.themeColor, "#05070e");
  const ogImage = absolute(base, site.ogImage);
  const ticker = c.ticker || {};
  const tickerItems = list(ticker.items).filter((t) => str(t?.text) || str(t?.accent));

  const tickerBlock =
    ticker.enabled !== false && tickerItems.length
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
  <title>${esc(site.title)}</title>
  <meta name="description" content="${esc(site.description)}">
  <meta name="keywords" content="${esc(list(site.keywords).join(", "))}">
  <link rel="canonical" href="${esc(base)}/">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="author" content="${esc(site.artist)}">

  <!-- Open Graph / Social -->
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${esc(site.artist)}">
  <meta property="og:url" content="${esc(base)}/">
  <meta property="og:title" content="${esc(str(site.ogTitle, site.title))}">
  <meta property="og:description" content="${esc(str(site.ogDescription, site.description))}">
  <meta property="og:image" content="${esc(ogImage)}">
  <meta property="og:image:alt" content="${esc(c.hero?.media?.alt || site.artist)}">
  <meta property="og:locale" content="${esc((site.lang || "en") === "de" ? "de_CH" : "en_US")}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(str(site.ogTitle, site.title))}">
  <meta name="twitter:description" content="${esc(str(site.ogDescription, site.description))}">
  <meta name="twitter:image" content="${esc(ogImage)}">

  <!-- Structured data -->
  <script type="application/ld+json">
${jsonScript(structuredData(c, sections))}
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
${
  c.hero?.media?.type !== "video" && safeUrl(c.hero?.media?.src)
    ? `  <link rel="preload" as="image" href="${href(c.hero.media.src)}" fetchpriority="high">\n`
    : ""
}
  <link rel="stylesheet" href="assets/site.css">
  <style>:root{--ink:${ink};--spark:${accent};}</style>
</head>
<body>
  <a class="skip" href="#about">Skip to content</a>
  <div class="progress" id="progress" aria-hidden="true"></div>

  <header>
    <a class="logo" href="#top">${esc(str(site.logoText, site.artist))}</a>
    <button class="burger" id="burger" aria-label="Menu" aria-expanded="false" aria-controls="nav">Menu</button>
    <nav id="nav">
      <ul>
          ${nav}
      </ul>
    </nav>
  </header>

  <!-- ============ HERO ============ -->
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
            ? `<a class="hero-cta" href="${href(str(c.hero.ctaHref, "#booking"))}">${esc(
                c.hero.ctaLabel
              )}</a>`
            : ""
        }
      </div>
    </div>
    <a class="hero-scroll mono" href="#${esc(order[0] || "top")}" aria-hidden="true" tabindex="-1">Scroll ↓</a>
  </section>
${tickerBlock}
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

  <script src="assets/site.js" defer></script>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ main */

function renderSitemap(c) {
  const base = c.site.domain.replace(/\/+$/, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${esc(base)}/</loc>
    <lastmod>${today()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
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

  const files = {
    "index.html": renderPage(content),
    "sitemap.xml": renderSitemap(content),
    "robots.txt": renderRobots(content),
  };
  for (const [name, body] of Object.entries(files)) {
    await writeFile(resolve(ROOT, name), body);
    console.log(`[build] ${name} — ${(body.length / 1024).toFixed(1)} kB`);
  }

  const shows = list(content.sections?.shows?.items).length;
  const gal = list(content.sections?.gallery?.items).length;
  console.log(`[build] fertig — ${shows} Show(s), ${gal} Galeriebild(er)`);
}

main().catch((err) => {
  console.error("[build] FEHLER:", err.message);
  process.exit(1);
});
