# Website-Audit Sam Sparking — Stand 10.08.2026

Geprüft und umgesetzt wurde in drei Repositories:

| Repo | Rolle |
|---|---|
| `Laurin-Rusterholz/s-mi` | die Website (Generator + gebaute Seiten + Server-Endpunkte) |
| `Laurin-Rusterholz/verwaltung-djsamsparkling` | die Verwaltung (Eingabemaske, Firebase) |
| `Laurin-Rusterholz/Beispiel-Sami` | Vorführ-Fassung (Kopie beider, unter `/site/` und `/verwaltung/`) |

Alle Änderungen liegen im Zweig `claude/website-audit-implementation-rgnv02`.

> **Was NICHT live geprüft werden konnte.** Aus dieser Arbeitsumgebung sind
> `samsparking.ch`, `djsamsparkling.netlify.app` und die Firebase-Datenbank
> durch die Netzsperre nicht erreichbar (`403` vom Egress-Proxy, siehe unten
> „Nachweise“). Geprüft wurde deshalb gegen den Code und die **wirklich
> gebauten Dateien**: Build, Tests, erzeugtes HTML, Regelkette in
> `netlify.toml`. Kein Punkt unten ist als „live gesehen“ ausgegeben.

---

## 1. Routing: Startseite zu, Unterseiten offen

Vorgabe: `/` bleibt „Coming soon“, `/booking/` und `/shop/` sowie `/api/*`
müssen öffentlich mit 200 antworten, ohne die eigentliche Website freizulegen.

Gelöst ausschliesslich in `netlify.toml`. Netlify nimmt die **erste passende
Regel** — die Reihenfolge ist die Lösung:

| # | Regel | Wirkung |
|---|---|---|
| 1 | `/robots.txt`, `/sitemap.xml` → 200 | Suchmaschinen sehen keine 5xx-robots.txt |
| 2 | `/api/*` → `/.netlify/functions/:splat` (200, force) | Endpunkte immer erreichbar |
| 3 | `/`, `/index.html`, `/de/`, `/de/index.html`, `/fr/`, `/fr/index.html` → `/coming-soon.html` (503, force) | nur die Startseiten |
| 4 | *(keine Regel)* | alles Übrige wird normal ausgeliefert |

Der gesamte Website-Inhalt (About, Shows, Referenzen, Galerie) steht
ausschliesslich **auf den Startseiten**. Es genügt darum, genau diese zu
sperren. Die frühere Regel `from = "/*"` mit `force = true` ist weg — sie hätte
die Unterseiten mitgesperrt.

**Nachweis:** `node scripts/routen.test.mjs` liest die `[[redirects]]` aus
`netlify.toml`, spielt Netlifys Erste-Regel-gewinnt-Logik nach und prüft für
24 Adressen Status *und* Zieldatei:

```
Routen: 24 Adressen gegen netlify.toml geprueft.
  zu (503 → coming-soon.html):  /, /de/, /fr/ samt index.html
  offen (200):                  /booking/, /shop/ in allen drei Sprachen,
                                /api/booking, /api/order, /api/stripe-webhook,
                                Impressum, CSS/JS, Presskit, robots, sitemap
  gesperrt (404):               /scripts/*, /content/*
```

Der Test prüft zusätzlich, dass keine der sechs Startseiten-Adressen mit 200
erreichbar ist und dass keine Regel `from = "/*"` mit `force` zurückkommt.

**Dabei gefunden und behoben:** `/scripts/*` und `/content/*` zeigten zwar auf
`404.html`, aber **ohne `force = true`**. Netlify wendet eine Weiterleitung nur
an, wenn keine Datei auf die Adresse passt — die Dateien liegen aber da
(`publish = "."`). Der Quelltext des Generators und der Inhalts-Schnappschuss
waren damit öffentlich herunterladbar. Beide Regeln haben jetzt `force = true`.

**Zwei Regeln überstimmen die Verwaltung** — beide stehen in
`content/korrekturen.json` und sind dort einzeln abschaltbar:

* `shop.sichtbar` — sonst gäbe es die Seite `/shop/` nicht und die Adresse
  liefe auf `404`.
* `heroShows` — die Zahl neben „Shows“ steht fest auf `30`. In der Datenbank
  stand zuletzt `2`. Ohne diese Regel wäre der Wert beim nächsten Speichern
  in der Verwaltung wieder ein anderer, weil `content/site.json` bei jedem
  Build aus der Datenbank überschrieben wird.

**Folge, die man kennen muss:** Auf `/booking/` und `/shop/` steht im Menü ein
Link „Home“. Der führt auf `/` und zeigt dort die Wartungsseite — so gewollt,
aber es ist eine Sackgasse, solange die Startseite zu ist.

---

## 2. Die Prüfliste, Punkt für Punkt

| # | Punkt | Status | Wo |
|---|---|---|---|
| 1 | Schreibweise „Sam Sparking“ | **erfüllt** | `schreibweise()` in `scripts/build.mjs` korrigiert bei *jedem* Build jeden Text; der Hostname `djsamsparkling.netlify.app` wird ausgenommen |
| 2a | Header: Name korrekt | **erfüllt** | `<h1><span class="sp">S A M</span> Sparking</h1>` |
| 2b | Instagram-Icon aus dem Header | **behoben** | Kopf-Zeichen sind jetzt *opt-in* (`inHeader === true`); zusätzlich zieht `nachziehen()` den alten Zustand einmal nach |
| 2c | Shows nicht prominent ohne Termine | **behoben** | Der Abschnitt entsteht nur bei einem **kommenden** Termin (vorher: bei irgendeinem) — ohne ihn fällt auch der Menüpunkt weg |
| 3a | Hero: „Clubs & Festivals“ → „Shows“ | **behoben** | Kennzahl-Aufschrift, inkl. DE/FR |
| 3c | Hero: Kennzahl nennt 30 Shows | **behoben** | In der Datenbank stand `2` — die Seite zeigte „2+ SHOWS“. `heroShows` in `korrekturen.json` setzt den Wert auf `30`; gefunden wird die Kennzahl über ihre Aufschrift, nie über ihren Platz in der Liste |
| 3b | Hero: nur „Turning energy into euphoria“, in Blau | **behoben** | `hero.meta` (Genre-Zeile) wird nicht mehr gelesen und aus dem Inhalt geräumt; `.hero-sub .tag` steht in `var(--spark)` = `#2e6bff` |
| 4 | Experience- und Genres-Abschnitt entfernen | **erfüllt** | Beide waren schon nicht mehr baubar; jetzt sind auch die Eingabemasken aus der Verwaltung raus |
| 5a | Show „Aftersun, Luzern, 29. August“ | **behoben** | Ort war „Herisau“; Name hatte ein Leerzeichen am Ende |
| 5b | Leere Shows dominieren die Navigation nicht | **behoben** | siehe 2c |
| 6 | Referenzen | **behoben, zwei Entscheide offen** | Neue Liste, siehe unten. Ersatz für IVY und der fünfte Eintrag der oberen Gruppe sind **nicht** entschieden |
| 7 | Galerie: Aftermovies und weitere Bilder aufklappbar | **behoben** | Aftermovies in `<details>`; weitere Bilder hatten schon einen Aufklapp-Knopf. Ohne hinterlegte Videos erscheint der Block gar nicht (statt „noch nichts da“) |
| 8a | Booking nach oben / eigenständiger Bereich | **behoben** | Eigene Seite `/booking/`, erster Menüpunkt auf jeder Seite |
| 8b | „Preferred setup / CDJs“ weg | **erfüllt** | Rider war schon entfernt; im gebauten HTML kein Treffer |
| 8c | Alle Felder verpflichtend | **erfüllt** | 8 Pflichtfelder + Rechenaufgabe; serverseitig erneut geprüft |
| 8d | Dankesmeldung mit gutem Kontrast | **behoben** | Eigener Kasten mit Haken, `#b6f5d8` auf abgesetztem Grund, grösser und fetter |
| 8e | Kontakt/Instagram integriert | **behoben** | Der Kontakt-Abschnitt (E-Mail, Telefon, Kanäle) steht jetzt auch auf `/booking/` |
| 8f | Gestaltung nach Vorbild jackdylan.ch | **teilweise** | Umgesetzt ist die *Struktur*: eigene Seite, kompakter Kopf, Formular als Hauptsache, eigenständiges responsives Layout. Die Seite selbst konnte nicht angesehen werden (Netzsperre) — was ich nicht gesehen habe, kann ich nicht als übernommen ausgeben |
| 9a | Shop: alle Kundendaten zwingend | **behoben** | Artikel, Anzahl, Name, E-Mail, Strasse, PLZ, Ort, Land — alle Pflicht, im Browser und auf dem Server |
| 9b | Keine Bestellung nur per E-Mail | **behoben** | `mailto:`-Bestellung und der Ein-Artikel-Bezahllink sind raus |
| 9c | Shop in eigener Seite/Route | **behoben** | `/shop/` statt Abschnitt auf der langen Startseite |
| 9d | Zahlung per Stripe vorbereitet, kein Bank-/TWINT-QR | **behoben** | TWINT-/Bank-Angaben und der QR-Block sind ersatzlos weg |
| 10 | Footer: TikTok, Instagram, Spotify, Mixcloud | **teilweise — extern** | Instagram und Mixcloud verlinkt; TikTok und Spotify: siehe „Extern zu erledigen“ |
| 11 | Neue Seite `/booking` mit Navigation, Layout, Formular, Erfolgsmeldung | **behoben** | inkl. `/de/booking/` und `/fr/booking/`; die alte Umleitung `/booking/* → /#booking` ist weg (sie hätte genau diese Adresse abgefangen) |
| 12 | E-Mail bei Booking und Bestellung serverseitig an info@samsparking.ch | **behoben** | drei Netlify-Funktionen, siehe Abschnitt 4 |
| 13 | Echter Stripe Payment Link für den CHF-35-Artikel | **extern zu konfigurieren** | Integration vollständig gebaut und getestet; **der echte Link ist noch extern anzulegen** |

### Referenzen — neue Liste

**Hervorgehoben oben** (die vier ausdrücklich genannten Events, in genau der
genannten Reihenfolge):

1. Kugl, St. Gallen · 2. Sektor 11, Zürich · 3. Ultrawild Festival, St. Gallen ·
4. BBC, Gossau

**Darunter klein und alphabetisch**, ohne Bündel-Überschriften: Aftersun
Festival (Luzern, *neu*), Amadeusbar (Herisau), B9 eventlocation (St. Gallen),
Dorffest Herisau, Firehouse Party Wittenbach, **IVY** (St. Gallen,
*unverändert — siehe offene Entscheide*), Jugendopenair (Wattwil), Monoevents
(St. Gallen), **Picante** (St. Gallen, *neu*), The Q (Schaan, FL),
Turnunterhaltung Sirnach, Winterzauber Bazenheid, Xploration Events (Glarus).

#### Zwei Entscheide fehlen — nicht geraten

1. **Wodurch wird IVY ersetzt?** Die Vorgaben nennen *beides*: „Jugendopenair
   St. Gallen statt IVY“ **und** „Club Eden SG statt IVY“. Das schliesst sich
   aus. IVY bleibt deshalb unverändert stehen, bis entschieden ist, welcher
   Eintrag gilt. Eine frühere Fassung hatte hier eigenmächtig Club Eden
   eingesetzt und zusätzlich ein „Jugendopenair St. Gallen“ erfunden — beides
   ist zurückgenommen.
2. **Wer ist der fünfte in der oberen Gruppe?** Verlangt sind „Top 5“, genannt
   sind vier: Kugl, Sektor 11, Ultrawild Festival, BBC. Es stehen darum vier
   oben. Ein fünfter Eintrag wird nicht erfunden.

#### Warum die Liste bis zum 10.08.2026 gar nicht ankam

Die Ersetzung greift nur, solange die Liste in der Verwaltung noch einem
bekannten Altstand entspricht — sonst würde sie eine selbst gepflegte Liste
überschreiben. Dieser Massstab (`alteReferenzen`) war auf **eine** Liste
festgelegt, und zwar auf die falsche: in der Datenbank stand die 7er-Liste
(Kugl, Sektor 11, The Q, IVY, BBC, B9, Ultrawild Festival), verglichen wurde
gegen eine 15er-Liste. Der Abgleich traf nie zu, die Ersetzung lief still ins
Leere, und die Website zeigte weiter die alte Liste.

Drei Änderungen daran:

* `alteReferenzen` hält jetzt **mehrere** bekannte Altstände.
* Verglichen wird **ohne Rücksicht auf die Reihenfolge** — die Verwaltung
  sortiert beim Speichern um, ein Vergleich Platz für Platz wäre schon
  dadurch hinfällig.
* Passt die Liste zu keinem Stand **und** ist sie nicht schon die gewünschte,
  **warnt der Build**. Genau diese Stille war das Problem: eine wirkungslose
  Regel sah aus wie eine erfüllte.

---

## 3. Warum die Formulare vorher nichts verschickt haben

Das war der schwerwiegendste Befund.

**Vorher:** `assets/site.js` schickte die Formulardaten per `fetch` direkt an
`https://…firebasedatabase.app/samsparking/inquiries.json`. Daraus folgte:

1. **Es ging nie eine E-Mail raus.** Eine Anfrage lag in der Datenbank und wurde
   erst gesehen, wenn jemand die Verwaltung öffnete.
2. **Die Schreib-Adresse der Datenbank stand im Quelltext jeder Seite.** Wer sie
   las, konnte hineinschreiben.
3. **Es gab ein „Danke“ ohne Zustellung.** Der Spam-Schutz meldete bei einer
   Ausfüllzeit unter 2,5 Sekunden Erfolg und *sendete nicht* — genau die
   Attrappe, die es nicht geben darf.

**Jetzt:** Die Formulare senden an die eigenen Endpunkte `/api/booking` und
`/api/order`. Dort wird geprüft, in denselben Eingang gelegt wie bisher (die
Verwaltung sieht keinen Unterschied) **und** eine E-Mail an
`info@samsparking.ch` verschickt. Honeypot und Ausfüllzeit werden mitgesendet
und **serverseitig** ausgewertet. Schlagen Eingang *und* E-Mail fehl, antwortet
der Endpunkt mit `502` und die Seite zeigt den Fehlertext mit der
E-Mail-Adresse — kein „Danke“.

---

## 4. Die Server-Endpunkte

`netlify/functions/`, reines ESM ohne Abhängigkeiten.

| Adresse | Datei | Aufgabe |
|---|---|---|
| `POST /api/booking` | `booking.mjs` | Anfrage prüfen → Eingang + E-Mail |
| `POST /api/order` | `order.mjs` | Bestellung prüfen → Eingang + E-Mail → Stripe-Bezahladresse |
| `POST /api/stripe-webhook` | `stripe-webhook.mjs` | Zahlungsmeldung von Stripe |

**Webhook — die drei Dinge, die stimmen müssen:**

* **Signatur** über dem *rohen* Rumpf (nicht über geparstem JSON), HMAC-SHA256
  mit `STRIPE_WEBHOOK_SECRET`, Vergleich zeitkonstant (`timingSafeEqual`).
  Ohne gültige Unterschrift `400`. Fehlt das Geheimnis, wird gar nichts
  angenommen (`503`) — ein ungeprüftes Zahlungssignal ist schlimmer als keines.
* **Alter** — Meldungen älter als 300 s werden abgelehnt (Wiedereinspielen).
* **Idempotenz** — jede Ereignis-Id wird unter `stripeEvents/<id>` vermerkt;
  eine schon vermerkte Meldung wird nur quittiert, nicht erneut ausgeführt.
  Stripe wiederholt bis zu einer 2xx-Antwort; ohne das käme zu einer Zahlung
  ein Stapel gleicher E-Mails. *(Gelesen-dann-geschrieben; die Realtime
  Database kennt kein „nur schreiben, wenn nichts da ist“. Stripe wiederholt
  nacheinander, nicht gleichzeitig — im schlimmsten Fall geht eine Bestätigung
  doppelt raus, nie wird doppelt kassiert.)*

Die Bezahladresse wird nur aus einem **echten** Stripe-Host gebaut
(`*.stripe.com` / `*.link.com`); eine falsch gesetzte Umgebungsvariable
schickt niemanden irgendwohin. Die Bestellnummer fährt als
`client_reference_id` mit, damit der Webhook Zahlung und Bestellung
zusammenbringt.

### Umgebungsvariablen (Netlify → Site settings → Environment variables)

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `RESEND_API_KEY` | **ja**, sonst keine E-Mail | Schlüssel von [resend.com](https://resend.com). Ohne ihn läuft alles weiter, aber es wird nur in den Eingang gelegt und eine Warnung protokolliert |
| `MAIL_TO` | nein | Empfänger, Vorgabe `info@samsparking.ch` |
| `MAIL_FROM` | **ja** für echten Versand | Absender einer bei Resend **verifizierten Domain**, z. B. `Sam Sparking <website@samsparking.ch>`. Die Vorgabe `onboarding@resend.dev` funktioniert nur zum Ausprobieren |
| `STRIPE_PAYMENT_LINK_URL` | **ja** für Bezahlung | der echte Payment Link, siehe unten |
| `STRIPE_WEBHOOK_SECRET` | **ja** für Zahlungsbestätigung | `whsec_…` aus dem Stripe-Dashboard |
| `INBOX_API_URL` | nein | Eingang, Vorgabe ist der bisherige `…/samsparking/inquiries.json` |
| `INBOX_API_TOKEN` | **offen — nicht „nein“** | die einzige Anmeldung, die der Server-Code kennt (`?auth=…`); ohne ihn ist der Schreibzugriff nicht angemeldet. Der **Zähler** wird live mit **HTTP 401** abgewiesen; für die übrigen Pfade liegt keine Messung vor. Was wirklich zu tun ist, steht unter „Server-Zugang zur Datenbank“ — mit ihm allein ist es nicht getan. Die Angabe „nein“ stand hier bis zum 17.09.2026 und war falsch |
| `CONTENT_API_URL` | schon gesetzt | Inhaltsquelle für den Build (steht in `netlify.toml`) |

### Server-Zugang zur Datenbank — Stand 17.09.2026

**Befund (Netlify, Production, Functions/zaehler, 17.09.2026):**

```
14:46:15  ERROR  [zaehler] nicht gezaehlt: HTTP 401
14:48:10  ERROR  [zaehler] nicht gezaehlt: HTTP 401
14:48:23  ERROR  [zaehler] nicht gezaehlt: HTTP 401
```

Der Aufruf kam an; abgewiesen hat die Realtime Database.

**Der Livestand der Regeln** (Firebase Console, 17.09.2026, nur **gelesen**,
nichts geändert). Unter `samsparking` steht:

```
samsparking
  .read   "auth != null"
  .write  "auth != null"
  content   { .read: true }
  media     { .read: true }
```

Mehr nicht — **keine** Unterregeln für `inquiries`, `stats` oder
`stripeEvents`, **keine** `.validate`. In der Realtime Database gilt eine Regel
für den ganzen Teilbaum darunter; Kinder können sie nicht zurücknehmen. Damit
gilt `auth != null` für **alle** diese Pfade.

> **Die Regeldatei im Repository beschreibt den Livezustand NICHT.**
> `verwaltung-djsamsparkling/firebase/database.rules.json` ist eine Vorlage, die
> laut ihrem eigenen Kommentar von Hand ausgerollt werden muss — das ist nicht
> geschehen. Alles, was dort an Feinheiten steht (Sitzungsnachweis je Pfad,
> `.validate`, Anlegen ohne Anmeldung), gilt live **nicht**.

**Was daraus folgt — belegt, nicht gefolgert.** Unsere Functions schicken ohne
`INBOX_API_TOKEN` gar keine Anmeldung mit. `auth` ist dann `null`, und die
Live-Regel verlangt `auth != null`:

| Aussage | Stand |
|---|---|
| Der Server schreibt **unangemeldet** | **belegt** — der Code hängt nur `?auth=` an, und zwar nur, wenn die Variable gesetzt ist |
| Die Live-Regel verlangt eine Anmeldung für `inquiries`, `stats`, `stripeEvents` | **belegt** — Konsolenstand oben |
| Der **Zähler** wird abgewiesen, HTTP 401 | **gemessen** — die drei Protokollzeilen oben |
| Ein unangemeldeter Schreibzugriff auf `stats` wird abgelehnt | **in der Regelsimulation belegt** — siehe unten |
| Ein unangemeldeter Schreibzugriff auf `inquiries` wird abgelehnt | **in der Regelsimulation belegt** — auch mit vollständigem Eintrag |
| Anfragen und Bestellungen scheitern **in der Produktion** | **nicht gemessen.** Die Regel lässt nichts anderes zu, ein Protokoll dazu gibt es aber nicht |
| Es geht eine **E-Mail** raus | **nicht belegt.** `RESEND_API_KEY` und `MAIL_FROM` sind gesetzt und der Weg ist im Mock geprüft — ein echter Versand wurde bis heute nicht ausgelöst |
| Eine **Zahlung** läuft durch | **nicht belegt.** Es wurde keine ausgelöst |

**Regelsimulation** (Firebase Rules Playground, 17.09.2026 — reine Simulation,
es wurde **kein** Datensatz angelegt):

```
set /samsparking/stats/__codex_rules_simulation__          ohne Anmeldung
  → Simulated write denied   (Regel Zeile 70: /samsparking  .write  auth != null)

set /samsparking/inquiries/__codex_rules_simulation__      ohne Anmeldung,
    mit name / email / createdAt
  → Simulated write denied
```

Damit ist die fehlende Anmeldung **auch für die Anfragen-Ablage** an den heute
geltenden Regeln belegt — nicht nur für den Zähler. Was damit weiterhin **nicht**
belegt ist: ein echter Mailversand und eine echte Zahlung.

**Welche Anmeldung die REST-Schnittstelle kennt.** Laut
[Firebase-Doku](https://firebase.google.com/docs/database/rest/auth) sind das
zwei verschiedene Wege — der Code kennt nur den ersten:

| Weg | wie mitgegeben | was hineingehört | Lebensdauer |
|---|---|---|---|
| `?auth=…` | Adresszeile | ein **Firebase-ID-Token** oder ein **Legacy-Datenbankgeheimnis** | ID-Token rund eine Stunde; Geheimnis dauerhaft |
| OAuth2-Zugriffstoken | `Authorization: Bearer …` **oder** `?access_token=…` | Zugriffstoken eines **Dienstkontos** | rund eine Stunde |

Ein Dienstkonto-Token gehört **nicht** in `?auth=`.

**Die Implementierungslücke.** `netlify/functions/_lib.mjs`, `zaehler.mjs` und
`stripe-webhook.mjs` hängen einen **festen** Wert aus der Umgebung an und haben
keinerlei Mechanismus, ein kurzlebiges Anmeldemerkmal zu beschaffen oder zu
erneuern. Beide brauchbaren Merkmale laufen aber nach rund einer Stunde ab. Ein
dauerhaft laufender Betrieb muss also **erneuern** — sonst funktioniert eine
einmal eingetragene Variable höchstens bis zum nächsten Ablauf.

Dauerhaft überdauert in `?auth=` nur das Legacy-Datenbankgeheimnis. Das ist
hier die schlechteste aller Möglichkeiten: es hat **alle** Rechte am ganzen
Projekt und hebelt jede Regel aus.

Das ist **nicht bloss Konfiguration.** Solange dieser Mechanismus fehlt, lässt
sich ein tragfähiger Serverzugang gar nicht einrichten. Die Lücke sitzt im
Code; sie zu schliessen braucht Code — zusätzlich zu den Entscheidungen, die
ausserhalb dieses Repositorys fallen.

**Warum hier nichts blind gesetzt werden darf — gemeinsames Projekt.** Die
Datenbank gehört nicht allein zu dieser Website. Weitere **private Bereiche
desselben Projekts** stehen ebenfalls auf `auth != null`. Eine gewöhnliche
Firebase-Server-Identität erfüllt diese Bedingung überall — sie käme damit an
**mehr als Sämis Daten**. Ein Token einzutragen, „damit der Zähler wieder
läuft“, vergrössert also den Zugriff weit über diese Website hinaus.

**IAM und Sicherheitsregeln sind zweierlei.** Ein Dienstkonto, das sich per
OAuth2 anmeldet, wird **nicht** automatisch durch die Regeln der Realtime
Database beschränkt. Was es darf, entscheidet seine **IAM-Rolle**; mit
Datenbank-Administrationsrechten geht der Zugriff an den Regeln vorbei — wie
beim Admin-SDK. Ein Regelentwurf ist deshalb **kein Zugangsschutz**, solange
das Identitätsmodell nicht dazu passt.

**Was zu klären ist — in dieser Reihenfolge, und nichts davon ohne
ausdrückliche Freigabe:**

1. **Rechtemodell entscheiden, bevor irgendetwas gesetzt wird.** Welche
   Identität darf was, und wie wird sie auf `samsparking` begrenzt, ohne die
   übrigen Bereiche des gemeinsamen Projekts zu öffnen? Ohne diese Antwort ist
   jeder Token zu weitreichend.
2. **Erst danach** die passenden Regeln formulieren und von Hand ausrollen
   (vollständige Regeldatei des Projekts). Öffentlich beschreibbar darf keiner
   der Pfade werden.
3. **Den Code um Beschaffung und Erneuerung des Anmeldemerkmals ergänzen** —
   siehe „Implementierungslücke“. Ein einmal eingetragener Wert genügt nicht.
4. **Die Variable nur in der Produktion setzen** (Netlify → Environment
   variables), nicht in Vorschau-Deploys.
5. **Nachsehen:** `GET /api/booking` meldet `eingangSchluesselGesetzt` als
   ja/nein — nie einen Wert.

**Kein neuer weitreichender Zugang ist freigegeben, und Regeländerungen sind es
ebenfalls nicht.** Bis Punkt 1 und 2 entschieden sind, bleibt der Zustand, wie
er ist: der Zähler zählt nicht, und für die übrigen Ablagen gilt dieselbe
Regel.

**Was die Vorlage zusätzlich enthielte, falls sie je ausgerollt wird:** eine
`.validate` am Eingang, die für jeden Eintrag `name` (mindestens zwei Zeichen),
eine E-Mail-Adresse und `createdAt` verlangt. Der Stripe-Beleg füllt `name` und
`email` aus `customer_details`; liefert Stripe keinen Namen, stünde dort ein
leerer Text und der Eintrag fiele durch. Live gibt es diese Prüfung **nicht** —
vermerkt, damit es beim Ausrollen nicht übersehen wird.

### Provider-Setup

**Resend** (E-Mail): Konto anlegen → Domain `samsparking.ch` hinzufügen → die
angezeigten DNS-Einträge (SPF/DKIM) beim Domain-Anbieter eintragen → API-Key
erzeugen → als `RESEND_API_KEY` hinterlegen, `MAIL_FROM` auf eine Adresse
dieser Domain setzen.

**Stripe** (Bezahlung):

1. Produkt anlegen: Name, Preis **CHF 35.00**.
2. **Payment links → New** auf dieses Produkt. Zahlungsarten Karte, TWINT,
   Apple/Google Pay aktivieren; Lieferadresse braucht es dort **nicht** (die
   hat das Bestellformular schon).
3. Adresse (`https://buy.stripe.com/…`) als `STRIPE_PAYMENT_LINK_URL` in
   Netlify hinterlegen.
4. **Developers → Webhooks → Add endpoint**:
   `https://samsparking.ch/api/stripe-webhook`, Ereignis
   `checkout.session.completed`. Das angezeigte `whsec_…` als
   `STRIPE_WEBHOOK_SECRET` hinterlegen.

---

## 5. Extern zu erledigen

1. **Echter Stripe-Link noch extern anzulegen.** Ohne Zugang zum
   Stripe-Dashboard und ohne Live-Schlüssel konnte kein Link erzeugt werden.
   Eine Fantasie-Adresse wurde bewusst **nicht** eingetragen: ohne
   `STRIPE_PAYMENT_LINK_URL` nimmt das Formular die Bestellung an, meldet sie
   per E-Mail und sagt offen, dass die Bezahlung noch aussteht. Der fehlende
   Handgriff ist Schritt 1–3 oben.
2. **Artikelname im Shop.** Der CHF-35-Artikel heisst in der Datenbank noch
   `Beispiel` — und `/shop/` ist jetzt öffentlich. Umbenennen in der
   Verwaltung → Shop → Ware. *(Die Tippreste `as` / `asd` in Beschreibung,
   Bildtext und Link räumt der Build selbst weg.)*
3. **Wodurch wird IVY ersetzt?** Die Vorgaben nennen „Jugendopenair
   St. Gallen“ **und** „Club Eden SG“ als Ersatz — das schliesst sich aus.
   Bis das entschieden ist, bleibt IVY stehen.
4. **Fünfter Eintrag der hervorgehobenen Gruppe.** „Top 5“, aber nur vier
   Events genannt. Es stehen vier oben.
5. **TikTok- und Spotify-Adresse.** Beide sind im Projekt nirgends hinterlegt
   und liessen sich von hier aus nicht nachschlagen. Geratene Adressen wären
   tote Links geworden. Eintragen in der Verwaltung → Kontakt → Kanäle
   (Instagram und Mixcloud stehen schon, TikTok und Spotify sind als leere
   Einträge vorbereitet — ohne Adresse verlinkt die Website einen Kanal nicht).
6. **`RESEND_API_KEY` und `MAIL_FROM`** setzen, sonst kommt keine E-Mail an.
7. **`STRIPE_WEBHOOK_SECRET`** setzen, sonst antwortet der Webhook mit `503`.
8. **Startseite freigeben**, wenn es so weit ist: die sechs
   Startseiten-Regeln in `netlify.toml` auskommentieren (Block „TEILWARTUNG“).

---

## 6. Geänderte Dateien

**`s-mi`**

| Datei | Was |
|---|---|
| `netlify.toml` | Teilwartung, `/api/*`, `[functions]`, `force` auf den Sperr-Regeln, alte `/booking/*`-Umleitung entfernt |
| `scripts/build.mjs` | Shop wieder baubar; Shows-Nav an kommenden Terminen; Kopf-Zeichen opt-in; Hero ohne Genre-Zeile; Menü aus Seiten + Abschnitten; Referenzen zweistufig; Aftermovies aufklappbar; Formulare an eigene Endpunkte; Bezahlung Stripe statt TWINT/QR; neue Korrekturregeln; `FORMS_DEMO` |
| `content/korrekturen.json` | Referenzen, Kennzahlen, Show-Ort, Kanäle, Seitenaufteilung, Währung, Platzhalter, Shop-Sichtbarkeit |
| `assets/site.js` | kein falsches „Danke“ mehr; Weiterleitung zu Stripe; Vorführ-Modus |
| `assets/site.css` | Anspruch in Blau; Referenz-Bündel; Aftermovie-Klappe; Dankesmeldung |
| `netlify/functions/*` | **neu** — `_lib.mjs`, `booking.mjs`, `order.mjs`, `stripe-webhook.mjs` |
| `scripts/api.test.mjs` | **neu** — Endpunkte Ende zu Ende |
| `scripts/links.test.mjs` | **neu** — Wege und Formulare im gebauten HTML |
| `scripts/routen.test.mjs` | **neu** — Regelkette aus `netlify.toml` |
| `scripts/build.test.mjs` | neue Korrekturregeln abgedeckt |

**`verwaltung-djsamsparkling`** — `public/js/content.js` (Genre-Zeile weg,
Referenzen mit Hervorhebung und Bündel, Shop auf Stripe, Kanäle, Erklärung
statt Datenbank-Adresse), `public/js/app.js` (Masken „Sound & Genres“ und
„Erlebnis“ entfernt), `public/js/fields.js` + `public/admin.css` (`note()`),
`public/defaults/site.json` (drei Seiten, Referenzen, Kennzahlen, Währung,
Kanäle inkl. leerem TikTok/Spotify).

**`Beispiel-Sami`** — `scripts/quellen-holen.mjs` (Endpunkte und Wartungsseite
werden nicht mehr mitkopiert), `netlify.toml` (`FORMS_DEMO=1`), dazu die
übernommenen Stände unter `site/` und `verwaltung/`.

---

## 7. Nachweise

```
$ node scripts/build.mjs
[build] index.html          38.4 kB  (about, shows, references, gallery, contact)
[build] booking/index.html  20.2 kB  (booking, contact)
[build] shop/index.html     17.4 kB  (shop)
… dasselbe unter /de/ und /fr/
[build] fertig — 3 Sprache(n) (en, de, fr), 3 Seite(n) je Sprache

$ node scripts/build.test.mjs      # Inhalts-Korrekturen
$ node scripts/api.test.mjs        # Endpunkte Ende zu Ende
$ node scripts/links.test.mjs      # Wege und Formulare im gebauten HTML
$ node scripts/routen.test.mjs     # Regelkette aus netlify.toml
```

`api.test.mjs` fängt jeden ausgehenden Aufruf ab und hält fest:

* vollständige Anfrage → **ein** Eintrag im Eingang **und** **eine** E-Mail an
  `info@samsparking.ch`, Antwortadresse ist die anfragende Person;
* unvollständige Anfrage (E-Mail ohne `@`, zu kurzer Name, kaputtes Datum,
  leere Nachricht) → `422`, **nichts** geht raus;
* Spam (Honeypot gefüllt oder unter 1 s) → unauffällige Antwort, nichts geht raus;
* Eingang *und* E-Mail fallen aus → `502`, kein „Danke“;
* nur der Eingang fällt aus → `200`, die E-Mail trägt die Anfrage allein;
* Bestellung ohne Strasse/PLZ/Ort/Land/E-Mail/Name/Artikel → `422`;
* Bezahladresse nur aus einem echten Stripe-Host, mit `client_reference_id`;
* Webhook: gültige Unterschrift → verarbeitet; falsche → `400`; fehlende →
  `400`; eine Stunde alt → `400`; Wiederholung → nur quittiert, **keine**
  zweite E-Mail; ohne Geheimnis → `503`.

`links.test.mjs` prüft alle 14 gebauten Seiten: jeder Menüpunkt und jede
Sprungmarke führt irgendwohin, jedes Formularfeld ist Pflicht, jedes Formular
hat Erfolgs- *und* Fehlermeldung, kein Formular sendet woandershin als an
`/api/booking` bzw. `/api/order`, und `firebasedatabase.app` steht in keinem
Quelltext mehr.

**Was fehlt:** Ein echter HTTP-Aufruf gegen die veröffentlichte Seite. Der
Egress-Proxy dieser Umgebung beantwortet `CONNECT samsparking.ch:443` mit
`403`, ebenso für `djsamsparkling.netlify.app` und die Firebase-Adresse. Nach
dem Deploy sind das die drei Handgriffe, die die Regeln bestätigen:

```
curl -sS -o /dev/null -w '%{http_code}\n' https://samsparking.ch/            # erwartet 503
curl -sS -o /dev/null -w '%{http_code}\n' https://samsparking.ch/booking/    # erwartet 200
curl -sS -o /dev/null -w '%{http_code}\n' https://samsparking.ch/shop/       # erwartet 200
curl -sS -X POST https://samsparking.ch/api/booking \
     -H 'content-type: application/json' -d '{}'                             # erwartet 422
```

Der letzte Aufruf ist der wichtigste: `422` beweist, dass der Endpunkt lebt
und prüft. Käme `404`, wären die Funktionen nicht deployt.
