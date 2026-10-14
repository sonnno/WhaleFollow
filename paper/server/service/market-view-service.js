const categories = [
  ['soccer', '足球'], ['american-football', '美式足球'], ['nfl', '美式足球'], ['tennis', '网球'], ['basketball', '篮球'], ['nba', '篮球'],
  ['baseball', '棒球'], ['hockey', '冰球'], ['cricket', '板球'], ['golf', '高尔夫'], ['formula-1', '赛车'], ['esports', '电竞'],
  ['weather', '天气'], ['climate', '气候'], ['crypto', '加密货币'], ['cryptocurrency', '加密货币'], ['elections', '选举'],
  ['politics', '政治'], ['geopolitics', '国际时事'], ['world', '国际时事'], ['economics', '经济'], ['finance', '金融'],
  ['business', '商业'], ['tech', '科技'], ['science', '科学'], ['culture', '文化娱乐'], ['sports', '体育']
];
const types = { moneyline: '胜负', child_moneyline: '胜负', spreads: '让分', spread: '让分', totals: '大小球 / 大小分', total: '大小球 / 大小分',
  both_teams_to_score: '双方是否进球', both_teams_to_score_first_half: '上半场双方是否进球', both_teams_to_score_second_half: '下半场双方是否进球',
  soccer_exact_score: '准确比分', correct_score: '准确比分', soccer_halftime_result: '半场胜负', soccer_second_half_result: '下半场胜负',
  double_chance: '双重机会', soccer_team_to_advance: '是否晋级', total_goals: '总进球数', total_corners: '角球数',
  first_half_moneyline: '上半场胜负', second_half_moneyline: '下半场胜负', first_half_totals: '上半场大小球 / 分', second_half_totals: '下半场大小球 / 分',
  team_totals: '球队总得分', tennis_exact_score: '网球准确比分', tennis_set_winner: '网球单盘胜负', tennis_first_set_winner: '网球首盘胜负', tennis_match_totals: '网球总局数' };
function describe(gamma) {
  const raw = gamma || {};
  const tags = Array.isArray(raw.tags) ? raw.tags : [];
  const slugs = new Set(tags.map(function (tag) { return String(tag.slug || tag.label || '').toLowerCase(); }));
  const known = categories.find(function (item) { return slugs.has(item[0]); });
  const category = known ? known[1] : raw.category || (tags.find(function (tag) { return tag.label && tag.slug !== 'games'; }) || {}).label || '分类待更新';
  const marketType = raw.sportsMarketType ? types[raw.sportsMarketType] || '其他体育玩法' : null;
  const event = raw.eventSlug || raw.slug;
  const officialUrl = event ? 'https://polymarket.com/event/' + encodeURIComponent(event) + (raw.eventSlug && raw.slug && raw.slug !== raw.eventSlug ? '/' + encodeURIComponent(raw.slug) : '') : null;
  return { category, marketType, officialUrl, tags: tags.map(function (tag) { const translated = categories.find(function (item) { return item[0] === tag.slug; }); return translated ? translated[1] : tag.label; }).filter(Boolean) };
}
// Uses the same priority and tag fallback as describe; expressions are application-owned SQL only.
function categorySql(gamma){
 const tags=`CASE WHEN jsonb_typeof(${gamma}->'tags')='array' THEN ${gamma}->'tags' ELSE '[]'::jsonb END`;
 const values=categories.map(function([slug,label],index){return "('"+slug+"','"+label+"',"+index+')';}).join(',');
 return `COALESCE((SELECT v.label FROM (VALUES ${values}) v(slug,label,priority) WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(${tags}) t WHERE lower(COALESCE(NULLIF(t->>'slug',''),t->>'label',''))=v.slug) ORDER BY v.priority LIMIT 1),NULLIF(${gamma}->>'category',''),(SELECT t->>'label' FROM jsonb_array_elements(${tags}) t WHERE COALESCE(t->>'slug','')<>'games' AND COALESCE(t->>'label','')<>'' LIMIT 1),'分类待更新')`;
}
module.exports = { describe,categorySql };
