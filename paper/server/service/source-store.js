function read(tx, group, callback) {
  tx.query(`/* source-context */ SELECT
    (SELECT to_jsonb(j) FROM paper_outbox j WHERE id=$3) AS job,
    (SELECT to_jsonb(s) FROM paper_settings s WHERE id='quarantine:'||$1) AS quarantine,
    (SELECT to_jsonb(s)||jsonb_build_object('budget',s.budget::text,'timestamp',s.timestamp::text) FROM paper_source_trades s WHERE id=$1) AS source,
    (SELECT jsonb_build_object('id',l.id,'active',l.active,'joinedAt',l."joinedAt",'inventory',jsonb_build_object($4::text,COALESCE(l.inventory->$4,'"0"'::jsonb)),'inventoryValid',l."inventoryValid",'raw',l.raw) FROM paper_leaders l WHERE id=$2) AS leader,
    (SELECT to_jsonb(s) FROM paper_settings s WHERE id='runtime') AS runtime`,
  [group.id, group.wallet, group.reconciliationJobId || null, group.token], function (err, rows) { callback(err, rows && rows[0]); });
}
function save(tx, source, leader, callback, inventoryChanged) {
  tx.query(`/* source-save */ WITH input AS (SELECT $1::jsonb AS v),
    source_change AS (
      INSERT INTO paper_source_trades(id,wallet,token,condition,side,timestamp,quantities,processed,budget,raw,"updatedAt")
      SELECT s->>'id',s->>'wallet',s->>'token',s->>'condition',s->>'side',(s->>'timestamp')::bigint,
        s->'quantities',s->'processed',(s->>'budget')::numeric,s->'raw',clock_timestamp()
      FROM input,LATERAL (SELECT v->'source' AS s) value WHERE s<>'null'::jsonb
      ON CONFLICT(id) DO UPDATE SET quantities=EXCLUDED.quantities,processed=EXCLUDED.processed,budget=EXCLUDED.budget,raw=EXCLUDED.raw,"updatedAt"=EXCLUDED."updatedAt" RETURNING id
    ), leader_change AS (
      UPDATE paper_leaders l SET inventory=CASE WHEN (v->>'inventoryChanged')::boolean THEN l.inventory||(v->'leader'->'inventory') ELSE l.inventory END,"inventoryValid"=(v->'leader'->>'inventoryValid')::boolean,
        raw=v->'leader'->'raw',"updatedAt"=clock_timestamp() FROM input WHERE l.id=v->'leader'->>'id' RETURNING l.id
    ) SELECT (SELECT count(*)::int FROM source_change) AS sources,(SELECT count(*)::int FROM leader_change) AS leaders`,
  [JSON.stringify({ source: source || null, leader: leader || null, inventoryChanged: inventoryChanged === true })], function (err, rows) {
    if (err) return callback(err);
    if (!rows[0] || rows[0].sources !== (source ? 1 : 0) || rows[0].leaders !== (leader ? 1 : 0)) return callback(new Error('Source persistence failed'));
    callback();
  });
}
module.exports = { read, save };
