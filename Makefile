APP_PORT ?= 8787
NODE := node --disable-warning=ExperimentalWarning --env-file-if-exists=.env

.PHONY: run serve dev install build test typecheck check e2e reset-login geoip

run: build serve

serve:
	PORT_API=$(APP_PORT) $(NODE) packages/server/src/index.ts

install: node_modules/.package-lock.json

node_modules/.package-lock.json: package.json package-lock.json packages/core/package.json packages/server/package.json packages/web/package.json
	npm ci

build: install
	npm run build -w @msa/web

dev: install
	./scripts/dev.sh

test: install
	npx vitest run

typecheck: install
	npm run typecheck

check: install
	node scripts/check-supply-chain.ts
	node scripts/check-docs.ts
	npm audit signatures

e2e: install
	$(NODE) scripts/fork-e2e.ts

reset-login:
	PORT_API=$(APP_PORT) $(NODE) scripts/reset-login.ts

geoip:
	$(NODE) scripts/fetch-geoip.ts
