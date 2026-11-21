import { NextResponse } from "next/server";

export async function GET(
  _req: Request,
  { params }: { params: { userId: string } }
) {
  const userId = Number(params.userId);
  const mcpBase = process.env.MCP_INTERNAL_URL || "http://localhost:8001";
  try {
    const res = await fetch(`${mcpBase}/tool-log/${userId}`, {
      cache: "no-store",
    });
    if (res.ok) {
      return NextResponse.json(await res.json());
    }
  } catch {
    // MCP server not running or unreachable
  }
  return NextResponse.json({ user_id: userId, logs: [] });
}
