import { randomInt } from "node:crypto";
import express, { type Request, type Response } from "express";

// A demo provider served by this same process, so a fresh install has paid
// tools that really work. Real providers host their own endpoints; the
// contract is the same: POST JSON { callId, input }, reply with JSON.

export const SAMPLE_SECRET = process.env.SAMPLE_PROVIDER_SECRET ?? "dev-sample-provider-secret";

function authorized(req: Request, res: Response): boolean {
  if (req.header("authorization") !== `Bearer ${SAMPLE_SECRET}`) {
    res.status(401).json({ error: "this endpoint only accepts calls from the AgentPay gateway" });
    return false;
  }
  return true;
}

export function sampleRouter() {
  const r = express.Router();

  // per_call: current weather for a city, via the free Open-Meteo APIs.
  r.post("/weather", async (req, res) => {
    if (!authorized(req, res)) return;
    const city = String(req.body?.input?.city ?? "").trim();
    if (!city) return void res.status(400).json({ error: "input.city is required" });
    try {
      const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`, {
        signal: AbortSignal.timeout(10_000),
      }).then((r) => r.json());
      const place = geo.results?.[0];
      if (!place) return void res.status(404).json({ error: `no place called "${city}"` });
      const wx = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
          `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`,
        { signal: AbortSignal.timeout(10_000) },
      ).then((r) => r.json());
      res.json({
        place: `${place.name}, ${place.country}`,
        temperatureC: wx.current?.temperature_2m,
        humidityPct: wx.current?.relative_humidity_2m,
        windKmh: wx.current?.wind_speed_10m,
        weatherCode: wx.current?.weather_code,
        observedAt: wx.current?.time,
      });
    } catch (err) {
      res.status(502).json({ error: `weather service unavailable: ${(err as Error).message}` });
    }
  });

  // per_unit: roll up to `dice` dice; charges only for dice actually rolled.
  r.post("/dice", (req, res) => {
    if (!authorized(req, res)) return;
    const dice = Number(req.body?.input?.dice);
    const sides = Number(req.body?.input?.sides ?? 6);
    if (!Number.isInteger(dice) || dice < 1) return void res.status(400).json({ error: "input.dice must be a positive integer" });
    if (!Number.isInteger(sides) || sides < 2 || sides > 1000) return void res.status(400).json({ error: "input.sides must be 2–1000" });
    const stopAt = req.body?.input?.stopAt;
    const rolls: number[] = [];
    for (let i = 0; i < dice; i++) {
      const roll = randomInt(1, sides + 1);
      rolls.push(roll);
      if (roll === stopAt) break;
    }
    res.setHeader("x-agentpay-units", String(rolls.length));
    res.json({ rolls, total: rolls.reduce((a, b) => a + b, 0) });
  });

  return r;
}
