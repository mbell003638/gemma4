import type { SqlRunner } from '../../db/schema';
import { createScopedReportReader, type ReportReadGuard } from './scopedReportReader';
import { ToolUnavailableError, type CoreReadPorts } from './coreReadTools';

/** Real SQLite-backed report ports; other read ports are supplied separately. */
export function createAccountingReportPorts(db: SqlRunner, guard: ReportReadGuard):
  Pick<CoreReadPorts, 'profitAndLoss' | 'trialBalance' | 'balanceSheet'> {
  const read = createScopedReportReader(db, guard);
  return {
    profitAndLoss: async (range, locations, scope) => {
      const report = await read(scope, range, locations.kind === 'company' ? 'all' : locations.ids);
      if (report.provisionalShopCogs) throw new ToolUnavailableError('PROVISIONAL_LOCATION_COGS');
      if (!report.reconciliation.ok) throw new ToolUnavailableError('INCONSISTENT_REPORT_DATA');
      return report.profitAndLoss;
    },
    trialBalance: async (asOf, locations, scope) => {
      const report = await read(scope, { to: asOf }, locations.kind === 'company' ? 'all' : locations.ids);
      if (report.provisionalShopCogs) throw new ToolUnavailableError('PROVISIONAL_LOCATION_COGS');
      return report.trialBalance;
    },
    balanceSheet: async (asOf, locations, scope) => {
      const report = await read(scope, { to: asOf }, locations.kind === 'company' ? 'all' : locations.ids);
      if (report.provisionalShopCogs) throw new ToolUnavailableError('PROVISIONAL_LOCATION_COGS');
      return report.balanceSheet;
    },
  };
}
