"""SMTP/IMAP checks for deploy/test/mail-stack.sh (stdlib only).

Environment: SMTP_PORT, SUBMISSION_PORT, SUBMISSIONS_PORT, IMAPS_PORT (on 127.0.0.1), CA_FILE (the
self-signed test certificate, verified for MAIL_HOSTNAME), MAIL_HOSTNAME, ALICE_PW, BOB_PW.
Prints "ok <check>" per check; exits 1 at the first failure.
"""
import email
import email.utils
import imaplib
import os
import smtplib
import ssl
import sys
import time
import uuid

HOST = "127.0.0.1"
NAME = os.environ["MAIL_HOSTNAME"]
CTX = ssl.create_default_context(cafile=os.environ["CA_FILE"])
CTX.minimum_version = ssl.TLSVersion.TLSv1_2
P25 = int(os.environ["SMTP_PORT"])
P587 = int(os.environ["SUBMISSION_PORT"])
P465 = int(os.environ["SUBMISSIONS_PORT"])
P993 = int(os.environ["IMAPS_PORT"])
ALICE = ("alice@panel.test", os.environ["ALICE_PW"])
BOB = ("bob@panel.test", os.environ["BOB_PW"])


def ok(msg):
    print(f"  ok   {msg}", flush=True)


def fail(msg):
    print(f"  ERROR {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def message(frm, to, subject):
    return (
        f"From: {frm}\r\nTo: {to}\r\nSubject: {subject}\r\n"
        f"Date: {email.utils.formatdate()}\r\nMessage-ID: <{uuid.uuid4()}@panel.test>\r\n"
        "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"
        "Hello, this is a test message of the mail stack.\r\n"
    )


class SMTP(smtplib.SMTP):
    """Connects to 127.0.0.1 but verifies the certificate for MAIL_HOSTNAME."""

    def __init__(self, port):
        super().__init__(HOST, port, local_hostname="client.panel.test", timeout=30)
        self._host = NAME

    def starttls(self):  # noqa: D102
        return super().starttls(context=CTX)


class SMTPS(smtplib.SMTP_SSL):
    def __init__(self, port):
        super().__init__(local_hostname="client.panel.test", timeout=30, context=CTX)
        self._host = NAME
        self.connect(HOST, port)

    def _get_socket(self, host, port, timeout):
        sock = __import__("socket").create_connection((HOST, port), timeout)
        return self.context.wrap_socket(sock, server_hostname=NAME)


class IMAPS(imaplib.IMAP4_SSL):
    def __init__(self):
        super().__init__(HOST, P993, ssl_context=CTX, timeout=30)

    def _create_socket(self, timeout):
        sock = __import__("socket").create_connection((HOST, P993), timeout)
        return self.ssl_context.wrap_socket(sock, server_hostname=NAME)


def expect_code(fn, codes, what):
    try:
        fn()
    except smtplib.SMTPRecipientsRefused as e:
        code = list(e.recipients.values())[0][0]
    except smtplib.SMTPSenderRefused as e:
        code = e.smtp_code
    except smtplib.SMTPResponseException as e:
        code = e.smtp_code
    else:
        fail(f"{what}: accepted, expected {codes}")
    if code not in codes:
        fail(f"{what}: got {code}, expected {codes}")
    ok(f"{what} ({code})")


def fetch(user, subject, timeout=60):
    """Waits for a message with this subject in the INBOX of user; returns its raw text."""
    deadline = time.time() + timeout
    while True:
        m = IMAPS()
        m.login(*user)
        m.select("INBOX")
        typ, data = m.search(None, "SUBJECT", f'"{subject}"')
        ids = data[0].split()
        if ids:
            typ, msg = m.fetch(ids[-1], "(RFC822)")
            m.logout()
            return msg[0][1].decode("utf-8", "replace")
        m.logout()
        if time.time() > deadline:
            fail(f"message '{subject}' not in INBOX of {user[0]} after {timeout}s")
        time.sleep(1)


def main():
    run = uuid.uuid4().hex[:8]

    # --- port 25: inbound, no AUTH, no relay
    s = SMTP(P25)
    s.ehlo()
    if s.has_extn("auth"):
        fail("port 25 offers AUTH before STARTTLS")
    s.starttls()
    s.ehlo()
    if s.has_extn("auth"):
        fail("port 25 offers AUTH (must only be on 465/587)")
    ver = s.sock.version()
    if ver not in ("TLSv1.2", "TLSv1.3"):
        fail(f"port 25 negotiated {ver}")
    ok(f"port 25: STARTTLS with the certificate for {NAME} ({ver}), no AUTH")
    subj1 = f"inbound {run}"
    s.sendmail("someone@outside.test", [ALICE[0]], message("someone@outside.test", ALICE[0], subj1))
    ok("port 25: mail for alice@panel.test accepted")
    expect_code(lambda: s.sendmail("someone@outside.test", ["victim@example.net"],
                                   message("someone@outside.test", "victim@example.net", "relay")),
                (554,), "port 25: relaying to a foreign domain without auth is refused")
    expect_code(lambda: s.sendmail("someone@outside.test", ["nobody@panel.test"],
                                   message("someone@outside.test", "nobody@panel.test", "unknown")),
                (550,), "port 25: unknown mailbox is refused")
    subj3 = f"catchall {run}"
    s.sendmail("someone@outside.test", [f"anything-{run}@node1.test"],
               message("someone@outside.test", f"anything-{run}@node1.test", subj3))
    ok("port 25: mail for <anything>@node1.test (catch-all) accepted")
    s.quit()

    fetch(ALICE, subj1)
    ok("IMAPS (ARGON2ID password): alice received the inbound mail")
    fetch(BOB, subj3)
    ok("catch-all @node1.test delivered to bob@panel.test")

    # --- 587 without TLS: no AUTH, nothing accepted
    s = SMTP(P587)
    s.ehlo()
    if s.has_extn("auth"):
        fail("port 587 offers AUTH without TLS")
    expect_code(lambda: s.sendmail(ALICE[0], [BOB[0]], message(ALICE[0], BOB[0], "plain")),
                (530,), "port 587 without STARTTLS: refused")
    s.close()

    # --- 587 STARTTLS + AUTH
    s = SMTP(P587)
    s.starttls()
    s.ehlo()
    try:
        s.login(ALICE[0], "wrong-password")
        fail("login with a wrong password succeeded")
    except smtplib.SMTPAuthenticationError as e:
        ok(f"port 587: wrong password refused ({e.smtp_code})")
    s.close()

    s = SMTP(P587)
    s.starttls()
    s.login(*ALICE)
    subj2 = f"submission {run}"
    s.sendmail(ALICE[0], [BOB[0]], message(ALICE[0], BOB[0], subj2))
    ok("port 587: STARTTLS + AUTH as alice, mail to bob accepted")
    s.sendmail("info@panel.test", [BOB[0]], message("info@panel.test", BOB[0], f"alias {run}"))
    ok("port 587: alice may send as her alias info@panel.test")
    expect_code(lambda: s.sendmail(BOB[0], [ALICE[0]], message(BOB[0], ALICE[0], "spoof")),
                (553,), "port 587: alice sending as bob@panel.test is refused")
    expect_code(lambda: s.sendmail("ceo@node1.test", [ALICE[0]], message("ceo@node1.test", ALICE[0], "spoof2")),
                (553,), "port 587: alice sending as an address of another domain is refused")
    s.quit()

    raw = fetch(BOB, subj2)
    msg = email.message_from_string(raw)
    sig = msg.get("DKIM-Signature", "")
    flat = "".join(sig.split())
    if "d=panel.test" not in flat or "s=dkim" not in flat:
        fail(f"no DKIM-Signature d=panel.test s=dkim on the submitted mail: {sig!r}")
    ok("DKIM-Signature (d=panel.test; s=dkim) present on mail sent via submission")

    # --- 465 implicit TLS + AUTH
    s = SMTPS(P465)
    s.ehlo()
    if not s.has_extn("auth"):
        fail("port 465 does not offer AUTH")
    s.login(*BOB)
    subj4 = f"submissions {run}"
    s.sendmail(BOB[0], [ALICE[0]], message(BOB[0], ALICE[0], subj4))
    s.quit()
    ok("port 465: implicit TLS + AUTH as bob, mail accepted")
    fetch(ALICE, subj4)
    ok("alice received the mail from 465")

    # --- IMAPS: wrong password refused
    m = IMAPS()
    try:
        m.login(ALICE[0], "wrong-password")
        fail("IMAP login with a wrong password succeeded")
    except imaplib.IMAP4.error:
        ok("IMAPS: wrong password refused")


if __name__ == "__main__":
    main()
