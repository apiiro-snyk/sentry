import styled from '@emotion/styled';
import {Location} from 'history';

import _EventsRequest from 'sentry/components/charts/eventsRequest';
import {PerformanceLayoutBodyRow} from 'sentry/components/performance/layouts';
import {CHART_PALETTE} from 'sentry/constants/chartPalette';
import {space} from 'sentry/styles/space';
import {Organization, Project} from 'sentry/types';
import {Series} from 'sentry/types/echarts';
import EventView from 'sentry/utils/discover/eventView';
import {usePageError} from 'sentry/utils/performance/contexts/pageError';

const EventsRequest = withApi(_EventsRequest);

import {useTheme} from '@emotion/react';

import {t} from 'sentry/locale';
import {DiscoverDatasets} from 'sentry/utils/discover/types';
import {MutableSearch} from 'sentry/utils/tokenizeSearch';
import withApi from 'sentry/utils/withApi';
import Chart, {useSynchronizeCharts} from 'sentry/views/starfish/components/chart';
import MiniChartPanel from 'sentry/views/starfish/components/miniChartPanel';
import formatThroughput from 'sentry/views/starfish/utils/chartValueFormatters/formatThroughput';
import {DataTitles} from 'sentry/views/starfish/views/spans/types';
import {SpanGroupBreakdownContainer} from 'sentry/views/starfish/views/webServiceView/spanGroupBreakdownContainer';

import EndpointList from './endpointList';

type BasePerformanceViewProps = {
  eventView: EventView;
  location: Location;
  organization: Organization;
  projects: Project[];
};

export function StarfishView(props: BasePerformanceViewProps) {
  const {organization, eventView} = props;
  const theme = useTheme();

  function renderCharts() {
    const query = new MutableSearch([
      'event.type:transaction',
      'has:http.method',
      'transaction.op:http.server',
    ]);

    return (
      <EventsRequest
        query={query.formatString()}
        includePrevious={false}
        partial
        interval="1h"
        includeTransformedData
        limit={1}
        environment={eventView.environment}
        project={eventView.project}
        period={eventView.statsPeriod}
        referrer="starfish-homepage-charts"
        start={eventView.start}
        end={eventView.end}
        organization={organization}
        yAxis={['tps()', 'http_error_count()']}
        dataset={DiscoverDatasets.METRICS}
      >
        {({loading, results}) => {
          if (!results || !results[0] || !results[1]) {
            return null;
          }

          const throughputData: Series = {
            seriesName: t('Throughput'),
            data: results[0].data,
          };

          const errorsData: Series = {
            seriesName: t('5xx Responses'),
            color: CHART_PALETTE[5][3],
            data: results[1].data,
          };

          return (
            <ChartGrid>
              <MiniChartPanel title={DataTitles.throughput}>
                <Chart
                  statsPeriod={eventView.statsPeriod}
                  height={80}
                  data={[throughputData]}
                  start=""
                  end=""
                  loading={loading}
                  utc={false}
                  grid={{
                    left: '0',
                    right: '0',
                    top: '8px',
                    bottom: '0',
                  }}
                  aggregateOutputFormat="rate"
                  definedAxisTicks={2}
                  stacked
                  isLineChart
                  chartColors={theme.charts.getColorPalette(2)}
                  tooltipFormatterOptions={{
                    valueFormatter: value => formatThroughput(value),
                  }}
                />
              </MiniChartPanel>

              <MiniChartPanel title={DataTitles.errorCount}>
                <Chart
                  statsPeriod={eventView.statsPeriod}
                  height={80}
                  data={[errorsData]}
                  start={eventView.start as string}
                  end={eventView.end as string}
                  loading={loading}
                  utc={false}
                  grid={{
                    left: '0',
                    right: '0',
                    top: '8px',
                    bottom: '0',
                  }}
                  definedAxisTicks={2}
                  isLineChart
                  chartColors={theme.charts.getColorPalette(2)}
                />
              </MiniChartPanel>

              <WideChart>
                <MiniChartPanel title={DataTitles.errorCount}>
                  <Chart
                    statsPeriod={eventView.statsPeriod}
                    height={80}
                    data={[errorsData]}
                    start={eventView.start as string}
                    end={eventView.end as string}
                    loading={loading}
                    utc={false}
                    grid={{
                      left: '0',
                      right: '0',
                      top: '8px',
                      bottom: '0',
                    }}
                    definedAxisTicks={2}
                    isLineChart
                    chartColors={theme.charts.getColorPalette(2)}
                  />
                </MiniChartPanel>
              </WideChart>
            </ChartGrid>
          );
        }}
      </EventsRequest>
    );
  }

  useSynchronizeCharts();

  return (
    <div data-test-id="starfish-view">
      <StyledRow minSize={200}>
        <ChartsContainer>
          <ChartsContainerItem>
            <SpanGroupBreakdownContainer />
          </ChartsContainerItem>
          <ChartsContainerItem2>{renderCharts()}</ChartsContainerItem2>
        </ChartsContainer>
      </StyledRow>

      <EndpointList {...props} setError={usePageError().setPageError} />
    </div>
  );
}

const StyledRow = styled(PerformanceLayoutBodyRow)`
  margin-bottom: ${space(2)};
`;

const ChartsContainer = styled('div')`
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: ${space(2)};
`;

const ChartsContainerItem = styled('div')`
  flex: 2;
`;

const ChartsContainerItem2 = styled('div')`
  flex: 1;
`;

const ChartGrid = styled('div')`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  grid-column-gap: ${space(2)};
`;

const WideChart = styled('div')`
  grid-column: 1 / 3;
`;
