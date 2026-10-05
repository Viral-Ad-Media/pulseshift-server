import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { supabase } from "./supabase.js";
import { createApp } from "./app.js";

const client = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;
const trustProxy = process.env.TRUST_PROXY_HOPS
  ? Number(process.env.TRUST_PROXY_HOPS)
  : false;
if (
  trustProxy !== false &&
  (!Number.isSafeInteger(trustProxy) || trustProxy < 1 || trustProxy > 3)
)
  throw new Error(
    "TRUST_PROXY_HOPS must be a verified proxy hop count from 1 to 3",
  );
const app = createApp({
  db: supabase,
  secret: process.env.JWT_SECRET,
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:3000",
  trustProxy,
  ai: client
    ? async (prompt) =>
        (
          await client.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
              responseMimeType: "application/json",
              httpOptions: { timeout: 20000 },
            },
          })
        ).text
    : null,
});
const { data, error } = await supabase.rpc("pulse_schema_ready");
if (error || data !== true)
  throw new Error(
    "Database schema is not ready. Apply supabase/schema.sql and supabase/migrations/20261005_audit.sql before starting the API.",
  );
const port = Number(process.env.PORT || 4000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
app.listen(port, () => console.log(`PulseShift API listening on port ${port}`));
