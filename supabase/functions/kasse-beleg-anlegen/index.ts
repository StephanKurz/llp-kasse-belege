// Legt aus einem vom Nutzer bestaetigten Beleg (Felder + Datei) in Easyverein sowohl einen
// Beleg (Invoice mit isReceipt=true, PDF-Anhang) als auch die zugehoerige Buchung auf dem
// Bankkonto "Kasse" an, verlinkt beide (relatedInvoice) und protokolliert das Ergebnis in
// kasse_belege_log.
//
// Kontenmodell (Stand 2026-07-30, per Live-Abfrage gegen /bank-account/ und /booking/ ermittelt):
// - Bankkonto "Kasse" hat die id 214741342 (Feld `bankAccount` auf Booking) - das entspricht dem,
//   was im Verein als "die Kasse" bezeichnet wird (physischer Kassenbestand).
// - Das Gegenkonto (`billingAccount`) kategorisiert die Ausgabe/Einnahme fachlich (z.B. Porto,
//   Bueromaterial) - es ist NICHT das "Kasse"-Bilanzkonto selbst (das waere id 37039/Nr. 920 und
//   wuerde eine Buchung gegen sich selbst ergeben). Die Liste unten sind die Konten, die in der
//   echten Buchungshistorie des Kasse-Bankkontos tatsaechlich verwendet wurden.
//
// Beide EV-Endpunkte (/invoice/, /booking/) benoetigen den Finanz-Scope-Token EV_API_KEY_BOOKING
// (bereits als Function-Secret gesetzt, siehe llp-jahresbudgets).

const EV_BASE_URL = "https://easyverein.com/api/v2.0";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const KASSE_BANK_ACCOUNT_ID = 214741342;

// Kontaktgruppe "Lieferanten" (Kuerzel LIEF) im gemeinsamen Adressbuch (/contact-details/),
// Stand 2026-08-01 per Live-Abfrage gegen /contact-details-group/ ermittelt. Wird beim Neuanlegen
// eines Rechnungsstellers gesetzt, der noch nicht im Adressbuch existiert.
const LIEFERANTEN_GROUP_ID = 139361291;

const BUCHUNGSKONTEN: Record<number, { id: number; name: string }> = {
  2668: { id: 62809, name: "Betrieb Geschäftsstelle" },
  2702: { id: 37048, name: "Porto" },
  2800: { id: 37054, name: "Mitgliederpflege, -versammlung" },
  705: { id: 54661, name: "Geldtransit" },
  2701: { id: 37047, name: "Büromaterial" },
  2412: { id: 37042, name: "Zuwendungen Dritter (zur freien Verfügung)" },
  2704: { id: 37051, name: "Sonstige Kosten" },
  2804: { id: 37056, name: "Bücher und Leselernmaterialien" },
  2810: { id: 37057, name: "Öffentlichkeitsarbeit" },
  2664: { id: 37046, name: "Einrichtung Geschäftsstelle" },
};

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Easyverein liefert Validierungsfehler mal als Array von Strings (z.B. Eindeutigkeits-Konflikte:
// ["Dieser Wert existiert bereits:  Wert: X, Feld: invNumber"]), mal als Objekt {feld: [meldung]}.
// Macht daraus einen lesbaren deutschen Satz statt des generischen "konnte nicht angelegt werden".
function evErrorText(json: any): string {
  if (json == null) return "Unbekannter Fehler.";
  if (Array.isArray(json)) return json.join(" ");
  if (typeof json === "object") {
    if (typeof json.raw === "string") return json.raw;
    const parts: string[] = [];
    for (const [key, val] of Object.entries(json)) {
      parts.push(Array.isArray(val) ? `${key}: ${val.join(" ")}` : `${key}: ${val}`);
    }
    if (parts.length) return parts.join(" | ");
  }
  return String(json);
}

// Erkennt den Spezialfall "Belegnummer/invNumber bereits vergeben" (typischerweise durch
// doppeltes Anlegen desselben Belegs) und gibt dafuer eine konkrete, verstaendliche Meldung
// statt des generischen Easyverein-Textes zurueck.
function friendlyInvoiceError(json: any, invNumber: string): string {
  const text = evErrorText(json);
  if (text.includes("existiert bereits") && text.includes("invNumber")) {
    return `Dieser Beleg scheint bereits angelegt zu sein - die Belegnummer "${invNumber}" ist in Easyverein schon vergeben. Bitte in Easyverein pruefen, ob der Beleg schon existiert, bevor er erneut angelegt wird.`;
  }
  return `Easyverein-Fehler beim Anlegen des Belegs: ${text}`;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Baut ein minimales, gueltiges einseitiges PDF, das ein JPEG per DCTDecode direkt einbettet
// (kein Re-Encoding der Pixel noetig). Easyverein akzeptiert fuer Invoice-Anhaenge nur PDF, viele
// Kassenbelege kommen aber als Foto (JPEG) vom Widget - daher dieser Wrapper statt einer externen
// PDF-Bibliothek (die es fuer Deno Edge Functions ohnehin nicht in einer schlanken Form gibt).
function wrapJpegAsPdf(jpeg: Uint8Array, width: number, height: number): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [0, 0, 0, 0, 0, 0];
  let pos = 0;

  function push(bytes: Uint8Array) {
    parts.push(bytes);
    pos += bytes.length;
  }
  function pushStr(s: string) {
    push(enc.encode(s));
  }

  pushStr("%PDF-1.4\n");

  offsets[1] = pos;
  pushStr(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);

  offsets[2] = pos;
  pushStr(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);

  offsets[3] = pos;
  pushStr(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> ` +
      `/MediaBox [0 0 ${width} ${height}] /Contents 5 0 R >>\nendobj\n`,
  );

  offsets[4] = pos;
  pushStr(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  push(jpeg);
  pushStr(`\nendstream\nendobj\n`);

  const content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ`;
  offsets[5] = pos;
  pushStr(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  const xrefOffset = pos;
  pushStr(`xref\n0 6\n0000000000 65535 f \n`);
  for (let i = 1; i <= 5; i++) {
    pushStr(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  pushStr(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function evRequest(
  method: string,
  url: string,
  apiKey: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: any }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get("Retry-After") ?? "2");
      await new Promise((r) => setTimeout(r, (retryAfter || 2) * 1000));
      continue;
    }
    const text = await resp.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { ok: resp.ok, status: resp.status, json };
  }
  throw new Error("Easyverein: zu viele 429-Antworten, abgebrochen.");
}

// Kassenminus-Pruefung: ermittelt den aktuellen Kassenbestand (Anfangsbestand des laufenden
// Jahres aus kasse_jahresanfangsbestand + Summe aller Kasse-Buchungen des laufenden Jahres) -
// dieselbe Rechnung wie im Kassenblatt (siehe kassenblatt-laden), hier aber ohne Bezug auf ein
// angezeigtes Jahr, sondern immer bezogen auf das aktuelle Kalenderjahr, da eine neue Ausgabe
// immer den JETZIGEN Bestand betrifft.
async function ermittleAktuellenKassenbestand(
  evApiKey: string,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<number | null> {
  const jahr = new Date().getFullYear();
  const anfangsResp = await fetch(
    `${supabaseUrl}/rest/v1/kasse_jahresanfangsbestand?jahr=eq.${jahr}&select=anfangsbestand`,
    { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } },
  );
  const anfangsRows = await anfangsResp.json();
  if (!Array.isArray(anfangsRows) || anfangsRows.length === 0) return null;
  const anfangsbestand = Number(anfangsRows[0].anfangsbestand);

  const jahrStart = `${jahr}-01-01`;
  const jahrEnde = `${jahr}-12-31`;
  let bestand = anfangsbestand;
  let url: string | null = `${EV_BASE_URL}/booking/?bankAccount=${KASSE_BANK_ACCOUNT_ID}&ordering=date&limit=100`;
  while (url) {
    const res = await evRequest("GET", url, evApiKey);
    if (!res.ok) throw new Error(evErrorText(res.json));
    for (const b of res.json.results || []) {
      const d = String(b.date || "").slice(0, 10);
      if (d >= jahrStart && d <= jahrEnde) bestand += Number(b.amount);
    }
    url = res.json.next || null;
  }
  return Math.round(bestand * 100) / 100;
}

async function evUploadAttachment(
  invoiceId: number,
  pdfBytes: Uint8Array,
  filename: string,
  apiKey: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  const form = new FormData();
  form.set("path", new Blob([pdfBytes], { type: "application/pdf" }), filename);

  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch(`${EV_BASE_URL}/invoice/${invoiceId}/`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get("Retry-After") ?? "2");
      await new Promise((r) => setTimeout(r, (retryAfter || 2) * 1000));
      continue;
    }
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text };
  }
  throw new Error("Easyverein: zu viele 429-Antworten beim Datei-Upload, abgebrochen.");
}

// Deutscher Anzeigename je ISO-Laendercode fuer das Freitextfeld "companyCountry" - deckt die
// Nachbarlaender ab, die bei einem in Reutlingen ansaessigen Verein realistischerweise als
// Rechnungssteller vorkommen koennen (z.B. IBAN aus Oesterreich/der Schweiz). Alles andere faellt
// auf "DE" zurueck (siehe countryCodeFromIban).
const COUNTRY_NAMES: Record<string, string> = {
  DE: "Deutschland", AT: "Österreich", CH: "Schweiz", FR: "Frankreich",
  NL: "Niederlande", IT: "Italien", ES: "Spanien", LU: "Luxemburg", BE: "Belgien",
};

// Die ersten zwei Zeichen einer IBAN sind immer der ISO-3166-Laendercode (z.B. "DE89..." ->
// "DE") - eine einfache, zuverlaessige Quelle, um den Laendercode zu bestimmen, ohne dass Claude
// ihn separat erkennen muesste. Liefert null, wenn keine plausible IBAN vorliegt.
function countryCodeFromIban(iban?: string | null): string | null {
  const cleaned = (iban || "").replace(/\s+/g, "").toUpperCase();
  const match = cleaned.match(/^([A-Z]{2})\d{2}/);
  return match ? match[1] : null;
}

// Sucht den Rechnungssteller im gemeinsamen Adressbuch (nur relevant fuer belegtyp="rechnung" -
// eine Rechnung braucht eine echte Adressbuch-Verknuepfung (relatedAddress) statt nur den freien
// receiver-Text, sonst landet sie nicht korrekt als offener Posten und ist nicht mit der dort
// hinterlegten IBAN verbunden). Wird niemand gefunden, legt die Funktion den Aussteller neu als
// Firma in der Kontaktgruppe "Lieferanten" an (inkl. Anschrift/IBAN/Laendercode, falls Claude sie
// aus der Rechnung extrahieren konnte). Gibt null zurueck, wenn weder Suche noch Anlegen
// funktionieren - der Aufrufer faellt dann auf den reinen receiver-Text zurueck, statt den ganzen
// Ablauf abzubrechen (die Adressverknuepfung ist eine Verbesserung, keine harte Voraussetzung).
async function findOrCreateContact(
  aussteller: string,
  info: { strasse?: string | null; plz?: string | null; ort?: string | null; iban?: string | null; bic?: string | null },
  apiKey: string,
): Promise<{ id: number; name: string; gefunden: boolean } | null> {
  if (!aussteller || !aussteller.trim()) return null;

  const searchRes = await evRequest(
    "GET",
    `${EV_BASE_URL}/contact-details/?search=${encodeURIComponent(aussteller)}&limit=5`,
    apiKey,
  );
  if (searchRes.ok && Array.isArray(searchRes.json?.results) && searchRes.json.results.length > 0) {
    const match = searchRes.json.results[0];
    return { id: match.id, name: match.name || match.companyName || aussteller, gefunden: true };
  }

  // Laendercode selbst bestimmen (aus der IBAN, falls vorhanden), im Zweifel "DE" - ohne dieses
  // Feld (company_country_code) bleibt der Kontakt in Easyverein sonst auf dem Enum-Wert "other"
  // stehen, unabhaengig vom Freitext companyCountry.
  const countryCode = countryCodeFromIban(info.iban) || "DE";
  const createBody: Record<string, unknown> = {
    _isCompany: true,
    name: aussteller,
    companyName: aussteller,
    contactDetailsGroups: [LIEFERANTEN_GROUP_ID],
    companyStreet: info.strasse || "",
    companyZip: info.plz || "",
    companyCity: info.ort || "",
    companyCountry: COUNTRY_NAMES[countryCode] || COUNTRY_NAMES.DE,
    company_country_code: countryCode,
    iban: info.iban || "",
    bic: info.bic || "",
  };
  let createRes = await evRequest("POST", `${EV_BASE_URL}/contact-details/`, apiKey, createBody);
  if (!createRes.ok) {
    // Haeufigster Grund: eine von Claude falsch gelesene oder ungueltige IBAN/BIC laesst die
    // Validierung scheitern. Lieber den Kontakt ohne Bankdaten anlegen (Personal kann die IBAN
    // spaeter in Easyverein nachtragen) als die ganze Adressverknuepfung aufzugeben.
    delete createBody.iban;
    delete createBody.bic;
    createRes = await evRequest("POST", `${EV_BASE_URL}/contact-details/`, apiKey, createBody);
  }
  if (!createRes.ok) return null;
  return { id: createRes.json.id, name: aussteller, gefunden: false };
}

async function logResult(
  supabaseUrl: string,
  serviceRoleKey: string,
  row: Record<string, unknown>,
): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/kasse_belege_log`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const evApiKey = Deno.env.get("EV_API_KEY_BOOKING");
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!evApiKey) {
    return jsonResponse({ error: "EV_API_KEY_BOOKING ist als Function-Secret nicht konfiguriert." }, 500);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Ungueltiges JSON im Request-Body." }, 400);
  }

  const {
    dateiname,
    mimeType,
    fileBase64,
    width,
    height,
    aussteller,
    datum,
    betrag,
    art,
    belegnummer,
    kurzbeschreibung,
    buchungskonto_nr,
    belegtyp,
    iban,
    bic,
    strasse,
    plz,
    ort,
    contact_override_id,
    contact_override_name,
  } = body ?? {};

  if (!mimeType || !fileBase64) {
    return jsonResponse({ error: "mimeType und fileBase64 sind erforderlich." }, 400);
  }
  if (!datum || typeof betrag !== "number" || betrag <= 0) {
    return jsonResponse({ error: "datum und ein positiver betrag sind erforderlich." }, 400);
  }
  const artNorm = art === "revenue" ? "revenue" : "expense";
  // "rechnung" = Rechnung mit Zahlungsziel, noch nicht bezahlt -> nur Beleg, keine Buchung (kein
  // Geld hat die Kasse verlassen). "kassenbeleg" (Default) = sofort bar bezahlt -> wie bisher
  // Beleg + Buchung. Vom Nutzer im Widget vorbelegt durch die Analyse, aber frei aenderbar.
  const belegtypNorm = belegtyp === "rechnung" ? "rechnung" : "kassenbeleg";
  const konto = BUCHUNGSKONTEN[Number(buchungskonto_nr)];
  if (belegtypNorm === "kassenbeleg" && !konto) {
    return jsonResponse(
      { error: `Unbekannte Buchungskonto-Nummer: ${buchungskonto_nr}. Erlaubt sind: ${Object.keys(BUCHUNGSKONTEN).join(", ")}` },
      400,
    );
  }

  // Kassenminus-Pruefung: eine Ausgabe (sofort bar bezahlt) darf den Kassenbestand nie negativ
  // werden lassen. Bewusst VOR jeder Easyverein-Schreiboperation (Invoice/Booking) geprueft, damit
  // bei Ablehnung ueberhaupt nichts angelegt wird - kein halb angelegter Beleg ohne Buchung.
  // Einnahmen und Rechnungen (Zahlungsziel, noch keine Kasse-Bewegung) sind nie betroffen.
  if (belegtypNorm === "kassenbeleg" && artNorm === "expense") {
    let aktuellerBestand: number | null;
    try {
      aktuellerBestand = await ermittleAktuellenKassenbestand(evApiKey, SUPABASE_URL, SERVICE_ROLE_KEY);
    } catch (e) {
      return jsonResponse(
        {
          error: `Kassenbestand konnte nicht ermittelt werden (${e instanceof Error ? e.message : e}). Buchung wurde sicherheitshalber nicht angelegt.`,
        },
        502,
      );
    }
    if (aktuellerBestand == null) {
      return jsonResponse(
        {
          error: `Kassenbestand konnte nicht ermittelt werden - für das laufende Jahr ist im Kassenblatt noch kein Anfangsbestand hinterlegt. Buchung wurde sicherheitshalber nicht angelegt.`,
        },
        409,
      );
    }
    const neuerBestand = Math.round((aktuellerBestand - betrag) * 100) / 100;
    if (neuerBestand < 0) {
      return jsonResponse(
        {
          error: `Diese Ausgabe (${betrag.toFixed(2)} €) würde den Kassenbestand auf ${neuerBestand.toFixed(2)} € drücken - der Kassenbestand darf nicht negativ werden. Aktueller Kassenbestand: ${aktuellerBestand.toFixed(2)} €. Die Buchung wurde nicht angelegt.`,
          code: "kassenminus",
        },
        409,
      );
    }
  }

  let pdfBytes: Uint8Array;
  try {
    const rawBytes = base64ToBytes(fileBase64);
    if (mimeType === "application/pdf") {
      pdfBytes = rawBytes;
    } else if (mimeType === "image/jpeg") {
      if (!width || !height) {
        return jsonResponse({ error: "width und height sind fuer JPEG-Belege erforderlich." }, 400);
      }
      pdfBytes = wrapJpegAsPdf(rawBytes, Number(width), Number(height));
    } else {
      return jsonResponse({ error: `Nicht unterstuetzter Dateityp: ${mimeType}. Erlaubt: PDF, JPEG.` }, 400);
    }
  } catch (e) {
    return jsonResponse({ error: `Fehler beim Aufbereiten der Datei: ${e instanceof Error ? e.message : e}` }, 500);
  }

  const invNumber = belegnummer && String(belegnummer).trim()
    ? String(belegnummer).trim()
    : `KASSE-${datum}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

  // Adressbuch-Verknuepfung NUR bei Rechnungen (siehe findOrCreateContact-Kommentar) - ein
  // Kassenbeleg ist sofort bar bezahlt und braucht keine offene-Posten-Verknuepfung. Eine manuell
  // im Widget ausgewaehlte Adresse (z.B. ein Mitglied, das die Rechnung bereits privat verauslagt
  // hat) hat Vorrang vor der automatischen Aussteller-Suche.
  let contact: { id: number; name: string; gefunden: boolean } | null = null;
  if (belegtypNorm === "rechnung") {
    if (contact_override_id) {
      contact = { id: Number(contact_override_id), name: contact_override_name || aussteller || "", gefunden: true };
    } else {
      contact = await findOrCreateContact(aussteller ?? "", { strasse, plz, ort, iban, bic }, evApiKey);
    }
  }

  const logBase = {
    dateiname: dateiname ?? null,
    betrag,
    datum,
    aussteller: aussteller ?? "",
    art: artNorm,
    belegtyp: belegtypNorm,
    buchungskonto_nr: konto ? Number(buchungskonto_nr) : null,
    buchungskonto_name: konto ? konto.name : null,
    belegnummer: invNumber,
    beschreibung: kurzbeschreibung ?? "",
    contact_id: contact ? contact.id : null,
    contact_gefunden: contact ? contact.gefunden : null,
  };

  // 1) Invoice (Beleg) im Entwurfsstatus anlegen - relatedAddress (falls ein Kontakt gefunden
  // oder neu angelegt wurde) verknuepft die Rechnung mit dem Adressbuch-Eintrag samt der dort
  // hinterlegten IBAN; receiver bleibt zusaetzlich als Anzeigetext gesetzt (auch als Fallback,
  // falls die Adressbuch-Verknuepfung mal nicht moeglich war).
  const createInvoiceBody: Record<string, unknown> = {
    isDraft: true,
    isReceipt: true,
    kind: artNorm,
    receiver: aussteller || "Unbekannt",
    totalPrice: betrag,
    tax: 0,
    taxRate: 0,
    gross: false,
    date: datum,
    invNumber,
    description: kurzbeschreibung ?? "",
  };
  if (contact) {
    createInvoiceBody.relatedAddress = contact.id;
  }

  const invoiceRes = await evRequest("POST", `${EV_BASE_URL}/invoice/`, evApiKey, createInvoiceBody);
  if (!invoiceRes.ok) {
    const reason = friendlyInvoiceError(invoiceRes.json, invNumber);
    await logResult(SUPABASE_URL, SERVICE_ROLE_KEY, {
      ...logBase,
      status: "fehler",
      fehler: `Invoice-Erstellung fehlgeschlagen (${invoiceRes.status}): ${reason}`,
    });
    return jsonResponse({ error: reason, details: invoiceRes.json }, 502);
  }
  const invoiceId = invoiceRes.json.id;

  // 1b) Belegposition (InvoiceItem) anlegen - die EV API verlangt mindestens eine Position,
  // bevor der Entwurfsstatus aufgehoben werden kann (steuer-/brutto-Einstellungen muessen zur
  // Invoice passen, siehe python-easyverein KNOWN_ISSUES). Titel "Belegposition" entspricht der
  // Konvention, die in der bestehenden Buchungshistorie dieses Vereins bereits verwendet wird.
  const createItemBody = {
    relatedInvoice: invoiceId,
    title: "Belegposition",
    quantity: 1,
    unitPrice: betrag,
    totalPrice: betrag,
    taxRate: 0,
    gross: false,
  };
  const itemRes = await evRequest("POST", `${EV_BASE_URL}/invoice-item/`, evApiKey, createItemBody);
  if (!itemRes.ok) {
    const reason = evErrorText(itemRes.json);
    await logResult(SUPABASE_URL, SERVICE_ROLE_KEY, {
      ...logBase,
      status: "fehler",
      easyverein_invoice_id: invoiceId,
      fehler: `Belegposition konnte nicht angelegt werden (${itemRes.status}): ${reason}`,
    });
    return jsonResponse(
      {
        error: `Beleg wurde als Entwurf angelegt (id ${invoiceId}), aber die Belegposition ist fehlgeschlagen: ${reason}. Bitte in Easyverein pruefen.`,
        easyverein_invoice_id: invoiceId,
        details: itemRes.json,
      },
      502,
    );
  }

  // 2) PDF-Anhang hochladen
  const uploadRes = await evUploadAttachment(invoiceId, pdfBytes, dateiname || `beleg-${invoiceId}.pdf`, evApiKey);
  if (!uploadRes.ok) {
    await logResult(SUPABASE_URL, SERVICE_ROLE_KEY, {
      ...logBase,
      status: "fehler",
      easyverein_invoice_id: invoiceId,
      fehler: `Datei-Upload fehlgeschlagen (${uploadRes.status}): ${uploadRes.text}`,
    });
    return jsonResponse(
      {
        error: `Beleg wurde angelegt (id ${invoiceId}), aber der Datei-Upload ist fehlgeschlagen: ${uploadRes.text}. Bitte in Easyverein pruefen.`,
        easyverein_invoice_id: invoiceId,
        details: uploadRes.text,
      },
      502,
    );
  }

  // 3) Entwurfsstatus aufheben
  const undraftRes = await evRequest("PATCH", `${EV_BASE_URL}/invoice/${invoiceId}/`, evApiKey, { isDraft: false });
  if (!undraftRes.ok) {
    const reason = evErrorText(undraftRes.json);
    await logResult(SUPABASE_URL, SERVICE_ROLE_KEY, {
      ...logBase,
      status: "fehler",
      easyverein_invoice_id: invoiceId,
      fehler: `Entwurfsstatus konnte nicht aufgehoben werden (${undraftRes.status}): ${reason}`,
    });
    return jsonResponse(
      {
        error: `Beleg + Anhang wurden angelegt (id ${invoiceId}), aber der Entwurfsstatus konnte nicht aufgehoben werden: ${reason}. Bitte in Easyverein pruefen.`,
        easyverein_invoice_id: invoiceId,
        details: undraftRes.json,
      },
      502,
    );
  }

  // 4) Buchung auf Bankkonto "Kasse" anlegen, verknuepft mit dem Beleg - NUR bei Kassenbelegen.
  // Rechnungen mit Zahlungsziel sind noch nicht bezahlt, es hat also noch kein Geld die Kasse
  // verlassen: hier endet der Ablauf bewusst mit dem reinen Beleg, ohne Buchung.
  if (belegtypNorm === "rechnung") {
    await logResult(SUPABASE_URL, SERVICE_ROLE_KEY, {
      ...logBase,
      status: "angelegt",
      easyverein_invoice_id: invoiceId,
    });
    return jsonResponse(
      {
        ok: true,
        easyverein_invoice_id: invoiceId,
        belegtyp: "rechnung",
        adressbuch: contact ? { name: contact.name, gefunden: contact.gefunden } : null,
      },
      200,
    );
  }

  const amount = artNorm === "expense" ? -Math.abs(betrag) : Math.abs(betrag);
  const createBookingBody = {
    billingAccount: konto.id,
    bankAccount: KASSE_BANK_ACCOUNT_ID,
    amount,
    date: `${datum}T00:00:00`,
    receiver: aussteller || "",
    description: kurzbeschreibung ?? "",
    relatedInvoice: [invoiceId],
  };

  const bookingRes = await evRequest("POST", `${EV_BASE_URL}/booking/`, evApiKey, createBookingBody);
  if (!bookingRes.ok) {
    const reason = evErrorText(bookingRes.json);
    await logResult(SUPABASE_URL, SERVICE_ROLE_KEY, {
      ...logBase,
      status: "fehler",
      easyverein_invoice_id: invoiceId,
      fehler: `Buchung konnte nicht angelegt werden (${bookingRes.status}): ${reason}`,
    });
    return jsonResponse(
      {
        error: `Beleg (id ${invoiceId}) wurde vollstaendig angelegt, aber die Buchung ist fehlgeschlagen: ${reason}. Bitte in Easyverein manuell nachbuchen.`,
        easyverein_invoice_id: invoiceId,
        details: bookingRes.json,
      },
      502,
    );
  }
  const bookingId = bookingRes.json.id;

  await logResult(SUPABASE_URL, SERVICE_ROLE_KEY, {
    ...logBase,
    status: "angelegt",
    easyverein_invoice_id: invoiceId,
    easyverein_booking_id: bookingId,
  });

  return jsonResponse(
    {
      ok: true,
      easyverein_invoice_id: invoiceId,
      easyverein_booking_id: bookingId,
      buchungskonto: konto.name,
      betrag: amount,
      belegtyp: "kassenbeleg",
    },
    200,
  );
});
