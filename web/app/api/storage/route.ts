import { NextResponse } from "next/server";
import { getDbPool, getStorageFiles, STORAGE_BUCKET } from "../../../lib/neon";

export async function GET(req: Request) {
  try {
    const files = getStorageFiles();
    const { searchParams } = new URL(req.url);
    const prefix = searchParams.get("prefix") || "";
    const { items: listed } = await files.list({ prefix });
    const keys = listed.map((f) => f.key);
    const items = await Promise.all(
      keys.slice(0, 20).map(async (key) => ({
        key,
        presigned_url: await files.url(key, { expiresIn: 3600 }),
      }))
    );
    return NextResponse.json({
      bucket: STORAGE_BUCKET,
      endpoint: process.env.AWS_ENDPOINT_URL_S3,
      region: process.env.AWS_REGION,
      count: keys.length,
      objects: items,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Object storage list failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const key: string = body.key || `uploads/vibe-${Date.now()}.txt`;
    const content: string = body.content || "VibeCart style note";
    const contentType: string = body.contentType || "text/plain";
    const userId: number | undefined = body.user_id ? Number(body.user_id) : undefined;

    const files = getStorageFiles();
    const buffer = body.base64
      ? Buffer.from(body.base64, "base64")
      : Buffer.from(content, "utf8");

    // 1. Upload to Neon Object Storage bucket `assets`
    await files.upload(key, buffer, { contentType });

    // 2. Verify download round-trip from Neon Object Storage
    const downloaded = await files.download(key);
    const downloadedBytes = new Uint8Array(await downloaded.arrayBuffer());

    // 3. Generate presigned GET URL
    const presignedUrl = await files.url(key, { expiresIn: 3600 });

    // 4. Optionally record object key in Lakebase Postgres user_preferences
    if (userId) {
      const pool = getDbPool();
      await pool.query(
        `INSERT INTO user_preferences (user_id, key, value, updated_at)
         VALUES ($1, 'latest_style_asset', $2, NOW())
         ON CONFLICT (user_id, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [userId, `s3://${STORAGE_BUCKET}/${key}`]
      );
    }

    return NextResponse.json({
      ok: true,
      bucket: STORAGE_BUCKET,
      key,
      bytes_written: buffer.byteLength,
      bytes_verified: downloadedBytes.byteLength,
      presigned_url: presignedUrl,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Object storage upload failed" },
      { status: 500 }
    );
  }
}
