import { NextResponse } from "next/server";
import { getDbPool, getStorageFiles } from "../../../lib/neon";

export async function GET() {
  try {
    const pool = getDbPool();
    const files = getStorageFiles();
    const { rows } = await pool.query(
      `SELECT id, name, gender, category, article_type, colour, price_inr, stock, sizes, image_url
       FROM products
       ORDER BY id ASC
       LIMIT 48`
    );

    // Resolve presigned URLs for product images stored in Neon Object Storage (`s3://assets/<key>`)
    const products = await Promise.all(
      rows.map(async (row) => {
        let imageUrl: string = row.image_url || `/products/${row.id}.jpg`;
        if (imageUrl.startsWith("s3://assets/")) {
          const key = imageUrl.replace("s3://assets/", "");
          try {
            imageUrl = await files.url(key, { expiresIn: 3600 });
          } catch {
            imageUrl = `/products/${row.id}.jpg`;
          }
        }
        return { ...row, image_url: imageUrl, storage_ref: row.image_url };
      })
    );

    return NextResponse.json({ products });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to load products", products: [] },
      { status: 500 }
    );
  }
}
