# Sam Sparkling — Website

Statische Website in **Deutsch, Englisch und Französisch**, generiert aus einer
Inhalts-Datei. Inhalte pflegst du
**nicht** in der HTML, sondern in der Verwaltung:

> **Verwaltung:** Repo [`verwaltung-djsamsparkling`](https://github.com/Laurin-Rusterholz/verwaltung-djsamsparkling)
> — dort meldest du dich mit dem gemeinsamen Passwort an und stellst Texte,
> Bilder, Videos, Shows, Rider und SEO ein. Beim Klick auf **Publizieren** wird
> diese Website neu gebaut.

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
         index.html · shows/ · gallery/ · … · sitemap.xml · robots.txt
```

- **`content/site.json`** — der Inhalt. Wird beim Build automatisch mit dem Stand
  aus der Verwaltung überschrieben; ist die Datenbank nicht erreichbar, baut
  Netlify mit dieser eingecheckten Datei weiter (mit Warnung im Build-Log).
- **`scripts/build.mjs`** — der Generator. Keine Abhängigkeiten, reines Node.
- **`index.html`** und die Seiten-Verzeichnisse (`shows/`, `gallery/`, …) —
  **generiert, nicht von Hand bearbeiten.** Änderungen hier gehen beim nächsten
  Build verloren; Verzeichnisse gelöschter Seiten räumt der Build weg.
- **`assets/site.css` / `assets/site.js`** — Aussehen und Interaktion. Das ist der
  richtige Ort für Design-Änderungen.
- **`en/` und `fr/`** — ebenfalls generiert, eine komplette Kopie der Seiten in
  der jeweiligen Sprache.

### Mehrsprachigkeit

Deutsch ist der gepflegte Stand im Inhalt. Die Übersetzungen liegen daneben:

```jsonc
{
  "site": { "lang": "de", "languages": ["de", "en", "fr"] },
  "sections": { "about": { "lede": "Aus Energie wird Euphorie" } },
  "i18n": {
    "en": { "sections": { "about": { "lede": "Turning energy into euphoria" } } }
  },
  "i18nHash": {                       // Fingerabdruck des deutschen Originals —
    "en": { "sections": { "about": { "lede": "3f0a91c2" } } }   // daran erkennt
  }                                   // die Verwaltung veraltete Übersetzungen
}
```

Der Generator baut je Sprache einen kompletten Satz Seiten: die Hauptsprache
unter `/`, die anderen unter `/<sprache>/`. Vor dem Rendern wird der Inhaltsbaum
einmal übersetzt (`localize`), deshalb kennen die einzelnen Bausteine keine
Sprachen. Fehlt eine Übersetzung, bleibt der deutsche Text stehen.

Steht in der Verwaltung noch ein alter Stand **ohne** `i18n` und mit einer
anderen Hauptsprache, übernimmt der Build die Texte aus `content/site.json` und
schreibt das ins Log. Sobald in der Verwaltung einmal gespeichert wurde, gilt
wieder ausschliesslich der Stand von dort.

`i18n.<lang>` darf verschachtelt (so schreibt es die Verwaltung — die Realtime
Database erlaubt keine Punkte in Schlüsseln) oder flach mit Punkt-Pfaden
(`"sections.about.lede"`) stehen; `flattenI18n()` versteht beides. Welche Felder
überhaupt übersetzt werden, entscheidet `collectStrings()` — die Liste muss mit
`public/js/i18n.js` in der Verwaltung übereinstimmen.

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
2. **Build-Hook anlegen:** Site configuration → Build & deploy → Build hooks →
   „Add build hook" → URL kopieren und in der Verwaltung unter *Einstellungen*
   eintragen. Erst dann wirkt der Publizieren-Knopf.

## Launch: eigene Domain (bei Jimdo gekauft) auf Netlify zeigen lassen

Die Domain bleibt bei Jimdo registriert, die Website läuft weiter auf Netlify.
Zwei Wege — der erste ist der bequemere:

**A. Nameserver auf Netlify umstellen (empfohlen)**

1. Netlify → Site → *Domain management* → *Add a domain* → Domain eintragen.
2. Netlify zeigt vier Nameserver (`dns1.p0X.nsone.net` …).
3. Bei Jimdo unter *Domains → Einstellungen → Nameserver* diese vier eintragen.
4. Nach der Umstellung (bis 24 h) verwaltet Netlify alle DNS-Einträge; Zertifikat
   und Weiterleitungen laufen automatisch.

**B. DNS bei Jimdo behalten**

1. Netlify → *Add a domain* → Domain eintragen; Netlify zeigt die nötigen Werte.
2. Bei Jimdo im DNS-Bereich setzen:
   - `A` für `@` (Wurzel) auf die von Netlify genannte IP (aktuell `75.2.60.5`)
   - `CNAME` für `www` auf `<deine-site>.netlify.app`
3. Bestehende Jimdo-Einträge für `@` und `www` vorher entfernen, sonst zeigt die
   Domain weiter auf Jimdo.

**Danach in beiden Fällen**

- In Netlify die **Primary domain** festlegen (z. B. `www.…`). Netlify leitet die
  andere Schreibweise per 301 dorthin um — wichtig, damit Google nicht zwei
  Adressen mit demselben Inhalt sieht.
- HTTPS erscheint unter *Domain management → HTTPS* automatisch (Let's Encrypt),
  sobald die DNS-Umstellung durch ist. Falls nicht: *Verify DNS configuration*.
- In der Verwaltung unter **SEO & Teilen → Domain der Website** die neue Adresse
  eintragen (mit `https://`, ohne Schrägstrich am Ende) und publizieren. Canonical,
  `hreflang`, Open Graph, JSON-LD, `sitemap.xml` und `robots.txt` ziehen automatisch nach.
- E-Mail: Wenn bei Jimdo Postfächer an der Domain hängen, die `MX`-Einträge in
  Netlify DNS nachtragen (Weg A) — sonst kommt keine Post mehr an.
- [Google Search Console](https://search.google.com/search-console): Property für
  die Domain anlegen, Inhaberschaft per DNS-`TXT` bestätigen und
  `https://<domain>/sitemap.xml` einreichen. Dasselbe bei
  [Bing Webmaster Tools](https://www.bing.com/webmasters).

## SEO — was die Website mitbringt

| Bereich | Umsetzung |
|---|---|
| Titel & Description | je Seite und je Sprache aus der Verwaltung, mit Längen-Check |
| Canonical | selbstreferenzierend, je Sprache und Seite |
| Mehrsprachigkeit | `hreflang` für alle Sprachen + `x-default`, `og:locale` und `og:locale:alternate` |
| Sitemap | alle Seiten × Sprachen, `xhtml:link`-Alternativen, `lastmod`, dazu die Galeriebilder als Bild-Sitemap |
| robots | `robots.txt` mit Sitemap-Verweis, `max-image-preview:large`, `max-snippet:-1`, `max-video-preview:-1` |
| Strukturierte Daten | ein `@graph` mit `Person` (inkl. Adresse, Genres, `sameAs`, Booking-`ContactPoint`), `WebSite`, `ImageObject`, `WebPage`/`ProfilePage` mit `BreadcrumbList`, `ImageGallery` und **`MusicEvent` je kommender Show** (mit `offers`, wenn ein Ticket-Link gesetzt ist) |
| Social | Open Graph und Twitter Cards inkl. Bild-Alternativtexten |
| Lokal | `geo.region` / `geo.placename` aus dem Standort im Kontakt-Abschnitt |
| Technik | semantisches HTML, Alt-Texte, Lazy-Loading, Hero-Preload, sauberes 404, Security-Header, unveränderliche Bild-Caches |

Nicht automatisierbar und darum deine Aufgabe: echte Backlinks (Clubs,
Festivals, Labels, Presskit-Verteiler), gepflegte Termine (die `MusicEvent`-Daten
sind die einzige Chance auf Event-Rich-Results) und ein aussagekräftiges
Vorschaubild.

## Bilder

Bilder **und Videos** lädst du in der Verwaltung unter **Medien** hoch (Firebase
Storage, max. 250 MB pro Datei). Sie werden direkt von dort ausgeliefert; im Repo
muss nichts abgelegt werden.

Als Hero-Hintergrund kann ein MP4 laufen — automatisch, stumm, in Dauerschleife
(anders erlaubt kein Browser Autoplay). Dazu gehört ein Poster-Bild: es ist
sofort sichtbar, während das Video lädt, und ersetzt es bei „Bewegung
reduzieren". Kurzer Loop von 5–15 Sekunden, gut komprimiert — Details stehen im
README der Verwaltung.

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
- Hero (Bild **oder** automatisch laufendes Video als Hintergrund), Lauftext-Ticker
- About mit Fakten-Leiste, Genres, Mixe (Link + optionales Embed)
- **Shows** — kommende Termine mit Datum, Venue, Ticket-Link und Status
  („Sold out", **„Gebucht"**); vergangene Termine klappen separat auf.
  Abgelaufene Termine verschwinden automatisch, auch ohne neuen Build.
  Bestätigt jemand in der Verwaltung eine Booking-Anfrage, steht der Termin
  ab dem nächsten Build als **gebucht** im Kalender.
- **Mehrere Seiten** — welche Seiten es gibt und welcher Abschnitt auf welcher
  steht, kommt aus der Verwaltung; Menü, Sitemap und Sprungmarken folgen
  automatisch. Ohne Seiten-Definition wird eine einzelne Seite gebaut.
- **Kalender** über den Terminen (Monatsansicht, Punkte sind Auftritte,
  gebuchte Tage blau, mit Legende darunter)
- **Hintergrundbild** hinter der ganzen Seite (in der Verwaltung wählbar) — die
  Inhalte stehen als freie, **eckige** Kacheln darauf, Bilder ohne Rahmen und
  ohne Rundungen, nur mit weichem Schatten
- Alle Texte in der **Ich-Form** — die Website spricht als Sam, nicht über ihn
- **Drei Sprachen** — Deutsch unter `/`, Englisch unter `/en/`, Französisch
  unter `/fr/`. Umschalter im **Fussbereich**, `hreflang`-Verweise und
  `xhtml:link` in der Sitemap. Übersetzt wird in der Verwaltung (auf Wunsch von
  Claude); fehlt eine Stelle, steht dort der deutsche Text.
- Referenzen, Galerie mit Lightbox (Pfeiltasten, Wischen, Zähler)
- Booking mit Rider und **Anfrage-Formular** → landet direkt in der Verwaltung
- Kontakt mit beliebig vielen Social-Links
- Jeder Abschnitt lässt sich in der Verwaltung ausschalten und umsortieren;
  Nummerierung und Navigation passen sich automatisch an.

**SEO** — ausführlich im Abschnitt „SEO — was die Website mitbringt"

**Technik**
- Keine Frameworks, keine Cookies, keine Tracker
- Freistehende Kacheln statt durchgehender Tabellen; auf dem Handy eigene
  Abstände, Tippziele ab 48 px und ein kompakter Seitenkopf
- Barrierefrei: Skip-Link, Fokus-Ringe, ARIA am Menü/Lightbox,
  `prefers-reduced-motion`, Tastaturbedienung überall
- Scroll-Fortschritt, aktiver Menüpunkt, Druck-Stylesheet
- Weiche Seitenwechsel (View Transitions), interne Seiten werden beim
  Überfahren des Links vorgeladen
