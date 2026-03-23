include scripts/common.mk
include scripts/deploy.mk

.PHONY: ci

ci: lint test

lint:
	ruff check .

test:
	pytest
