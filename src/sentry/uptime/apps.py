from django.apps import AppConfig


class Config(AppConfig):
    name = "sentry.uptime"

    def ready(self):
        pass
