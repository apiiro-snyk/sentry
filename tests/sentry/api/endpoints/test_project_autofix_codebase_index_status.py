from unittest import mock
from unittest.mock import call, patch

from django.conf import settings
from django.urls import reverse
from rest_framework import status

from sentry.testutils.cases import APITestCase
from sentry.utils import json


class TestProjectAutofixCodebaseIndexStatus(APITestCase):
    endpoint = "sentry-api-0-project-autofix-codebase-index-status"

    def setUp(self):
        super().setUp()
        self.login_as(user=self.user)
        self.project = self.create_project()
        self.url = reverse(
            self.endpoint,
            kwargs={
                "organization_slug": self.project.organization.slug,
                "project_id_or_slug": self.project.slug,
            },
        )

    @patch("sentry.api.endpoints.project_autofix_codebase_index_status.requests.post")
    def test_autofix_codebase_status_successful(self, mock_post):
        mock_post.return_value.status_code = 200
        mock_post.return_value.json.return_value = {"status": "up_to_date"}

        repo = self.create_repo(
            name="getsentry/sentry", provider="integrations:github", external_id="123"
        )
        self.create_code_mapping(project=self.project, repo=repo)

        response = self.client.get(
            self.url,
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK
        assert response.data == {"status": "up_to_date"}
        mock_post.assert_called_once_with(
            f"{settings.SEER_AUTOFIX_URL}/v1/automation/codebase/index/status",
            data=json.dumps(
                {
                    "organization_id": self.project.organization.id,
                    "project_id": self.project.id,
                    "repo": {
                        "provider": "integrations:github",
                        "owner": "getsentry",
                        "name": "sentry",
                        "external_id": "123",
                    },
                }
            ),
            headers={"content-type": "application/json;charset=utf-8"},
        )

    @patch("sentry.api.endpoints.project_autofix_codebase_index_status.requests.post")
    def test_autofix_codebase_status_multiple_repos_one_in_progress(self, mock_post):
        # Setup multiple repositories
        repo1 = self.create_repo(
            name="getsentry/sentry", provider="integrations:github", external_id="123"
        )
        repo2 = self.create_repo(
            name="getsentry/relay", provider="integrations:github", external_id="234"
        )
        self.create_code_mapping(project=self.project, repo=repo1, stack_root="/path1")
        self.create_code_mapping(project=self.project, repo=repo2, stack_root="/path2")

        # Mock the POST request to return successful status
        mock_post.side_effect = [
            mock.Mock(status_code=200, json=mock.Mock(return_value={"status": "up_to_date"})),
            mock.Mock(status_code=200, json=mock.Mock(return_value={"status": "indexing"})),
        ]

        # Perform the POST request
        response = self.client.get(
            self.url,
            format="json",
        )

        # Assertions
        assert response.status_code == status.HTTP_200_OK
        assert (
            mock_post.call_count == 2
        )  # Ensure that the endpoint was called twice, once for each repo
        assert response.data == {"status": "indexing"}
        calls = [
            call(
                f"{settings.SEER_AUTOFIX_URL}/v1/automation/codebase/index/status",
                data=json.dumps(
                    {
                        "organization_id": self.project.organization.id,
                        "project_id": self.project.id,
                        "repo": {
                            "provider": "integrations:github",
                            "owner": "getsentry",
                            "name": "sentry",
                            "external_id": "123",
                        },
                    }
                ),
                headers={"content-type": "application/json;charset=utf-8"},
            ),
            call(
                f"{settings.SEER_AUTOFIX_URL}/v1/automation/codebase/index/status",
                data=json.dumps(
                    {
                        "organization_id": self.project.organization.id,
                        "project_id": self.project.id,
                        "repo": {
                            "provider": "integrations:github",
                            "owner": "getsentry",
                            "name": "relay",
                            "external_id": "234",
                        },
                    }
                ),
                headers={"content-type": "application/json;charset=utf-8"},
            ),
        ]
        mock_post.assert_has_calls(calls, any_order=True)

    @patch("sentry.api.endpoints.project_autofix_codebase_index_status.requests.post")
    def test_autofix_codebase_status_multiple_repos_both_done(self, mock_post):
        # Setup multiple repositories
        repo1 = self.create_repo(
            name="getsentry/sentry", provider="integrations:github", external_id="123"
        )
        repo2 = self.create_repo(
            name="getsentry/relay", provider="integrations:github", external_id="234"
        )
        self.create_code_mapping(project=self.project, repo=repo1, stack_root="/path1")
        self.create_code_mapping(project=self.project, repo=repo2, stack_root="/path2")

        # Mock the POST request to return successful status
        mock_post.side_effect = [
            mock.Mock(status_code=200, json=mock.Mock(return_value={"status": "up_to_date"})),
            mock.Mock(status_code=200, json=mock.Mock(return_value={"status": "up_to_date"})),
        ]

        # Perform the POST request
        response = self.client.get(
            self.url,
            format="json",
        )

        # Assertions
        assert response.status_code == status.HTTP_200_OK
        assert (
            mock_post.call_count == 2
        )  # Ensure that the endpoint was called twice, once for each repo
        assert response.data == {"status": "up_to_date"}
        calls = [
            call(
                f"{settings.SEER_AUTOFIX_URL}/v1/automation/codebase/index/status",
                data=json.dumps(
                    {
                        "organization_id": self.project.organization.id,
                        "project_id": self.project.id,
                        "repo": {
                            "provider": "integrations:github",
                            "owner": "getsentry",
                            "name": "sentry",
                            "external_id": "123",
                        },
                    }
                ),
                headers={"content-type": "application/json;charset=utf-8"},
            ),
            call(
                f"{settings.SEER_AUTOFIX_URL}/v1/automation/codebase/index/status",
                data=json.dumps(
                    {
                        "organization_id": self.project.organization.id,
                        "project_id": self.project.id,
                        "repo": {
                            "provider": "integrations:github",
                            "owner": "getsentry",
                            "name": "relay",
                            "external_id": "234",
                        },
                    }
                ),
                headers={"content-type": "application/json;charset=utf-8"},
            ),
        ]
        mock_post.assert_has_calls(calls, any_order=True)

    @patch("sentry.api.endpoints.project_autofix_codebase_index_status.requests.post")
    def test_autofix_codebase_status_multiple_repos_one_not_indexed(self, mock_post):
        # Setup multiple repositories
        repo1 = self.create_repo(
            name="getsentry/sentry", provider="integrations:github", external_id="123"
        )
        repo2 = self.create_repo(
            name="getsentry/relay", provider="integrations:github", external_id="234"
        )
        self.create_code_mapping(project=self.project, repo=repo1, stack_root="/path1")
        self.create_code_mapping(project=self.project, repo=repo2, stack_root="/path2")

        # Mock the POST request to return successful status
        mock_post.side_effect = [
            mock.Mock(status_code=200, json=mock.Mock(return_value={"status": "up_to_date"})),
            mock.Mock(status_code=200, json=mock.Mock(return_value={"status": "not_indexed"})),
        ]

        # Perform the POST request
        response = self.client.get(
            self.url,
            format="json",
        )

        # Assertions
        assert response.status_code == status.HTTP_200_OK
        assert (
            mock_post.call_count == 2
        )  # Ensure that the endpoint was called twice, once for each repo
        assert response.data == {"status": "not_indexed"}
        calls = [
            call(
                f"{settings.SEER_AUTOFIX_URL}/v1/automation/codebase/index/status",
                data=json.dumps(
                    {
                        "organization_id": self.project.organization.id,
                        "project_id": self.project.id,
                        "repo": {
                            "provider": "integrations:github",
                            "owner": "getsentry",
                            "name": "sentry",
                            "external_id": "123",
                        },
                    }
                ),
                headers={"content-type": "application/json;charset=utf-8"},
            ),
            call(
                f"{settings.SEER_AUTOFIX_URL}/v1/automation/codebase/index/status",
                data=json.dumps(
                    {
                        "organization_id": self.project.organization.id,
                        "project_id": self.project.id,
                        "repo": {
                            "provider": "integrations:github",
                            "owner": "getsentry",
                            "name": "relay",
                            "external_id": "234",
                        },
                    }
                ),
                headers={"content-type": "application/json;charset=utf-8"},
            ),
        ]
        mock_post.assert_has_calls(calls, any_order=True)
