#!/usr/bin/env python3
"""Find the inbox message Jarvis proposes to reply to (spec §14.3). Read-only.
    mail_find.py <sender address> <subject>
Prints a JSON list (newest first, at most 3) of {rowid, from, fromName, subject, date} for inbox
messages from that exact sender in the last 21 days whose subject matches, ignoring Re:/Fwd: prefixes."""
from __future__ import annotations

import datetime as dt
import json
import re
import sqlite3
import sys
from pathlib import Path


def norm(s: str) -> str:
    s = re.sub(r"^\s*((re|fwd?|aw|wg)\s*:\s*)+", "", s or "", flags=re.I)
    return re.sub(r"\s+", " ", s).strip().lower()


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit("usage: mail_find.py <sender> <subject>")
    sender, subject = sys.argv[1].strip().lower(), norm(sys.argv[2])
    db = sorted(Path.home().glob("Library/Mail/V*/MailData/Envelope Index"))[-1]
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    since = int((dt.datetime.now() - dt.timedelta(days=21)).timestamp())
    rows = con.execute(
        """select distinct m.ROWID, a.address, a.comment, s.subject, m.date_received
           from messages m
           join addresses a on a.ROWID = m.sender
           join subjects s on s.ROWID = m.subject
           join mailboxes mb on mb.ROWID = m.mailbox
           left join labels lb on lb.message_id = m.ROWID
           left join mailboxes lmb on lmb.ROWID = lb.mailbox_id
           where m.deleted = 0 and m.date_received >= ? and lower(a.address) = ?
             and (mb.url like '%/INBOX' or lmb.url like '%/INBOX')
           order by m.date_received desc""", (since, sender)).fetchall()
    out = []
    for rowid, addr, name, subj, received in rows:
        if norm(subj) != subject:
            continue
        when = dt.datetime.fromtimestamp(received).strftime("%a %b %-d, %-I:%M %p")
        out.append({"rowid": rowid, "from": addr, "fromName": name or "", "subject": subj, "date": when})
        if len(out) == 3:
            break
    print(json.dumps(out))


if __name__ == "__main__":
    main()
