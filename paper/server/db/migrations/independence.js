const names = ['leaders', 'source_trades', 'positions', 'settlements', 'cash_ledger', 'markets', 'equity_snapshots', 'sync_checkpoints', 'outbox', 'settings', 'leaderboard_snapshots', 'closed_cycles', 'daily_reports'];
class PaperIsolation1792000000000 {
  name = 'PaperIsolation1792000000000';
  up(runner) {
    const statements = names.map(function (name) { return `DO $$ BEGIN
      IF to_regclass('public.${name}') IS NOT NULL AND to_regclass('public.paper_${name}') IS NOT NULL THEN RAISE EXCEPTION 'Both old and paper-owned tables exist: ${name}'; END IF;
      IF to_regclass('public.${name}') IS NOT NULL THEN ALTER TABLE "${name}" RENAME TO "paper_${name}"; END IF;
    END $$`; });
    statements.push(`CREATE TABLE IF NOT EXISTS paper_system_identity (id text PRIMARY KEY CHECK(id='paper')); INSERT INTO paper_system_identity(id) VALUES('paper') ON CONFLICT DO NOTHING`);
    return runner.query(statements.join(';'));
  }
  down() { throw new Error('表名回退需要停机与人工迁移，不能自动回退'); }
}
module.exports = PaperIsolation1792000000000;
