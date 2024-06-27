import {useMemo, useRef} from 'react';
import styled from '@emotion/styled';

import TransitionChart from 'sentry/components/charts/transitionChart';
import {MetricChart} from 'sentry/components/metrics/chart/chart';
import {space} from 'sentry/styles/space';
import type {ReactEchartsRef} from 'sentry/types/echarts';
import type {MetricsQueryApiResponse} from 'sentry/types/metrics';
import type {MetricDisplayType} from 'sentry/utils/metrics/types';
import type {MetricsQueryApiQueryParams} from 'sentry/utils/metrics/useMetricsQuery';
import {LoadingScreen} from 'sentry/views/dashboards/widgetCard/widgetCardChartContainer';
import {createChartPalette} from 'sentry/views/metrics/utils/metricsChartPalette';
import {getChartTimeseries} from 'sentry/views/metrics/widget';

import {DASHBOARD_CHART_GROUP} from '../dashboard';

type MetricChartContainerProps = {
  displayType: MetricDisplayType;
  isLoading: boolean;
  metricQueries: MetricsQueryApiQueryParams[];
  chartHeight?: number;
  showLegend?: boolean;
  timeseriesData?: MetricsQueryApiResponse;
};

export function MetricChartContainer({
  timeseriesData,
  isLoading,
  metricQueries,
  chartHeight,
  displayType,
  showLegend,
}: MetricChartContainerProps) {
  const chartRef = useRef<ReactEchartsRef>(null);

  const chartSeries = useMemo(() => {
    return timeseriesData
      ? getChartTimeseries(timeseriesData, metricQueries, {
          getChartPalette: createChartPalette,
        })
      : [];
  }, [timeseriesData, metricQueries]);

  return (
    <MetricWidgetChartWrapper>
      <TransitionChart loading={isLoading} reloading={isLoading}>
        <LoadingScreen loading={isLoading} />
        <MetricChart
          ref={chartRef}
          series={chartSeries}
          displayType={displayType}
          group={DASHBOARD_CHART_GROUP}
          height={chartHeight}
          enableZoom
          showLegend={showLegend}
        />
      </TransitionChart>
    </MetricWidgetChartWrapper>
  );
}

const MetricWidgetChartWrapper = styled('div')`
  height: 100%;
  width: 100%;
  padding: ${space(3)};
  padding-top: ${space(0.25)};
`;
