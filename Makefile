# Everything runs in Docker; the only prerequisite is Docker (plus make on the host).
# node_modules holds Linux binaries (Biome, tsc) and is only used inside Docker.
# The app is the TypeScript service at the repo root (src/, static/, eval/, test/);
# T7.2 moved app/ up, so these recipes no longer cd into it. The Go v1 tree the
# older targets built was deleted in T7.1: a Go line cite in a comment (internal/…,
# cmd/…, *.go) means the Go v1 code, tag v1.0.1.
.DEFAULT_GOAL := help
SHELL := /bin/bash

COMPOSE := docker compose

NODE_IMAGE ?= node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
DOCKER := docker run --rm --user $$(id -u):$$(id -g) -e NPM_CONFIG_UPDATE_NOTIFIER=false -e HOME=/tmp -v $(CURDIR):/app -w /app
RUN := $(DOCKER) $(NODE_IMAGE)

# `make chat-eval*` passes the environment through these names only: the
# app-test service has no env_file on purpose, so nothing else reaches the
# container. `docker compose run -e NAME` forwards NAME from the calling shell,
# and compose fills it from the project's .env when the shell has none (checked:
# the names arrive), so .env's connection is what `make chat-eval` uses; a
# variable exported in the shell wins. The documents cases need the app's bucket
# settings and SETTINGS_SECRET as well. Billed: both targets call the endpoint.
EVAL_ENV := -e LLM_BASE_URL -e LLM_MODEL -e LLM_STREAMING -e LLM_THINK_ON_DEMAND -e TZ -e LLM_API_KEY
# The documents cases read the app's own bucket. Its non-secret settings are
# passed as explicit values (`-e NAME="$${NAME}"`) rather than forwarded by name:
# the app-test service sets MinIO's S3_* values (docker-compose.yml: the tests
# must never see the real bucket), and `docker compose run -e NAME` with NAME
# unset forwards nothing, which would leave those MinIO values in place. With
# explicit values an unset S3_ENDPOINT_URL reaches the container empty, which is
# how the app talks to AWS in production; a set one points at that endpoint.
# The chat-eval recipes load them from the repo's .env (EVAL_LOAD_ENV below).
EVAL_BUCKET := -e S3_ENDPOINT_URL="$${S3_ENDPOINT_URL}" -e S3_BUCKET="$${S3_BUCKET}" \
	-e S3_PREFIX="$${S3_PREFIX}" -e AWS_REGION="$${AWS_REGION}"
# Secrets are forwarded by name only: `docker compose run -e NAME` takes the value
# from the caller's environment without it ever reaching this command line, where
# `ps` on the host would show it while the run lasts. `LLM_API_KEY` is in
# `EVAL_ENV` instead, because the plain `chat-eval` needs it too — by name, so it
# stays off the command line either way.
EVAL_SECRETS := -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e SETTINGS_SECRET

.PHONY: help dev down lint test format build image run shell ui-check chat-eval chat-eval-docs chat-eval-env clean

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

node_modules/.installed: package-lock.json ## (internal) install the pinned dependencies in Docker
	$(RUN) npm ci --ignore-scripts --no-audit --no-fund
	@touch node_modules/.installed

lint: node_modules/.installed ## Biome check + tsc type-check
	$(RUN) npm run lint

test: node_modules/.installed ## Vitest on Node 24, the S3 half against the compose MinIO
	HOST_UID=$$(id -u) HOST_GID=$$(id -g) $(COMPOSE) --profile tools run --rm --build app-test npm test

format: node_modules/.installed ## Biome check --write
	$(RUN) npm run format

# The v3 production image (Dockerfile, built from the repo root, which is also
# the build context: the image needs docs/admin-guide.md as well as src/ and
# static/). `build` is the same target under the name the README used to use.
image: ## Build the production image, movin-app:local
	docker build -f Dockerfile -t movin-app:local .

build: image ## Build the production image (the same target as image)

# The same image under compose's app-image: read-only root filesystem, /data
# on a volume, MinIO instead of the real bucket (docker-compose.yml).
run: image ## Build and start it as compose's app-image on 127.0.0.1:8091
	$(COMPOSE) --profile image up -d app-image

# Port of cmd/chateval (agent-spec §6): the twelve messages through the real v3
# agent, on an in-memory copy of the fixture. Billed: it calls the endpoint.
# `chat-eval` and `chat-eval-docs` use the connection saved on the web page (the
# NAI gateway), read only from the app's bucket: the recipe loads the repo's
# .env into its own shell (never echoed), so nothing needs exporting first;
# .env's values win over the shell's. `chat-eval-env` uses LLM_* from
# the environment instead (e.g. a local model server).
EVAL_LOAD_ENV := set -a; if [ -f .env ]; then . ./.env; fi; set +a; \
	test -n "$${S3_BUCKET}" || { echo "chat-eval reads the saved connection from the app's bucket: set S3_BUCKET (and AWS_*, SETTINGS_SECRET) in .env or your shell."; exit 1; }
EVAL_RUN := HOST_UID=$$(id -u) HOST_GID=$$(id -g) $(COMPOSE) --profile tools run --rm $(EVAL_ENV)

chat-eval: node_modules/.installed ## Run the eval messages on the saved connection (NAI; read only; billed)
	@$(EVAL_LOAD_ENV); \
	$(EVAL_RUN) $(EVAL_BUCKET) $(EVAL_SECRETS) app-test node eval/chateval.ts -saved

chat-eval-docs: node_modules/.installed ## The eval plus the document questions, on the saved connection (read only; billed)
	@$(EVAL_LOAD_ENV); \
	$(EVAL_RUN) $(EVAL_BUCKET) $(EVAL_SECRETS) app-test node eval/chateval.ts -saved -docs

chat-eval-env: node_modules/.installed ## Run the eval messages against the LLM_* in your environment (billed if remote)
	$(EVAL_RUN) app-test node eval/chateval.ts

ui-check: ## Headless Chrome against the TS app on MinIO; screenshots in tmp/ui-check-ts
	tools/ui-check/run.sh

shell: node_modules/.installed ## Interactive sh in the container
	$(DOCKER) -it $(NODE_IMAGE) sh

clean: ## Remove containers and volumes (the test MinIO's data; never the real bucket)
	$(COMPOSE) --profile tools --profile ts --profile image down -v --remove-orphans
