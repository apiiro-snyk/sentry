import type {List} from 'react-virtualized';
import * as Sentry from '@sentry/react';
import {mat3, vec2} from 'gl-matrix';

import type {Client} from 'sentry/api';
import type {Organization} from 'sentry/types';
import clamp from 'sentry/utils/number/clamp';
import {lightTheme as theme} from 'sentry/utils/theme';
import {
  isAutogroupedNode,
  isParentAutogroupedNode,
  isSiblingAutogroupedNode,
  isSpanNode,
  isTransactionNode,
} from 'sentry/views/performance/newTraceDetails/guards';
import {
  type TraceTree,
  TraceTreeNode,
} from 'sentry/views/performance/newTraceDetails/traceTree';

const DIVIDER_WIDTH = 6;

function easeOutQuad(x: number): number {
  return 1 - (1 - x) * (1 - x);
}

function onPreventBackForwardNavigation(event: WheelEvent) {
  if (event.deltaX !== 0) {
    event.preventDefault();
  }
}

type ViewColumn = {
  column_nodes: TraceTreeNode<TraceTree.NodeValue>[];
  column_refs: (HTMLElement | undefined)[];
  translate: [number, number];
  width: number;
};

class View {
  public x: number;
  public y: number;
  public width: number;
  public height: number;

  constructor(x: number, y: number, width: number, height: number) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }

  static From(view: View): View {
    return new View(view.x, view.y, view.width, view.height);
  }
  static Empty(): View {
    return new View(0, 0, 1000, 1);
  }

  serialize() {
    return [this.x, this.y, this.width, this.height];
  }

  between(to: View): mat3 {
    return mat3.fromValues(
      to.width / this.width,
      0,
      0,
      to.height / this.height,
      0,
      0,
      to.x - this.x * (to.width / this.width),
      to.y - this.y * (to.height / this.height),
      1
    );
  }

  transform(mat: mat3): [number, number, number, number] {
    const x = this.x * mat[0] + this.y * mat[3] + mat[6];
    const y = this.x * mat[1] + this.y * mat[4] + mat[7];
    const width = this.width * mat[0] + this.height * mat[3];
    const height = this.width * mat[1] + this.height * mat[4];
    return [x, y, width, height];
  }

  get center() {
    return this.x + this.width / 2;
  }

  get left() {
    return this.x;
  }
  get right() {
    return this.x + this.width;
  }
  get top() {
    return this.y;
  }
  get bottom() {
    return this.y + this.height;
  }
}

/**
 * Tracks the state of the virtualized view and manages the resizing of the columns.
 * Children components should call the appropriate register*Ref methods to register their
 * HTML elements.
 */
export class VirtualizedViewManager {
  // Represents the space of the entire trace, for example
  // a trace starting at 0 and ending at 1000 would have a space of [0, 1000]
  to_origin: number = 0;
  trace_space: View = View.Empty();
  // The view defines what the user is currently looking at, it is a subset
  // of the trace space. For example, if the user is currently looking at the
  // trace from 500 to 1000, the view would be represented by [x, width] = [500, 500]
  trace_view: View = View.Empty();
  // Represents the pixel space of the entire trace - this is the container
  // that we render to. For example, if the container is 1000px wide, the
  // pixel space would be [0, 1000]
  trace_physical_space: View = View.Empty();
  container_physical_space: View = View.Empty();

  measurer: RowMeasurer = new RowMeasurer();
  text_measurer: TextMeasurer = new TextMeasurer();

  resize_observer: ResizeObserver | null = null;
  list: List | null = null;

  // HTML refs that we need to keep track of such
  // that rendering can be done programmatically
  divider: HTMLElement | null = null;
  container: HTMLElement | null = null;
  indicators: ({indicator: TraceTree['indicators'][0]; ref: HTMLElement} | undefined)[] =
    [];
  span_bars: ({ref: HTMLElement; space: [number, number]} | undefined)[] = [];
  span_text: ({ref: HTMLElement; space: [number, number], text: string;} | undefined)[] =
    [];

  // Holds the span to px matrix so we dont keep recalculating it
  span_to_px: mat3 = mat3.create();

  // Column configuration
  columns: {
    list: ViewColumn;
    span_list: ViewColumn;
  };

  constructor(columns: {
    list: Pick<ViewColumn, 'width'>;
    span_list: Pick<ViewColumn, 'width'>;
  }) {
    this.columns = {
      list: {...columns.list, column_nodes: [], column_refs: [], translate: [0, 0]},
      span_list: {
        ...columns.span_list,
        column_nodes: [],
        column_refs: [],
        translate: [0, 0],
      },
    };

    this.onDividerMouseDown = this.onDividerMouseDown.bind(this);
    this.onDividerMouseUp = this.onDividerMouseUp.bind(this);
    this.onDividerMouseMove = this.onDividerMouseMove.bind(this);
    this.onSyncedScrollbarScroll = this.onSyncedScrollbarScroll.bind(this);
    this.onWheelZoom = this.onWheelZoom.bind(this);
  }

  initializeTraceSpace(space: [x: number, y: number, width: number, height: number]) {
    this.to_origin = space[0];

    this.trace_space = new View(0, 0, space[2], space[3]);
    this.trace_view = new View(0, 0, space[2], space[3]);

    this.recomputeSpanToPxMatrix();
  }

  initializePhysicalSpace(width: number, height: number) {
    this.container_physical_space = new View(0, 0, width, height);
    this.trace_physical_space = new View(
      0,
      0,
      width * this.columns.span_list.width,
      height
    );

    this.recomputeSpanToPxMatrix();
  }

  onContainerRef(container: HTMLElement | null) {
    if (container) {
      this.initialize(container);
    } else {
      this.teardown();
    }
  }

  dividerStartVec: [number, number] | null = null;
  onDividerMouseDown(event: MouseEvent) {
    if (!this.container) {
      return;
    }

    this.dividerStartVec = [event.clientX, event.clientY];
    this.container.style.userSelect = 'none';

    this.container.addEventListener('mouseup', this.onDividerMouseUp, {passive: true});
    this.container.addEventListener('mousemove', this.onDividerMouseMove, {
      passive: true,
    });
  }

  onDividerMouseUp(event: MouseEvent) {
    if (!this.container || !this.dividerStartVec) {
      return;
    }

    const distance = event.clientX - this.dividerStartVec[0];
    const distancePercentage = distance / this.container_physical_space.width;

    this.columns.list.width = this.columns.list.width + distancePercentage;
    this.columns.span_list.width = this.columns.span_list.width - distancePercentage;

    this.container.style.userSelect = 'auto';
    this.dividerStartVec = null;

    this.container.removeEventListener('mouseup', this.onDividerMouseUp);
    this.container.removeEventListener('mousemove', this.onDividerMouseMove);
  }

  onDividerMouseMove(event: MouseEvent) {
    if (!this.dividerStartVec || !this.divider) {
      return;
    }

    const distance = event.clientX - this.dividerStartVec[0];
    const distancePercentage = distance / this.container_physical_space.width;

    this.trace_physical_space.width =
      (this.columns.span_list.width - distancePercentage) *
      this.container_physical_space.width;

    this.draw({
      list: this.columns.list.width + distancePercentage,
      span_list: this.columns.span_list.width - distancePercentage,
    });
  }

  registerList(list: List | null) {
    this.list = list;
  }

  registerDividerRef(ref: HTMLElement | null) {
    if (!ref) {
      if (this.divider) {
        this.divider.removeEventListener('mousedown', this.onDividerMouseDown);
      }
      this.divider = null;
      return;
    }

    this.divider = ref;
    this.divider.style.width = `${DIVIDER_WIDTH}px`;
    ref.addEventListener('mousedown', this.onDividerMouseDown, {passive: true});
  }

  registerSpanBarRef(ref: HTMLElement | null, space: [number, number], index: number) {
    this.span_bars[index] = ref ? {ref, space} : undefined;
  }

  registerSpanBarTextRef(
    ref: HTMLElement | null,
    text: string,
    space: [number, number],
    index: number
  ) {
    this.span_text[index] = ref ? {ref, text, space} : undefined;
  }

  registerColumnRef(
    column: string,
    ref: HTMLElement | null,
    index: number,
    node: TraceTreeNode<any>
  ) {
    if (!this.columns[column]) {
      throw new TypeError('Invalid column');
    }

    if (typeof index !== 'number' || isNaN(index)) {
      throw new TypeError('Invalid index');
    }

    if (column === 'list') {
      const element = this.columns[column].column_refs[index];
      if (ref === undefined && element) {
        element.removeEventListener('wheel', this.onSyncedScrollbarScroll);
      } else if (ref) {
        const scrollableElement = ref.children[0];
        if (scrollableElement) {
          this.measurer.measure(node, scrollableElement as HTMLElement);
          ref.addEventListener('wheel', this.onSyncedScrollbarScroll, {passive: true});
        }
      }
    }

    if (column === 'span_list') {
      const element = this.columns[column].column_refs[index];
      if (ref === undefined && element) {
        element.removeEventListener('wheel', this.onWheelZoom);
      } else if (ref) {
        ref.addEventListener('wheel', this.onWheelZoom, {passive: false});
      }
    }

    this.columns[column].column_refs[index] = ref ?? undefined;
    this.columns[column].column_nodes[index] = node ?? undefined;
  }

  registerIndicatorRef(
    ref: HTMLElement | null,
    index: number,
    indicator: TraceTree['indicators'][0]
  ) {
    if (!ref) {
      this.indicators[index] = undefined;
    } else {
      this.indicators[index] = {ref, indicator};
    }

    if (ref) {
      ref.style.left = this.columns.list.width * 100 + '%';
      ref.style.transform = `translateX(${this.computeTransformXFromTimestamp(
        indicator.start
      )}px)`;
    }
  }

  getConfigSpaceCursor(cursor: {x: number; y: number}): [number, number] {
    const left_percentage = cursor.x / this.trace_physical_space.width;
    const left_view = left_percentage * this.trace_view.width;

    return [this.trace_view.x + left_view, 0];
  }

  onWheelZoom(event: WheelEvent) {
    if (event.metaKey) {
      event.preventDefault();

      if (!this.onWheelEndRaf) {
        this.onWheelStart();
        this.enqueueOnWheelEndRaf();
        return;
      }

      const scale = 1 - event.deltaY * 0.01 * -1;
      const configSpaceCursor = this.getConfigSpaceCursor({
        x: event.offsetX,
        y: event.offsetY,
      });

      const center = vec2.fromValues(configSpaceCursor[0], 0);
      const centerScaleMatrix = mat3.create();

      mat3.fromTranslation(centerScaleMatrix, center);
      mat3.scale(centerScaleMatrix, centerScaleMatrix, vec2.fromValues(scale, 1));
      mat3.translate(
        centerScaleMatrix,
        centerScaleMatrix,
        vec2.fromValues(-center[0], 0)
      );

      const newView = this.trace_view.transform(centerScaleMatrix);
      this.setTraceView({
        x: newView[0],
        width: newView[2],
      });
      this.draw();
    } else {
      const physical_delta_pct = event.deltaX / this.trace_physical_space.width;
      const view_delta = physical_delta_pct * this.trace_view.width;
      this.setTraceView({
        x: this.trace_view.x + view_delta,
      });
      this.draw();
    }
  }

  onWheelEndRaf: number | null = null;
  enqueueOnWheelEndRaf() {
    if (this.onWheelEndRaf !== null) {
      window.cancelAnimationFrame(this.onWheelEndRaf);
    }

    const start = performance.now();
    const rafCallback = (now: number) => {
      const elapsed = now - start;
      if (elapsed > 100) {
        this.onWheelEnd();
      } else {
        this.onWheelEndRaf = window.requestAnimationFrame(rafCallback);
      }
    };

    this.onWheelEndRaf = window.requestAnimationFrame(rafCallback);
  }

  onWheelStart() {
    for (let i = 0; i < this.columns.span_list.column_refs.length; i++) {
      const span_list = this.columns.span_list.column_refs[i];
      if (span_list?.children?.[0]) {
        (span_list.children[0] as HTMLElement).style.pointerEvents = 'none';
      }
    }
  }

  onWheelEnd() {
    this.onWheelEndRaf = null;

    for (let i = 0; i < this.columns.span_list.column_refs.length; i++) {
      const span_list = this.columns.span_list.column_refs[i];
      if (span_list?.children?.[0]) {
        (span_list.children[0] as HTMLElement).style.pointerEvents = 'auto';
      }
    }
  }

  setTraceView(view: {width?: number; x?: number}) {
    const x = view.x ?? this.trace_view.x;
    const width = view.width ?? this.trace_view.width;

    this.trace_view.x = clamp(x, 0, this.trace_space.width - width);
    this.trace_view.width = clamp(width, 0, this.trace_space.width);
    this.recomputeSpanToPxMatrix();
  }

  scrollSyncRaf: number | null = null;
  onSyncedScrollbarScroll(event: WheelEvent) {
    if (this.bringRowIntoViewAnimation !== null) {
      window.cancelAnimationFrame(this.bringRowIntoViewAnimation);
      this.bringRowIntoViewAnimation = null;
    }

    this.enqueueOnScrollEndOutOfBoundsCheck();
    const columnWidth = this.columns.list.width * this.container_physical_space.width;

    this.columns.list.translate[0] = clamp(
      this.columns.list.translate[0] - event.deltaX,
      -(this.measurer.max - columnWidth + 16), // 16px margin so we dont scroll right to the last px
      0
    );

    for (let i = 0; i < this.columns.list.column_refs.length; i++) {
      const list = this.columns.list.column_refs[i];
      if (list?.children?.[0]) {
        (list.children[0] as HTMLElement).style.transform =
          `translateX(${this.columns.list.translate[0]}px)`;
      }
    }

    // Eventually sync the column translation to the container
    if (this.scrollSyncRaf) {
      window.cancelAnimationFrame(this.scrollSyncRaf);
    }
    this.scrollSyncRaf = window.requestAnimationFrame(() => {
      // @TODO if user is outside of the container, scroll the container to the left
      this.container?.style.setProperty(
        '--column-translate-x',
        this.columns.list.translate[0] + 'px'
      );
    });
  }

  scrollEndSyncRaf: number | null = null;
  enqueueOnScrollEndOutOfBoundsCheck() {
    if (this.scrollEndSyncRaf !== null) {
      window.cancelAnimationFrame(this.scrollEndSyncRaf);
    }

    const start = performance.now();
    const rafCallback = (now: number) => {
      const elapsed = now - start;
      if (elapsed > 300) {
        this.onScrollEndOutOfBoundsCheck();
      } else {
        this.scrollEndSyncRaf = window.requestAnimationFrame(rafCallback);
      }
    };

    this.scrollEndSyncRaf = window.requestAnimationFrame(rafCallback);
  }

  onScrollEndOutOfBoundsCheck() {
    this.scrollEndSyncRaf = null;

    const translation = this.columns.list.translate[0];
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let innerMostNode: TraceTreeNode<any> | undefined;

    const offset = this.list?.Grid?.props.overscanRowCount ?? 0;
    const renderCount = this.columns.span_list.column_refs.length;

    for (let i = offset + 1; i < renderCount - offset; i++) {
      const width = this.measurer.cache.get(this.columns.list.column_nodes[i]);
      if (width === undefined) {
        // this is unlikely to happen, but we should trigger a sync measure event if it does
        continue;
      }

      min = Math.min(min, width);
      max = Math.max(max, width);
      innerMostNode =
        !innerMostNode || this.columns.list.column_nodes[i].depth < innerMostNode.depth
          ? this.columns.list.column_nodes[i]
          : innerMostNode;
    }

    if (innerMostNode) {
      if (translation + max < 0) {
        this.scrollRowIntoViewHorizontally(innerMostNode);
      } else if (
        translation + innerMostNode.depth * 24 >
        this.columns.list.width * this.container_physical_space.width
      ) {
        this.scrollRowIntoViewHorizontally(innerMostNode);
      }
    }
  }

  scrollRowIntoViewHorizontally(node: TraceTreeNode<any>, duration: number = 600) {
    const VISUAL_OFFSET = 24 / 2;
    const target = Math.min(-node.depth * 24 + VISUAL_OFFSET, 0);
    this.animateScrollColumnTo(target, duration);
  }

  bringRowIntoViewAnimation: number | null = null;
  animateScrollColumnTo(x: number, duration: number) {
    const start = performance.now();

    const startPosition = this.columns.list.translate[0];
    const distance = x - startPosition;

    const animate = (now: number) => {
      const elapsed = now - start;
      const progress = duration > 0 ? elapsed / duration : 1;
      const eased = easeOutQuad(progress);

      const pos = startPosition + distance * eased;

      for (let i = 0; i < this.columns.list.column_refs.length; i++) {
        const list = this.columns.list.column_refs[i];
        if (list?.children?.[0]) {
          (list.children[0] as HTMLElement).style.transform = `translateX(${pos}px)`;
        }
      }

      if (progress < 1) {
        this.columns.list.translate[0] = pos;
        this.bringRowIntoViewAnimation = window.requestAnimationFrame(animate);
      } else {
        this.columns.list.translate[0] = x;
      }
    };

    this.bringRowIntoViewAnimation = window.requestAnimationFrame(animate);
  }

  initialize(container: HTMLElement) {
    if (this.container !== container && this.resize_observer !== null) {
      this.teardown();
    }

    this.container = container;
    this.container.addEventListener('wheel', onPreventBackForwardNavigation, {
      passive: false,
    });

    this.resize_observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) {
        throw new Error('ResizeObserver entry is undefined');
      }

      this.initializePhysicalSpace(entry.contentRect.width, entry.contentRect.height);
      this.draw();
    });

    this.resize_observer.observe(container);
  }

  recomputeSpanToPxMatrix() {
    const traceViewToSpace = this.trace_space.between(this.trace_view);
    const tracePhysicalToView = this.trace_physical_space.between(this.trace_space);
    this.span_to_px = mat3.multiply(
      this.span_to_px,
      traceViewToSpace,
      tracePhysicalToView
    );
  }

  computeSpanCSSMatrixTransform(
    space: [number, number]
  ): [number, number, number, number, number, number] {
    const scale = space[1] / this.trace_view.width;

    return [
      Math.max(scale, (1 * this.span_to_px[0]) / this.trace_view.width),
      0,
      0,
      1,
      (space[0] - this.to_origin) / this.span_to_px[0] -
        this.trace_view.x / this.span_to_px[0],
      0,
    ];
  }

  scrollToPath(
    tree: TraceTree,
    scrollQueue: TraceTree.NodePath[],
    rerender: () => void,
    {api, organization}: {api: Client; organization: Organization}
  ): Promise<TraceTreeNode<TraceTree.NodeValue> | null> {
    const segments = [...scrollQueue];
    const list = this.list;

    if (!list) {
      return Promise.resolve(null);
    }

    // Keep parent reference as we traverse the tree so that we can only
    // perform searching in the current level and not the entire tree
    let parent: TraceTreeNode<TraceTree.NodeValue> = tree.root;

    const scrollToRow = async (): Promise<TraceTreeNode<TraceTree.NodeValue> | null> => {
      const path = segments.pop();
      const current = findInTreeFromSegment(parent, path!);

      if (!current) {
        Sentry.captureMessage('Failed to scroll to node in trace tree');
        return null;
      }

      // Reassing the parent to the current node
      parent = current;

      if (isTransactionNode(current)) {
        const nextSegment = segments[segments.length - 1];
        if (nextSegment?.startsWith('span:') || nextSegment?.startsWith('ag:')) {
          await tree.zoomIn(current, true, {
            api,
            organization,
          });
          return scrollToRow();
        }
      }

      if (isAutogroupedNode(current) && segments.length > 0) {
        tree.expand(current, true);
        return scrollToRow();
      }

      if (segments.length > 0) {
        return scrollToRow();
      }

      // We are at the last path segment (the node that the user clicked on)
      // and we should scroll the view to this node.
      const index = tree.list.findIndex(node => node === current);
      if (index === -1) {
        throw new Error("Couldn't find node in list");
      }

      rerender();
      list.scrollToRow(index);
      return current;
    };

    return scrollToRow();
  }

  computeTransformXFromTimestamp(timestamp: number): number {
    return (timestamp - this.to_origin - this.trace_view.x) / this.span_to_px[0];
  }

  computeSpanTextPlacement(span_space: [number, number], text: string): number | null {
    const TEXT_PADDING = 2;
    const span_left = span_space[0] - this.to_origin;
    const span_right = span_left + span_space[1];

    if (span_right < this.trace_view.x) {
      return (
        this.computeTransformXFromTimestamp(span_space[0] + span_space[1]) + TEXT_PADDING
      );
    }

    if (span_left > this.trace_view.right) {
      return this.computeTransformXFromTimestamp(span_space[0]) + TEXT_PADDING;
    }

    const view_left = this.trace_view.x;
    const view_right = view_left + this.trace_view.width;

    const width = this.text_measurer.measure(text);
    const space_right = view_right - span_right;

    // If we have space to the right, we will try and place the text there
    if (space_right > 0) {
      const space_right_px = space_right / this.span_to_px[0];

      if (space_right_px > width) {
        return (
          this.computeTransformXFromTimestamp(span_space[0] + span_space[1]) +
          TEXT_PADDING
        );
      }
    }

    if (space_right < 0) {
      const full_span_px_width = span_space[1] / this.span_to_px[0];

      if (full_span_px_width > width) {
        const difference = span_right - this.trace_view.right;
        const visible_width = (span_space[1] - difference) / this.span_to_px[0];

        if (visible_width > width) {
          return (
            this.computeTransformXFromTimestamp(
              this.to_origin + this.trace_view.left + this.trace_view.width
            ) -
            width -
            TEXT_PADDING
          );
        }

        return this.computeTransformXFromTimestamp(span_space[0]) + TEXT_PADDING;
      }
    }

    return null;
  }

  draw(options: {list?: number; span_list?: number} = {}) {
    const list_width = options.list ?? this.columns.list.width;
    const span_list_width = options.span_list ?? this.columns.span_list.width;

    if (this.divider) {
      this.divider.style.transform = `translateX(${
        list_width * this.container_physical_space.width - DIVIDER_WIDTH / 2
      }px)`;
    }

    const listWidth = list_width * 100 + '%';
    const spanWidth = span_list_width * 100 + '%';

    for (let i = 0; i < this.columns.list.column_refs.length; i++) {
      const list = this.columns.list.column_refs[i];
      if (list) list.style.width = listWidth;
      const span = this.columns.span_list.column_refs[i];
      if (span) span.style.width = spanWidth;

      const span_bar = this.span_bars[i];
      if (span_bar) {
        const span_transform = this.computeSpanCSSMatrixTransform(span_bar.space);
        span_bar.ref.style.transform = `matrix(${span_transform.join(',')}`;
      }
      const span_text = this.span_text[i];
      if (span_text) {
        const text_transform = this.computeSpanTextPlacement(
          span_text.space,
          span_text.text
        );

        if (text_transform === null) {
          continue;
        }

        span_text.ref.style.transform = `translateX(${text_transform}px)`;
      }
    }

    for (let i = 0; i < this.indicators.length; i++) {
      const entry = this.indicators[i];
      if (!entry) {
        continue;
      }
      entry.ref.style.left = listWidth;
      entry.ref.style.transform = `translateX(${this.computeTransformXFromTimestamp(
        entry.indicator.start
      )}px)`;
    }
  }

  teardown() {
    if (this.container) {
      this.container.removeEventListener('wheel', onPreventBackForwardNavigation);
    }
    if (this.resize_observer) {
      this.resize_observer.disconnect();
    }
  }
}

// The backing cache should be a proper LRU cache,
// so we dont end up storing an infinite amount of elements
class RowMeasurer {
  cache: Map<TraceTreeNode<any>, number> = new Map();
  elements: HTMLElement[] = [];

  queue: [TraceTreeNode<any>, HTMLElement][] = [];
  drainRaf: number | null = null;
  max: number = 0;

  constructor() {
    this.drain = this.drain.bind(this);
  }

  enqueueMeasure(node: TraceTreeNode<any>, element: HTMLElement) {
    if (this.cache.has(node)) {
      return;
    }

    this.queue.push([node, element]);

    if (this.drainRaf !== null) {
      window.cancelAnimationFrame(this.drainRaf);
    }
    this.drainRaf = window.requestAnimationFrame(this.drain);
  }

  drain() {
    for (const [node, element] of this.queue) {
      this.measure(node, element);
    }
  }

  measure(node: TraceTreeNode<any>, element: HTMLElement): number {
    const cache = this.cache.get(node);
    if (cache !== undefined) {
      return cache;
    }

    const width = element.getBoundingClientRect().width;
    if (width > this.max) {
      this.max = width;
    }
    this.cache.set(node, width);
    return width;
  }
}

// The backing cache should be a proper LRU cache,
// so we dont end up storing an infinite amount of elements
class TextMeasurer {
  queue: string[] = [];
  drainRaf: number | null = null;
  cache: Map<string, number> = new Map();

  ctx: CanvasRenderingContext2D;

  number: number = 0;
  dot: number = 0;
  duration: Record<string, number> = {};

  constructor() {
    this.drain = this.drain.bind(this);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      throw new Error('Canvas 2d context is not available');
    }

    canvas.width = 50 * window.devicePixelRatio ?? 1;
    canvas.height = 50 * window.devicePixelRatio ?? 1;
    this.ctx = ctx;

    ctx.font = '11px' + theme.text.family;

    this.dot = this.ctx.measureText('.').width;
    for (let i = 0; i < 10; i++) {
      const measurement = this.ctx.measureText(i.toString());
      this.number = Math.max(this.number, measurement.width);
    }

    for (const duration of ['ns', 'ms', 's', 'm', 'h', 'd']) {
      this.duration[duration] = this.ctx.measureText(duration).width;
    }
  }

  drain() {
    for (const string of this.queue) {
      this.measure(string);
    }
  }

  computeStringLength(string: string): number {
    let width = 0;
    for (let i = 0; i < string.length; i++) {
      switch (string[i]) {
        case '.':
          width += this.dot;
          break;
        case '0':
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9':
          width += this.number;
          break;
        default:
          const remaining = string.slice(i);
          if (this.duration[remaining]) {
            width += this.duration[remaining];
            return width;
          }
      }
    }
    return width;
  }

  measure(string: string): number {
    const cached_width = this.cache.get(string);
    if (cached_width !== undefined) {
      return cached_width;
    }

    const width = this.computeStringLength(string);
    this.cache.set(string, width);
    return width;
  }
}

function findInTreeFromSegment(
  start: TraceTreeNode<TraceTree.NodeValue>,
  segment: TraceTree.NodePath
): TraceTreeNode<TraceTree.NodeValue> | null {
  const [type, id] = segment.split(':');

  if (!type || !id) {
    throw new TypeError('Node path must be in the format of `type:id`');
  }

  return TraceTreeNode.Find(start, node => {
    if (type === 'txn' && isTransactionNode(node)) {
      return node.value.event_id === id;
    }

    if (type === 'span' && isSpanNode(node)) {
      return node.value.span_id === id;
    }

    if (type === 'ag' && isAutogroupedNode(node)) {
      if (isParentAutogroupedNode(node)) {
        return node.head.value.span_id === id || node.tail.value.span_id === id;
      }
      if (isSiblingAutogroupedNode(node)) {
        const child = node.children[0];
        if (isSpanNode(child)) {
          return child.value.span_id === id;
        }
      }
    }

    return false;
  });
}
