.PHONY: migrate deploy reset-db

migrate:
	python manage.py migrate

deploy:
	gcloud app deploy

reset-db:
	python manage.py flush --noinput
