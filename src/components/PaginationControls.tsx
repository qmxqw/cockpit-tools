import { useRef } from 'react';
import { Rows3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SingleSelectFilterDropdown } from './SingleSelectFilterDropdown';
import { usePaginationHotkeys } from '../hooks/usePaginationHotkeys';

interface PaginationControlsProps {
  totalItems: number;
  currentPage: number;
  totalPages: number;
  pageSize: number;
  pageSizeOptions: readonly number[];
  rangeStart: number;
  rangeEnd: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPageSizeChange: (pageSize: number) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  enableKeyboardNavigation?: boolean;
}

export function PaginationControls({
  totalItems,
  currentPage,
  totalPages,
  pageSize,
  pageSizeOptions,
  rangeStart,
  rangeEnd,
  canGoPrevious,
  canGoNext,
  onPageSizeChange,
  onPreviousPage,
  onNextPage,
  enableKeyboardNavigation = true,
}: PaginationControlsProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);

  usePaginationHotkeys({
    containerRef,
    canGoPrevious,
    canGoNext,
    onPreviousPage,
    onNextPage,
    enabled: enableKeyboardNavigation && totalItems > 0 && totalPages > 1,
  });

  if (totalItems === 0) {
    return null;
  }

  const prevLabel = t('pagination.prev', 'Previous');
  const nextLabel = t('pagination.next', 'Next');

  return (
    <div ref={containerRef} className="pagination-container">
      <div className="pagination-info">
        {t('pagination.info', {
          start: rangeStart,
          end: rangeEnd,
          total: totalItems,
          defaultValue: 'Showing {{start}} - {{end}} of {{total}}',
        })}
      </div>
      <div className="pagination-controls">
        <SingleSelectFilterDropdown
          value={String(pageSize)}
          options={pageSizeOptions.map((count) => ({
            value: String(count),
            label: t('pagination.perPage', {
              count,
              defaultValue: '{{count}} / page',
            }),
          }))}
          ariaLabel={t('pagination.perPage', {
            count: pageSize,
            defaultValue: '{{count}} / page',
          })}
          icon={<Rows3 size={14} />}
          onChange={(value) => onPageSizeChange(Number.parseInt(value, 10))}
        />
        <div className="pagination-buttons">
          <button
            type="button"
            className="pagination-btn"
            onClick={onPreviousPage}
            disabled={!canGoPrevious}
            title={`${prevLabel} (PageUp)`}
            aria-label={`${prevLabel} (PageUp)`}
          >
            {prevLabel}
          </button>
          <span className="pagination-page">
            {t('pagination.page', {
              current: currentPage,
              total: totalPages,
              defaultValue: 'Page {{current}} / {{total}}',
            })}
          </span>
          <button
            type="button"
            className="pagination-btn"
            onClick={onNextPage}
            disabled={!canGoNext}
            title={`${nextLabel} (PageDown)`}
            aria-label={`${nextLabel} (PageDown)`}
          >
            {nextLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
