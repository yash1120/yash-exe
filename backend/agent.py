"""LangGraph agent that wraps Groq's Llama 3.3 70B chat completion.

Architecture notes:
- Single-node LangGraph for v1. Adding tool nodes later (search_github, fetch_publications,
  end_call) is a one-line change.
- Groq's OpenAI-compatible API delivers sub-second token latency on the free tier — actually
  *faster* than the equivalent Claude or GPT-4 call, which makes voice UX feel real-time.
- No prompt caching (Groq doesn't expose it), but for a demo-sized profile (~3k tokens) the
  free tier easily handles thousands of turns. If we ever outgrow it, swapping to Groq paid
  or Anthropic with prompt caching is a 20-line diff.
"""

from __future__ import annotations

import os
from typing import Annotated, AsyncIterator, TypedDict

from groq import AsyncGroq
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages

from .prompts import build_system_prompt

MODEL = os.environ.get("YASH_EXE_MODEL", "llama-3.3-70b-versatile")
MAX_TOKENS = int(os.environ.get("YASH_EXE_MAX_TOKENS", "512"))

_client = AsyncGroq()
_system_prompt = build_system_prompt()


class AgentState(TypedDict):
    messages: Annotated[list, add_messages]


def _to_chat_messages(messages: list) -> list[dict]:
    """LangGraph messages -> OpenAI-format messages, with the system prompt prepended."""
    out: list[dict] = [{"role": "system", "content": _system_prompt}]
    for m in messages:
        if isinstance(m, dict):
            out.append({"role": m["role"], "content": m["content"]})
        else:
            role = "assistant" if m.type == "ai" else "user"
            out.append({"role": role, "content": m.content})
    return out


async def _call_model(state: AgentState) -> dict:
    response = await _client.chat.completions.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        messages=_to_chat_messages(state["messages"]),
    )
    text = response.choices[0].message.content or ""
    return {"messages": [{"role": "assistant", "content": text}]}


def _build_graph():
    graph = StateGraph(AgentState)
    graph.add_node("agent", _call_model)
    graph.set_entry_point("agent")
    graph.add_edge("agent", END)
    return graph.compile()


agent = _build_graph()


async def chat(history: list[dict], user_message: str) -> str:
    """One-shot chat. `history` is a list of {role, content} dicts from prior turns."""
    state = {"messages": history + [{"role": "user", "content": user_message}]}
    result = await agent.ainvoke(state)
    last = result["messages"][-1]
    return last.content if hasattr(last, "content") else last["content"]


async def stream(history: list[dict], user_message: str) -> AsyncIterator[str]:
    """Token-streamed chat for low-latency voice UX. Yields text chunks as they arrive."""
    messages = _to_chat_messages(history + [{"role": "user", "content": user_message}])
    stream_resp = await _client.chat.completions.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        messages=messages,
        stream=True,
    )
    async for chunk in stream_resp:
        delta = chunk.choices[0].delta.content
        if delta:
            yield delta
