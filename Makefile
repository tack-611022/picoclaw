IMAGE_NAME := picoclaw
IMAGE_TAG := latest
CONTAINER_NAME := picoclaw-dev
PORT := 9000

BUILD_VERSION := $(shell node -p "require('./package.json').version" 2>/dev/null || echo unknown)
BUILD_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
BUILD_TIME := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

GHCR_IMAGE := ghcr.io/breakcafe/picoclaw
GIT_BRANCH := $(shell git branch --show-current 2>/dev/null || echo unknown)
IS_MAIN := $(filter main,$(GIT_BRANCH))
BRANCH_SLUG := $(shell echo "$(GIT_BRANCH)" | sed 's/[^a-zA-Z0-9]/-/g' | tr 'A-Z' 'a-z')

ifneq (,$(wildcard .env))
include .env
export
endif

# ── Build ────────────────────────────────────────────────

build-ts: ## Compile TypeScript to dist/
	npm run build

dev: build-ts ## Run from compiled dist/ (build first)
	node dist/index.js

dev-watch: ## Run from source with tsx watch (no build needed)
	npx tsx --watch src/index.ts

# ── Docker ───────────────────────────────────────────────

docker-build: ## Build Docker image (multi-stage, no local Node.js needed)
	docker build --platform linux/amd64 \
		--build-arg BUILD_VERSION=$(BUILD_VERSION) \
		--build-arg BUILD_COMMIT=$(BUILD_COMMIT) \
		--build-arg BUILD_TIME=$(BUILD_TIME) \
		-t $(IMAGE_NAME):$(IMAGE_TAG) .

docker-build-lambda: ## Build Docker image with Lambda Web Adapter
	docker build --platform linux/amd64 \
		--build-arg ENABLE_LAMBDA_ADAPTER=true \
		--build-arg BUILD_VERSION=$(BUILD_VERSION) \
		--build-arg BUILD_COMMIT=$(BUILD_COMMIT) \
		--build-arg BUILD_TIME=$(BUILD_TIME) \
		-t $(IMAGE_NAME):lambda .

docker-run: _ensure-data-dirs ## Run container interactively with volume mounts
	docker run --rm -it \
		--name $(CONTAINER_NAME) \
		-p $(PORT):9000 \
		--env-file .env \
		-v $(CURDIR)/dev-data/memory:/data/memory \
		-v $(CURDIR)/dev-data/store:/data/store \
		$(IMAGE_NAME):$(IMAGE_TAG)

docker-run-bg: _ensure-data-dirs ## Run container in background
	docker run -d --rm \
		--name $(CONTAINER_NAME) \
		-p $(PORT):9000 \
		--env-file .env \
		-v $(CURDIR)/dev-data/memory:/data/memory \
		-v $(CURDIR)/dev-data/store:/data/store \
		$(IMAGE_NAME):$(IMAGE_TAG)

docker-stop: ## Stop the running container
	docker stop $(CONTAINER_NAME) 2>/dev/null || true

docker-logs: ## Tail container logs
	docker logs -f $(CONTAINER_NAME)

# ── GHCR (Container Registry) ────────────────────────────

ghcr-login: ## Authenticate Docker to GHCR via gh CLI
	@gh auth token | docker login ghcr.io -u $(shell gh api user -q .login) --password-stdin

ghcr-build: ## Build standard image with GHCR tags
ifdef IS_MAIN
	docker build --platform linux/amd64 \
		--build-arg BUILD_VERSION=$(BUILD_VERSION) \
		--build-arg BUILD_COMMIT=$(BUILD_COMMIT) \
		--build-arg BUILD_TIME=$(BUILD_TIME) \
		-t $(GHCR_IMAGE):latest \
		-t $(GHCR_IMAGE):$(BUILD_VERSION) \
		-t $(GHCR_IMAGE):$(BUILD_VERSION)-$(BUILD_COMMIT) .
else
	docker build --platform linux/amd64 \
		--build-arg BUILD_VERSION=$(BUILD_VERSION) \
		--build-arg BUILD_COMMIT=$(BUILD_COMMIT) \
		--build-arg BUILD_TIME=$(BUILD_TIME) \
		-t $(GHCR_IMAGE):dev \
		-t $(GHCR_IMAGE):dev-$(BUILD_COMMIT) \
		-t $(GHCR_IMAGE):dev-$(BRANCH_SLUG) .
endif

ghcr-build-lambda: ## Build Lambda image with GHCR tags
ifdef IS_MAIN
	docker build --platform linux/amd64 \
		--build-arg ENABLE_LAMBDA_ADAPTER=true \
		--build-arg BUILD_VERSION=$(BUILD_VERSION) \
		--build-arg BUILD_COMMIT=$(BUILD_COMMIT) \
		--build-arg BUILD_TIME=$(BUILD_TIME) \
		-t $(GHCR_IMAGE):latest-lambda \
		-t $(GHCR_IMAGE):$(BUILD_VERSION)-lambda \
		-t $(GHCR_IMAGE):$(BUILD_VERSION)-$(BUILD_COMMIT)-lambda .
else
	docker build --platform linux/amd64 \
		--build-arg ENABLE_LAMBDA_ADAPTER=true \
		--build-arg BUILD_VERSION=$(BUILD_VERSION) \
		--build-arg BUILD_COMMIT=$(BUILD_COMMIT) \
		--build-arg BUILD_TIME=$(BUILD_TIME) \
		-t $(GHCR_IMAGE):dev-lambda \
		-t $(GHCR_IMAGE):dev-$(BUILD_COMMIT)-lambda \
		-t $(GHCR_IMAGE):dev-$(BRANCH_SLUG)-lambda .
endif

ghcr-push: ghcr-login ## Push standard image tags to GHCR
ifdef IS_MAIN
	docker push $(GHCR_IMAGE):latest
	docker push $(GHCR_IMAGE):$(BUILD_VERSION)
	docker push $(GHCR_IMAGE):$(BUILD_VERSION)-$(BUILD_COMMIT)
else
	docker push $(GHCR_IMAGE):dev
	docker push $(GHCR_IMAGE):dev-$(BUILD_COMMIT)
	docker push $(GHCR_IMAGE):dev-$(BRANCH_SLUG)
endif

ghcr-push-lambda: ghcr-login ## Push Lambda image tags to GHCR
ifdef IS_MAIN
	docker push $(GHCR_IMAGE):latest-lambda
	docker push $(GHCR_IMAGE):$(BUILD_VERSION)-lambda
	docker push $(GHCR_IMAGE):$(BUILD_VERSION)-$(BUILD_COMMIT)-lambda
else
	docker push $(GHCR_IMAGE):dev-lambda
	docker push $(GHCR_IMAGE):dev-$(BUILD_COMMIT)-lambda
	docker push $(GHCR_IMAGE):dev-$(BRANCH_SLUG)-lambda
endif

ghcr-release: ghcr-build ghcr-build-lambda ghcr-push ghcr-push-lambda ## Build and push all images to GHCR

ghcr-make-public: ## One-time: set GHCR package visibility to public (requires public repo or GitHub Team plan)
	gh api -X PUT 'orgs/breakcafe/packages/container/picoclaw/visibility' -f visibility=public

# ── Test ─────────────────────────────────────────────────

test: ## Run unit tests (vitest)
	npm test

test-health: ## Smoke test: GET /health
	@curl -s http://localhost:$(PORT)/health | jq .

test-chat: ## Smoke test: POST /chat with a sample message
	@curl -s -X POST http://localhost:$(PORT)/chat \
		-H "Authorization: Bearer $(API_TOKEN)" \
		-H "Content-Type: application/json" \
		-d '{"message":"你好，请简单介绍一下你自己。","sender":"test","sender_name":"测试用户"}' \
		| jq .

test-task-create: ## Smoke test: create a sample scheduled task
	@curl -s -X POST http://localhost:$(PORT)/task \
		-H "Authorization: Bearer $(API_TOKEN)" \
		-H "Content-Type: application/json" \
		-d '{"prompt":"报告当前系统时间和日期","schedule_type":"interval","schedule_value":"300000","context_mode":"isolated"}' \
		| jq .

test-task-check: ## Smoke test: check and execute due tasks
	@curl -s -X POST http://localhost:$(PORT)/task/check \
		-H "Authorization: Bearer $(API_TOKEN)" \
		| jq .

test-e2e: ## End-to-end: build, run, multi-turn conversation, persistence, stop
	./scripts/e2e-test.sh

test-e2e-quick: ## E2E without Docker build or Claude API calls
	./scripts/e2e-test.sh --no-build --no-chat

# ── Cleanup ──────────────────────────────────────────────

clean: docker-stop ## Stop container and remove images
	docker rmi $(IMAGE_NAME):$(IMAGE_TAG) 2>/dev/null || true
	docker rmi $(IMAGE_NAME):lambda 2>/dev/null || true

clean-data: ## Remove local dev store and .claude state (keeps memory persona)
	rm -rf dev-data/store dev-data/memory/.claude

# ── Internal ─────────────────────────────────────────────

_ensure-data-dirs:
	@mkdir -p dev-data/memory dev-data/memory/.claude/skills dev-data/memory/conversations
	@mkdir -p dev-data/store
	@test -f dev-data/memory/CLAUDE.md || printf '# PicoClaw Memory\n\nYou are a helpful assistant.\n' > dev-data/memory/CLAUDE.md

_wait-ready:
	@for i in $$(seq 1 30); do \
		curl -sf http://localhost:$(PORT)/health > /dev/null 2>&1 && break; \
		sleep 1; \
	done
	@curl -sf http://localhost:$(PORT)/health > /dev/null 2>&1 \
		|| (echo "Server failed to start" && docker logs $(CONTAINER_NAME) && exit 1)

# ── Help ─────────────────────────────────────────────────

.DEFAULT_GOAL := help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

.PHONY: build-ts dev dev-watch docker-build docker-build-lambda docker-run docker-run-bg \
	docker-stop docker-logs ghcr-login ghcr-build ghcr-build-lambda ghcr-push \
	ghcr-push-lambda ghcr-release ghcr-make-public test test-health test-chat \
	test-task-create test-task-check test-e2e test-e2e-quick clean clean-data \
	help _ensure-data-dirs _wait-ready
