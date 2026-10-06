#!/opt/venv/bin/python
"""shim.py — the per-workspace outreach engine (docs/cloudflare.md).

One stdlib HTTP server wrapping the *sending* half of the installed
openoutreach package. The finding half is deliberately not exposed: the
calling agent (voki) discovers and qualifies leads itself and hands them
over through the documented ingest contract — JSON Lines on stdin, the pipe
`outfind find --json | outsend` has always implemented.

What this adds over the CLI:

  - the turn-based --agent-draft protocol as request/response: a sending
    pass stops at draft_pending carrying the deal's own fields, which ride
    on GET /pending until the caller answers with POST /draft;
  - read-only CRM endpoints over the sender's own tables;
  - the R2 state sync (restore at boot, upload after every change) over the
    Worker's outbound proxy — the container holds no credentials.

Everything runs under the orchestrator's settings (one database at
OPENOUTREACH_DB), so the sender's leads, deals, mail log and suppression
list are the only store there is.
"""

from __future__ import annotations

import json
import os
import signal
import sqlite3
import subprocess
import sys
import tarfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("SHIM_PORT", "8080"))
DB = os.environ.get("OPENOUTREACH_DB", "/app/data/db.sqlite3")
WORKSPACE = os.environ.get("WORKSPACE_ID", "default")
STATE_HOST = os.environ.get("STATE_HOST", "state.internal")
PREFIX = f"crm/{WORKSPACE}"
HOME = os.environ.get("HOME", "/root")
SEND_TIMEOUT = 6 * 3600  # `send all` waits out the send clocks; let it

# One CLI subprocess at a time — one job per database, ever, enforced here too.
RUN_MUTEX = threading.Lock()
JOB_LOCK = threading.Lock()
CURRENT: dict[str, subprocess.Popen] = {}
# JOB tracks only the send/draft protocol lifecycle, so a pending draft can
# never be hidden by an ingest or a check; those report into their own slots.
JOB: dict = {"verb": None, "phase": "idle", "updated_at": None}
LAST_INGEST: dict | None = None
LAST_CHECK: dict | None = None


def log(message: str) -> None:
    print(f"[engine:{WORKSPACE}] {message}", flush=True)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── the R2 state store, over the Worker's outbound proxy ─────────────


def r2_get(key: str) -> bytes | None:
    try:
        with urllib.request.urlopen(f"http://{STATE_HOST}/{PREFIX}/{key}", timeout=300) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def r2_put(key: str, data: bytes) -> None:
    req = urllib.request.Request(
        f"http://{STATE_HOST}/{PREFIX}/{key}", data=data, method="PUT",
        headers={"Content-Type": "application/octet-stream"})
    with urllib.request.urlopen(req, timeout=900) as r:
        r.read()


def checkpoint() -> None:
    """Fold the WAL into the main file before it is uploaded."""
    if not os.path.exists(DB):
        return
    conn = sqlite3.connect(DB)
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        conn.close()


def scrubbed_copy() -> bytes:
    """The database as it may leave the container: mailbox passwords blanked.

    Credentials live in the workspace's Durable Object and arrive as
    ENGINE_MAILBOXES at every start (reconcile_workspace puts them back), so
    the copy in R2 — and what GET /db serves — never holds one.
    """
    copy = "/tmp/upload.sqlite3"
    src, dst = sqlite3.connect(DB), sqlite3.connect(copy)
    try:
        src.backup(dst)
        dst.execute("UPDATE outsend_emails_mailbox SET password = ''")
        dst.commit()
    finally:
        src.close()
        dst.close()
    try:
        with open(copy, "rb") as f:
            return f.read()
    finally:
        os.remove(copy)


def sync_state() -> None:
    """Persist the whole engine state: database, home, job document."""
    try:
        checkpoint()
        if os.path.exists(DB):
            r2_put("db.sqlite3", scrubbed_copy())
        import io
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            tar.add(HOME, arcname=".")
        r2_put("home.tar.gz", buf.getvalue())
        r2_put("job.json", json.dumps(pending_document()).encode())
    except Exception as e:  # a failed sync must not lose the response
        log(f"WARNING: state sync failed: {e}")


def load_job_from_store() -> None:
    global JOB, LAST_INGEST, LAST_CHECK
    raw = None
    try:
        raw = r2_get("job.json")
    except Exception as e:
        log(f"warning: could not read job state from the store ({e})")
    if raw:
        try:
            stored = json.loads(raw)
            LAST_INGEST = stored.get("last_ingest")
            LAST_CHECK = stored.get("last_check")
            JOB = {k: v for k, v in stored.items()
                   if k not in ("last_ingest", "last_check")}
        except ValueError:
            pass
    if JOB.get("phase") == "running":
        # The process died mid-run (container sleep or host restart). The
        # database is consistent; the caller resumes by starting the verb
        # again — every verb is resumable by design.
        JOB = {"verb": JOB.get("verb"), "phase": "error",
               "error": {"type": "interrupted",
                         "message": "the run was interrupted; re-issue the verb to resume"},
               "updated_at": now()}


def set_job(**fields) -> None:
    with JOB_LOCK:
        JOB.update(fields, updated_at=now())


def pending_document() -> dict:
    with JOB_LOCK:
        doc = dict(JOB)
    doc["last_ingest"] = LAST_INGEST
    doc["last_check"] = LAST_CHECK
    return doc


# ── running the CLI ──────────────────────────────────────────────────

# Ingest and check have no orchestrator verb of their own, so they enter
# through the sender's main() — under OUR settings module, so every verb
# lands in the one database.
_INGEST = ("import os,sys; os.environ['DJANGO_SETTINGS_MODULE']='openoutreach.settings'; "
           "from cold_outreach.__main__ import main; sys.exit(main([]))")
_CHECK = ("import os,sys; os.environ['DJANGO_SETTINGS_MODULE']='openoutreach.settings'; "
          "from cold_outreach.__main__ import main; sys.exit(main(['check']))")


# The workspace's configuration, applied to the database at every start. The
# sender seeds its operator and mailbox from the environment only while none
# exists, so a later change would otherwise be ignored — and its one-mailbox
# variables cannot describe a pool. This goes through the sender's own
# set_operator and Mailbox.objects.create_verified (the SMTP-login gate).
# A retired box keeps its threads: replies are still read and answered, but it
# opens no conversation and sends no follow-up (its spacing clock never runs out).
_RECONCILE = r"""
import json, os, sys
from datetime import datetime, timezone as tz
os.environ['DJANGO_SETTINGS_MODULE'] = 'openoutreach.settings'
import django; django.setup()
from cold_outreach.core.operator import set_operator
from cold_outreach.emails.models import Mailbox

RETIRED = datetime(9000, 1, 1, tzinfo=tz.utc)
name = os.environ.get('OUTSEND_OPERATOR_NAME', '').strip()
if name:
    set_operator(full_name=name, email=os.environ.get('OUTSEND_OPERATOR_EMAIL', '').strip())

configured = json.loads(os.environ.get('ENGINE_MAILBOXES') or '[]')
results = []
for box in configured:
    address = box['address']
    transport = dict(host=box['smtp_host'], port=box['smtp_port'],
                     imap_host=box['imap_host'], imap_port=box['imap_port'])
    row = Mailbox.objects.filter(username=address).first()
    same = row is not None and all(getattr(row, k) == v for k, v in transport.items())
    if box.get('verify') or not same:
        if box.get('retired'):
            results.append({'address': address, 'ok': True, 'retired': True})
            continue
        row, reason = Mailbox.objects.create_verified(
            from_address=address, password=box['app_password'], **transport)
        if row is None:
            results.append({'address': address, 'ok': False, 'reason': reason})
            continue
    else:
        row.password = box['app_password']
    row.next_send_at = RETIRED if box.get('retired') else (
        None if row.next_send_at == RETIRED else row.next_send_at)
    if box.get('signature') is not None:
        row.signature = box['signature']
    row.save()
    results.append({'address': address, 'ok': True, 'retired': bool(box.get('retired'))})

# A row no configuration names any more: retired, and its credentials dropped.
names = {box['address'] for box in configured}
for row in Mailbox.objects.exclude(username__in=names):
    row.password, row.next_send_at = '', RETIRED
    row.save(update_fields=['password', 'next_send_at'])
    results.append({'address': row.username, 'ok': True, 'retired': True, 'unconfigured': True})
print(json.dumps(results))
"""
MAILBOX_STATUS: list[dict] = []


def reconcile_workspace() -> None:
    """Apply the configuration this instance was started with; record per-box results."""
    global MAILBOX_STATUS
    proc = subprocess.run([sys.executable, "-c", _RECONCILE], capture_output=True,
                          text=True, timeout=600)
    if proc.returncode != 0:
        log(f"WARNING: reconcile failed: {proc.stderr.strip()[-2000:]}")
        MAILBOX_STATUS = [{"ok": False, "reason": "reconcile failed — see logs"}]
        return
    MAILBOX_STATUS = json.loads(proc.stdout.strip().splitlines()[-1])
    for box in MAILBOX_STATUS:
        log(f"mailbox {box.get('address')}: {'ok' if box['ok'] else box.get('reason')}")
    sync_state()


# Every sending pass runs with replies held for the owner (engine_review.py):
# the sender's model still drafts them, nothing reaches a prospect unreviewed.
REVIEW = [sys.executable, "/engine_review.py"]
_PASS = [*REVIEW, "pass"]


def run_cli(args: list[str], stdin_text: str | None = None,
            timeout: int = SEND_TIMEOUT) -> dict:
    """Run one CLI invocation and translate its exit contract to a dict."""
    proc = subprocess.run(args, input=stdin_text, capture_output=True,
                          text=True, timeout=timeout)
    return finish_cli(proc.returncode, proc.stdout, proc.stderr)


def finish_cli(code: int, stdout: str, stderr: str) -> dict:
    """The CLI's contract: exit 0 = goal met; anything else carries a typed
    error on stderr as one JSON object under --json, with the pending
    protocol's payload (profile_text, company, ...) on the error object."""
    tail = (stderr or "").strip().splitlines()
    parsed = None
    for line in reversed(tail):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                parsed = json.loads(line)
                break
            except ValueError:
                continue
    error = (parsed or {}).get("error") if isinstance(parsed, dict) else None
    return {"exit": code, "stdout": stdout, "stderr": "\n".join(tail[-40:]),
            "error": error}


def background(verb: str, args: list[str], stdin_text: str | None = None) -> None:
    def work() -> None:
        acquired = RUN_MUTEX.acquire(timeout=5)
        if not acquired:
            # Never clobber the live job document — the caller polls /pending.
            log("busy: another run holds the database; start ignored")
            return
        try:
            set_job(verb=verb, phase="running")
            proc = subprocess.Popen(args, stdin=subprocess.PIPE if stdin_text is not None else None,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            CURRENT["proc"] = proc
            try:
                out, err = proc.communicate(input=stdin_text, timeout=SEND_TIMEOUT)
                result = finish_cli(proc.returncode, out, err)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
                result = {"exit": 124, "stdout": "", "stderr": "timeout",
                          "error": {"type": "timeout", "message": f"run exceeded {SEND_TIMEOUT}s"}}
            finally:
                CURRENT.pop("proc", None)
            error = result.get("error")
            if error and error.get("type") == "draft_pending":
                phase = "draft_pending"
            elif result["exit"] != 0:
                # The orchestrator renders send failures as one plain line
                # (no JSON object), so a non-zero exit without a parsed error
                # is still a failure — the message rides in result.stderr.
                phase = "error"
            else:
                phase = "done"
            set_job(verb=verb, phase=phase, result=result, error=error)
            sync_state()
        finally:
            RUN_MUTEX.release()
    threading.Thread(target=work, daemon=True).start()


# ── CRM reads, straight off the sender's tables ──────────────────────

def query(sql: str, params: tuple = (), limit_default: int = 100) -> list[dict]:
    if not os.path.exists(DB):
        return []
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def crm_leads(limit: int) -> list[dict]:
    return query(
        """SELECT l.lead_id, l.email, l.first_name, l.last_name, l.company, l.title,
                  l.website, l.linkedin_url, l.profile_summary, l.created_at, l.updated_at,
                  d.state, d.outcome, d.reason AS deal_reason, d.email_subject,
                  d.email_sent_at, d.chat_summary, d.qualified_at,
                  EXISTS(SELECT 1 FROM outsend_leads_suppression s
                         WHERE s.email = l.email) AS suppressed
           FROM outsend_leads_lead l
           LEFT JOIN outsend_leads_deal d ON d.lead_id = l.id
           ORDER BY COALESCE(d.email_sent_at, l.created_at) DESC
           LIMIT ?""", (limit,))


def crm_conversations(limit: int) -> list[dict]:
    return query(
        """SELECT m.direction, m.from_address, m.to_address, m.subject,
                  m.sent_at, m.received_at, m.kind, l.lead_id, l.company, l.title,
                  d.state AS deal_state
           FROM outsend_emails_message m
           LEFT JOIN outsend_leads_deal d ON d.thread_id = m.thread_id
           LEFT JOIN outsend_leads_lead l ON l.id = d.lead_id
           ORDER BY COALESCE(m.sent_at, m.received_at, m.recorded_at) DESC
           LIMIT ?""", (limit,))


def mailboxes() -> list[dict]:
    """Each configured box: whether it connected, and the pacing it has learned."""
    rows = {r["username"]: r for r in query(
        # the password column is deliberately not selected
        """SELECT username, host, port, imap_host, imap_port, signature,
                  daily_limit, measured_on, next_send_at
           FROM outsend_emails_mailbox ORDER BY id""")}
    out = []
    for status in MAILBOX_STATUS:
        row = rows.get(status.get("address"), {})
        if status.get("retired"):
            row = {k: v for k, v in row.items() if k != "next_send_at"}
        out.append({**status, **{k: v for k, v in row.items() if k != "username"}})
    return out


# ── HTTP surface ─────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # one clean line per request
        log(f"http {self.command} {urllib.parse.urlparse(self.path).path}")

    # -- plumbing
    def _body(self, limit: int) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            raise ValueError(f"body exceeds {limit} bytes")
        return self.rfile.read(length) if length else b""

    def _json(self, payload, status: int = 200) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _not_found(self) -> None:
        self._json({"error": "not_found"}, 404)

    # -- routes
    def do_GET(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        query = urllib.parse.urlparse(self.path).query
        if path == "/health":
            return self._json({"ok": True, "workspace": WORKSPACE})
        if path == "/pending":
            return self._json(pending_document())
        if path == "/crm/leads":
            return self._json({"leads": crm_leads(self._limit(query))})
        if path == "/crm/conversations":
            return self._json({"messages": crm_conversations(self._limit(query))})
        if path == "/mailboxes":
            return self._json({"mailboxes": mailboxes()})
        if path == "/replies":
            proc = subprocess.run([*REVIEW, "list"], capture_output=True, text=True, timeout=120)
            if proc.returncode != 0:
                return self._json({"error": "review_list_failed", "message": proc.stderr[-500:]}, 500)
            return self._json(json.loads(proc.stdout.strip().splitlines()[-1]))
        return self._not_found()

    def do_POST(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        if path == "/leads":
            return self._ingest()
        if path == "/send":
            return self._send()
        if path == "/draft":
            return self._draft()
        if path == "/check":
            return self._check()
        if path.startswith("/replies/"):
            return self._decide_reply(path.removeprefix("/replies/"))
        return self._not_found()

    @staticmethod
    def _limit(query_string: str) -> int:
        from urllib.parse import parse_qs
        try:
            return max(1, min(500, int(parse_qs(query_string).get("limit", ["100"])[0])))
        except ValueError:
            return 100

    def _ingest(self) -> None:
        """The public pipe, as an endpoint: JSON Lines in, rows stored.

        Idempotent on lead_id; suppression checked at the door; a malformed
        line is skipped and counted; a blank email is stored, not rejected.
        """
        global LAST_INGEST
        try:
            body = self._body(2_000_000).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as e:
            return self._json({"error": "bad_body", "message": str(e)}, 400)
        if not body.strip():
            return self._json({"error": "bad_body", "message": "no JSON Lines in body"}, 400)
        acquired = RUN_MUTEX.acquire(timeout=30)
        if not acquired:
            return self._json({"error": "busy"}, 409)
        try:
            result = run_cli([sys.executable, "-c", _INGEST], stdin_text=body, timeout=600)
            LAST_INGEST = {"at": now(), **result}
            sync_state()
            return self._json(result, 200 if result["exit"] == 0 else 422)
        finally:
            RUN_MUTEX.release()

    def _send(self) -> None:
        """Start a sending pass in --agent-draft mode; poll /pending.

        The pass reads the mail, answers replies, and stops at the first
        deal needing an opener (draft_pending) or when the guards say stop.
        """
        try:
            payload = json.loads(self._body(4096) or b"{}")
        except ValueError:
            return self._json({"error": "bad_json"}, 400)
        with JOB_LOCK:
            if JOB.get("phase") == "running":
                return self._json({"error": "busy"}, 409)
        n = payload.get("n")
        args = [*_PASS, "send"]
        if n is not None:
            if n != "all" and not (isinstance(n, int) and 1 <= n <= 500):
                return self._json({"error": "bad_n"}, 400)
            args.append(str(n))
        args += ["--agent-draft", "--json"]
        background("send", args)
        return self._json({"started": True}, 202)

    def _draft(self) -> None:
        """Answer the pending draft: the opener the caller wrote itself."""
        try:
            payload = json.loads(self._body(100_000) or b"{}")
        except ValueError:
            return self._json({"error": "bad_json"}, 400)
        subject, body = payload.get("subject"), payload.get("body")
        with JOB_LOCK:
            if JOB.get("phase") != "draft_pending":
                return self._json({"error": "no_pending_draft"}, 409)
        if not isinstance(subject, str) or not isinstance(body, str) or not body.strip():
            return self._json({"error": "bad_draft"}, 400)
        background("draft", [*_PASS, "send",
                             "--agent-draft", "--subject", subject, "--body", body, "--json"])
        return self._json({"started": True}, 202)

    def _decide_reply(self, review_id: str) -> None:
        """Send (as suggested, or edited) or dismiss one held reply."""
        if not review_id.isdigit():
            return self._not_found()
        try:
            payload = json.loads(self._body(100_000) or b"{}")
        except ValueError:
            return self._json({"error": "bad_json"}, 400)
        action = payload.get("action")
        body = payload.get("body")
        if action not in ("send", "dismiss") or (body is not None and not isinstance(body, str)):
            return self._json({"error": "bad_request",
                               "message": "expected {action: send|dismiss, body?: string}"}, 400)
        acquired = RUN_MUTEX.acquire(timeout=30)
        if not acquired:
            return self._json({"error": "busy"}, 409)
        try:
            proc = subprocess.run([*REVIEW, action, review_id], capture_output=True, text=True,
                                  timeout=300, input=json.dumps({"body": body}) if body is not None else "")
            try:
                result = json.loads(proc.stdout.strip().splitlines()[-1])
            except (ValueError, IndexError):
                return self._json({"error": "review_failed", "message": proc.stderr[-800:]}, 500)
            if proc.returncode == 0:
                sync_state()
            status = {0: 200, 2: 400, 3: 409, 4: 404}.get(proc.returncode, 500)
            return self._json(result, status)
        finally:
            RUN_MUTEX.release()

    def _check(self) -> None:
        """`outsend check`: verifies what a run needs — including a real
        SMTP login for the mailbox. Bounded; runs synchronously."""
        global LAST_CHECK
        acquired = RUN_MUTEX.acquire(timeout=30)
        if not acquired:
            return self._json({"error": "busy"}, 409)
        try:
            result = run_cli([sys.executable, "-c", _CHECK], timeout=300)
            LAST_CHECK = {"at": now(), **result}
            return self._json(result, 200 if result["exit"] == 0 else 422)
        finally:
            RUN_MUTEX.release()


# ── lifecycle ────────────────────────────────────────────────────────

def shutdown(signum, _frame) -> None:
    log(f"signal {signum}: stopping")
    proc = CURRENT.get("proc")
    if proc is not None:
        proc.terminate()  # the CLI exits cleanly; nothing found is lost
        try:
            proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            proc.kill()
    if JOB.get("phase") == "running":
        set_job(phase="error", error={"type": "interrupted",
                                      "message": "container stopped mid-run"})
    sync_state()
    sys.exit(0)


def main() -> None:
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    load_job_from_store()
    reconcile_workspace()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"engine up on :{PORT} (workspace {WORKSPACE}, db {DB})")
    server.serve_forever()


if __name__ == "__main__":
    main()
