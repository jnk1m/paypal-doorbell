// The one place that reads the Upstash env. The Vercel Marketplace integration sets KV_REST_API_URL and KV_REST_API_TOKEN.
import { Redis } from "@upstash/redis";

// Returns null when Redis is not configured, so callers can fall back to memory. The brief store and the rate limiter parse their
// values themselves, hence automaticDeserialization off (the client would otherwise JSON.parse any string that looks like JSON).
export function redisFromEnv(): Redis | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url) {
    // Memory is per serverless instance: the release lock (R8) and the rate limit would silently stop being global.
    if (process.env.VERCEL) throw new Error("KV_REST_API_URL is not set on Vercel: refusing the in-memory fallback, because its release lock and rate limit are not shared across instances");
    return null;
  }
  if (!token) throw new Error("KV_REST_API_URL is set but KV_REST_API_TOKEN is missing");
  return new Redis({ url, token, automaticDeserialization: false });
}
