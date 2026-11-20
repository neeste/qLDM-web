-include .env
-include ../qCLS/.env

NODE = node
FTP_HOST ?= audres.org
PUBLIC_HOST ?= audres.org
FTP_DIR ?= qLDM

WEB_FILES = index.html guide.html style.css qldm_core.js app.js assets/boys-town-logo.png

all: test

test: qldm_core.js app.js
	$(NODE) --check qldm_core.js
	$(NODE) --check app.js
	$(NODE) test/test_dom_wiring.mjs
	$(NODE) test/test_qldm_acceptance.mjs

deploy:
	@if [ -z "$(FTP_CREDS)" ]; then \
		echo "Error: FTP_CREDS environment variable is not set."; \
		exit 1; \
	fi
	@set -e; for f in $(WEB_FILES); do \
		echo "Uploading $$f -> ftp://$(FTP_HOST)/$(FTP_DIR)/$$f"; \
		curl -sS --ftp-create-dirs -T $$f "ftp://$(FTP_CREDS)@$(FTP_HOST)/$(FTP_DIR)/$$f"; \
	done
	@echo "Verify HTTP status:"
	@curl -sS -I "http://$(PUBLIC_HOST)/$(FTP_DIR)/" | head -n 5 || true
