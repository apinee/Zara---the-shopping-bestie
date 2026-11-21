import { NextResponse } from "next/server";
import { getDbPool } from "../../../../lib/neon";

export async function GET(
  _req: Request,
  { params }: { params: { userId: string } }
) {
  try {
    const userId = Number(params.userId);
    const pool = getDbPool();
    const { rows } = await pool.query(
      `SELECT user_id, name, preferences, recent_purchases, last_call_summary
       FROM user_memory
       WHERE user_id = $1`,
      [userId]
    );

    if (rows.length === 0) {
      return NextResponse.json({ detail: "User not found" }, { status: 404 });
    }
    return NextResponse.json(rows[0]);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to fetch memory" },
      { status: 500 }
    );
  }
}
