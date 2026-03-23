.PHONY: bootstrap

bootstrap:
	echo "starting"
	mkdir -p .cache
	cp -r configs/* .cache/
	python scripts/sync.py
	echo "done"
