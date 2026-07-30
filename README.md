# Kassenbelege (Easyverein)

Ein per `<iframe>` einbettbares Widget zum Erfassen von Kassenbelegen: Foto oder PDF hochladen,
Claude liest Aussteller, Datum, Betrag, Belegnummer und eine passende Buchungskonto-Kategorie aus,
nach kurzer Prüfung werden in Easyverein automatisch ein **Beleg** (Invoice mit `isReceipt=true`,
PDF-Anhang) und die zugehörige **Buchung** auf dem Bankkonto "Kasse" angelegt (verlinkt über
`relatedInvoice`).

## Einbindung

```html
<iframe
  src="https://stephankurz.github.io/llp-kasse-belege/"
  style="width:100%; height:800px; border:0;">
</iframe>
```

Kein eigener Login: Die einbettende Webseite ist die Sicherheitsgrenze (gleiches Prinzip wie bei
Termine-Suche, Schulkontakte-Editor und Jahresbudgets).

## Ablauf

1. Beleg (Foto: JPG/PNG, oder PDF) per Drag&Drop oder Dateiauswahl hochladen.
2. Fotos werden im Browser auf max. 2000px Kantenlänge verkleinert und als JPEG neu kodiert.
3. Die Edge Function `kasse-beleg-analysieren` schickt das Bild/PDF an Claude und extrahiert:
   Aussteller, Datum, Bruttobetrag, Art (Ausgabe/Einnahme), Belegnummer (falls sichtbar), eine
   Kurzbeschreibung sowie einen Vorschlag für das Buchungskonto.
4. Die extrahierten Felder werden editierbar angezeigt - **bitte prüfen**, bevor "Beleg + Buchung
   anlegen" geklickt wird. Es entstehen dabei sofort echte Buchungen in Easyverein.
5. Nach Bestätigung legt `kasse-beleg-anlegen` in Easyverein an:
   - Einen **Beleg** (`/invoice/`, `isReceipt: true`, `kind: expense|revenue`) mit dem Foto/PDF als
     Anhang (Fotos werden dafür serverseitig in ein minimales einseitiges PDF gewrappt, da
     Easyverein für Invoice-Anhänge nur PDF akzeptiert).
   - Eine **Buchung** (`/booking/`) auf dem Bankkonto "Kasse" (`bankAccount`), mit dem passenden
     Gegenkonto (`billingAccount`) aus der festen Kategorienliste unten, Betrag negativ bei
     Ausgaben, Datum = Belegdatum, verlinkt mit dem Beleg über `relatedInvoice`.
   - Ein Protokolleintrag in der Supabase-Tabelle `kasse_belege_log` (Audit-Trail, auch bei
     Fehlern - dann mit Status `fehler` und der genauen Fehlermeldung).

## Kontenmodell

Ermittelt am 2026-07-30 per Live-Abfrage gegen die Easyverein-API aus der tatsächlichen
Buchungshistorie des Bankkontos "Kasse" (id `214741342`):

| Konto (Gegenkonto) | Nr. | id |
|---|---|---|
| Betrieb Geschäftsstelle (Standard) | 2668 | 62809 |
| Porto | 2702 | 37048 |
| Mitgliederpflege, -versammlung | 2800 | 37054 |
| Geldtransit | 705 | 54661 |
| Büromaterial | 2701 | 37047 |
| Zuwendungen Dritter (zur freien Verfügung) | 2412 | 37042 |
| Sonstige Kosten | 2704 | 37051 |
| Bücher und Leselernmaterialien | 2804 | 37056 |
| Öffentlichkeitsarbeit | 2810 | 37057 |
| Einrichtung Geschäftsstelle | 2664 | 37046 |

Kommt ein neues Gegenkonto hinzu, das für Kassenbuchungen genutzt werden soll, muss die Liste in
beiden Edge Functions (`kasse-beleg-analysieren` und `kasse-beleg-anlegen`) manuell ergänzt werden.

## Architektur

Statisches HTML (`index.html`, kein Build-Schritt, keine Abhängigkeiten) plus zwei Supabase Edge
Functions im Projekt `llp-schuldaten`:

| Edge Function | Zweck |
|---|---|
| `kasse-beleg-analysieren` | Schickt Bild/PDF an die Anthropic API (Claude), extrahiert Felder + Kategorievorschlag. Legt nichts an. |
| `kasse-beleg-anlegen` | Nimmt die bestätigten Felder + Datei entgegen, legt Beleg + Buchung in Easyverein an, protokolliert in `kasse_belege_log`. |

Beide Functions laufen server-seitig, weil `EV_API_KEY_BOOKING` (Finanz-Scope) und
`ANTHROPIC_API_KEY` niemals im Browser landen dürfen.
