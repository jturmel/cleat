.PHONY: test lint build

test:
	pytest

lint:
	ruff check .

build:
	npm run build
