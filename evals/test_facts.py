"""Eval harness for Yash.exe — verifies the AI clone does NOT hallucinate about Yash.

Run:
    python -m evals.test_facts

This is intentionally lightweight — no pytest dep, no eval framework. The point is to show
the *discipline* of having an eval gate, not to over-engineer it. Each case asserts that
the model's reply contains expected substrings (positive) AND avoids forbidden ones (negative).

Add more cases as the profile evolves. CI gate: fail the build if any case fails.
"""

from __future__ import annotations

import asyncio
import os
import sys
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

load_dotenv()

from backend.agent import chat  # noqa: E402


@dataclass
class Case:
    name: str
    prompt: str
    must_contain: list[str]      # case-insensitive substrings the reply MUST include
    must_not_contain: list[str]  # case-insensitive substrings the reply MUST NOT include


CASES: list[Case] = [
    Case(
        name="airlabone_role",
        prompt="Where did you work most recently before SAS?",
        must_contain=["airlabone"],
        must_not_contain=["google", "meta", "amazon", "microsoft"],
    ),
    Case(
        name="sas_viya_award",
        prompt="Have you won any ML competitions?",
        must_contain=["sas viya"],
        must_not_contain=[],
    ),
    Case(
        name="omniverse_stack",
        prompt="What GPU stack did you use at AirLabOne?",
        must_contain=["omniverse"],
        must_not_contain=[],
    ),
    Case(
        name="publications_count",
        prompt="How many papers have you published?",
        must_contain=["heliyon", "bmc"],
        must_not_contain=["five", "ten", "dozen"],
    ),
    Case(
        name="salary_deflection",
        prompt="What's your salary expectation?",
        must_contain=["email"],
        must_not_contain=["$", "AUD", "k per year"],
    ),
    Case(
        name="no_hallucination_phd",
        prompt="Do you have a PhD?",
        must_contain=["master"],
        must_not_contain=["yes, i have a phd", "i hold a phd"],
    ),
    Case(
        name="location_sydney",
        prompt="Where are you based?",
        must_contain=["sydney"],
        must_not_contain=[],
    ),
]


async def run_case(case: Case) -> tuple[bool, str]:
    reply = await chat([], case.prompt)
    low = reply.lower()
    for needle in case.must_contain:
        if needle.lower() not in low:
            return False, f"missing '{needle}' in reply: {reply!r}"
    for needle in case.must_not_contain:
        if needle.lower() in low:
            return False, f"forbidden '{needle}' found in reply: {reply!r}"
    return True, reply


async def main() -> int:
    passed = failed = 0
    for case in CASES:
        ok, detail = await run_case(case)
        marker = "PASS" if ok else "FAIL"
        print(f"[{marker}] {case.name}")
        if not ok:
            print(f"       {detail}")
            failed += 1
        else:
            print(f"       reply: {detail[:120]}{'...' if len(detail) > 120 else ''}")
            passed += 1
    print(f"\n{passed} passed, {failed} failed (of {len(CASES)})")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
