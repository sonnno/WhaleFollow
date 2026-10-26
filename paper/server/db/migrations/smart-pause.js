class SmartPause1793000000000 {
  name='SmartPause1793000000000';
  up(runner){return runner.query('ALTER TABLE paper_follow_tasks ADD COLUMN IF NOT EXISTS "smartPause" jsonb DEFAULT NULL');}
  down(){throw new Error('Smart pause keeps event eligibility across restarts; do not drop it automatically');}
}
module.exports=SmartPause1793000000000;
