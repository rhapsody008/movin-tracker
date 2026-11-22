# The app is the TypeScript service under app/ (see app/README.md): Biome, tsc
# and vitest run in Docker (app/Makefile), and this file forwards to it. The Go
# v1 tree these targets used to build was deleted in T7.1; Go line cites in the
# comments of app/src refer to that code, tag v1.0.1.
.DEFAULT_GOAL := help
SHELL := /bin/bash

COMPOSE := docker compose

.PHONY: help dev down lint test chat-eval chat-eval-docs build run ui-check clean

help: ## List the targets
	@awk 'BEGIN{FS=":.*## "} /^[a-z-]+:.*## /{printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.env: ## (internal) create .env from .env.example with a fresh SETTINGS_SECRET
	@cp .env.example .env
	@secret=$$(openssl rand -base64 32 | tr '+/' '-_'); \
	  sed -i.bak "s|^SETTINGS_SECRET=.*|SETTINGS_SECRET=$$secret|" .env && rm -f .env.bak
	@echo "Created .env with a new SETTINGS_SECRET. Add your LLM_* values there."

dev: .env ## Run the TypeScript app at http://127.0.0.1:8081, on the real S3 bucket from .env
	$(COMPOSE) --profile ts up -d app-ts
	@echo "Web page: http://127.0.0.1:$${APP_TS_PORT:-8081}"
	@echo "Logs:     docker compose logs -f app-ts"

down: ## Stop the stack
	$(COMPOSE) --profile tools --profile ts --profile image down

lint: ## Biome check + tsc, in the app container
	$(MAKE) -C app lint

test: ## Vitest (the S3 half against MinIO), then the poppler tests on the production runtime
	$(MAKE) -C app test

chat-eval: ## Run the eval messages on the saved connection (NAI; read only; billed)
	$(MAKE) -C app chat-eval

chat-eval-docs: ## The eval plus the document questions (read only; billed)
	$(MAKE) -C app chat-eval-docs

build: ## Build the production image, movin-app:local (app/Dockerfile)
	$(MAKE) -C app image

run: ## Run the production image locally at http://127.0.0.1:8091, as in k8s
	$(MAKE) -C app run

ui-check: ## Headless Chrome against the TypeScript app on MinIO
	$(MAKE) -C app ui-check

clean: ## Remove containers and volumes (the test MinIO's data; never the real bucket)
	$(COMPOSE) --profile tools --profile ts --profile image down -v --remove-orphans
