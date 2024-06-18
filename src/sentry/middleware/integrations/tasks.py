import logging
from collections.abc import MutableMapping
from typing import Any, cast

import orjson
import requests
import sentry_sdk
from requests import Response
from rest_framework import status

from sentry.silo.base import SiloMode
from sentry.silo.client import RegionSiloClient
from sentry.tasks.base import instrumented_task
from sentry.types.region import get_region_by_name

logger = logging.getLogger(__name__)


@instrumented_task(
    name="sentry.middleware.integrations.tasks.convert_to_async_slack_response",
    queue="integrations.control",
    silo_mode=SiloMode.CONTROL,
    max_retries=2,
    default_retry_delay=5,
    record_timing=True,
)
def convert_to_async_slack_response(
    region_names: list[str],
    payload: dict[str, Any],
    response_url: str,
):
    regions = [get_region_by_name(rn) for rn in region_names]
    region_to_response_map: MutableMapping[str, Response] = {}
    result: MutableMapping[str, Any] = {"response": None, "region": None}
    for region in regions:
        region_response = RegionSiloClient(region=region).request(
            method=payload["method"],
            path=payload["path"],
            headers=payload["headers"],
            data=payload["body"].encode("utf-8"),
            json=False,
            raw_response=True,
        )
        region_response = cast(Response, region_response)
        region_to_response_map[region.name] = region_response
        if region_response.status_code >= 200 and region_response.status_code < 300:
            result["response"] = region_response
            result["region"] = region

    logger.info(
        "slack.async_region_response",
        extra={
            "region": result["region"],
            "response_map": {
                region_name: response.status_code
                for region_name, response in region_to_response_map.items()
            },
        },
    )
    if not result["response"]:
        return

    response_body = result["response"].content
    if response_body == b"":
        logger.info(
            "slack.async_empty_body",
            {
                "path": payload["path"],
                "region": result["region"],
                "response_status": result["response"].status_code,
            },
        )
        return

    response_payload = {}
    try:
        response_payload = orjson.loads(response_body)
    except Exception as exc:
        sentry_sdk.capture_exception(exc)

    integration_response = requests.post(response_url, json=response_payload)
    logger.info(
        "slack.async_integration_response",
        extra={
            "path": payload["path"],
            "region": result["region"],
            "region_status_code": result["response"].status_code,
            "integration_status_code": integration_response.status_code,
        },
    )


@instrumented_task(
    name="sentry.middleware.integrations.tasks.convert_to_async_discord_response",
    queue="integrations.control",
    silo_mode=SiloMode.CONTROL,
    max_retries=2,
    default_retry_delay=5,
)
def convert_to_async_discord_response(
    region_names: list[str],
    payload: dict[str, Any],
    response_url: str,
):
    """
    This task asks relevant region silos for response data to send asynchronously to Discord. It
    assumes Discord has received a callback of type:5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE).
    (See https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-response-object-interaction-callback-type)

    In the event this task finishes prior to returning the above type, the outbound post will fail.
    """
    regions = [get_region_by_name(rn) for rn in region_names]
    region_to_response_map: MutableMapping[str, Response] = {}
    result: MutableMapping[str, Any] = {"response": None, "region": None}
    for region in regions:
        region_response = RegionSiloClient(region=region).request(
            method=payload["method"],
            path=payload["path"],
            headers=payload["headers"],
            data=payload["body"].encode("utf-8"),
            json=False,
            raw_response=True,
        )
        region_response = cast(Response, region_response)
        region_to_response_map[region.name] = region_response
        if region_response.status_code >= 200 and region_response.status_code < 300:
            result["response"] = region_response
            result["region"] = region

    logger.info(
        "discord.async_region_response",
        extra={
            "region": result["region"],
            "response_map": {
                region_name: response.status_code
                for region_name, response in region_to_response_map.items()
            },
        },
    )
    if not result["response"]:
        return

    response_payload = {}
    try:
        # Region will return a response assuming it's meant to go directly to Discord. Since we're
        # handling the request asynchronously, we extract only the data, and post it to the webhook
        # that discord provides.
        # https://discord.com/developers/docs/interactions/receiving-and-responding#followup-messages
        response_payload = orjson.loads(result["response"].content).get("data")
    except Exception as e:
        sentry_sdk.capture_exception(e)
    integration_response = requests.post(response_url, json=response_payload)
    logger.info(
        "discord.async_integration_response",
        extra={
            "path": payload["path"],
            "region": result["region"].name,
            "region_status_code": result["response"].status_code,
            "integration_status_code": integration_response.status_code,
        },
    )
    if integration_response.status_code == status.HTTP_404_NOT_FOUND:
        raise Exception("Discord hook is not ready.")
