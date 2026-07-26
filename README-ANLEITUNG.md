# Sam Sparking — Website

Statische One-Page-Website, generiert aus einer Inhalts-Datei. Inhalte pflegst du
**nicht** in der HTML, sondern in der Verwaltung:

> **Verwaltung:** Repo [`verwaltung-djsamsparkling`](https://github.com/Laurin-Rusterholz/verwaltung-djsamsparkling)
> — dort loggst du dich mit Google ein und stellst Texte, Bilder, Shows, Rider und
> SEO ein. Beim Klick auf **Publizieren** wird diese Website neu gebaut.

---

## Wie das zusammenspielt

```
Verwaltung (Admin)  ──schreibt──▶  Firebase Realtime Database
                                    samsparking/content
                                          │
                        Netlify-Build ────┘  (liest den Knoten)
                                          │
                                    node scripts/build.mjs
                                          │
                            index.html · sitemap.xml · robots.txt
```

- **`content/site.json`** — der Inhalt. Wird beim Build automatisch mit dem Stand
  aus der Verwaltung überschrieben; ist die Datenbank nicht erreichbar, baut
  Netlify mit dieser eingecheckten Datei weiter (mit Warnung im Build-Log).
- **`scripts/build.mjs`** — der Generator. Keine Abhängigkeiten, reines Node.
- **`index.html`** — **generiert, nicht von Hand bearbeiten.** Änderungen hier
  gehen beim nächsten Build verloren.
- **`assets/site.css` / `assets/site.js`** — Aussehen und Interaktion. Das ist der
  richtige Ort für Design-Änderungen.

## Lokal bauen und anschauen

```bash
node scripts/build.mjs          # baut aus content/site.json
npx http-server -p 8080 .       # http://localhost:8080
```

Mit Inhalt direkt aus der Verwaltung bauen:

```bash
CONTENT_API_URL="https://jupidu-36804-default-rtdb.europe-west1.firebasedatabase.app/samsparking/content.json" \
  node scripts/build.mjs
```

## Deploy auf Netlify

1. Site aus diesem Repo erstellen (Build-Command und Publish-Verzeichnis stehen
   in `netlify.toml`, es ist nichts weiter einzustellen).
2. Domain verbinden: Site settings → Domain management → Custom domain →
   `samsparking.ch`, DNS beim Registrar setzen. HTTPS macht Netlify automatisch.
3. **Build-Hook anlegen:** Site configuration → Build & deploy → Build hooks →
   „Add build hook" → URL kopieren und in der Verwaltung unter *Einstellungen*
   eintragen. Erst dann wirkt der Publizieren-Knopf.
4. Bei Google Search Console `https://www.samsparking.ch/sitemap.xml` einreichen.

Wenn die Domain nicht `samsparking.ch` wird: in der Verwaltung unter
*Einstellungen → Domain* ändern — Canonical, Open Graph, JSON-LD, `sitemap.xml`
und `robots.txt` ziehen automatisch nach.

## Bilder

Bilder lädst du in der Verwaltung unter **Medien** hoch (Firebase Storage). Sie
werden direkt von dort ausgeliefert; im Repo muss nichts abgelegt werden.

Die Dateien in `img/` sind der **Fallback-Stand** (aktuell Platzhalter-Grafiken).
Wer ohne Verwaltung arbeiten will, kann sie weiterhin überschreiben —
gleicher Dateiname, Datei ersetzen:

| Datei | Empfehlung |
|---|---|
| `img/hero.jpg` | Bestes Querformat: Sam am Pult, Crowd/Laser (~2000 px breit) |
| `img/about.jpg` | Portrait im Hochformat |
| `img/gallery-01..12.jpg` | 12 Lieblingsbilder gemischt |

Tipp: vorher auf max. ~2000 px Breite verkleinern, JPG Qualität ~80.

## Presskit

PDF unter `presskit/sam-sparking-presskit-2026.pdf` ablegen — oder in der
Verwaltung eine beliebige URL als Presskit-Link eintragen.

## Was drin ist

**Inhalt & Funktion**
- Hero (Bild **oder** Video als Hintergrund), Lauftext-Ticker
- About mit Fakten-Leiste, Genres, Mixe (Link + optionales Embed)
- **Shows** — kommende Termine mit Datum, Venue, Ticket-Link, „Sold out";
  vergangene Termine klappen separat auf. Abgelaufene Termine verschwinden
  automatisch, auch ohne neuen Build.
- Referenzen, Galerie mit Lightbox (Pfeiltasten, Wischen, Zähler)
- Booking mit Rider und **Anfrage-Formular** → landet direkt in der Verwaltung
- Kontakt mit beliebig vielen Social-Links
- Jeder Abschnitt lässt sich in der Verwaltung ausschalten und umsortieren;
  Nummerierung und Navigation passen sich automatisch an.

**SEO**
- Title, Description, Canonical, Open Graph, Twitter Cards
- Strukturierte Daten als `@graph`: Person + WebSite + **MusicEvent je Show**
  (Chance auf Event-Rich-Results in der Google-Suche)
- `sitemap.xml` + `robots.txt` werden mitgeneriert, `lastmod` automatisch
- Semantisches HTML, Alt-Texte, Lazy-Loading, Hero-Preload

**Technik**
- Keine Frameworks, keine Cookies, keine Tracker
- Barrierefrei: Skip-Link, Fokus-Ringe, ARIA am Menü/Lightbox,
  `prefers-reduced-motion`, Tastaturbedienung überall
- Scroll-Fortschritt, aktiver Menüpunkt, Druck-Stylesheet
