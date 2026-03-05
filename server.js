import express from "express";
import OpenAI from "openai";
import Airtable from "airtable";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// --- Sanity checks (helps you debug fast in Render logs) ---
const REQUIRED_ENVS = ["OPENAI_API_KEY", "AIRTABLE_API_KEY", "AIRTABLE_BASE_ID", "AIRTABLE_TABLE_NAME"];
for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) console.warn(`[WARN] Missing env var: ${k}`);
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Airtable setup
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID
);

const TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "Submissions";

// NOTE: These enum labels should match your Airtable Single Select options EXACTLY.
const SYSTEM_PROMPT = `
You are the SkySpot Travel Grievance intake assistant (SkySpot Airport Stress Line).

GOAL:
1) Let the user share a general travel grievance (open-ended).
2) Convert it into structured data for reporting.
3) Keep it short (<= 7 turns). Ask ONE question at a time.

FLOW:
- First ask: "What happened? Share your travel grievance in your own words (30–60 seconds)."
- Then ask for the airport if not mentioned.
- Determine outcome:
  - "Missed" if they missed the flight.
  - "Almost Missed" if they nearly missed / barely made it.
  - Otherwise "Stressed".
- Classify the grievance into ONE primary cause from the list below.
- If unclear, ask: "Which best fits?" and present the list.

CAUSE options (must match EXACTLY):
"Traffic","TSA","Parking","Rideshare","Underestimated","Airline Delay","Gate Change","Baggage","Navigation","Cost/Fees","Other"

IMPORTANT RULES:
- Only ask "How early did you leave?" IF the story is about timing/arrival (missed/almost missed/late arrival).
  Otherwise set minutes_early_left_home = null and do NOT ask.
- Do NOT return final JSON unless ALL of these are known:
  airport, outcome, cause, story, sentiment, followup_opt_in
- Follow-up handling:
  - If user says "no", set followup_opt_in=false and contact=null.
  - If user says "yes" but provides no email/phone, ask again:
    "Please share your email or phone so we can follow up."

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

app.post("/api/stress", async (req, res) => {
  try {
    const { messages, source } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }
    if (!process.env.OPENAI_API_KEY) {
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

    // --- If final JSON: save to Airtable (best effort), but DO NOT show JSON to user ---
    const fields = {
      // Match your Airtable field names exactly:
      Airport: parsed.airport ?? "",
      Outcome: parsed.outcome ?? "",
      Cause: parsed.cause ?? "",
      // If your Airtable column name differs, update this key to match exactly.
      "Minutes Early Left Home":
        typeof parsed.minutes_early_left_home === "number"
          ? parsed.minutes_early_left_home
          : null,
      Story: parsed.story ?? "",
      Sentiment: parsed.sentiment ?? "",
      "Follow Up Opt In": !!parsed.follow_up_opt_in,
      Contact: parsed.contact ?? "",
      "Raw JSON": JSON.stringify(parsed),
      Source: source || "landing_page",
      "Created At": new Date().toISOString(),
    };

    try {
      await base(TABLE_NAME).create([{ fields }]);
    } catch (airErr) {
  console.error("Airtable save failed:");
  console.error(airErr);
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