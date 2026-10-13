.PHONY: help install setup dev dev-app dev-agent build lint clean

help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install all dependencies (Node + Python)
	pnpm install

setup: install ## Full setup: install deps and create .env from template
	@if [ ! -f apps/agent/.env ]; then \
		cp .env.example apps/agent/.env; \
		echo "Created apps/agent/.env from .env.example - set BEDROCK_MODEL_SONNET and TYPESAFE_API_KEY"; \
	else \
		echo "apps/agent/.env already exists, skipping"; \
	fi

dev: ## Start all services (frontend + agent)
	pnpm dev

dev-app: ## Start Next.js frontend only (http://localhost:3000)
	pnpm dev:app

dev-agent: ## Start LangGraph agent only (http://localhost:8123)
	pnpm dev:agent

build: ## Build all apps
	pnpm build

lint: ## Lint all apps
	pnpm lint

clean: ## Clean build artifacts
	pnpm clean
