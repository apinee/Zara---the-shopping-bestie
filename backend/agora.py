import os
import time
import uuid
from typing import Any, Dict
import httpx
from agora_token_builder import RtcTokenBuilder

ROLE_PUBLISHER = 1
AGENT_RTC_UID = "2001"
GEMINI_OPENAI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"


def generate_rtc_token(channel: str, uid: int | str, expire_seconds: int = 3600) -> str:
    """Generate an Agora RTC token for a given channel and integer UID."""
    app_id = os.environ["AGORA_APP_ID"].strip()
    app_cert = os.environ["AGORA_APP_CERTIFICATE"].strip()
    privilege_expired_ts = int(time.time()) + expire_seconds
    return RtcTokenBuilder.buildTokenWithUid(
        app_id,
        app_cert,
        channel,
        int(uid),
        ROLE_PUBLISHER,
        privilege_expired_ts,
    )


def get_llm_config() -> tuple[str, str, str]:
    """
    Resolve LLM endpoint, API key, and model.
    Preferred: LLM_URL / LLM_API_KEY / LLM_MODEL (default URL = Gemini's OpenAI-compatible endpoint).
    Fallbacks: legacy GEMINI_* vars, OpenAI, or Neon AI Gateway.
    """
    llm_key = (os.getenv("LLM_API_KEY") or "").strip()
    if llm_key:
        return (
            (os.getenv("LLM_URL") or GEMINI_OPENAI_URL).strip(),
            llm_key,
            (os.getenv("LLM_MODEL") or "gemini-2.5-flash").strip(),
        )

    gemini_key = (os.getenv("GEMINI_API_KEY") or os.getenv("gemini_API_KEY") or "").strip()
    if gemini_key:
        model = (os.getenv("GEMINI_MODEL") or os.getenv("gemini_MODEL") or "gemini-2.5-flash").strip()
        return (
            GEMINI_OPENAI_URL,
            gemini_key,
            model,
        )

    openai_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if openai_key:
        model = (os.getenv("OPENAI_MODEL") or "gpt-4o-mini").strip()
        return (
            "https://api.openai.com/v1/chat/completions",
            openai_key,
            model,
        )

    gateway_base = (os.getenv("NEON_AI_GATEWAY_BASE_URL") or "").strip()
    gateway_token = (os.getenv("NEON_AI_GATEWAY_TOKEN") or "").strip()
    if gateway_base and gateway_token:
        url = f"{gateway_base.rstrip('/')}/v1/chat/completions"
        model = (os.getenv("OPENAI_MODEL") or "gpt-5-mini").strip()
        return url, gateway_token, model

    raise RuntimeError("No LLM API key configured (set LLM_API_KEY, OPENAI_API_KEY, or NEON_AI_GATEWAY_TOKEN)")


async def start_agent(
    channel: str,
    user_uid: int | str,
    system_prompt: str,
    greeting_message: str,
) -> Dict[str, Any]:
    """
    Start an Agora Conversational AI agent in `channel` using Deepgram ASR,
    Gemini (OpenAI-compatible) LLM + VibeCart MCP tools, and Murf Falcon TTS.
    """
    app_id = os.environ["AGORA_APP_ID"].strip()
    customer_id = os.environ["AGORA_CUSTOMER_ID"].strip()
    customer_secret = os.environ["AGORA_CUSTOMER_SECRET"].strip()

    agent_token = generate_rtc_token(channel, AGENT_RTC_UID)
    url = f"https://api.agora.io/api/conversational-ai-agent/v2/projects/{app_id}/join"
    llm_url, llm_key, llm_model = get_llm_config()

    payload = {
        "name": f"zara-{channel}-{uuid.uuid4().hex[:6]}",
        "properties": {
            "channel": channel,
            "token": agent_token,
            "agent_rtc_uid": AGENT_RTC_UID,
            "remote_rtc_uids": [str(user_uid)],
            "idle_timeout": 30,
            "advanced_features": {
                "enable_tools": True,
            },
            "asr": {
                "vendor": "deepgram",
                "params": {
                    "api_key": os.environ["DEEPGRAM_API_KEY"].strip(),
                },
            },
            "llm": {
                "url": llm_url,
                "api_key": llm_key,
                "params": {
                    "model": llm_model,
                },
                "system_messages": [
                    {"role": "system", "content": system_prompt},
                ],
                "greeting_message": greeting_message,
                "mcp_servers": [
                    {
                        "name": "vibecart",
                        "endpoint": os.environ["MCP_PUBLIC_URL"].strip(),
                        "transport": "streamable_http",
                    }
                ],
            },
            "tts": {
                "vendor": "murf",
                "params": {
                    "api_key": os.environ["MURF_API_KEY"].strip(),
                    "voiceId": os.environ["MURF_VOICE_ID"].strip(),
                    "model": "FALCON",
                    "locale": "en-IN",
                },
            },
        },
    }

    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(
            url,
            auth=(customer_id, customer_secret),
            json=payload,
        )
        if resp.is_error:
            raise RuntimeError(f"Agora join failed ({resp.status_code}): {resp.text}")
        return resp.json()


async def get_history(agent_id: str) -> list[Dict[str, Any]]:
    """Fetch the short-term conversation history (role/content turns) of an active agent."""
    app_id = os.environ["AGORA_APP_ID"]
    customer_id = os.environ["AGORA_CUSTOMER_ID"]
    customer_secret = os.environ["AGORA_CUSTOMER_SECRET"]

    url = f"https://api.agora.io/api/conversational-ai-agent/v2/projects/{app_id}/agents/{agent_id}/history"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url, auth=(customer_id, customer_secret))
        resp.raise_for_status()
        return resp.json().get("contents") or []


async def summarize_call(contents: list[Dict[str, Any]]) -> str | None:
    """Summarize a call transcript into one line for users.last_call_summary."""
    transcript = "\n".join(
        f"{turn.get('role')}: {turn.get('content')}"
        for turn in contents
        if turn.get("role") in ("user", "assistant") and turn.get("content")
    )
    if not transcript.strip():
        return None

    llm_url, llm_key, llm_model = get_llm_config()
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(
            llm_url,
            headers={"Authorization": f"Bearer {llm_key}"},
            json={
                "model": llm_model,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "Summarize this shopping call in ONE short sentence (max 25 words) "
                            "for the assistant's memory: what the shopper looked at, liked, bought, "
                            "or is still deciding on."
                        ),
                    },
                    {"role": "user", "content": transcript[-6000:]},
                ],
            },
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"].strip()


async def leave(agent_id: str) -> Dict[str, Any]:
    """Stop an active Agora Conversational AI agent session."""
    app_id = os.environ["AGORA_APP_ID"]
    customer_id = os.environ["AGORA_CUSTOMER_ID"]
    customer_secret = os.environ["AGORA_CUSTOMER_SECRET"]

    url = f"https://api.agora.io/api/conversational-ai-agent/v2/projects/{app_id}/agents/{agent_id}/leave"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(url, auth=(customer_id, customer_secret))
        resp.raise_for_status()
        return resp.json() if resp.content else {"ok": True}
