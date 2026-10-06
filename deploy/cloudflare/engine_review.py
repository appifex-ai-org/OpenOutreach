#!/opt/venv/bin/python
"""engine_review.py — replies to prospects wait for the owner (docs/cloudflare.md).

The sender answers a prospect's reply on its own: its model decides, and a
`send_message` decision goes straight out. This engine holds that one action
for review instead. Everything else the reply step decides still happens on
its own, because none of it writes to the prospect:

  - an opt-out is honoured at once (suppressed for good, nothing sent);
  - a closed conversation (`mark_completed`) is closed.

A held reply is stored with the inbound message it answers, in this
workspace's own database (so it syncs to R2 with everything else). The
owner sends it — as suggested or edited — or dismisses it (they answered
from their own mailbox). Either way the engine never suggests again for that
inbound message; a newer message from the prospect makes a new suggestion,
and makes the older one stale.

A replied-to deal is never followed up (the sender's follow-up pool excludes
any thread with an inbound turn since our last message), so holding a reply
cannot trigger a chaser.

Usage (the shim runs these):
  engine_review.py pass <openoutreach send args...>   a send pass with review on
  engine_review.py list                               pending reviews, as JSON
  engine_review.py send <id>      (stdin: {"body": "..."})
  engine_review.py dismiss <id>
"""

from __future__ import annotations

import json
import logging
import os
import sys
from types import SimpleNamespace

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "openoutreach.settings")

import django  # noqa: E402

django.setup()

from django.db import connection, transaction  # noqa: E402
from django.utils import timezone  # noqa: E402

logger = logging.getLogger("engine.review")

TABLE = "engine_reply_review"


def ensure_table() -> None:
    with connection.cursor() as c:
        c.execute(f"""CREATE TABLE IF NOT EXISTS {TABLE} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            deal_id INTEGER NOT NULL,
            inbound_message_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            suggestion TEXT NOT NULL,
            sent_body TEXT,
            created_at TEXT NOT NULL,
            decided_at TEXT,
            UNIQUE (deal_id, inbound_message_id))""")


def newest_inbound(deal):
    """The prospect's newest turn — what a reply would be answering."""
    from cold_outreach.emails.models import Direction

    if not deal.thread_id:
        return None
    return (deal.thread.turns().filter(direction=Direction.INBOUND)
            .order_by("-sent_at", "-pk").first())


def install() -> None:
    """Route the sender's reply step through review."""
    import cold_outreach.emails.steps.reply as reply

    ensure_table()
    original = reply.answer_reply

    def answer_with_review(deal):
        inbound = newest_inbound(deal)
        if inbound is not None:
            with connection.cursor() as c:
                c.execute(f"SELECT 1 FROM {TABLE} WHERE deal_id = %s AND inbound_message_id = %s",
                          [deal.pk, inbound.pk])
                if c.fetchone():
                    return None  # already with the owner (or decided) — wait for them
        held = []
        send = reply._send_reply
        reply._send_reply = lambda _deal, decision: held.append(decision)
        try:
            state = original(deal)
        finally:
            reply._send_reply = send
        if held and inbound is not None:
            with connection.cursor() as c:
                c.execute(f"INSERT OR IGNORE INTO {TABLE} (deal_id, inbound_message_id, suggestion, created_at)"
                          " VALUES (%s, %s, %s, %s)",
                          [deal.pk, inbound.pk, held[-1].message, timezone.now().isoformat()])
            logger.info("reply to %s held for the owner's review", deal.lead.public_id)
        return state

    reply.answer_reply = answer_with_review


def pending() -> list[dict]:
    from cold_outreach.emails.models import Direction
    from cold_outreach.leads.models import Deal

    ensure_table()
    with connection.cursor() as c:
        c.execute(f"SELECT id, deal_id, inbound_message_id, suggestion, created_at FROM {TABLE}"
                  " WHERE status = 'pending' ORDER BY id")
        rows = c.fetchall()
    out = []
    for review_id, deal_id, inbound_id, suggestion, created_at in rows:
        deal = Deal.objects.select_related("lead").filter(pk=deal_id).first()
        if deal is None:
            continue
        newest = newest_inbound(deal)
        lead = deal.lead
        thread = [
            {"direction": m.direction, "subject": m.subject, "sent_at": m.sent_at.isoformat() if m.sent_at else None,
             "body": m.body_text}
            for m in (deal.thread.turns() if deal.thread_id else [])
        ]
        out.append({
            "id": review_id,
            "lead_id": lead.lead_id,
            "email": lead.email,
            "first_name": lead.first_name,
            "last_name": lead.last_name,
            "company": lead.company,
            "title": lead.title,
            "subject": f"Re: {deal.email_subject}" if not (deal.email_subject or "").lower().startswith("re:")
            else deal.email_subject,
            "suggestion": suggestion,
            "stale": newest is None or newest.pk != inbound_id,
            "thread": thread[-6:],
            "inbound_count": sum(1 for m in thread if m["direction"] == Direction.INBOUND),
            "created_at": created_at,
        })
    return out


def decide(review_id: int, action: str, body: str | None) -> tuple[int, dict]:
    """Send or dismiss one pending review. Returns (exit code, payload)."""
    import cold_outreach.emails.steps.reply as reply
    from cold_outreach.leads.models import Deal

    ensure_table()
    with transaction.atomic():
        with connection.cursor() as c:
            c.execute(f"SELECT deal_id, inbound_message_id, suggestion, status FROM {TABLE} WHERE id = %s",
                      [review_id])
            row = c.fetchone()
        if row is None:
            return 4, {"error": "not_found"}
        deal_id, inbound_id, suggestion, status = row
        if status != "pending":
            return 3, {"error": "already_decided", "status": status}
        deal = Deal.objects.select_related("lead", "mailbox", "thread").get(pk=deal_id)
        newest = newest_inbound(deal)
        if newest is None or newest.pk != inbound_id:
            with connection.cursor() as c:
                c.execute(f"UPDATE {TABLE} SET status = 'stale', decided_at = %s WHERE id = %s",
                          [timezone.now().isoformat(), review_id])
            return 3, {"error": "stale",
                       "message": "the prospect wrote again — the next pass suggests a new reply"}
        if action == "dismiss":
            with connection.cursor() as c:
                c.execute(f"UPDATE {TABLE} SET status = 'dismissed', decided_at = %s WHERE id = %s",
                          [timezone.now().isoformat(), review_id])
            return 0, {"dismissed": True}
        text = (body if body is not None else suggestion).strip()
        if not text:
            return 2, {"error": "bad_body"}
        reply._send_reply(deal, SimpleNamespace(message=text))
        with connection.cursor() as c:
            c.execute(f"UPDATE {TABLE} SET status = 'sent', sent_body = %s, decided_at = %s WHERE id = %s",
                      [text, timezone.now().isoformat(), review_id])
        return 0, {"sent": True, "to": deal.lead.email}


def main(argv: list[str]) -> int:
    verb = argv[1] if len(argv) > 1 else ""
    if verb == "pass":
        install()
        from openoutreach.__main__ import main as openoutreach_main
        sys.argv = ["openoutreach", *argv[2:]]
        openoutreach_main(sys.argv)
        return 0
    if verb == "list":
        print(json.dumps({"replies": pending()}))
        return 0
    if verb in ("send", "dismiss") and len(argv) > 2 and argv[2].isdigit():
        body = None
        if verb == "send":
            raw = sys.stdin.read().strip()
            try:
                body = json.loads(raw).get("body") if raw else None
            except (ValueError, AttributeError):
                print(json.dumps({"error": "bad_json"}))
                return 2
        code, payload = decide(int(argv[2]), verb, body)
        print(json.dumps(payload))
        return code
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
