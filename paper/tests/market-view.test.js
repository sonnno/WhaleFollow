const test = require('node:test');
const assert = require('node:assert/strict');
const { describe } = require('../server/service/market-view-service');
test('official soccer tags and market slugs produce a readable type and exact market page', function () {
  const view = describe({ slug: 'team-a-win', eventSlug: 'team-a-vs-b', sportsMarketType: 'moneyline', tags: [{ slug: 'sports', label: 'Sports' }, { slug: 'soccer', label: 'Soccer' }] });
  assert.equal(view.category, '足球'); assert.equal(view.marketType, '胜负');
  assert.equal(view.officialUrl, 'https://polymarket.com/event/team-a-vs-b/team-a-win');
});
test('missing tags stay unclassified and missing slug does not invent a link', function () {
  assert.deepEqual(describe({}), { category: '分类待更新', marketType: null, officialUrl: null, tags: [] });
});
