import { NextResponse } from "next/server";
import { generateText } from "ai";
import { getDbPool, listGatewayModels, neonAI } from "../../../lib/neon";

export async function GET() {
  try {
    const { status, body } = await listGatewayModels();
    const models: any[] = Array.isArray(body?.data) ? body.data : [];
    const enabledModels = models.filter((m) => m.enabled);
    return NextResponse.json({
      ok: status === 200,
      status,
      gateway_base_url: process.env.NEON_AI_GATEWAY_BASE_URL,
      total_catalog_models: models.length,
      enabled_models_count: enabledModels.length,
      enabled_models: enabledModels.map((m) => m.id),
      sample_models: models.slice(0, 5).map((m) => ({
        id: m.id,
        owned_by: m.owned_by,
        enabled: m.enabled,
        unavailable_reason: m.unavailable_reason || null,
        recovery_url: m.recovery_url || null,
      })),
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to query Neon AI Gateway" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const { user_id, prompt, model = "gpt-5-mini" } = await req.json();

    let memoryContext = "Guest shopper";
    if (user_id) {
      const pool = getDbPool();
      const { rows } = await pool.query(
        "SELECT name, preferences, recent_purchases, last_call_summary FROM user_memory WHERE user_id = $1",
        [Number(user_id)]
      );
      if (rows[0]) {
        memoryContext = JSON.stringify(rows[0]);
      }
    }

    const { text } = await generateText({
      model: neonAI(model),
      system: `You are Zara, a sassy but kind Bengaluru shopping bestie at VibeCart. Reply in max 2 short sentences with light Hinglish. User memory: ${memoryContext}`,
      prompt: prompt || "Hey Zara, what should I wear in Indiranagar tonight?",
    });

    return NextResponse.json({
      ok: true,
      model,
      reply: text,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || "AI Gateway call failed",
      },
      { status: 502 }
    );
  }
}
