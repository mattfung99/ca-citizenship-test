PORT ?= 8001

.PHONY: help serve stop export import update-config

help:
	@echo "Dev:"
	@echo "  make serve         - start local dev server and open browser"
	@echo "  make stop          - stop local dev server"
	@echo ""
	@echo "Supabase migration (run after copying scripts/migrate.env.example → scripts/migrate.env):"
	@echo "  make export        - export users + attempts from OLD project → backups/"
	@echo "  make import        - import backup into NEW project (remaps user IDs by email)"
	@echo "  make update-config - rewrite src/config.js with NEW project credentials"
	@echo ""
	@echo "Full migration walkthrough: see scripts/migrate.py --help"

# ── Dev server ───────────────────────────────────────────────────────────────

serve: stop
	@python3 dev_server.py $(PORT) >/dev/null 2>&1 &
	@sleep 0.4
	@open "http://localhost:$(PORT)/"
	@echo "Serving on http://localhost:$(PORT)/  (make stop to kill)"

stop:
	@lsof -ti tcp:$(PORT) | xargs kill -9 2>/dev/null || true

# ── Supabase migration ───────────────────────────────────────────────────────

export:
	@python3 scripts/migrate.py export

import:
	@python3 scripts/migrate.py import-data

update-config:
	@python3 scripts/migrate.py update-config
