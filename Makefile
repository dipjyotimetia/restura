# Restura — project automation.
#
# Thin wrappers over the npm scripts + docker compose so common workflows are
# one command and discoverable via `make help`. Two echo-local prerequisites
# aren't in git — the TLS certs and the Kafka/MQTT broker containers — so
# `make setup` creates both for a new contributor.
#
#   make install        # install dependencies
#   make setup          # echo-local prerequisites (certs + brokers)
#   make dev            # web dev server (Vite + local Worker)
#   make validate       # the full CI gate
#
# Run `make` (or `make help`) for the full list.

COMPOSE         := docker compose -f echo-local/docker-compose.yml
KAFKA_CONTAINER := kafka
MQTT_CONTAINER  := restura-echo-emqx

.DEFAULT_GOAL := help
.PHONY: help install check \
        dev electron-dev docs-dev preview \
        build build-docker electron-build electron-pack electron-dist docs-build \
        lint lint-fix format format-check type-check type-check-all validate \
        test test-run test-watch test-coverage test-contract test-e2e test-e2e-ui \
        test-e2e-electron grpc-server \
        proto-gen gen-types verify-types capabilities capabilities-check \
        docker-build start \
        certs brokers brokers-status brokers-down echo-local collection setup \
        deploy deploy-echo deploy-docs \
        clean

help: ## List available targets
	@awk 'BEGIN {FS = ":.*## "} \
	  /^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next} \
	  /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

##@ Setup
install: ## Install dependencies (npm install)
	npm install

check: ## Verify echo-local prerequisites (Node 24+, openssl, Docker daemon)
	@command -v node >/dev/null    || { echo "✗ node not found (need Node 24+)"; exit 1; }
	@command -v openssl >/dev/null || { echo "✗ openssl not found (required to generate echo-local certs)"; exit 1; }
	@command -v docker >/dev/null  || { echo "✗ docker not found (required for the Kafka/MQTT brokers)"; exit 1; }
	@docker info >/dev/null 2>&1   || { echo "✗ docker daemon is not running"; exit 1; }
	@echo "✓ node $$(node -v) · $$(openssl version | cut -d' ' -f1-2) · docker $$(docker version -f '{{.Server.Version}}' 2>/dev/null)"

##@ Develop
dev: ## Vite dev server + local Worker via Miniflare (web, :5173)
	npm run dev

electron-dev: ## Run the Electron desktop app in dev mode
	npm run electron:dev

docs-dev: ## Run the docs-site dev server
	npm run docs:dev

preview: ## Preview the production web build
	npm run preview

##@ Build
build: ## Production web build (SPA + Worker bundle)
	npm run build

build-docker: ## Self-host build (plain SPA + Node server bundle → dist/)
	npm run build:docker

electron-build: ## Build the Electron renderer + compile the main process
	npm run test:e2e:electron:build

electron-pack: ## Package an unpacked desktop build (local smoke testing)
	npm run electron:pack

electron-dist: ## Package desktop distributables for the current platform
	npm run electron:dist

docs-build: ## Build the docs site
	npm run docs:build

##@ Quality
lint: ## Biome lint over the application source trees
	npm run lint

lint-fix: ## Biome lint --write
	npm run lint:fix

format: ## Biome format --write
	npm run format

format-check: ## Biome format check
	npm run format:check

type-check: ## TypeScript strict check (renderer only)
	npm run type-check

type-check-all: ## TypeScript check across every project (renderer/electron/worker/echo/cli)
	npm run type-check:all

validate: ## Full CI gate: type-check:all + lint + codegen verify + capabilities + unit tests
	npm run validate

##@ Test
test: ## Vitest (interactive watch)
	npm test

test-run: ## Vitest (single run)
	npm run test:run

test-watch: ## Vitest (watch mode)
	npm run test:watch

test-coverage: ## Vitest with coverage report
	npm run test:coverage

test-contract: ## Contract tests (tests/contract)
	npm run test:contract

test-e2e: ## Web e2e (Playwright; boots the dev server + Worker)
	npm run test:e2e

test-e2e-ui: ## Web e2e in Playwright UI mode
	npm run test:e2e:ui

test-e2e-electron: ## Desktop e2e: build + run (Kafka/MQTT specs need Docker — see 'make brokers')
	npm run test:e2e:electron:build
	npm run test:e2e:electron

grpc-server: ## Native gRPC dev server on :50051 (desktop gRPC e2e upstream)
	npm run grpc:server

##@ Codegen
proto-gen: ## Regenerate protobuf TypeScript (buf generate)
	npm run proto:gen

gen-types: ## Regenerate OpenCollection types from the JSON Schema
	npm run gen:opencollection-types

verify-types: ## Fail if the generated OpenCollection types are stale (CI gate)
	npm run verify:opencollection-types

capabilities: ## Regenerate docs/CAPABILITY_MATRIX.md from capabilities.ts
	npm run capabilities:matrix

capabilities-check: ## Fail if the capability matrix is stale (CI gate)
	npm run capabilities:check

##@ Self-host (single Node process: SPA + /api/*)
docker-build: ## Build the self-host bundle (SPA + dist/server/index.mjs)
	npm run build:docker

start: ## Run the self-host server (node dist/server/index.mjs)
	npm start

##@ echo-local (local multi-protocol test upstream)
certs: ## Generate the echo-local TLS material (local CA + server/client leaf + PKCS#12)
	@command -v openssl >/dev/null || { echo "✗ openssl is required to generate certs"; exit 1; }
	npm run echo:local:certs
	@echo "✓ certs in echo-local/certs/ — import ca.crt as a custom CA; attach client.crt/.key or client.p12 (pass: restura) for mTLS"

brokers: ## Start the Dockerised Kafka (Redpanda) + MQTT (EMQX) brokers and wait until healthy
	@docker info >/dev/null 2>&1 || { echo "✗ docker daemon is not running"; exit 1; }
	$(COMPOSE) up -d
	@echo "Waiting for Kafka + MQTT to report healthy (Redpanda first boot takes ~15-30s)…"
	@for i in $$(seq 1 90); do \
	  k=$$(docker inspect -f '{{.State.Health.Status}}' $(KAFKA_CONTAINER) 2>/dev/null); \
	  m=$$(docker inspect -f '{{.State.Health.Status}}' $(MQTT_CONTAINER) 2>/dev/null); \
	  if [ "$$k" = healthy ] && [ "$$m" = healthy ]; then echo "✓ Kafka ($(KAFKA_CONTAINER)) + MQTT ($(MQTT_CONTAINER)) healthy"; exit 0; fi; \
	  sleep 2; \
	done; \
	echo "✗ brokers did not become healthy in time:"; $(COMPOSE) ps; exit 1

brokers-status: ## Show broker container status
	$(COMPOSE) ps

brokers-down: ## Stop the brokers and wipe their data volumes
	$(COMPOSE) down -v

echo-local: ## Boot the in-process stack (generates certs if missing, prints the manifest, stays up)
	npm run echo:local

collection: ## Write the importable OpenCollection for the local stack
	npm run echo:local:collection

setup: check certs brokers ## One-shot contributor setup: prerequisite check + certs + brokers
	@echo "✓ echo-local prerequisites ready — run 'make echo-local' to boot the in-process stack."

##@ Deploy (maintainers; requires wrangler auth)
deploy: ## Deploy the web app (Worker api.restura.dev + Pages) to production
	npm run deploy

deploy-echo: ## Deploy the echo test Worker
	npm run deploy:echo

deploy-docs: ## Build + deploy the docs site
	npm run deploy:docs

##@ Housekeeping
clean: ## Stop brokers + remove build outputs and echo-local generated files
	-$(COMPOSE) down -v
	rm -rf dist cli/dist docs-site/dist playwright-report test-results coverage
	rm -rf echo-local/certs echo-local/manifest.json echo-local/*.collection.json
	@echo "✓ cleaned build artifacts + echo-local generated files (node_modules left intact)"
