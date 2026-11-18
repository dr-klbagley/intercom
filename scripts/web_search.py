#!/usr/bin/env python3
"""Web search for Intercom, through Hermes's own web search (the same provider Jarvis uses; read-only).
Run with the Hermes venv's Python, from anywhere:
    web_search.py <hermes-agent dir> <query>
Prints the top results as Markdown. The query is built by Intercom from Kevin's own words only."""
from __future__ import annotations

import io
import json
import os
import re
import sys
from contextlib import redirect_stderr, redirect_stdout


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit("usage: web_search.py <hermes-agent dir> <query>")
    agent_dir, query = sys.argv[1], sys.argv[2][:300]
    sys.path.insert(0, agent_dir)
    os.environ.setdefault("HERMES_HOME", os.path.join(os.path.expanduser("~"), ".hermes"))
    noise = io.StringIO()
    with redirect_stdout(noise), redirect_stderr(noise):  # Hermes logs provider fallbacks; keep stdout clean
        from tools.web_tools import web_search_tool
        raw = web_search_tool(query, limit=6)
    data = json.loads(raw) if raw.strip().startswith("{") else {}
    if not data.get("success"):
        print(f"WEB SEARCH UNAVAILABLE: {str(data.get('error') or raw)[:200]}")
        sys.exit(0)
    results = (data.get("data") or {}).get("web") or []
    if not results:
        print("No web results.")
        return
    out = [f'Search: "{query}"']
    for i, r in enumerate(results[:6], 1):
        desc = re.sub(r"\n{2,}", "\n", (r.get("description") or "")).strip()
        if len(desc) > 900:
            desc = desc[:900].rsplit(" ", 1)[0] + " …"
        site = re.sub(r"^https?://(www\.)?([^/]+).*", r"\2", r.get("url") or "")
        out.append(f"[{i}] {r.get('title', '').strip()} ({site})\n{desc}")
    print("\n\n".join(out))


if __name__ == "__main__":
    main()
