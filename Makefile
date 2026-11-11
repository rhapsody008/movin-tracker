# Everything runs in Docker; the only prerequisites are Docker and make.
# Host ports: APP_PORT (8080), MINIO_PORT (9000), MINIO_CONSOLE_PORT (9001).
.DEFAULT_GOAL := help
SHELL := /bin/bash

COMPOSE := docker compose
TOOLS   := $(COMPOSE) --profile tools run --rm test
IMAGE   ?= movin:local

.PHONY: help dev down seed test conflict-test chat-eval lint build run clean

help: ## List the targets
	@awk 'BEGIN{FS=":.*## "} /^[a-z-]+:.*## /{printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.env: ## (internal) create .env from .env.example with a fresh SETTINGS_SECRET
	@cp .env.example .env
	@secret=$$(openssl rand -base64 32 | tr '+/' '-_'); \
	  sed -i.bak "s|^SETTINGS_SECRET=.*|SETTINGS_SECRET=$$secret|" .env && rm -f .env.bak
	@echo "Created .env with a new SETTINGS_SECRET. Add your LLM_* values there."

dev: .env ## Compose up app + MinIO with live reload, at http://localhost:8080
	$(COMPOSE) up --build -d app
	@echo "Board:          http://localhost:$${APP_PORT:-8080}"
	@echo "MinIO console:  http://localhost:$${MINIO_CONSOLE_PORT:-9001}  (minioadmin / minioadmin)"
	@echo "Logs:           docker compose logs -f app"

down: ## Stop the stack
	$(COMPOSE) --profile tools --profile prod down

seed: ## Load fixtures/entries.sample.json into MinIO
	$(COMPOSE) run --rm --build -v ./fixtures:/fixtures:ro bucket-init seed /fixtures/entries.sample.json

test: ## Unit + API tests in the container, against MinIO, with a stubbed LLM
	$(TOOLS) go test -race -count=1 ./...

conflict-test: ## Two concurrent writers on one ETag; both changes must survive
	$(TOOLS) go test -count=1 -v -run 'TestConditionalWrites|TestConflictBothChangesSurvive|TestConcurrentWriters|TestConflictReturns409' ./internal/...

chat-eval: .env ## Run the agent eval messages against the real endpoint from .env; print the entry diff per message
	$(COMPOSE) --profile tools run --rm --no-deps test go run ./cmd/chateval

lint: ## gofmt + go vet
	$(TOOLS) sh -c 'out=$$(gofmt -l $$(find . -name "*.go" -not -path "./vendor/*")); if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi; go vet ./... && echo "lint ok"'

build: ## Build the production image
	docker build -t $(IMAGE) .

run: build .env ## Run the production image locally against MinIO, read-only rootfs, as in k8s
	-$(COMPOSE) stop app
	$(COMPOSE) --profile prod up -d prod
	@echo "Production image on http://localhost:$${APP_PORT:-8080} (read-only rootfs, uid 65532). Stop with: make down"

clean: ## Remove containers, volumes and the MinIO bucket
	$(COMPOSE) --profile tools --profile prod down -v --remove-orphans
