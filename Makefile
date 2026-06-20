# Contributor setup for the echo-local test stack.
#
# echo-local is the local multi-protocol upstream: HTTP/HTTPS/mTLS/gRPC/WS/WSS/
# Socket.IO/MCP run in-process, while Kafka (Redpanda) and MQTT (EMQX) run via
# Docker. Two prerequisites aren't checked into git — the TLS certificates and
# the broker containers. These targets create both.
#
# Quick start for a new contributor:
#   make setup          # check tools, generate certs, start brokers
#   make echo-local     # boot the in-process stack (prints the manifest)
#
# Run `make` (or `make help`) to list every target.

COMPOSE         := docker compose -f echo-local/docker-compose.yml
KAFKA_CONTAINER := kafka
MQTT_CONTAINER  := restura-echo-emqx

.DEFAULT_GOAL := help
.PHONY: help check certs brokers brokers-status brokers-down setup echo-local collection e2e-electron clean

help: ## List available targets
	@echo "echo-local contributor tasks:"
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

check: ## Verify prerequisites (Node 24+, openssl, Docker daemon)
	@command -v node >/dev/null    || { echo "✗ node not found (need Node 24+)"; exit 1; }
	@command -v openssl >/dev/null || { echo "✗ openssl not found (required to generate echo-local certs)"; exit 1; }
	@command -v docker >/dev/null  || { echo "✗ docker not found (required for the Kafka/MQTT brokers)"; exit 1; }
	@docker info >/dev/null 2>&1   || { echo "✗ docker daemon is not running"; exit 1; }
	@echo "✓ node $$(node -v) · $$(openssl version | cut -d' ' -f1-2) · docker $$(docker version -f '{{.Server.Version}}' 2>/dev/null)"

certs: ## Generate the echo-local TLS material (local CA + server/client leaf + PKCS#12)
	@command -v openssl >/dev/null || { echo "✗ openssl is required to generate certs"; exit 1; }
	npm run echo:local:certs
	@echo "✓ certs written to echo-local/certs/ — import ca.crt as a custom CA; attach client.crt/.key or client.p12 (pass: restura) for mTLS"

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

setup: check certs brokers ## One-shot contributor setup: prerequisite check + certs + brokers
	@echo "✓ echo-local prerequisites ready — run 'make echo-local' to boot the in-process stack."

echo-local: ## Boot the full in-process stack (generates certs if missing, prints the manifest, stays up)
	npm run echo:local

collection: ## Write the importable OpenCollection for the local stack
	npm run echo:local:collection

e2e-electron: ## Build + run the desktop e2e suite (Kafka/MQTT specs auto-manage Docker, and skip if absent)
	npm run test:e2e:electron:build
	npm run test:e2e:electron

clean: brokers-down ## Stop brokers and remove generated certs / manifest / collection
	rm -rf echo-local/certs echo-local/manifest.json echo-local/*.collection.json
	@echo "✓ removed echo-local generated artifacts"
