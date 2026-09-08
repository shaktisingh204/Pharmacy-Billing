# RxBill — pharmacy billing and inventory
#
# NOTE (macOS, this machine): the Xcode license has not been accepted. Both
# /usr/bin/cc and /usr/bin/make are xcrun shims that refuse to run until it is —
# so `make` fails before it ever reads this file. Use the Command Line Tools copy
# (/Library/Developer/CommandLineTools/usr/bin/make), which needs no licence.
# DEVELOPER_DIR below points the Rust build at the CLT compiler for the same
# reason. The permanent fix is one of:
#     sudo xcodebuild -license accept
#     sudo xcode-select -s /Library/Developer/CommandLineTools
# Once either is done this override is harmless and can be deleted.
ifeq ($(shell uname),Darwin)
ifneq ($(wildcard /Library/Developer/CommandLineTools/usr/bin/cc),)
export DEVELOPER_DIR := /Library/Developer/CommandLineTools
endif
endif

WEB := web

.PHONY: help setup dev dev-api dev-web check test build fmt lint db doctor clean

help:
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

setup: ## One-time: install web deps, create the dev database
	cd $(WEB) && npm ci || (cd $(WEB) && npm install)
	bash scripts/db-bootstrap.sh
	@test -f .env || sed "s|YOUR_LOCAL_ROLE|$$(whoami)|" .env.example > .env
	@echo "Also run once: cargo install sqlx-cli --no-default-features -F rustls,postgres"
	@echo "  (NOT --locked: sqlx 0.9 removed Cargo.lock from its repository)"

dev-api: ## Run the Rust API on :8080
	cargo run --bin rxbill-api

dev-web: ## Run the Vite dev server on :5173 (proxies /api to :8080)
	cd $(WEB) && npm run dev

db: ## Create/refresh the dev database and extensions
	bash scripts/db-bootstrap.sh

fmt: ## Format Rust
	cargo fmt

lint: ## Lint both sides
	cargo clippy --all-targets -- -D warnings
	cd $(WEB) && npm run lint

test: ## Unit tests, both sides
	cargo test
	cd $(WEB) && npm run test

e2e: ## Playwright, at the 1366x768 POS floor and at desktop
	cd $(WEB) && npx playwright test

build: ## Production build of both sides
	cd $(WEB) && npm run build
	cargo build --release

check: ## THE GATE. Everything CI runs.
	cargo fmt --check
	cargo clippy --all-targets -- -D warnings
	cargo test
	cd $(WEB) && npx tsc -b && npm run lint && npm run test
	bash scripts/guardrails.sh
	cd $(WEB) && npx playwright test

doctor: ## Report what this machine can and cannot do
	@echo "node    $$(node --version 2>/dev/null || echo MISSING)"
	@echo "npm     $$(npm --version 2>/dev/null || echo MISSING)"
	@echo "cargo   $$(cargo --version 2>/dev/null || echo MISSING)"
	@echo "cc      $$(cc --version 2>/dev/null | head -1 || echo 'BROKEN — see the note at the top of this Makefile')"
	@echo "sqlx    $$(sqlx --version 2>/dev/null || echo 'MISSING — cargo install sqlx-cli --no-default-features -F rustls,postgres')"
	@echo "psql    $$(psql --version 2>/dev/null || echo MISSING)"
	@echo "server  $$(psql -d postgres -tAc 'SHOW server_version' 2>/dev/null || echo UNREACHABLE)"
	@echo "docker  $$(docker --version 2>/dev/null || echo 'absent — by design, tests use the local server')"

clean:
	cargo clean
	rm -rf $(WEB)/dist $(WEB)/playwright-report $(WEB)/test-results
