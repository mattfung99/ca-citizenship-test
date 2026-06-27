#!/usr/bin/env python3
"""
Supabase migration helper for citizenship-test.

When a free-plan Supabase project is paused or needs to be recreated, this
script exports all user accounts and attempt history from the OLD project and
re-imports them into a NEW project, remapping user IDs by email address.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUICK START
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1. cp scripts/migrate.env.example scripts/migrate.env
  2. Fill in OLD_SUPABASE_URL + OLD_SERVICE_ROLE_KEY
  3. make export                          # → backups/backup_<timestamp>.json
  4. Create a new Supabase project at https://supabase.com
  5. Apply the schema (choose one):
       a) Push to GitHub — the Supabase GitHub integration re-runs automatically
          once you reconnect it to the new project ref in the dashboard, OR
       b) Copy supabase/migrations/20260604000000_initial.sql into the new
          project's SQL editor and run it.
  6. Fill in NEW_SUPABASE_URL + NEW_SERVICE_ROLE_KEY + NEW_SUPABASE_ANON_KEY
  7. make import                          # restores data; users must reset passwords
  8. make update-config                   # rewrites src/config.js
  9. git add src/config.js && git commit -m "chore: point to new Supabase project"
     git push                            # GitHub integration picks up the new project

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NOTES ON USERS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Supabase Auth stores passwords as bcrypt hashes that cannot be exported.
The import step re-creates each user account by email (no password set,
email confirmed) so their attempt history is available immediately.
Users sign in via "Forgot password / send reset link" on first login to
the new project.  No attempt data is lost — it is re-linked by email.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMMANDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  python3 scripts/migrate.py export          [--out backups/backup_TIMESTAMP.json]
  python3 scripts/migrate.py import-data     [--backup backups/backup_LATEST.json]
  python3 scripts/migrate.py update-config

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_env_file(path: Path) -> None:
    """Load key=value pairs from a .env file into os.environ (no-op if absent)."""
    if not path.exists():
        return
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key:
                os.environ.setdefault(key, value)


def _require_env(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        sys.exit(f"ERROR: environment variable {name!r} is not set.\n"
                 "       Copy scripts/migrate.env.example → scripts/migrate.env and fill it in.")
    return val


def _api(method: str, url: str, service_role_key: str,
         body: Optional[dict] = None) -> "dict | list":
    """Make a JSON request to the Supabase REST or Auth Admin API."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Content-Type": "application/json",
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            # Ask PostgREST to return the inserted rows so we can verify.
            "Prefer": "return=representation",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode(errors="replace")
        sys.exit(f"HTTP {exc.code} {exc.reason} → {url}\n{body_text}")


def _paginate_users(base_url: str, key: str) -> List[dict]:
    """Fetch all auth users, handling Supabase's page-based pagination."""
    users = []
    page = 1
    per_page = 1000
    while True:
        url = f"{base_url}/auth/v1/admin/users?page={page}&per_page={per_page}"
        result = _api("GET", url, key)
        # Supabase returns {"users": [...], "aud": "...", "total": N}
        batch = result.get("users", result) if isinstance(result, dict) else result
        if not batch:
            break
        users.extend(batch)
        if len(batch) < per_page:
            break
        page += 1
    return users


def _latest_backup() -> Optional[Path]:
    """Return the most-recently modified backup file, if any exist."""
    backup_dir = REPO_ROOT / "backups"
    if not backup_dir.exists():
        return None
    files = sorted(backup_dir.glob("backup_*.json"), key=lambda p: p.stat().st_mtime)
    return files[-1] if files else None


# ---------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------

def cmd_export(args: argparse.Namespace) -> None:
    """Dump all users and attempts from the OLD project to a JSON backup file."""
    _load_env_file(REPO_ROOT / "scripts" / "migrate.env")

    url = _require_env("OLD_SUPABASE_URL").rstrip("/")
    key = _require_env("OLD_SERVICE_ROLE_KEY")

    print(f"Exporting from {url} …")

    # 1. Fetch all auth users (email + id).
    print("  Fetching auth users …", end="", flush=True)
    raw_users = _paginate_users(url, key)
    users = [{"id": u["id"], "email": u["email"]} for u in raw_users]
    print(f" {len(users)} users")

    # 2. Fetch all attempts rows (service_role bypasses RLS).
    print("  Fetching attempts …", end="", flush=True)
    attempts_url = f"{url}/rest/v1/attempts?select=*&order=finished_at.asc"
    attempts = _api("GET", attempts_url, key)
    print(f" {len(attempts)} rows")

    # 3. Write backup.
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = Path(args.out) if args.out else REPO_ROOT / "backups" / f"backup_{timestamp}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "source_url": url,
        "users": users,
        "attempts": attempts,
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    print(f"\nBackup written → {out_path.relative_to(REPO_ROOT)}")
    print(f"  {len(users)} users, {len(attempts)} attempts")


# ---------------------------------------------------------------------------
# import-data
# ---------------------------------------------------------------------------

def cmd_import_data(args: argparse.Namespace) -> None:
    """
    Recreate users and attempts in the NEW project from a backup file.

    Steps:
      1. Resolve which backup file to use.
      2. Create each user account by email in the new project (confirmed, no password).
      3. Build an old-user-id → new-user-id map.
      4. Re-insert all attempts with updated user_ids in batches.
    """
    _load_env_file(REPO_ROOT / "scripts" / "migrate.env")

    new_url = _require_env("NEW_SUPABASE_URL").rstrip("/")
    new_key = _require_env("NEW_SERVICE_ROLE_KEY")

    # Resolve backup file.
    if args.backup:
        backup_path = Path(args.backup)
    else:
        backup_path = _latest_backup()
        if backup_path is None:
            sys.exit("ERROR: No backup file found in backups/. Run 'make export' first.")

    if not backup_path.exists():
        sys.exit(f"ERROR: Backup file not found: {backup_path}")

    print(f"Importing from backup: {backup_path.relative_to(REPO_ROOT)}")
    payload = json.loads(backup_path.read_text())
    users: list[dict] = payload["users"]
    attempts: list[dict] = payload["attempts"]
    print(f"  {len(users)} users, {len(attempts)} attempts")

    # ── Step 1: Create users in new project ──────────────────────────────
    print("\nCreating user accounts …")
    id_map: Dict[str, str] = {}   # old_user_id → new_user_id
    skipped = 0

    for i, user in enumerate(users, 1):
        email = user["email"]
        old_id = user["id"]
        print(f"  [{i}/{len(users)}] {email}", end=" … ", flush=True)

        resp = _api(
            "POST",
            f"{new_url}/auth/v1/admin/users",
            new_key,
            body={
                "email": email,
                "email_confirm": True,   # skip confirmation email; user resets password
                "user_metadata": {"migrated": True},
            },
        )

        if isinstance(resp, dict) and resp.get("id"):
            new_id = resp["id"]
            id_map[old_id] = new_id
            print(f"created ({new_id[:8]}…)")
        elif isinstance(resp, dict) and "already" in str(resp).lower():
            # User already exists — look up their new ID.
            existing = _paginate_users(new_url, new_key)
            match = next((u for u in existing if u["email"] == email), None)
            if match:
                id_map[old_id] = match["id"]
                print(f"already exists ({match['id'][:8]}…)")
                skipped += 1
            else:
                print("ERROR: could not find existing user; skipping")
        else:
            print(f"unexpected response: {resp}")

    if not id_map:
        sys.exit("ERROR: No users were mapped. Cannot continue.")

    unmapped = [a for a in attempts if a["user_id"] not in id_map]
    if unmapped:
        print(f"\nWARNING: {len(unmapped)} attempt(s) have no matching user and will be skipped.")
        attempts = [a for a in attempts if a["user_id"] in id_map]

    # ── Step 2: Insert attempts with remapped user_ids ───────────────────
    print(f"\nInserting {len(attempts)} attempts …")
    remapped = []
    for a in attempts:
        row = {**a, "user_id": id_map[a["user_id"]]}
        remapped.append(row)

    BATCH = 200
    inserted = 0
    for i in range(0, len(remapped), BATCH):
        batch = remapped[i : i + BATCH]
        _api(
            "POST",
            f"{new_url}/rest/v1/attempts",
            new_key,
            body=batch,
        )
        inserted += len(batch)
        print(f"  … {inserted}/{len(remapped)}")

    print(f"\nDone. {len(users)} users ({skipped} pre-existing), {inserted} attempts imported.")
    print("\nNext steps:")
    print("  • Users must use 'Forgot password' to set a new password on the new project.")
    print("  • Run `make update-config` to point the app at the new project.")


# ---------------------------------------------------------------------------
# update-config
# ---------------------------------------------------------------------------

def cmd_update_config(args: argparse.Namespace) -> None:
    """Rewrite src/config.js with the new project's URL and anon key."""
    _load_env_file(REPO_ROOT / "scripts" / "migrate.env")

    new_url = _require_env("NEW_SUPABASE_URL").rstrip("/")
    new_anon = _require_env("NEW_SUPABASE_ANON_KEY")

    config_path = REPO_ROOT / "src" / "config.js"
    original = config_path.read_text()

    updated = re.sub(
        r"(const SUPABASE_URL\s*=\s*')[^']*(';)",
        lambda m: f"{m.group(1)}{new_url}{m.group(2)}",
        original,
    )
    updated = re.sub(
        r"(const SUPABASE_ANON_KEY\s*=\s*')[^']*(';)",
        lambda m: f"{m.group(1)}{new_anon}{m.group(2)}",
        updated,
    )

    if updated == original:
        print("WARNING: src/config.js was not changed — check the NEW_* env vars.")
    else:
        config_path.write_text(updated)
        print("Updated src/config.js with new Supabase credentials.")
        print("  Remember to also reconnect the Supabase GitHub integration")
        print("  in the new project's dashboard (Settings → Integrations).")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    _load_env_file(REPO_ROOT / "scripts" / "migrate.env")

    parser = argparse.ArgumentParser(
        description="Supabase migration helper for citizenship-test",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_export = sub.add_parser("export", help="Export data from old Supabase project")
    p_export.add_argument("--out", metavar="FILE",
                          help="Output path (default: backups/backup_<timestamp>.json)")

    p_import = sub.add_parser("import-data", help="Import data into new Supabase project")
    p_import.add_argument("--backup", metavar="FILE",
                          help="Backup file to read (default: latest in backups/)")

    sub.add_parser("update-config", help="Rewrite src/config.js with new project credentials")

    args = parser.parse_args()

    if args.command == "export":
        cmd_export(args)
    elif args.command == "import-data":
        cmd_import_data(args)
    elif args.command == "update-config":
        cmd_update_config(args)


if __name__ == "__main__":
    main()
