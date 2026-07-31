// Nimmt ein einzelnes Belegbild/PDF entgegen (base64) und laesst Claude (Anthropic API) die
// relevanten Felder extrahieren: Aussteller, Datum, Betrag, Art (Ausgabe/Einnahme), Belegnummer
// (falls auf dem Beleg sichtbar), eine Kurzbeschreibung sowie einen Vorschlag fuer das
// Buchungskonto (Gegenkonto) aus der festen Liste unten - diese Liste wurde am 2026-07-30 aus der
// tatsaechlichen Buchungshistorie des Bankkontos "Kasse" abgeleitet (siehe kasse-beleg-anlegen.ts,
// dort ist dieselbe Liste zur Validierung nochmal hinterlegt). Bei Rechnungen extrahiert Claude
// zusaetzlich IBAN/BIC/Anschrift des Ausstellers, falls sichtbar - die Adressbuch-Suche selbst
// macht das Widget live ueber die Funktion kasse-adresse-suchen (siehe dort), nicht diese Funktion.
// Reine Analyse, legt selbst noch nichts in Easyverein an - das uebernimmt kasse-beleg-anlegen nach
// Bestaetigung im Widget.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Bekannte Gegenkonten fuer Kasse-Buchungen (Nummer/Name/id), Stand 2026-07-30.
const BUCHUNGSKONTEN = [
  { id: 62809, nr: 2668, name: "Betrieb Geschäftsstelle" },
  { id: 37048, nr: 2702, name: "Porto" },
  { id: 37054, nr: 2800, name: "Mitgliederpflege, -versammlung" },
  { id: 54661, nr: 705, name: "Geldtransit" },
  { id: 37047, nr: 2701, name: "Büromaterial" },
  { id: 37042, nr: 2412, name: "Zuwendungen Dritter (zur freien Verfügung)" },
  { id: 37051, nr: 2704, name: "Sonstige Kosten" },
  { id: 37056, nr: 2804, name: "Bücher und Leselernmaterialien" },
  { id: 37057, nr: 2810, name: "Öffentlichkeitsarbeit" },
  { id: 37046, nr: 2664, name: "Einrichtung Geschäftsstelle" },
];

const ANTHROPIC_MODEL = "claude-sonnet-5";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY ist als Function-Secret nicht konfiguriert." }, 500);
  }

  try {
    const body = await req.json();
    const { mimeType, fileBase64 } = body as { mimeType?: string; fileBase64?: string };

    if (!mimeType || !fileBase64) {
      return jsonResponse({ error: "mimeType und fileBase64 sind erforderlich." }, 400);
    }

    const isPdf = mimeType === "application/pdf";
    const isImage = mimeType === "image/jpeg" || mimeType === "image/png";
    if (!isPdf && !isImage) {
      return jsonResponse(
        { error: `Nicht unterstuetzter Dateityp: ${mimeType}. Erlaubt: PDF, JPEG, PNG.` },
        400,
      );
    }

    const kontenListe = BUCHUNGSKONTEN.map((k) => `- "${k.name}" (Nr. ${k.nr})`).join("\n");

    const contentBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: fileBase64 } }
      : { type: "image", source: { type: "base64", media_type: mimeType, data: fileBase64 } };

    const instructions = `Du analysierst einen Kassenbeleg (Kassenbon oder Quittung) eines gemeinnützigen Vereins. ` +
      `Extrahiere die folgenden Felder und antworte AUSSCHLIESSLICH mit einem einzigen JSON-Objekt, ` +
      `ohne Markdown-Codeblock, ohne zusätzlichen Text:\n\n` +
      `{\n` +
      `  "aussteller": string,        // Name des Geschäfts/der Firma/der Person auf dem Beleg\n` +
      `  "datum": string,             // Datum im Format YYYY-MM-DD (Belegdatum, nicht heutiges Datum)\n` +
      `  "betrag": number,            // Bruttogesamtbetrag als Zahl mit Punkt als Dezimaltrennzeichen, z.B. 13.50\n` +
      `  "art": "expense" | "revenue", // "expense" = Ausgabe (Normalfall, Geld verlässt die Kasse), ` +
      `"revenue" nur bei eindeutiger Einnahme (z.B. Pfand-/Leergut-Gutschrift, Spende in bar)\n` +
      `  "belegnummer": string | null, // Bon-/Rechnungs-/Belegnummer falls auf dem Beleg sichtbar, sonst null\n` +
      `  "kurzbeschreibung": string,  // sehr kurze Beschreibung, was gekauft/bezahlt wurde (max. 60 Zeichen)\n` +
      `  "buchungskonto_nr": number,  // die Kontonummer aus folgender Liste, die inhaltlich am besten passt:\n` +
      `${kontenListe}\n` +
      `  // Falls nichts eindeutig passt, verwende 2668 ("Betrieb Geschäftsstelle") als Standard.\n` +
      `  "belegtyp": "kassenbeleg" | "rechnung", // "kassenbeleg": Kassenbon/Quittung mit sofortiger ` +
      `Barzahlung - typische Signale: Kassierer, TSE-/Kassen-Seriennummer, TSE-Signatur, Rückgeld/` +
      `Bargeld erhalten, Bon-Nummer. "rechnung": Rechnung mit Zahlungsziel, noch nicht bezahlt - ` +
      `typische Signale: IBAN/Bankverbindung des Ausstellers, Fälligkeits-/Zahlungsziel-Datum ` +
      `("bitte begleichen Sie ... bis zum ..."), Rechnungsnummer, Kundennummer, KEIN TSE/Kassierer/` +
      `Rückgeld. Im Zweifel "kassenbeleg" verwenden.\n` +
      `  "confidence": "high" | "medium" | "low", // wie sicher du dir bei Betrag und Datum bist\n` +
      `  "iban": string | null,       // IBAN des Ausstellers, falls auf dem Beleg sichtbar (nur bei Rechnungen üblich)\n` +
      `  "bic": string | null,        // BIC des Ausstellers, falls sichtbar\n` +
      `  "strasse": string | null,    // Straße + Hausnummer des Ausstellers, falls sichtbar\n` +
      `  "plz": string | null,        // Postleitzahl des Ausstellers, falls sichtbar\n` +
      `  "ort": string | null         // Ort des Ausstellers, falls sichtbar\n` +
      `}`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [contentBlock, { type: "text", text: instructions }],
          },
        ],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return jsonResponse({ error: `Anthropic-API-Fehler (${resp.status}): ${text}` }, 502);
    }

    const data = await resp.json();
    const textContent = (data.content ?? []).find((b: { type: string }) => b.type === "text")?.text ?? "";

    let parsed: Record<string, unknown>;
    try {
      const match = textContent.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : textContent);
    } catch {
      return jsonResponse(
        { error: "Konnte Antwort von Claude nicht als JSON parsen.", raw: textContent },
        502,
      );
    }

    const konto = BUCHUNGSKONTEN.find((k) => k.nr === Number(parsed.buchungskonto_nr)) ?? BUCHUNGSKONTEN[0];
    const aussteller = String(parsed.aussteller ?? "");

    return jsonResponse(
      {
        aussteller,
        datum: parsed.datum ?? null,
        betrag: typeof parsed.betrag === "number" ? parsed.betrag : Number(parsed.betrag) || null,
        art: parsed.art === "revenue" ? "revenue" : "expense",
        belegnummer: parsed.belegnummer ?? null,
        kurzbeschreibung: parsed.kurzbeschreibung ?? "",
        buchungskonto: konto,
        belegtyp: parsed.belegtyp === "rechnung" ? "rechnung" : "kassenbeleg",
        confidence: parsed.confidence ?? "medium",
        buchungskonten_optionen: BUCHUNGSKONTEN,
        iban: parsed.iban ?? null,
        bic: parsed.bic ?? null,
        strasse: parsed.strasse ?? null,
        plz: parsed.plz ?? null,
        ort: parsed.ort ?? null,
      },
      200,
    );
  } catch (e) {
    return jsonResponse({ error: String(e instanceof Error ? e.message : e) }, 502);
  }
});
