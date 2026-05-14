import express from "express";
import OpenAI from "openai";
import Airtable from "airtable";
import fs from "fs";

function loadEnvFile(path = ".env", ignoredKeys = new Set()) {
  if (!fs.existsSync(path)) return;

  const env = fs.readFileSync(path, "utf8");

  for (const line of env.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    if (!key || ignoredKeys.has(key) || process.env[key]) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadEnvFile();
loadEnvFile("../skyspot/backend/.env", new Set(["PORT"]));

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));
app.use("/assets", express.static("assets"));

// --- Sanity checks (helps you debug fast in Render logs) ---
const REQUIRED_ENVS = ["OPENAI_API_KEY", "AIRTABLE_API_KEY", "AIRTABLE_BASE_ID", "AIRTABLE_TABLE_NAME"];
for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) console.warn(`[WARN] Missing env var: ${k}`);
}

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Airtable setup
const airtableBase =
  process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID
    ? new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID)
    : null;
const TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "Submissions";

// NOTE: These enum labels should match your Airtable Single Select options EXACTLY.
const SYSTEM_PROMPT = `
You are the SkySpot Travel Grievance intake assistant (SkySpot Airport Stress Line).

GOAL:
1) Let the user share a general travel grievance (open-ended).
2) Convert it into structured data for reporting.
3) Keep it short (<= 7 turns). Ask ONE question at a time.

FLOW:

1) First ask:
"What happened? Share your travel grievance in your own words (1–2 short sentences)."

2) Extract key details from the story:
- Airport (if mentioned)
- Outcome (Missed / Almost Missed / Stressed)
- Likely cause

3) If airport was NOT mentioned, ask:
"Which airport were you traveling through?"

4) Determine outcome:
- "Missed" if they missed the flight
- "Almost Missed" if they barely made it
- Otherwise "Stressed"

5) Determine the primary cause from the user’s story whenever possible.

Only ask the user to choose a cause if the story does not clearly indicate one.

Do NOT ask the user to confirm the cause if it is obvious from the story.

6) If the cause is unclear, ask:
"Which best fits the main issue?"

1) Traffic
2) TSA
3) Parking
4) Rideshare
5) Airline Delay
6) Gate Change
7) Baggage
8) Navigation
9) Cost/Fees
10) Underestimated timing
11) Other

7) Ask sentiment:
"How did the experience make you feel?"

Options:
Calm / Annoyed / Stressed / Angry / Anxious

8) Ask follow-up:
"Would you like us to follow up with you?"

If yes, ask for contact.
If no, set followup_opt_in = false.

9) Only ask leave-time question if the issue involved timing or arrival.
Otherwise set minutes_early_left_home = null.

Return final JSON only after all required fields are collected.

CAUSE options (must match EXACTLY):
"Traffic","TSA","Parking","Rideshare","Underestimated","Airline Delay","Gate Change","Baggage","Navigation","Cost/Fees","Other"

IMPORTANT RULES:
- Only ask "How early did you leave?" IF the story is about timing/arrival (missed/almost missed/late arrival).
  Otherwise set minutes_early_left_home = null and do NOT ask.
- Do NOT return final JSON unless ALL of these are known:
  airport, outcome, cause, story, sentiment, follow_up_opt_in
- Follow-up handling:
  - If user says "no", set follow_up_opt_in=false and contact=null.
  - If user says "yes" but provides no email/phone, ask again:
    "Please share your email or phone so we can follow up."

Keep the conversation concise and conversational.

Occasionally reassure the user about progress by briefly indicating that only a couple more questions remain.

Examples:
- "Thanks — just a couple quick questions left."
- "Got it. One more quick question."
- "Almost done — just one last thing."


- When asking the user to pick a cause, format options as a numbered list with one option per line.
  Do NOT use quotes or comma-separated lists.
  Example:
  "Which best fits?"
  1) Traffic
  2) TSA
  3) Parking
  ...

Return ONLY valid JSON when complete (no extra words, no markdown):
{
  "airport": string,
  "outcome": "Missed"|"Almost Missed"|"Stressed",
  "cause": "Traffic"|"TSA"|"Parking"|"Rideshare"|"Underestimated"|"Airline Delay"|"Gate Change"|"Baggage"|"Navigation"|"Cost/Fees"|"Other",
  "minutes_early_left_home": number|null,
  "story": string,
  "sentiment": "Calm"|"Annoyed"|"Stressed"|"Angry"|"Anxious",
  "follow_up_opt_in": boolean,
  "contact": string|null
}
`;

// More reliable than just checking { } at ends
function extractJsonObject(text) {
  const t = (text || "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  const candidate = t.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

// Optional health check
app.get("/health", (req, res) => res.json({ ok: true }));

const AIRPORT_DESTINATIONS = {
  ATL: "Hartsfield-Jackson Atlanta International Airport, Atlanta, GA",
  LAX: "Los Angeles International Airport, Los Angeles, CA",
  JFK: "John F. Kennedy International Airport, Queens, NY",
  MIA: "Miami International Airport, Miami, FL",
  DFW: "Dallas Fort Worth International Airport, Dallas, TX",
  SEA: "Seattle-Tacoma International Airport, Seattle, WA",
  BOS: "Boston Logan International Airport, Boston, MA",
  PHL: "Philadelphia International Airport, Philadelphia, PA",
  SFO: "San Francisco International Airport, San Francisco, CA",
  IAH: "George Bush Intercontinental Airport, Houston, TX",
  MCI: "Kansas City International Airport, Kansas City, MO",
};

const AIRPORT_COORDS = {
  ATL: { latitude: 33.6407, longitude: -84.4277 },
  LAX: { latitude: 33.9416, longitude: -118.4085 },
  JFK: { latitude: 40.6413, longitude: -73.7781 },
  MIA: { latitude: 25.7959, longitude: -80.2870 },
  DFW: { latitude: 32.8998, longitude: -97.0403 },
  SEA: { latitude: 47.4502, longitude: -122.3088 },
  BOS: { latitude: 42.3656, longitude: -71.0096 },
  PHL: { latitude: 39.8744, longitude: -75.2424 },
  SFO: { latitude: 37.6213, longitude: -122.3790 },
  IAH: { latitude: 29.9902, longitude: -95.3368 },
  MCI: { latitude: 39.2976, longitude: -94.7139 },
};

function parseGoogleDuration(duration) {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(duration || "");
  if (!match) return null;
  return Math.max(1, Math.round(Number(match[1]) / 60));
}

function getPlacesApiKey() {
  return process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
}

function getRoutesApiKey() {
  return process.env.GOOGLE_ROUTES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
}

app.post("/api/place-autocomplete", async (req, res) => {
  try {
    const { input, airport } = req.body || {};
    const normalizedInput = String(input || "").trim();
    const normalizedAirport = String(airport || "ATL").toUpperCase();
    const airportCoords = AIRPORT_COORDS[normalizedAirport] || AIRPORT_COORDS.ATL;

    if (normalizedInput.length < 2) {
      return res.json({ suggestions: [] });
    }

    const placesApiKey = getPlacesApiKey();

    if (!placesApiKey) {
      return res.status(500).json({ error: "Missing GOOGLE_PLACES_API_KEY or GOOGLE_MAPS_API_KEY" });
    }

    const googleResp = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": placesApiKey,
        "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text",
      },
      body: JSON.stringify({
        input: normalizedInput,
        includedRegionCodes: ["us"],
        regionCode: "us",
        locationBias: {
          circle: {
            center: airportCoords,
            radius: 50000,
          },
        },
      }),
    });

    if (!googleResp.ok) {
      const text = await googleResp.text().catch(() => "");
      console.error("Google Places Autocomplete failed:", googleResp.status, text);
      return res.status(502).json({ error: "places_api_failed" });
    }

    const data = await googleResp.json();
    const suggestions = (data.suggestions || [])
      .map((suggestion) => suggestion.placePrediction)
      .filter(Boolean)
      .map((prediction) => ({
        placeId: prediction.placeId,
        text: prediction.text?.text,
      }))
      .filter((prediction) => prediction.text);

    return res.json({ suggestions });
  } catch (err) {
    console.error("Place autocomplete API error:", err?.message || err);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/drive-time", async (req, res) => {
  try {
    const { origin, airport } = req.body || {};
    const normalizedAirport = String(airport || "").toUpperCase();
    const destination = AIRPORT_DESTINATIONS[normalizedAirport];

    if (!origin || !destination) {
      return res.status(400).json({ error: "origin and supported airport are required" });
    }

    const routesApiKey = getRoutesApiKey();

    if (!routesApiKey) {
      return res.status(500).json({ error: "Missing GOOGLE_ROUTES_API_KEY or GOOGLE_MAPS_API_KEY" });
    }

    const googleResp = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": routesApiKey,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
      },
      body: JSON.stringify({
        origin: { address: origin },
        destination: { address: destination },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE_OPTIMAL",
        units: "IMPERIAL",
      }),
    });

    if (!googleResp.ok) {
      const text = await googleResp.text().catch(() => "");
      console.error("Google Routes API failed:", googleResp.status, text);
      return res.status(502).json({ error: "routes_api_failed" });
    }

    const data = await googleResp.json();
    const route = data.routes?.[0];
    const minutes = parseGoogleDuration(route?.duration);

    if (!minutes) {
      return res.status(502).json({ error: "routes_api_missing_duration" });
    }

    return res.json({
      minutes,
      distanceMeters: route.distanceMeters ?? null,
      source: "google_routes",
    });
  } catch (err) {
    console.error("Drive time API error:", err?.message || err);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/stress", async (req, res) => {
  try {
    const { messages, source } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }
    if (!client) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const resp = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    });

    const text = resp.output_text || "";
    const parsed = extractJsonObject(text);

    // If it's NOT final JSON, just return the next question/message
    if (!parsed) {
      return res.json({ text, done: false });
    }
const rawMinutes = parsed.minutes_early_left;
const minutes =
  typeof rawMinutes === "number"
    ? rawMinutes
    : (typeof rawMinutes === "string" && rawMinutes.trim() !== "" && !isNaN(Number(rawMinutes)))
      ? Number(rawMinutes)
      : null;
    // --- If final JSON: save to Airtable (best effort), but DO NOT show JSON to user ---
    const fields = {
      // Match your Airtable field names exactly:
      Airport: parsed.airport ?? "",
      Outcome: parsed.outcome ?? "",
      Cause: parsed.cause ?? "",
      // If your Airtable column name differs, update this key to match exactly.
      "Minutes Early Left": minutes,
      Story: parsed.story ?? "",
      Sentiment: parsed.sentiment ?? "",
      "Follow Up Opt In": !!parsed.follow_up_opt_in,
      Contact: parsed.contact ?? "",
      "Raw JSON": JSON.stringify(parsed),
      Source: source || "landing_page",
    };

    if (airtableBase) {
      try {
        await airtableBase(TABLE_NAME).create([{ fields }]);
      } catch (airErr) {
        console.error("Airtable save failed:");
        console.error(airErr);
      }
    } else {
      console.warn("Airtable save skipped: missing Airtable env vars");
    }

    // Friendly completion message (front-end will redirect when done:true)
    return res.json({
      text: "Got it — thank you for using the Stress Line!",
      done: true,
    });
  } catch (err) {
    console.error("API error:", err?.message || err);
    return res.status(500).json({ error: "server_error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
