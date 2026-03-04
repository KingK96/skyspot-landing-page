import express from "express";
import OpenAI from "openai";
import Airtable from "airtable";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Airtable setup
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
  .base(process.env.AIRTABLE_BASE_ID);

const TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "Submissions";

const SYSTEM_PROMPT = `
You are the SkySpot Airport Stress Line intake assistant.
Ask ONE question at a time. Finish in <= 6 questions.

When you have enough info, return ONLY valid JSON (no extra words) matching:
{
  "airport": string,
  "outcome": "Missed"|"Almost Missed"|"Stressed",
  "cause": "Traffic"|"TSA"|"Parking"|"Rideshare"|"Underestimated"|"Other",
  "minutes_early_left_home": number|null,
  "story": string,
  "sentiment": "Calm"|"Annoyed"|"Stressed"|"Angry"|"Anxious",
  "followup_opt_in": boolean,
  "contact": string|null
}

Rules:
- If user doesn’t know minutes, set minutes_early_left_home to null.
- Keep questions short. Be empathetic, not chatty.
- Do not include markdown in the final JSON.
`;

function looksLikeJson(text) {
  const t = (text || "").trim();
  return t.startsWith("{") && t.endsWith("}");
}

app.post("/api/stress", async (req, res) => {
  try {
    const { messages, source } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }

    const resp = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    });

    const text = resp.output_text || "";

    // If the model returned final JSON, parse + save to Airtable
    if (looksLikeJson(text)) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        // If JSON is malformed, return as-is (don’t crash)
        return res.json({ text });
      }

      // Airtable fields (match your table field names)
      const fields = {
  "Airport": parsed.airport ?? "",
  "Outcome": parsed.outcome ?? "",
  "Cause": parsed.cause ?? "",
  "Minutes Early Left Home": 
    typeof parsed.minutes_early_left_home === "number"
      ? parsed.minutes_early_left_home
      : null,
  "Story": parsed.story ?? "",
  "Sentiment": parsed.sentiment ?? "",
  "Follow Up Opt In": !!parsed.followup_opt_in,
  "Contact": parsed.contact ?? "",
  "Raw JSON": JSON.stringify(parsed),
  "Source": source || "landing_page",
  "Created At": new Date().toISOString()
};

      // Save (best-effort: we still respond even if Airtable fails)
      try {
        await base(TABLE_NAME).create([{ fields }]);
      } catch (airErr) {
        console.error("Airtable save failed:", airErr);
      }
    }

    return res.json({ text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "server_error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));