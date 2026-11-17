#!/usr/bin/env python3
"""Read-only context from the Jarvis vault for Intercom (spec §8): research (Fangorn / Entmoot),
LinkedIn (Gandalf / Rivendell) and Mind Stone (proposals, corrections). Prints Markdown.
    vault_gather.py <vault dir> research|linkedin|mindstone
Everything printed is data for Jarvis to answer from, never instructions."""
from __future__ import annotations

import re
import sys
from pathlib import Path


def read(p: Path, limit: int) -> str:
    try:
        text = p.read_text(encoding="utf-8")
    except OSError:
        return ""
    text = re.sub(r"^---\n.*?\n---\n", "", text, flags=re.S)  # front matter
    text = re.sub(r"\[\[([^\]|]+\|)?([^\]]+)\]\]", r"\2", text)  # [[link|label]] -> label
    return text if len(text) <= limit else text[:limit].rsplit("\n", 1)[0] + "\n…(trimmed)"


def open_items(p: Path, limit: int = 8) -> list[str]:
    """Unchecked '- [ ]' lines, without block ids."""
    out = []
    for line in read(p, 200_000).splitlines():
        if line.startswith("- [ ]"):
            out.append("- " + re.sub(r"\s*\^[\w-]+\s*$", "", line[5:].strip()))
            if len(out) >= limit:
                break
    return out


def research(v: Path) -> str:
    r = v / "Generated/Research"
    parts = ["## Fangorn's research (also shown in Entmoot)"]
    briefs = sorted((r / "Briefs").glob("*.md"), reverse=True)[:4]
    if briefs:
        parts.append("### Latest briefs (newest first)")
        for b in briefs:
            parts.append(f"#### {b.stem[:10]} · {b.stem[11:].replace('-', ' ')}\n{read(b, 1400)}")
    q = open_items(r / "Fangorn Questions.md")
    if q:
        parts.append("### Questions Fangorn is working on\n" + "\n".join(q))
    inbox = open_items(v / "Kevin/Research Inbox.md")
    parts.append("### Kevin's open research requests (Research Inbox)\n" + ("\n".join(inbox) if inbox else "None open."))
    return "\n\n".join(parts)


def linkedin(v: Path) -> str:
    li = v / "Generated/LinkedIn"
    parts = ["## LinkedIn with Gandalf (also shown in Rivendell)"]
    plans = sorted((li / "Plans").glob("*.md"), reverse=True)
    if plans:
        parts.append(f"### This week's plan ({plans[0].stem})\n{read(plans[0], 4500)}")
    ideas = read(v / "Kevin/Social/Ideas.md", 1500)
    if ideas.strip():
        parts.append(f"### Kevin's post ideas\n{ideas}")
    feedback = read(v / "Kevin/Social/Gandalf Feedback.md", 1200)
    if feedback.strip():
        parts.append(f"### Kevin's feedback to Gandalf\n{feedback}")
    return "\n\n".join(parts)


def mindstone(v: Path) -> str:
    parts = ["## Mind Stone (what Jarvis remembers)"]
    proposals = read(v / "Jarvis/Proposals.md", 6000)
    pending = [l for l in proposals.splitlines() if "status: proposed" in l]
    parts.append(f"### Proposals waiting for Kevin's decision: {len(pending)}\n" + ("\n".join(pending) if pending else "None."))
    parts.append(f"### Corrections Jarvis follows\n{read(v / 'Jarvis/Corrections.md', 3500)}")
    return "\n\n".join(parts)


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[2] not in ("research", "linkedin", "mindstone"):
        sys.exit("usage: vault_gather.py <vault dir> research|linkedin|mindstone")
    v = Path(sys.argv[1]).expanduser()
    print({"research": research, "linkedin": linkedin, "mindstone": mindstone}[sys.argv[2]](v))


if __name__ == "__main__":
    main()
