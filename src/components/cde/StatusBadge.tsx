import { STATUS_LABEL, type FileStatus } from '../../lib/cde';

/** Small coloured chip for the ISO 19650 lifecycle status of a document. */
export function StatusBadge({ status }: { status: FileStatus }) {
  return <span className={`cde-status cde-status-${status}`}>{STATUS_LABEL[status]}</span>;
}
