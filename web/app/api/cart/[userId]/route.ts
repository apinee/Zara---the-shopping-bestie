import { NextResponse } from "next/server";
import { getDbPool } from "../../../../lib/neon";

export async function GET(
  _req: Request,
  { params }: { params: { userId: string } }
) {
  try {
    const userId = Number(params.userId);
    const pool = getDbPool();

    const itemsRes = await pool.query(
      `SELECT c.id, c.product_id, c.size, c.qty,
              p.name, p.price_inr, p.colour, p.image_url
       FROM cart_items c
       JOIN products p ON p.id = c.product_id
       WHERE c.user_id = $1
       ORDER BY c.id ASC`,
      [userId]
    );

    const couponRes = await pool.query(
      `SELECT uc.coupon_code, cp.discount_pct
       FROM user_coupons uc
       JOIN coupons cp ON cp.code = uc.coupon_code
       WHERE uc.user_id = $1 AND cp.active = TRUE`,
      [userId]
    );

    const items = itemsRes.rows;
    const subtotal = items.reduce(
      (acc, i) => acc + Number(i.price_inr) * Number(i.qty),
      0
    );
    const coupon = couponRes.rows[0];
    const discountPct = coupon ? Number(coupon.discount_pct) : 0;
    const discountInr = Math.round((subtotal * discountPct) / 100);

    return NextResponse.json({
      user_id: userId,
      items,
      coupon_code: coupon ? coupon.coupon_code : null,
      discount_pct: discountPct,
      subtotal_inr: subtotal,
      discount_inr: discountInr,
      total_inr: Math.max(0, subtotal - discountInr),
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to fetch cart", items: [], total_inr: 0 },
      { status: 500 }
    );
  }
}
