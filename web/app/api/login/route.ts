import { NextResponse } from "next/server";
import { getDbPool } from "../../../lib/neon";

export async function POST(req: Request) {
  try {
    const { name, pin } = await req.json();
    if (!name || !/^\d{4}$/.test(String(pin || ""))) {
      return NextResponse.json(
        { detail: "Name and a 4-digit PIN are required" },
        { status: 400 }
      );
    }

    const pool = getDbPool();
    const cleanName = String(name).trim();

    const existing = await pool.query(
      `SELECT id, name, (pin_hash = crypt($2, pin_hash)) AS pin_ok
       FROM users
       WHERE LOWER(name) = LOWER($1)`,
      [cleanName, String(pin)]
    );

    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      if (!user.pin_ok) {
        return NextResponse.json({ detail: "Invalid 4-digit PIN" }, { status: 401 });
      }
      return NextResponse.json({
        user_id: user.id,
        name: user.name,
        is_new: false,
      });
    }

    const created = await pool.query(
      `INSERT INTO users (name, pin_hash)
       VALUES ($1, crypt($2, gen_salt('bf')))
       RETURNING id, name`,
      [cleanName, String(pin)]
    );
    return NextResponse.json({
      user_id: created.rows[0].id,
      name: created.rows[0].name,
      is_new: true,
    });
  } catch (err: any) {
    return NextResponse.json(
      { detail: err?.message || "Database error" },
      { status: 500 }
    );
  }
}
