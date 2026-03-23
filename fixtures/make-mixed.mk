.PHONY: dev verify

dev:
	docker compose up backend db

verify:
	pytest
	npm run build
