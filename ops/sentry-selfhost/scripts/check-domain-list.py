#!/usr/bin/env python3
"""CI guard: the DNS Firewall block list in core.json and the evidence pattern in
scripts/verify-no-phone-home.sh must name the same Sentry-company domains, and
the block list must cover each domain and its subdomains."""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
BACKSLASH = chr(92)

core = json.loads((ROOT / "core.json").read_text())
domains = core["Resources"]["SentryCompanyDomainList"]["Properties"]["Domains"]
apexes = sorted({d.removeprefix("*.") for d in domains})
for apex in apexes:
    if apex not in domains or f"*.{apex}" not in domains:
        raise SystemExit(f"{apex}: the firewall list needs both {apex} and *.{apex}")

script = (ROOT / "scripts" / "verify-no-phone-home.sh").read_text()
match = re.search(r"\(\^\|\\\.\)\(([^)]*)\)", script)
if not match:
    raise SystemExit("evidence pattern not found in scripts/verify-no-phone-home.sh")
pattern = sorted(p.replace(BACKSLASH + ".", ".") for p in match.group(1).split("|"))
if pattern != apexes:
    raise SystemExit(f"evidence pattern {pattern} does not match the firewall list {apexes}")
print("firewall list and evidence pattern agree:", ", ".join(apexes))
