# Sam Sparking — Website

Statische Website in **Englisch (Hauptsprache), Deutsch und Französisch**,
generiert aus einer Inhalts-Datei. Inhalte pflegst du
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
- **`content/bildmasse.json`** — Breite und Höhe je Bild, aus der
  Medienbibliothek der Verwaltung. Damit stehen `width` und `height` am `<img>`
  und die Seite springt beim Nachladen nicht mehr. Wird beim Build erneuert;
  von Hand ist hier nichts zu pflegen.
- **`scripts/build.mjs`** — der Generator. Keine Abhängigkeiten, reines Node.
- **`index.html`** und die Seiten-Verzeichnisse (`shows/`, `gallery/`, …) —
  **generiert, nicht von Hand bearbeiten.** Änderungen hier gehen beim nächsten
  Build verloren; Verzeichnisse gelöschter Seiten räumt der Build weg.
- **`assets/site.css` / `assets/site.js`** — Aussehen und Interaktion. Das ist der
  richtige Ort für Design-Änderungen.
- **`en/` und `fr/`** — ebenfalls generiert, eine komplette Kopie der Seiten in
  der jeweiligen Sprache.

### Mehrsprachigkeit

Englisch ist der gepflegte Stand im Inhalt. Die Übersetzungen liegen daneben:

```jsonc
{
  "site": { "lang": "en", "languages": ["en", "de", "fr"] },
  "sections": { "about": { "lede": "Aus Energie wird Euphorie" } },
  "i18n": {
    "en": { "sections": { "about": { "lede": "Turning energy into euphoria" } } }
  },
  "i18nHash": {                       // Fingerabdruck des englischen Originals —
    "en": { "sections": { "about": { "lede": "3f0a91c2" } } }   // daran erkennt
  }                                   // die Verwaltung veraltete Übersetzungen
}
```

Der Generator baut je Sprache einen kompletten Satz Seiten: die Hauptsprache
unter `/`, die anderen unter `/<sprache>/`. Vor dem Rendern wird der Inhaltsbaum
einmal übersetzt (`localize`), deshalb kennen die einzelnen Bausteine keine
Sprachen. Fehlt eine Übersetzung, bleibt der englische Text stehen.

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

## Shop: Produkt anlegen und verkaufen

Stand 10.08.2026 ist `/shop/` **leer** — es gibt keine verifizierten
Artikeldaten. Die Seite antwortet trotzdem mit 200 und sagt „The shop opens
soon". Ohne Ware baut der Generator von selbst kein Bestellformular und keine
Bezahl-Angaben; es kann also niemand etwas bestellen, das es nicht gibt.

### Der ganze Weg — drei Schritte, kein API-Schlüssel

1. **In Stripe** einen Preis anlegen und daraus einen **Payment Link** erzeugen
   (Stripe-Dashboard → *Produktkatalog* → Produkt/Preis → *Payment Link*). Die
   Adresse sieht so aus: `https://buy.stripe.com/…`
2. **In der Verwaltung** unter *Shop* → *Ware* den Artikel anlegen — Name,
   Preis, Bild, Beschreibung — und die Adresse aus Schritt 1 in das Feld
   **„Stripe Payment Link"** einsetzen.
3. **Speichern und publizieren.** Der Kauf-Knopf dieses Artikels führt danach
   direkt auf genau diese Kasse.

**Warum am Artikel und nicht global:** ein Payment Link gehört in Stripe zu
genau *einem* Preis. Ein gemeinsamer Link für alle Artikel würde bei jedem
Artikel denselben Betrag abrechnen. Deshalb hat jeder Artikel sein eigenes Feld —
und es gibt **keinen** Rückfall auf einen globalen Link: fehlt der Link bei einem
Artikel, bekommt er keinen Kauf-Knopf, statt versehentlich den falschen Preis zu
kassieren.

**Was geprüft wird:** nur `https://buy.stripe.com/…` wird übernommen. Eine
Dashboard-Adresse, `http://`, eine fremde Domain oder ein Tippfehler zählen wie
kein Link — der Knopf erscheint dann einfach nicht. Ein Payment Link ist eine
öffentliche Adresse; **ein API-Schlüssel wird nie gebraucht** und gehört auch
nicht in die Verwaltung.

### Was ohne Payment Link passiert

Der Artikel steht mit Bild und Preis da, aber ohne Kauf-Knopf. Ist ein
Bestellformular da (das entsteht, sobald Ware im Shop steht), wird die Bestellung
erfasst und per E-Mail gemeldet — bezahlt wird dann auf Absprache. Die Seite
verspricht in diesem Fall ausdrücklich **keine** Bezahlung: kein „via Stripe",
kein TWINT/Apple Pay/Google Pay.

### Umgebungsvariablen in Netlify

Alle unter **Site configuration → Environment variables** der Netlify-Site, die
`s-mi` ausliefert. Keine davon gehört ins Repo — Netlify ist der einzige Ort.

| Variable | Wofür | Fehlt sie, dann … |
|---|---|---|
| `RESEND_API_KEY` | E-Mail-Versand (Resend) für Booking- und Bestell-Meldungen | es wird **keine E-Mail** verschickt; die Anfrage wird nur im Eingang abgelegt |
| `MAIL_TO` | Empfänger der Meldungen | Rückfall auf `info@samsparking.ch` |
| `MAIL_FROM` | Absender, muss eine in Resend verifizierte Domain sein | Rückfall auf die Resend-Testadresse — landet leicht im Spam |
| `INBOX_API_URL` | Ablage der Anfragen (Realtime Database) | die Anfrage wird nicht gespeichert; kommt weder E-Mail noch Ablage zustande, antwortet der Endpunkt mit 502 statt „Danke" |
| `INBOX_API_TOKEN` | Schreibrecht für die Ablage, falls die Regeln eines verlangen | nur nötig, wenn die Datenbankregeln es fordern |
| `STRIPE_WEBHOOK_SECRET` | Prüft die Zahlungsbestätigung von Stripe (`/api/stripe-webhook`) | der Endpunkt lehnt jede Meldung mit 503 ab — ohne Geheimnis ist keine Unterschrift prüfbar |
| `STRIPE_PAYMENT_LINK_URL` | **optional, veraltet.** Globaler Zahlungslink für den Formular-Weg | nichts fehlt: die Kasse hängt am Artikel (siehe oben). Bleibt leer, solange nicht bewusst ein globaler Link gewollt ist |

Ob etwas gesetzt ist, sagt ein `GET` auf `/api/booking` als reines ja/nein —
**ohne** je einen Schlüssel auszugeben.

### Was noch fehlt, wenn Ware dazukommt

| Was | Wo eintragen |
|---|---|
| **Artikelname**, **Preis** in CHF | Verwaltung → *Shop* → Ware |
| **Produktbild**, das wirklich lädt | Verwaltung → *Medien*, dann in der Ware auswählen |
| **Beschreibung** (eine Zeile) | dito, Feld *Kurze Zeile darunter* |
| **Grössen / Varianten**, falls Textil | dito (eigener Artikel je Grösse, solange es kein Varianten-Feld gibt) |
| **Status** `available` / `soldout` | dito |
| **Versandkosten und Liefergebiet** | Verwaltung → *Shop* → Versandzeile |
| **Stripe Payment Link** je Artikel | dito, Feld *Stripe Payment Link* |

Der Platzhalter `"Beispiel"` wird vom Generator entfernt
(`shop.entfernteWare` in `content/korrekturen.json`). Sobald es echte Ware gibt,
gehört der Name dort heraus — sonst räumt der nächste Build sie wieder weg.

## Presskit

PDF unter `presskit/sam-sparking-presskit-2026.pdf` ablegen — oder in der
Verwaltung eine beliebige URL als Presskit-Link eintragen.

## Wunsch-Modus (Vorschau in der Verwaltung)

Die Verwaltung zeigt unter *Website & Wünsche* die veröffentlichte Seite in
einem Rahmen. Dort lässt sich auf eine Stelle tippen und ein Anpassungswunsch
eintippen; daraus wird eine Aufgabe in Quantus (Repo `ai-sync`).

Dafür bringt die Website zwei Dinge mit:

- `netlify.toml` erlaubt das Einbetten per
  `Content-Security-Policy: frame-ancestors` — nur für die eigenen
  Netlify-Adressen (`X-Frame-Options` gibt es dafür bewusst nicht mehr, das
  kennt nur „alles oder nichts").
- `assets/site.js` schaltet den Wunsch-Modus **nur** frei, wenn die Seite in
  einem Rahmen läuft **und** `?wunsch=1` in der Adresse steht. Dann meldet ein
  Klick den Abschnitt und das angetippte Element an die Verwaltung, statt zu
  navigieren. Für normale Besuche ist der Block wirkungslos.

## Was drin ist

**Inhalt & Funktion**
- Hero (Bild **oder** automatisch laufendes Video als Hintergrund), Lauftext-Ticker
- About mit Fakten-Leiste, Genres, Mixe (Link + optionales Embed)
- **Shows** — kommende Termine mit Datum, Venue, Ticket-Link und Status
  („Sold out", **„Gebucht"**); vergangene Termine klappen separat auf.
  Abgelaufene Termine verschwinden automatisch, auch ohne neuen Build.
  Bestätigt jemand in der Verwaltung eine Booking-Anfrage, steht der Termin
  ab dem nächsten Build als **gebucht** im Kalender.
- **Einseiter** — ausgeliefert wird alles auf einer Seite, das Menü springt zu
  den Abschnitten. Unter *Seiten* in der Verwaltung lässt sich die Website
  jederzeit wieder in mehrere Seiten aufteilen; Menü, Sitemap und Sprungmarken
  folgen automatisch.
- **Kalender** über den Terminen (immer sichtbar; Punkte sind Auftritte,
  gebuchte Tage blau, mit Legende darunter). **Freie kommende Tage sind
  anklickbar** und übernehmen das Datum direkt ins Booking-Formular.
- **Shop** — Produkte aus der Verwaltung (Bild, Preis, Beschreibung), Kauf
  über einen Bezahl-Link je Produkt (z. B. Stripe Payment Link); ohne Link
  „Per Mail bestellen“. Produkte erscheinen als Product-Daten fürs
  Google-Shopping-Schaufenster.
- **Funken** — aufsteigende, leuchtende Funken im Kopfbereich (reines CSS,
  passend zum Namen; ausgeblendet bei „Bewegung reduzieren“)
- **Hintergrundbild** hinter der ganzen Seite (in der Verwaltung wählbar) — die
  Inhalte stehen als freie, **eckige** Kacheln darauf, Bilder ohne Rahmen und
  ohne Rundungen, nur mit weichem Schatten
- Alle Texte in der **Ich-Form** — die Website spricht als Sam, nicht über ihn
- **Impressum & Datenschutz** unter `/legal/` bzw. `/de/rechtliches/` (drei Sprachen, im Footer
  verlinkt) — Vorlage auf Basis des tatsächlichen Setups (Netlify, Firebase,
  keine Tracker); vor dem offiziellen Launch einmal selbst durchlesen
- **App-Icons und Web-Manifest** — beim „Zum Home-Bildschirm hinzufügen"
  erscheint das Blitz-Logo statt eines Screenshots
- **Drei Sprachen** — Englisch unter `/`, Deutsch unter `/de/`, Französisch
  unter `/fr/`. Umschalter im **Fussbereich**, `hreflang`-Verweise und
  `xhtml:link` in der Sitemap. Übersetzt wird in der Verwaltung (auf Wunsch von
  Claude); fehlt eine Stelle, steht dort der englische Text.
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
