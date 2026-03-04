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
You are the SkySpot Airport Stress Line intake assistant.
Ask ONE question at a time. Finish in <= 6 questions.

CRITICAL RULES:
- Do NOT return final JSON unless ALL required fields are collected.
- If user says "yes" to follow-up but does not provide contact, ask again:
  "Please share your email or phone so we can follow up."
- If user says "no", set followup_opt_in to false and contact to null.
- Do not guess missing values.

Return ONLY valid JSON when complete (no extra words):
{
  "airport": string,
  "outcome": "Missed"|"Almost Missed"|"Stressed",
  "cause": "Traffic"|"TSA"|"Parking"|"Rideshare"|"Underestimated"|"Other",
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