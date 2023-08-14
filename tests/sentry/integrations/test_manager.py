from sentry import integrations
from sentry.integrations.vsts_extension import VstsExtensionIntegrationProvider
from sentry.testutils.cases import TestCase


class TestIntegrations(TestCase):
    def test_excludes_non_visible_integrations(self):
        # The VSTSExtension is not visible
        assert all(not isinstance(i, VstsExtensionIntegrationProvider) for i in integrations.all())
