"use client";

import React, { useEffect, useRef, useState } from "react";
import MemoryGraph, { GraphEdge } from "./MemoryGraph";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

interface Product {
  id: number;
  name: string;
  price_inr: number;
  colour?: string;
  category?: string;
  stock?: number;
  image_url?: string;
}

interface CartItem {
  id: number;
  product_id: number;
  name: string;
  size: string;
  qty: number;
  price_inr: number;
}

interface CartState {
  items: CartItem[];
  coupon_code: string | null;
  subtotal_inr: number;
  discount_inr: number;
  total_inr: number;
}

interface MemoryState {
  preferences: Record<string, string>;
  recent_purchases: Array<{
    order_id: number;
    razorpay_order_id: string | null;
    tracking_id: string | null;
    amount_inr: number;
    status: string;
  }>;
  last_call_summary: string;
  graph?: { center: string; edges: GraphEdge[] };
}

interface ToolLogEntry {
  id: number;
  tool: string;
  summary: string;
  status: "ok" | "error";
  external?: Array<{ service: string; call: string; ok: boolean; detail: string }>;
  memory?: string[];
  timestamp: number;
}

export default function VibeCartStorePage() {
  // User & Login Modal state
  const [user, setUser] = useState<{ user_id: number; name: string } | null>(null);
  const [loginName, setLoginName] = useState("");
  const [loginPin, setLoginPin] = useState("");
  const [loginError, setLoginError] = useState("");

  // Storefront & Right Side Panel state
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartState>({
    items: [],
    coupon_code: null,
    subtotal_inr: 0,
    discount_inr: 0,
    total_inr: 0,
  });
  const [memory, setMemory] = useState<MemoryState>({
    preferences: {},
    recent_purchases: [],
    last_call_summary: "",
  });
  const [toolLogs, setToolLogs] = useState<ToolLogEntry[]>([]);

  // Agora RTC Voice Call state
  const [inCall, setInCall] = useState(false);
  const [callBusy, setCallBusy] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [callError, setCallError] = useState("");
  const rtcClientRef = useRef<any>(null);
  const localMicTrackRef = useRef<any>(null);

  // Razorpay Checkout state
  const [razorpayKeyId, setRazorpayKeyId] = useState("");
  const [payStatus, setPayStatus] = useState("");

  // Restore login from previous visit
  useEffect(() => {
    try {
      const saved = localStorage.getItem("vibecart_user");
      if (saved) setUser(JSON.parse(saved));
    } catch {
      // Storage unavailable — user just logs in again
    }
  }, []);

  // Load products and public config on mount
  useEffect(() => {
    fetch(`${BACKEND_URL}/config`)
      .then((r) => r.json())
      .then((data) => setRazorpayKeyId(data.razorpay_key_id || ""))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`${BACKEND_URL}/products`)
      .then((r) => r.json())
      .then((data) => setProducts(data.products || []))
      .catch(() => {});
  }, []);

  // Poll Cart, Memory, and Tool Log every 2s once logged in
  useEffect(() => {
    if (!user) return;

    const poll = async () => {
      try {
        const [cartRes, memRes, logRes] = await Promise.all([
          fetch(`${BACKEND_URL}/cart/${user.user_id}`),
          fetch(`${BACKEND_URL}/memory/${user.user_id}`),
          fetch(`${BACKEND_URL}/tool-log/${user.user_id}`),
        ]);
        if (cartRes.ok) setCart(await cartRes.json());
        if (memRes.ok) setMemory(await memRes.json());
        if (logRes.ok) {
          const logData = await logRes.json();
          setToolLogs(logData.logs || []);
        }
      } catch {
        // Ignore transient polling errors
      }
    };

    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, [user]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError("");
    try {
      const res = await fetch(`${BACKEND_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: loginName, pin: loginPin }),
      });
      if (!res.ok) {
        const err = await res.json();
        setLoginError(err.detail || "Login failed");
        return;
      }
      const data = await res.json();
      const loggedIn = { user_id: data.user_id, name: data.name };
      setUser(loggedIn);
      try {
        localStorage.setItem("vibecart_user", JSON.stringify(loggedIn));
      } catch {
        // Ignore storage failures
      }
    } catch {
      setLoginError("Could not reach backend at " + BACKEND_URL);
    }
  }

  // Leave the RTC channel, then let the backend summarize the call and stop Zara
  async function endCall(currentAgentId: string | null) {
    if (localMicTrackRef.current) {
      localMicTrackRef.current.stop();
      localMicTrackRef.current.close();
      localMicTrackRef.current = null;
    }
    if (rtcClientRef.current) {
      const client = rtcClientRef.current;
      rtcClientRef.current = null;
      await client.leave();
    }
    if (currentAgentId) {
      await fetch(`${BACKEND_URL}/call/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: currentAgentId, user_id: user?.user_id }),
      }).catch(() => {});
    }
    setAgentId(null);
    setInCall(false);
  }

  async function toggleCall() {
    if (!user || callBusy) return;
    setCallBusy(true);
    setCallError("");

    try {
      if (!inCall) {
        // 1. Request Agora channel, user token, and spawn Zara agent via backend
        const res = await fetch(`${BACKEND_URL}/call/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: user.user_id }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || "Failed to start call");
        }
        const { agent_id, channel, token, uid, app_id } = await res.json();

        // 2. Join Agora RTC channel & publish microphone audio (keeps existing Agora Web SDK flow)
        const AgoraRTC = (await import("agora-rtc-sdk-ng")).default;
        const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
        rtcClientRef.current = client;

        client.on("user-published", async (remoteUser: any, mediaType: "audio" | "video") => {
          await client.subscribe(remoteUser, mediaType);
          if (mediaType === "audio" && remoteUser.audioTrack) {
            remoteUser.audioTrack.play();
          }
        });

        // Zara (agent uid 2001) leaves on idle_timeout — reset the call UI when that happens
        client.on("user-left", (remoteUser: any) => {
          if (String(remoteUser.uid) === "2001" && rtcClientRef.current === client) {
            endCall(null);
          }
        });

        try {
          await client.join(app_id, channel, token, uid);
          const micTrack = await AgoraRTC.createMicrophoneAudioTrack({
            AEC: true,
            ANS: true,
            AGC: true,
          });
          localMicTrackRef.current = micTrack;
          await client.publish([micTrack]);
        } catch (err) {
          // Don't leave Zara running in the channel if we couldn't join or get the mic
          await endCall(agent_id);
          throw err;
        }

        setAgentId(agent_id);
        setInCall(true);
      } else {
        await endCall(agentId);
      }
    } catch (err: any) {
      console.error("Call toggle error:", err);
      setCallError(
        err?.name === "AgoraRTCException" && String(err?.code).includes("PERMISSION")
          ? "Microphone permission denied — allow mic access and try again."
          : err?.message || "Call failed"
      );
    } finally {
      setCallBusy(false);
    }
  }

  function loadRazorpayScript(): Promise<boolean> {
    if ((window as any).Razorpay) return Promise.resolve(true);
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  }

  // Open Razorpay Checkout for an order Zara created, then verify the signature on the backend
  async function payForOrder(order: MemoryState["recent_purchases"][number]) {
    setPayStatus("");
    if (!razorpayKeyId || !order.razorpay_order_id) {
      setPayStatus("Razorpay keys are not configured on the backend.");
      return;
    }
    if (!(await loadRazorpayScript())) {
      setPayStatus("Could not load Razorpay Checkout.");
      return;
    }
    const rzp = new (window as any).Razorpay({
      key: razorpayKeyId,
      order_id: order.razorpay_order_id,
      amount: order.amount_inr * 100,
      currency: "INR",
      name: "VibeCart",
      description: `Order #${order.order_id}`,
      prefill: { name: user?.name },
      theme: { color: "#7c3aed" },
      handler: async (resp: any) => {
        const res = await fetch(`${BACKEND_URL}/payment/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(resp),
        });
        setPayStatus(res.ok ? `Order #${order.order_id} paid ✓` : "Payment verification failed");
      },
    });
    rzp.on("payment.failed", (resp: any) => {
      setPayStatus(resp?.error?.description || "Payment failed");
    });
    rzp.open();
  }

  // Most recent order (recent_purchases is newest-first) for the confirmation card
  const latestOrder = (memory.recent_purchases || [])[0];

  // Only orders with a real Razorpay order id can be paid (order_test_* means keys weren't set)
  const unpaidOrders = (memory.recent_purchases || []).filter(
    (o) => o.status === "created" && o.razorpay_order_id && !o.razorpay_order_id.startsWith("order_test_")
  );

  function logout() {
    if (inCall) endCall(agentId);
    try {
      localStorage.removeItem("vibecart_user");
    } catch {
      // Ignore storage failures
    }
    setUser(null);
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", minHeight: "100vh" }}>
      {/* Left: Store Home Page & Product Grid */}
      <main style={{ padding: "24px 32px", paddingBottom: "100px" }}>
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "24px",
          }}
        >
          <div>
            <h1 style={{ fontSize: "24px", fontWeight: 700 }}>VibeCart ✨</h1>
            <p style={{ color: "#9ca3af", fontSize: "14px" }}>
              Shop by talking with Zara — your Bengaluru shopping bestie
            </p>
          </div>
          {user && (
            <span style={{ fontSize: "14px", color: "#a78bfa" }}>
              Logged in as <strong>{user.name}</strong> (#{user.user_id}) ·{" "}
              <button
                onClick={logout}
                style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", padding: 0 }}
              >
                Log out
              </button>
            </span>
          )}
        </header>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
            gap: "16px",
          }}
        >
          {products.map((p) => (
            <div
              key={p.id}
              style={{
                background: "#181b24",
                border: "1px solid #262a36",
                borderRadius: "12px",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div style={{ height: "210px", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <img
                  src={p.image_url || `/products/${p.id}.jpg`}
                  alt={p.name}
                  style={{ maxHeight: "100%", maxWidth: "100%", objectFit: "contain" }}
                />
              </div>
              <div style={{ padding: "12px" }}>
                <div style={{ fontSize: "11px", color: "#9ca3af", marginBottom: "4px" }}>
                  #{p.id} · {p.colour}
                </div>
                <div
                  style={{
                    fontSize: "14px",
                    fontWeight: 500,
                    lineHeight: 1.3,
                    marginBottom: "8px",
                    height: "36px",
                    overflow: "hidden",
                  }}
                >
                  {p.name}
                </div>
                <div style={{ fontSize: "16px", fontWeight: 700, color: "#34d399" }}>
                  ₹{p.price_inr}
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>

      {/* Right Side Panel: Polls every 2s (Cart, Memory, Live Actions) */}
      <aside
        style={{
          background: "#141720",
          borderLeft: "1px solid #262a36",
          padding: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          height: "100vh",
          position: "sticky",
          top: 0,
          overflowY: "auto",
        }}
      >
        {/* Card 1: Cart */}
        <section
          style={{
            background: "#1c202c",
            borderRadius: "12px",
            padding: "14px",
            border: "1px solid #2b3040",
          }}
        >
          <h2 style={{ fontSize: "15px", fontWeight: 600, marginBottom: "10px" }}>
            🛒 Your Cart ({cart.items.length})
          </h2>
          {cart.items.length === 0 ? (
            <p style={{ fontSize: "13px", color: "#9ca3af" }}>
              Cart is empty. Tell Zara what you want to try!
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {cart.items.map((item) => (
                <div
                  key={`${item.product_id}-${item.size}`}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "13px",
                  }}
                >
                  <span>
                    {item.qty}x {item.name} ({item.size})
                  </span>
                  <strong>₹{item.price_inr * item.qty}</strong>
                </div>
              ))}
              <hr style={{ borderColor: "#2b3040", margin: "6px 0" }} />
              {cart.coupon_code && (
                <div style={{ fontSize: "12px", color: "#34d399" }}>
                  Coupon {cart.coupon_code}: -₹{cart.discount_inr}
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
                <span>Total</span>
                <span>₹{cart.total_inr}</span>
              </div>
            </div>
          )}
        </section>

        {/* Card 1a: Order confirmation for the latest order */}
        {latestOrder && (
          <section
            style={{
              background: "#052e1c",
              borderRadius: "12px",
              padding: "14px",
              border: "1px solid #065f46",
            }}
          >
            <h2 style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>
              ✅ Order confirmed
            </h2>
            <div style={{ fontSize: "13px", display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px" }}>
              <span style={{ color: "#9ca3af" }}>Order ID</span>
              <strong>#{latestOrder.order_id}</strong>
              <span style={{ color: "#9ca3af" }}>Tracking ID</span>
              <strong style={{ fontFamily: "ui-monospace, monospace" }}>{latestOrder.tracking_id || "—"}</strong>
              <span style={{ color: "#9ca3af" }}>Razorpay</span>
              <span style={{ fontFamily: "ui-monospace, monospace", fontSize: "11px", wordBreak: "break-all" }}>
                {latestOrder.razorpay_order_id || "—"}
              </span>
              <span style={{ color: "#9ca3af" }}>Amount</span>
              <strong>
                ₹{latestOrder.amount_inr} · {latestOrder.status}
              </strong>
            </div>
          </section>
        )}

        {/* Card 1b: Orders awaiting payment (created by Zara's checkout tool) */}
        {(unpaidOrders.length > 0 || payStatus) && (
          <section
            style={{
              background: "#1c202c",
              borderRadius: "12px",
              padding: "14px",
              border: "1px solid #2b3040",
            }}
          >
            <h2 style={{ fontSize: "15px", fontWeight: 600, marginBottom: "10px" }}>💳 Pay for your order</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {unpaidOrders.map((o) => (
                <button
                  key={o.order_id}
                  onClick={() => payForOrder(o)}
                  style={{
                    background: "#059669",
                    color: "#fff",
                    border: "none",
                    borderRadius: "8px",
                    padding: "10px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Pay ₹{o.amount_inr} · Order #{o.order_id}
                </button>
              ))}
              {payStatus && <div style={{ fontSize: "12px", color: "#d1d5db" }}>{payStatus}</div>}
            </div>
          </section>
        )}

        {/* Card 2: What Zara knows about you */}
        <section
          style={{
            background: "#1c202c",
            borderRadius: "12px",
            padding: "14px",
            border: "1px solid #2b3040",
          }}
        >
          <h2 style={{ fontSize: "15px", fontWeight: 600, marginBottom: "10px" }}>
            🧠 What Zara knows about you
          </h2>
          <MemoryGraph center={memory.graph?.center || user?.name || "You"} edges={memory.graph?.edges || []} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "10px" }}>
            {Object.entries(memory.preferences || {}).length === 0 ? (
              <span style={{ fontSize: "12px", color: "#9ca3af" }}>No preferences saved yet</span>
            ) : (
              Object.entries(memory.preferences).map(([k, v]) => (
                <span
                  key={k}
                  style={{
                    background: "#2e1065",
                    color: "#ddd6fe",
                    fontSize: "12px",
                    padding: "3px 8px",
                    borderRadius: "999px",
                  }}
                >
                  {k}: {v}
                </span>
              ))
            )}
          </div>
          {(memory.recent_purchases || []).length > 0 && (
            <div style={{ fontSize: "12px", color: "#d1d5db", marginBottom: "8px" }}>
              Recent orders:{" "}
              {memory.recent_purchases
                .map((o) => `#${o.order_id} ₹${o.amount_inr} (${o.status})`)
                .join(", ")}
            </div>
          )}
          {memory.last_call_summary && (
            <p style={{ fontSize: "12px", color: "#9ca3af" }}>
              Last vibe: {memory.last_call_summary}
            </p>
          )}
        </section>

        {/* Card 3: Live actions (tool log with ✓ ticks) */}
        <section
          style={{
            background: "#1c202c",
            borderRadius: "12px",
            padding: "14px",
            border: "1px solid #2b3040",
            flex: 1,
          }}
        >
          <h2 style={{ fontSize: "15px", fontWeight: 600, marginBottom: "10px" }}>
            ⚡ Live actions
          </h2>
          {toolLogs.length === 0 ? (
            <p style={{ fontSize: "12px", color: "#9ca3af" }}>
              Tool calls will appear here as Zara searches & updates your cart.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {toolLogs.map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    fontSize: "12px",
                    background: "#141720",
                    padding: "8px 10px",
                    borderRadius: "8px",
                    border: "1px solid #262a36",
                  }}
                >
                  <div style={{ fontWeight: 600, color: entry.status === "ok" ? "#34d399" : "#f87171" }}>
                    {entry.status === "ok" ? "✓" : "✗"} {entry.tool}
                  </div>
                  <div style={{ color: "#d1d5db", marginTop: "2px" }}>{entry.summary}</div>
                  {(entry.external || []).map((ext, i) => (
                    <div
                      key={i}
                      style={{
                        marginTop: "4px",
                        fontFamily: "ui-monospace, monospace",
                        fontSize: "11px",
                        color: ext.ok ? "#93c5fd" : "#9ca3af",
                      }}
                    >
                      ↗ {ext.ok ? "✓" : "–"} {ext.service} {ext.call} · {ext.detail}
                    </div>
                  ))}
                  {(entry.memory || []).length > 0 && (
                    <div style={{ marginTop: "4px", fontSize: "11px", color: "#c4b5fd" }}>
                      🧠 learned: {(entry.memory || []).join(", ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </aside>

      {callError && (
        <div
          style={{
            position: "fixed",
            bottom: "86px",
            left: "50%",
            transform: "translateX(-50%)",
            background: "#7f1d1d",
            color: "#fecaca",
            fontSize: "13px",
            padding: "8px 14px",
            borderRadius: "8px",
            zIndex: 40,
            maxWidth: "90vw",
          }}
        >
          {callError}
        </div>
      )}

      {/* Floating "Talk to Zara" Button + Murf credit */}
      {user && (
        <div
          style={{
            position: "fixed",
            bottom: "8px",
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: "11px",
            color: "#a78bfa",
            zIndex: 40,
            letterSpacing: "0.02em",
          }}
        >
          🔊 Voice by Murf Falcon
        </div>
      )}
      {user && (
        <button
          onClick={toggleCall}
          disabled={callBusy}
          style={{
            position: "fixed",
            bottom: "28px",
            left: "50%",
            transform: "translateX(-50%)",
            background: inCall ? "#ef4444" : "#7c3aed",
            color: "#fff",
            border: "none",
            borderRadius: "999px",
            padding: "14px 28px",
            fontSize: "16px",
            fontWeight: 700,
            boxShadow: "0 10px 25px rgba(124, 58, 237, 0.4)",
            zIndex: 40,
          }}
        >
          {callBusy
            ? "Connecting..."
            : inCall
            ? "🔴 End Call with Zara"
            : "🎙️ Talk to Zara"}
        </button>
      )}

      {/* Simple Login Modal (Name + 4-digit PIN) */}
      {!user && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
        >
          <form
            onSubmit={handleLogin}
            style={{
              background: "#181b24",
              border: "1px solid #2b3040",
              borderRadius: "16px",
              padding: "28px",
              width: "340px",
              display: "flex",
              flexDirection: "column",
              gap: "14px",
            }}
          >
            <h2 style={{ fontSize: "20px", fontWeight: 700 }}>Welcome to VibeCart</h2>
            <p style={{ fontSize: "13px", color: "#9ca3af" }}>
              Enter your name and a 4-digit PIN so Zara remembers your vibe.
            </p>
            <input
              type="text"
              placeholder="Your Name (e.g. Aarav)"
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              required
              style={{
                padding: "10px 12px",
                borderRadius: "8px",
                border: "1px solid #374151",
                background: "#0f1117",
                color: "#fff",
              }}
            />
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              pattern="\d{4}"
              placeholder="4-digit PIN (e.g. 1234)"
              value={loginPin}
              onChange={(e) => setLoginPin(e.target.value)}
              required
              style={{
                padding: "10px 12px",
                borderRadius: "8px",
                border: "1px solid #374151",
                background: "#0f1117",
                color: "#fff",
              }}
            />
            {loginError && (
              <div style={{ fontSize: "12px", color: "#f87171" }}>{loginError}</div>
            )}
            <button
              type="submit"
              style={{
                background: "#7c3aed",
                color: "#fff",
                border: "none",
                borderRadius: "8px",
                padding: "11px",
                fontWeight: 600,
              }}
            >
              Enter Store
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
