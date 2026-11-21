import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { Files } from "files-sdk";
import { neon as neonStorageAdapter } from "files-sdk/neon";
import { neon as neonAI } from "@neon/ai-sdk-provider";
import { parseEnv } from "@neon/env";
import neonConfig from "../../neon";

// Ensure root .env.local is loaded in server runtime
function ensureRootEnvLoaded() {
  for (const dir of [process.cwd(), path.resolve(process.cwd(), "..")]) {
    for (const file of [".env.local", ".env"]) {
      const p = path.join(dir, file);
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, "utf8");
        for (const line of content.split(/\r?\n/)) {
          const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
          if (match && !process.env[match[1]]) {
            process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
          }
        }
      }
    }
  }
}

ensureRootEnvLoaded();

// Validate and parse Neon environment variables against neon.ts
export function getNeonEnv() {
  ensureRootEnvLoaded();
  return parseEnv(neonConfig);
}

// 1. Lakebase Postgres (pg Pool over pooled DATABASE_URL for app traffic)
declare global {
  // eslint-disable-next-line no-var
  var __vibecartPgPool: Pool | undefined;
}

export function getDbPool(): Pool {
  ensureRootEnvLoaded();
  if (!global.__vibecartPgPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not configured");
    }
    global.__vibecartPgPool = new Pool({
      connectionString,
      max: 10,
    });
  }
  return global.__vibecartPgPool;
}

// 2. Neon Object Storage (files-sdk with neon adapter for bucket "assets")
export const STORAGE_BUCKET = "assets";

export function getStorageFiles(): Files {
  ensureRootEnvLoaded();
  return new Files({
    adapter: neonStorageAdapter({ bucket: STORAGE_BUCKET }),
  });
}

// 3. Neon AI Gateway (@neon/ai-sdk-provider + live /v1/models discovery)
export { neonAI };

export async function listGatewayModels() {
  ensureRootEnvLoaded();
  const baseUrl = process.env.NEON_AI_GATEWAY_BASE_URL;
  const token = process.env.NEON_AI_GATEWAY_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("NEON_AI_GATEWAY_BASE_URL or NEON_AI_GATEWAY_TOKEN is not set");
  }
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });
  const body = await res.json();
  return { status: res.status, body };
}
