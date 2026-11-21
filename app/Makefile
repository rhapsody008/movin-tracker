# Everything runs in Docker; the only prerequisite is Docker (plus make on the host).
# node_modules holds Linux binaries (Biome, tsc) and is only used inside Docker.
.DEFAULT_GOAL := help
SHELL := /bin/bash

NODE_IMAGE ?= node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
DOCKER := docker run --rm --user $$(id -u):$$(id -g) -e NPM_CONFIG_UPDATE_NOTIFIER=false -e HOME=/tmp -v $(CURDIR):/app -w /app
RUN := $(DOCKER) $(NODE_IMAGE)

.PHONY: help lint test format shell clean

help: ## List the targets
	@awk 'BEGIN{FS=":.*## "} /^[a-z-]+:.*## /{printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

node_modules/.installed: package-lock.json ## (internal) install the pinned dependencies in Docker
	$(RUN) npm ci --ignore-scripts --no-audit --no-fund
	@touch node_modules/.installed

lint: node_modules/.installed ## Biome check + tsc type-check
	$(RUN) npm run lint

test: node_modules/.installed ## Vitest on Node 24, the S3 half against the compose MinIO
	HOST_UID=$$(id -u) HOST_GID=$$(id -g) docker compose -f ../docker-compose.yml --profile tools run --rm --build app-test npm test

format: node_modules/.installed ## Biome check --write
	$(RUN) npm run format

shell: node_modules/.installed ## Interactive sh in the container
	$(DOCKER) -it $(NODE_IMAGE) sh

clean: ## Remove node_modules and coverage
	rm -rf node_modules coverage
