# Makefile for fin-sim-framework
# Tests use Node.js (native node:test runner — no npm, no build tools).
# Run `make setup` once after cloning, then `make test` to run tests.

NODE := $(shell command -v node 2>/dev/null)
NVM_DIR := $(HOME)/.nvm

.PHONY: setup test help

help:
	@echo "Targets:"
	@echo "  make setup   Install/fix Node.js (run once after cloning)"
	@echo "  make test    Run the test suite"

## ── Setup ────────────────────────────────────────────────────────────────────
# Installs Node.js LTS (v22) via nvm if nvm is available, otherwise via Homebrew.
# Re-run any time 'node --version' fails (e.g. after a brew icu4c upgrade).

setup:
	@echo "==> Setting up Node.js..."
	@if [ -s "$(NVM_DIR)/nvm.sh" ]; then \
		echo "  Found nvm — installing Node.js version from .nvmrc..."; \
		. "$(NVM_DIR)/nvm.sh" && nvm install && nvm use; \
	elif command -v brew >/dev/null 2>&1; then \
		echo "  Found Homebrew — reinstalling Node.js (fixes icu4c link issues)..."; \
		brew reinstall node; \
	else \
		echo "  Neither nvm nor Homebrew found."; \
		echo "  Install nvm: https://github.com/nvm-sh/nvm#installing-and-updating"; \
		echo "  Then re-run: make setup"; \
		exit 1; \
	fi
	@echo "==> Node.js setup complete: $$(node --version)"

## ── Test ─────────────────────────────────────────────────────────────────────

test:
	@if [ -s "$(NVM_DIR)/nvm.sh" ]; then \
		. "$(NVM_DIR)/nvm.sh" && nvm use --silent && node --test tests/**.test.mjs; \
	else \
		node --test tests/**.test.mjs; \
	fi
