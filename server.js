// Tiny proxy: phone page -> this server -> Backboard.
// The Backboard API key lives ONLY here (as an environment variable), never in the web page.
// No npm packages needed. Requires Node 18+.

const http = require("http");

const PORT = process.env.PORT || 3000;
const KEY = process.env.BACKBOARD_API_KEY;
const PROVIDER = process.env.BACKBOARD_PROVIDER || "openai";
const MODEL = process.env.BACKBOARD_MODEL || "gpt-4o"; // must be a vision-capable model
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"; // e.g. https://yourname.github.io
const MAX_PER_DAY = Number(process.env.MAX_PER_DAY || 200); // protects your free credit
const MAX_BYTES = 4 * 1024 * 1024;

let today = new Date().toDateString();
let count = 0;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function send(res, status, obj) {
  setCors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BYTES) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const num = v => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

function buildPrompt(q) {
  const low = num(q.get("low")), mid = num(q.get("mid")), high = num(q.get("high")), hum = num(q.get("hum"));
  const weather = [low, mid, high, hum].every(v => v !== null)
    ? `Weather forecast for sunset: low cloud ${low}%, mid cloud ${mid}%, high cloud ${high}%, humidity ${hum}%.`
    : "No weather data is available.";
  return [
    "You are a sunset forecaster. The attached photo shows the western sky shortly before sunset.",
    weather,
    "Look at the clouds you can actually see (type, height, amount, thickness) and predict the peak twilight colors.",
    'Reply with ONLY a JSON object, no other text: {"colors": "<short phrase naming the colors>", "vividness": <integer 0-100>, "reason": "<one short sentence about the clouds you see>"}'
  ].join("\n");
}

function parseAnswer(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in model reply");
  const a = JSON.parse(m[0]);
  return {
    colors: String(a.colors || "Warm orange glow").slice(0, 80),
    vividness: Math.max(0, Math.min(100, num(a.vividness) ?? 50)),
    reason: String(a.reason || "").slice(0, 200)
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") { setCors(res); res.writeHead(204); return res.end(); }
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

  if (req.method === "POST" && url.pathname === "/analyze") {
    if (!KEY) return send(res, 500, { error: "server is missing BACKBOARD_API_KEY" });

    if (new Date().toDateString() !== today) { today = new Date().toDateString(); count = 0; }
    if (count >= MAX_PER_DAY) return send(res, 429, { error: "daily limit reached" });

    const type = (req.headers["content-type"] || "").split(";")[0];
    if (!type.startsWith("image/")) return send(res, 400, { error: "send an image" });

    try {
      const body = await readBody(req);
      count++;

      const form = new FormData();
      form.append("content", buildPrompt(url.searchParams));
      form.append("llm_provider", PROVIDER);
      form.append("model_name", MODEL);
      form.append("stream", "false");
      form.append("memory", "off");
      form.append("json_output", "true");
      form.append("files", new Blob([body], { type }), "sky.jpg");

      const r = await fetch("https://app.backboard.io/api/threads/messages", {
        method: "POST",
        headers: { "X-API-Key": KEY },
        body: form,
        signal: AbortSignal.timeout(40000)
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error("Backboard error", r.status, JSON.stringify(data).slice(0, 300));
        return send(res, 502, { error: "AI provider error", status: r.status });
      }
      return send(res, 200, parseAnswer(data.content));
    } catch (err) {
      console.error("analyze failed:", err.message);
      return send(res, 502, { error: "analysis failed" });
    }
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log("listening on " + PORT));