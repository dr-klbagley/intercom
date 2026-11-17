"""Print the newest digest Jarvis emailed Kevin (briefing or headlines), read-only from Apple Mail's index.

  latest_digest.py SCRIPTS_DIR SUBJECT_PREFIX [--days N]

The scheduled jobs email their content and keep only a delivery note, so the email itself is the
record. Reuses Jarvis's own Mail readers (travel_receipts.py) and sender address (kevin_mail_send.py).
Exit 3 if nothing was found.
"""
import argparse
import sys
import time
from datetime import datetime

ap = argparse.ArgumentParser()
ap.add_argument("scripts_dir")
ap.add_argument("subject_prefix")
ap.add_argument("--days", type=float, default=2)
a = ap.parse_args()
sys.path.insert(0, a.scripts_dir)

import kevin_mail_send as kms  # noqa: E402
import travel_receipts as tr  # noqa: E402

since = int(time.time() - a.days * 86400)
con = tr.db()
rows = con.execute(
    """select m.ROWID as rowid, m.date_received as received, s.subject as subject, mb.url as mailbox
         from messages m join subjects s on s.ROWID = m.subject
         join addresses a on a.ROWID = m.sender join mailboxes mb on mb.ROWID = m.mailbox
        where s.subject like ? escape '\\' and lower(a.address) = ? and m.date_received >= ?
        order by m.date_received desc limit 10""",
    (a.subject_prefix.replace("%", r"\%").replace("_", r"\_") + "%", kms.SENDER.lower(), since),
).fetchall()

for r in rows:
    path = tr.find_emlx(r["rowid"], tr.account_of(r["mailbox"]))
    if not path:
        continue
    html_body, text_body = tr.bodies(tr.parse_emlx(path))
    text = text_body or (tr.html_to_text(html_body) if html_body else "")
    if not text.strip():
        continue
    when = datetime.fromtimestamp(r["received"]).strftime("%A %-d %B, %-I:%M %p")
    print(f"Subject: {r['subject']}\nReceived: {when}\n\n{text.strip()}")
    sys.exit(0)

sys.exit(3)
