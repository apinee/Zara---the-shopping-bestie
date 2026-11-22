"use client";

import React, { useEffect, useRef, useState } from "react";
import MemoryGraph, { GraphEdge } from "./MemoryGraph";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

const INR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
// `|| 0` turns -0 into 0 so a zero discount never renders as "-₹0"
const inr = (n: number) => INR.format(Number(n) || 0);

const SWATCHES: Record<string, string> = {
  black: "#111", white: "#f5f5f5", blue: "#3b82f6", navy: "#1e3a8a", red: "#ef4444", green: "#22c55e",
  yellow: "#facc15", pink: "#f472b6", purple: "#a855f7", orange: "#fb923c", brown: "#92400e",
  grey: "#9ca3af", beige: "#e7d7b5", gold: "#d4a72c", silver: "#cbd5e1", maroon: "#7f1d1d", olive: "#65a30d",
};
const swatch = (colour?: string) =>
  SWATCHES[(colour || "").toLowerCase().split(" ").pop() || ""] ||
  "conic-gradient(#f472b6, #a855f7, #3b82f6, #22c55e, #facc15, #f472b6)";

// ---------- Live transcripts from the Agora agent (RTC data stream) ----------
interface Caption {
  text: string;
  done: boolean;
}
type ChunkBuffer = Map<string, { parts: Record<number, string>; total: number; at: number }>;
const textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;

/**
 * Decode one `stream-message` payload into a JSON message, or null if it's partial/unknown.
 * Handles plain JSON and the chunked form "<message_id>|<part_idx>|<part_sum>|<base64 chunk>"
 * (parts are reassembled in index order, whether they're numbered from 0 or 1).
 */
function decodeAgentMessage(raw: Uint8Array, buffer: ChunkBuffer): any | null {
  if (!textDecoder) return null;
  const text = textDecoder.decode(raw);
  if (text.startsWith("{")) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  const match = text.match(/^([^|]+)\|(\d+)\|(\d+)\|([\s\S]*)$/);
  if (!match) return null;
  const [, id, idx, total, part] = match;
  const now = Date.now();
  buffer.forEach((v, k) => {
    if (now - v.at > 15000) buffer.delete(k); // drop messages whose other parts never arrived
  });
  const entry = buffer.get(id) || { parts: {}, total: Number(total), at: now };
  entry.parts[Number(idx)] = part;
  buffer.set(id, entry);
  const keys = Object.keys(entry.parts).map(Number).sort((a, b) => a - b);
  if (keys.length < entry.total) return null;
  buffer.delete(id);
  try {
    const binary = atob(keys.map((k) => entry.parts[k]).join(""));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(textDecoder.decode(bytes));
  } catch {
    return null;
  }
}

const PROMPTS = ["Show me blue shirts", "Suggest something for me", "What's my size?", "Apply coupon ZARA20"];

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
    </svg>
  );
}

interface Product {
  id: number;
  name: string;
  price_inr: number;
  colour?: string;
  category?: string;
  article_type?: string;
  stock?: number;
  sizes?: Record<string, number> | string;
  image_url?: string;
  option?: number;
}

interface ShowcaseState {
  query: string;
  items: Product[];
  timestamp: number;
}

interface CartItem {
  id: number;
  product_id: number;
  name: string;
  size: string;
  qty: number;
  price_inr: number;
  image_url?: string;
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
  const [productsStatus, setProductsStatus] = useState<"loading" | "ready" | "error">("loading");
  // True when the 2s poll can't reach the backend, so a stale cart isn't mistaken for the real one
  const [backendDown, setBackendDown] = useState(false);
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
  const [showcase, setShowcase] = useState<ShowcaseState>({ query: "", items: [], timestamp: 0 });
  const [dismissedTs, setDismissedTs] = useState<number>(0);
  const [selectedSizes, setSelectedSizes] = useState<Record<number, string>>({});
  const [addingId, setAddingId] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("All");

  // Agora RTC Voice Call state
  const [inCall, setInCall] = useState(false);
  const [callBusy, setCallBusy] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [callError, setCallError] = useState("");
  const rtcClientRef = useRef<any>(null);
  const localMicTrackRef = useRef<any>(null);

  // Live captions + "refresh now" hooks so the panel updates the moment Zara acts
  const [userCaption, setUserCaption] = useState<Caption | null>(null);
  const [zaraCaption, setZaraCaption] = useState<Caption | null>(null);
  const chunkBufferRef = useRef<ChunkBuffer>(new Map());
  const lastZaraTurnRef = useRef<string | number | null>(null);
  const pollRef = useRef<() => void>(() => {});

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

  function loadProducts() {
    setProductsStatus("loading");
    fetch(`${BACKEND_URL}/products`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setProducts(data.products || []);
        setProductsStatus("ready");
      })
      .catch(() => setProductsStatus("error"));
  }

  useEffect(loadProducts, []);

  // Poll Cart, Memory, and Tool Log once logged in: every 1s during a call, 2.5s otherwise.
  // Transcript events also trigger an immediate poll via pollRef.
  useEffect(() => {
    if (!user) return;
    let inFlight = false;

    const poll = async () => {
      if (inFlight) return; // never stack requests if the backend is slow
      inFlight = true;
      try {
        const [cartRes, memRes, logRes] = await Promise.all([
          fetch(`${BACKEND_URL}/cart/${user.user_id}`),
          fetch(`${BACKEND_URL}/memory/${user.user_id}`),
          fetch(`${BACKEND_URL}/tool-log/${user.user_id}`),
        ]);
        setBackendDown(!(cartRes.ok && memRes.ok));
        if (cartRes.ok) setCart(await cartRes.json());
        if (memRes.ok) setMemory(await memRes.json());
        if (logRes.ok) {
          const logData = await logRes.json();
          setToolLogs(logData.logs || []);
          if (logData.showcase && Array.isArray(logData.showcase.items)) {
            setShowcase(logData.showcase);
          }
        }
      } catch {
        // Network error: keep the last good data on screen but flag it as stale
        setBackendDown(true);
      } finally {
        inFlight = false;
      }
    };

    pollRef.current = poll;
    poll();
    const interval = setInterval(poll, inCall ? 1000 : 2500);
    return () => clearInterval(interval);
  }, [user, inCall]);

  // Handle one decoded agent message: update captions, and refresh the panel when a turn completes
  function handleAgentMessage(msg: any) {
    if (!msg || typeof msg !== "object") return;
    if (msg.object === "user.transcription") {
      const done = Boolean(msg.final);
      setUserCaption({ text: String(msg.text || ""), done });
      if (done) setTimeout(() => pollRef.current(), 400);
    } else if (msg.object === "assistant.transcription") {
      // turn_status: 0 in progress, 1 end, 2 interrupted
      setZaraCaption({ text: String(msg.text || ""), done: msg.turn_status !== 0 });
      const turn = msg.turn_id ?? msg.turn_seq_id ?? null;
      if (turn !== lastZaraTurnRef.current) {
        // Zara just started a new reply: her tool calls ran right before it, so fetch their results now
        lastZaraTurnRef.current = turn;
        pollRef.current();
      }
      if (msg.turn_status === 1) pollRef.current();
    } else if (msg.object === "message.interrupt") {
      setZaraCaption((c) => (c ? { ...c, done: true } : c));
    }
  }

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
    setUserCaption(null);
    setZaraCaption(null);
    lastZaraTurnRef.current = null;
    chunkBufferRef.current.clear();
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

        // Live transcripts + agent events arrive over the RTC data stream
        let loggedStreamMessages = 0;
        client.on("stream-message", (_uid: any, payload: Uint8Array) => {
          const msg = decodeAgentMessage(payload, chunkBufferRef.current);
          if (msg && loggedStreamMessages < 5) {
            loggedStreamMessages++;
            console.debug("[zara-stream]", msg.object, msg); // first few only: confirms transcripts are flowing
          }
          handleAgentMessage(msg);
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

  function getSizeKeys(p: Product): string[] {
    if (!p.sizes) return ["M"];
    let parsed: any = p.sizes;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return ["M"];
      }
    }
    if (parsed && typeof parsed === "object") {
      const keys = Object.keys(parsed).filter((k) => Number(parsed[k]) > 0);
      return keys.length > 0 ? keys : Object.keys(parsed);
    }
    return ["M"];
  }

  async function quickAddToCart(p: Product) {
    if (!user) return;
    const sizeKeys = getSizeKeys(p);
    const chosenSize = selectedSizes[p.id] || sizeKeys[0] || "M";
    setAddingId(p.id);
    try {
      const res = await fetch(`${BACKEND_URL}/cart/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: user.user_id,
          product_id: p.id,
          size: chosenSize,
          qty: 1,
        }),
      });
      if (res.ok) {
        setCart(await res.json());
      }
    } finally {
      setAddingId(null);
    }
  }

  function logout() {
    if (inCall) endCall(agentId);
    try {
      localStorage.removeItem("vibecart_user");
    } catch {
      // Ignore storage failures
    }
    setUser(null);
  }

  const categories = ["All", ...Array.from(new Set(products.map((p) => p.category).filter(Boolean) as string[]))];
  const visibleProducts =
    categoryFilter === "All" ? products : products.filter((p) => p.category === categoryFilter);
  const firstName = user?.name?.split(" ")[0] || "bestie";
  const prefEntries = Object.entries(memory.preferences || {});

  return (
    <div className="shell">
      {/* Left: store */}
      <main className="store">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">V</span>
            <div>
              <h1 className="brand-name">
                Vibe<span>Cart</span>
              </h1>
              <p className="brand-tag">Shop by talking · Bengaluru edition</p>
            </div>
          </div>
          {user && (
            <div className="user-pill">
              <span className="avatar" aria-hidden="true">
                {user.name.charAt(0).toUpperCase()}
              </span>
              <span>{user.name}</span>
              <button className="link-btn" onClick={logout}>
                Log out
              </button>
            </div>
          )}
        </header>

        {/* Zara hero */}
        <section className={`hero ${inCall ? "is-live" : ""}`}>
          <div className="zara-orb" aria-hidden="true">
            Z
          </div>
          <div>
            <p className="eyebrow">{inCall ? "Zara is listening" : "Meet Zara"}</p>
            <h2>
              {inCall ? `Go on ${firstName}, tell me what you're looking for.` : `Hey ${firstName}, scene kya hai today?`}
            </h2>
            {inCall ? (
              <div className="captions" aria-live="polite">
                <p className={`caption ${userCaption && !userCaption.done ? "is-partial" : ""}`}>
                  <span className="caption-who">You</span>
                  {userCaption?.text || "Start talking…"}
                </p>
                <p className={`caption caption-zara ${zaraCaption && !zaraCaption.done ? "is-partial" : ""}`}>
                  <span className="caption-who">Zara</span>
                  {zaraCaption?.text || "…"}
                </p>
              </div>
            ) : (
              <>
                <p className="hero-sub">
                  Your shopping bestie finds it, checks your size, fills the cart and remembers your taste for next time.
                </p>
                <div className="prompt-chips" aria-label="Things you can say">
                  {PROMPTS.map((t) => (
                    <span key={t} className="chip">
                      &ldquo;{t}&rdquo;
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
          {inCall && (
            <div className="eq" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
          )}
        </section>

        {/* Zara's live options spotlight */}
        {showcase.items.length > 0 && showcase.timestamp > dismissedTs && (
          <section className="spotlight" aria-live="polite">
            <div className="spotlight-head">
              <div>
                <span className="badge-live">Live from Zara</span>
                <h2>Options for &ldquo;{showcase.query}&rdquo;</h2>
                <p>
                  Say <strong>&ldquo;add option 1&rdquo;</strong>, or pick a size and tap.
                </p>
              </div>
              <button className="ghost-btn" onClick={() => setDismissedTs(showcase.timestamp)}>
                Clear options
              </button>
            </div>
            <div className="grid grid-lg">
              {showcase.items.map((p, idx) => {
                const optNum = p.option || idx + 1;
                const sizeKeys = getSizeKeys(p);
                const activeSize = selectedSizes[p.id] || sizeKeys[0] || "M";
                return (
                  <article key={p.id} className="card product">
                    <span className="option-tag">Option {optNum}</span>
                    <div className="product-media">
                      <img src={p.image_url || `/products/${p.id}.jpg`} alt={p.name} />
                    </div>
                    <div className="product-body">
                      <div className="meta">
                        <span className="swatch" style={{ background: swatch(p.colour) }} />
                        {p.colour} · {p.article_type || p.category}
                      </div>
                      <h3 className="product-name">{p.name}</h3>
                      <div className="price">{inr(p.price_inr)}</div>
                      <div className="sizes" role="group" aria-label={`Size for option ${optNum}`}>
                        {sizeKeys.map((sz) => (
                          <button
                            key={sz}
                            className={`size ${activeSize === sz ? "is-active" : ""}`}
                            aria-pressed={activeSize === sz}
                            onClick={() => setSelectedSizes((prev) => ({ ...prev, [p.id]: sz }))}
                          >
                            {sz}
                          </button>
                        ))}
                      </div>
                      <button
                        className="btn btn-primary btn-block"
                        onClick={() => quickAddToCart(p)}
                        disabled={addingId === p.id}
                      >
                        {addingId === p.id ? "Adding…" : `Add option ${optNum} · ${activeSize}`}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {/* Catalogue */}
        <div className="section-head">
          <h2>The edit</h2>
          {productsStatus === "ready" && products.length > 0 && (
            <div className="filters" role="group" aria-label="Filter by category">
              {categories.map((c) => (
                <button
                  key={c}
                  className={`filter ${categoryFilter === c ? "is-active" : ""}`}
                  aria-pressed={categoryFilter === c}
                  onClick={() => setCategoryFilter(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>

        {productsStatus === "error" && (
          <div className="notice notice-error" role="alert">
            Couldn&apos;t load products from {BACKEND_URL}. Check that the backend is running.{" "}
            <button className="link-btn" style={{ color: "#c4b5fd" }} onClick={loadProducts}>
              Try again
            </button>
          </div>
        )}
        {productsStatus === "ready" && products.length === 0 && (
          <div className="empty-state">
            No products yet. Run <code>python scripts/seed_products.py</code> to add them.
          </div>
        )}

        <div className="grid" aria-busy={productsStatus === "loading"}>
          {productsStatus === "loading" &&
            Array.from({ length: 8 }).map((_, i) => <div key={i} className="card skeleton" aria-hidden="true" />)}
          {visibleProducts.map((p) => {
            const soldOut = p.stock === 0;
            const lowStock = !soldOut && p.stock !== undefined && p.stock <= 5;
            return (
              <article key={p.id} className={`card product ${soldOut ? "is-out" : ""}`}>
                <div className="product-media">
                  <img src={p.image_url || `/products/${p.id}.jpg`} alt={p.name} loading="lazy" />
                  {lowStock && <span className="stock-badge">Only {p.stock} left</span>}
                  {soldOut && <span className="stock-badge is-out">Sold out</span>}
                </div>
                <div className="product-body">
                  <div className="meta">
                    <span className="swatch" style={{ background: swatch(p.colour) }} />
                    {p.colour} · {p.article_type || p.category}
                  </div>
                  <h3 className="product-name">{p.name}</h3>
                  <div className="product-foot">
                    <span className="price">{inr(p.price_inr)}</span>
                    <span className="pid">#{p.id}</span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </main>

      {/* Right: live panel (polls every 2s) */}
      <aside className="panel">
        {backendDown && (
          <div className="notice notice-warn" role="status">
            Can&apos;t reach the backend. The cart and memory below may be out of date.
          </div>
        )}

        {/* Cart */}
        <section className="card panel-card">
          <header className="panel-head">
            <span className="panel-icon" aria-hidden="true">🛍️</span>
            <h2>Your cart</h2>
            <span className="count">{cart.items.length}</span>
          </header>
          {cart.items.length === 0 ? (
            <p className="muted small">Empty for now. Tell Zara what you want to try.</p>
          ) : (
            <>
              <ul className="cart-list">
                {cart.items.map((item) => (
                  <li key={`${item.product_id}-${item.size}`} className="cart-item">
                    <div className="cart-thumb">{item.image_url && <img src={item.image_url} alt="" />}</div>
                    <div className="cart-info">
                      <span className="cart-name">{item.name}</span>
                      <span className="muted small">
                        Size {item.size} · Qty {item.qty}
                      </span>
                    </div>
                    <strong>{inr(item.price_inr * item.qty)}</strong>
                  </li>
                ))}
              </ul>
              <div className="totals">
                {cart.coupon_code && (
                  <div className="row discount">
                    <span>Coupon {cart.coupon_code}</span>
                    <span>−{inr(cart.discount_inr)}</span>
                  </div>
                )}
                <div className="row total">
                  <span>Total</span>
                  <span>{inr(cart.total_inr)}</span>
                </div>
              </div>
            </>
          )}
        </section>

        {/* Latest order confirmation */}
        {latestOrder && (
          <section className="card order-card">
            <header className="panel-head">
              <span className="panel-icon" aria-hidden="true">✅</span>
              <h2>Order confirmed</h2>
            </header>
            <dl className="order-grid">
              <dt>Order</dt>
              <dd>
                #{latestOrder.order_id}
                <span className="status-pill">{latestOrder.status}</span>
              </dd>
              <dt>Tracking</dt>
              <dd className="mono">{latestOrder.tracking_id || "—"}</dd>
              <dt>Razorpay</dt>
              <dd className="mono small">{latestOrder.razorpay_order_id || "—"}</dd>
              <dt>Amount</dt>
              <dd>{inr(latestOrder.amount_inr)}</dd>
            </dl>
          </section>
        )}

        {/* Orders awaiting payment */}
        {(unpaidOrders.length > 0 || payStatus) && (
          <section className="card panel-card">
            <header className="panel-head">
              <span className="panel-icon" aria-hidden="true">💳</span>
              <h2>Pay for your order</h2>
            </header>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {unpaidOrders.map((o) => (
                <button key={o.order_id} className="btn btn-success btn-block" onClick={() => payForOrder(o)}>
                  Pay {inr(o.amount_inr)} · Order #{o.order_id}
                </button>
              ))}
              {payStatus && <p className="pay-status">{payStatus}</p>}
            </div>
          </section>
        )}

        {/* Memory graph */}
        <section className="card panel-card">
          <header className="panel-head">
            <span className="panel-icon" aria-hidden="true">🧠</span>
            <h2>What Zara knows about you</h2>
            {inCall && <span className="badge-live">Live</span>}
          </header>
          <MemoryGraph
            center={memory.graph?.center || user?.name || "You"}
            edges={memory.graph?.edges}
            live={inCall}
          />
          {prefEntries.length > 0 && (
            <div className="pref-chips">
              {prefEntries.map(([k, v]) => (
                <span key={k} className="pref-chip">
                  {k.replace(/_/g, " ")}: {v}
                </span>
              ))}
            </div>
          )}
          {memory.last_call_summary && <p className="last-vibe">Last vibe: {memory.last_call_summary}</p>}
        </section>

        {/* Live actions timeline */}
        <section className="card panel-card" style={{ flex: 1 }}>
          <header className="panel-head">
            <span className="panel-icon" aria-hidden="true">⚡</span>
            <h2>Live actions</h2>
            {inCall ? (
              <span className="badge-live">Live</span>
            ) : (
              toolLogs.length > 0 && <span className="count">{toolLogs.length}</span>
            )}
          </header>
          {toolLogs.length === 0 ? (
            <p className="muted small">Every tool Zara uses shows up here as she searches and fills your cart.</p>
          ) : (
            <ol className="timeline">
              {toolLogs.map((entry) => (
                <li key={entry.id} className={`timeline-item ${entry.status === "ok" ? "" : "is-error"}`}>
                  <span className="timeline-dot" aria-hidden="true" />
                  <div>
                    <span className="tool-check">{entry.status === "ok" ? "✓" : "✗"}</span>
                    <span className="tool-name">{entry.tool}</span>
                  </div>
                  <div className="tool-summary">{entry.summary}</div>
                  {(entry.external || []).map((ext, i) => (
                    <div key={i} className={`ext-call ${ext.ok ? "" : "is-skipped"}`}>
                      ↗ {ext.service} {ext.call} · {ext.detail}
                    </div>
                  ))}
                  {(entry.memory || []).length > 0 && (
                    <div className="learned">🧠 learned: {(entry.memory || []).join(", ")}</div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      </aside>

      {/* Talk dock */}
      {user && (
        <div className="dock">
          {callError && (
            <div className="toast-error" role="alert">
              {callError}
            </div>
          )}
          <button className={`talk-btn ${inCall ? "is-live" : ""}`} onClick={toggleCall} disabled={callBusy}>
            <span className="talk-icon">{inCall ? "■" : <MicIcon />}</span>
            {callBusy ? "Connecting…" : inCall ? "End call" : "Talk to Zara"}
          </button>
          <span className="murf-credit">
            Voice by <b>Murf Falcon</b>
          </span>
        </div>
      )}

      {/* Login (name + 4-digit PIN) */}
      {!user && (
        <div className="overlay">
          <form className="login-card" onSubmit={handleLogin} role="dialog" aria-modal="true" aria-labelledby="login-title">
            <div className="zara-orb sm" aria-hidden="true">
              Z
            </div>
            <h2 id="login-title">Welcome to VibeCart</h2>
            <p className="muted small">Your name and a 4-digit PIN let Zara remember your vibe next time.</p>
            <label className="field">
              Name
              <input
                type="text"
                placeholder="e.g. Aarav"
                autoFocus
                autoComplete="given-name"
                value={loginName}
                onChange={(e) => setLoginName(e.target.value)}
                required
              />
            </label>
            <label className="field">
              PIN
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                pattern="\d{4}"
                placeholder="4 digits"
                value={loginPin}
                onChange={(e) => setLoginPin(e.target.value)}
                required
              />
            </label>
            {loginError && (
              <div className="field-error" role="alert">
                {loginError}
              </div>
            )}
            <button type="submit" className="btn btn-primary btn-block" style={{ padding: "12px" }}>
              Enter the store
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
