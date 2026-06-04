PORT ?= 8001

.PHONY: help serve stop

help:
	@echo "Targets:"
	@echo "  make serve  - kill anything on PORT ($(PORT)), start server, open browser"
	@echo "  make stop   - kill server on PORT"

serve: stop
	@python3 -m http.server $(PORT) >/dev/null 2>&1 &
	@sleep 0.4
	@open "http://localhost:$(PORT)/"
	@echo "Serving on http://localhost:$(PORT)/  (make stop to kill)"

stop:
	@lsof -ti tcp:$(PORT) | xargs kill -9 2>/dev/null || true
