# Sam Sparking — Website

Statische One-Page-Website, bereit für Netlify. Inhalte 1:1 aus dem offiziellen Presskit 2026.

## Echte Fotos einsetzen (wichtig!)

Die Bilder in `img/` sind momentan **Platzhalter** (dunkle Bühnenlicht-Grafiken).
Ersetze sie einfach durch die Sarto-Photography-Fotos — **gleicher Dateiname, Datei überschreiben**, fertig:

| Datei              | Empfehlung                                              |
|--------------------|---------------------------------------------------------|
| `img/hero.jpg`     | Bestes Querformat-Bild: Sam am Pult, Crowd/Laser (ca. 2000px breit) |
| `img/about.jpg`    | Portrait im Hochformat                                   |
| `img/gallery-01..12.jpg` | 12 Lieblingsbilder gemischt (03, 06, 09, 12 = Hochformat, Rest Querformat) |

Tipp: Bilder vorher auf max. ~2000px Breite verkleinern und als JPG (Qualität ~80) speichern, dann lädt die Seite schnell (gut für SEO).

## Presskit

Lege das PDF unter `presskit/sam-sparking-presskit-2026.pdf` ab (Download-Button im Booking-Bereich verweist darauf).

## Mixcloud

Der "Listen on Mixcloud"-Button zeigt auf `mixcloud.com/samsparking/euphoric-melodic-hardstyle-rec/`.
Falls der Mix unter einem anderen Namen veröffentlicht ist, den Link in `index.html` (Abschnitt "Sound") anpassen.

## Deploy auf Netlify

1. Auf app.netlify.com → "Add new site" → "Deploy manually" → diesen Ordner (bzw. das ZIP entpackt) reinziehen.
2. Domain verbinden: Site settings → Domain management → Custom domain → `samsparking.ch` eintragen und beim Registrar die angezeigten DNS-Einträge setzen. HTTPS macht Netlify automatisch.
3. Nach dem ersten Deploy bei Google Search Console die Domain anmelden und `https://www.samsparking.ch/sitemap.xml` einreichen.

## SEO — schon eingebaut

- Title, Meta-Description, Canonical, Open-Graph/Twitter-Tags
- Strukturierte Daten (schema.org Person mit Genres, Kontakt, Ort)
- `sitemap.xml` + `robots.txt`
- Semantisches HTML (h1/h2-Struktur), Alt-Texte auf allen Bildern, Lazy-Loading
- Cache-Header über `netlify.toml`

Wenn die Domain nicht `samsparking.ch` wird: die Domain in `index.html` (canonical + og:url + JSON-LD), `sitemap.xml` und `robots.txt` ersetzen.
