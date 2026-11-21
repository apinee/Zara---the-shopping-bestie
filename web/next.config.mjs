import fs from "fs";
import path from "path";

// Load root ../.env.local (populated by `neon deploy`) and ../.env into process.env
for (const envFile of [".env.local", ".env"]) {
  const fullPath = path.resolve(process.cwd(), "..", envFile);
  if (fs.existsSync(fullPath)) {
    const content = fs.readFileSync(fullPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
      }
    }
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
};

export default nextConfig;
