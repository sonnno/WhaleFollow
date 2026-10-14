const async = require('async');
const defaultHttp = require('../lib/http-client');
const docs = 'https://docs.polymarket.com/api-reference/';
const routes = {
  traders: { v2: ['/v2/leaderboard', 'boards/get-the-trader-leaderboard'], v1: ['/v1/leaderboard', 'core/get-trader-leaderboard-rankings'] },
  wins: { v2: ['/v2/biggest-winners', 'boards/list-the-biggest-wins'] },
  builders: { v2: ['/v2/builders/leaderboard', 'boards/get-the-builders-leaderboard'], v1: ['/v1/builders/leaderboard', 'builders/get-aggregated-builder-leaderboard'] },
  'builder-volume': { v2: ['/v2/builders/volume', 'boards/get-builder-volume-over-time'], v1: ['/v1/builders/volume', 'builders/get-daily-builder-volume-time-series'] }
};
const categories = [['overall', '综合'], ['politics', '政治'], ['sports', '体育'], ['esports', '电竞'], ['crypto', '加密'], ['culture', '文化'], ['mentions', '提及'], ['weather', '天气'], ['economics', '经济'], ['tech', '技术'], ['finance', '金融'], ['combos', '组合']];
const periods = ['day', 'week', 'month', 'all'];
const walletPattern = /^0x[a-fA-F0-9]{40}$/;
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function failure(message, statusCode) { return Object.assign(new Error(message), { statusCode }); }
function integer(value, fallback, min, max, label) {
  if (value === undefined || value === '') return fallback;
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw failure(label + '必须在' + min + '至' + max + '之间', 400);
  return Number(value);
}
function text(value, fallback, label, max) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw failure('无效的' + label, 400);
  return value.trim();
}
function filters(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('无效的查询参数', 400);
  const allowed = ['type', 'version', 'timePeriod', 'category', 'orderBy', 'limit', 'offset', 'cursor', 'user', 'userName', 'bucketLimit', 'force'];
  Object.keys(input).forEach(function (key) { if (!allowed.includes(key)) throw failure('不支持的查询参数: ' + key, 400); });
  const type = text(input.type, 'traders', '榜单类型', 30);
  const version = text(input.version, 'v2', '接口版本', 5);
  if (!Object.hasOwn(routes, type) || !Object.hasOwn(routes[type], version)) throw failure('不支持的榜单类型或接口版本', 400);
  const timePeriod = text(input.timePeriod, 'month', '时间范围', 10);
  const category = text(input.category, 'overall', '分类', 100);
  const orderBy = text(input.orderBy, 'PNL', '排序', 10);
  if (!periods.includes(timePeriod)) throw failure('不支持的时间范围', 400);
  if (!['PNL', 'VOLUME'].includes(orderBy)) throw failure('不支持的排序', 400);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category)) throw failure('分类应为合法的小写分类标识', 400);
  if (version === 'v1' && !categories.slice(0, -1).some(function (row) { return row[0] === category; })) throw failure('旧版接口不支持此分类', 400);
  const user = text(input.user, '', '钱包地址', 42);
  const userName = text(input.userName, '', '用户名', 200);
  text(input.cursor, '', '分页游标', 8192);
  const cursor = input.cursor || '';
  if (user && (!walletPattern.test(user) || type !== 'traders')) throw failure('个人名次查询需要有效的交易员钱包地址', 400);
  if (userName && (version !== 'v1' || type !== 'traders')) throw failure('用户名查询仅支持旧版交易员榜', 400);
  if (cursor && (version !== 'v2' || type === 'builder-volume')) throw failure('此接口不支持游标分页', 400);
  if (!user && version === 'v2' && type === 'traders' && category === 'combos' && orderBy === 'VOLUME') throw failure('组合分类不支持成交量榜', 400);
  const limit = integer(input.limit, 20, 1, version === 'v1' && type !== 'builder-volume' ? 50 : 1000, '每页条数');
  const offset = integer(input.offset, 0, 0, version === 'v1' && type !== 'builder-volume' ? 1000 : Number.MAX_SAFE_INTEGER, '分页起点');
  if (version === 'v2' && type !== 'builder-volume' && offset !== 0) throw failure('新版榜单使用游标分页，不支持offset', 400);
  const bucketLimit = integer(input.bucketLimit, 30, 1, 90, '时间桶数量');
  if (input.force !== undefined && ![true, false, 'true', 'false', '1', '0', ''].includes(input.force)) throw failure('无效的刷新标识', 400);
  return { type, version, timePeriod, category, orderBy, user: user.toLowerCase(), userName, cursor, limit, offset, bucketLimit, force: [true, 'true', '1'].includes(input.force) };
}
function requestParams(query) {
  if (query.version === 'v1') {
    const params = { timePeriod: query.timePeriod.toUpperCase() };
    if (query.type !== 'builder-volume') Object.assign(params, { limit: query.limit, offset: query.offset });
    if (query.type === 'traders') {
      Object.assign(params, { category: query.category.toUpperCase(), orderBy: query.orderBy === 'VOLUME' ? 'VOL' : 'PNL' });
      if (query.user) params.user = query.user;
      if (query.userName) params.userName = query.userName;
    }
    return params;
  }
  if (query.type === 'builder-volume') return { interval: query.timePeriod, limit: query.bucketLimit };
  if (query.user) return { user: query.user, time_period: query.timePeriod, category: query.category };
  // The official opaque cursor already pins window/category/sort and page size.
  if (query.cursor) return { cursor: query.cursor };
  const params = { time_period: query.timePeriod };
  if (['traders', 'wins'].includes(query.type)) params.category = query.category;
  if (query.type === 'traders') params.sort_by = query.orderBy;
  params.limit = query.limit;
  return params;
}
function number(value) { return value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null; }
function normalized(row, query) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw failure('榜单返回了无效的行', 502);
  const builder = ['builders', 'builder-volume'].includes(query.type);
  const candidate = builder ? null : row.user_id || row.proxyWallet || null;
  const wallet = typeof candidate === 'string' ? candidate.toLowerCase() : null;
  const canFollow = !builder && !!wallet && walletPattern.test(wallet);
  const result = {
    wallet,
    name: builder ? row.builder_name || row.builder || row.builder_code || row.builderCode || '' : row.user_name || row.userName || wallet || '',
    rank: number(query.type === 'wins' ? row.win_rank : row.rank),
    pnl: number(row.pnl), volume: number(row.volume === undefined ? row.vol : row.volume),
    canFollow, profileUrl: canFollow ? 'https://polymarket.com/profile/' + wallet : null
  };
  if (builder) Object.assign(result, { builderCode: row.builder_code || row.builderCode || '', activeUsers: number(row.active_users === undefined ? row.activeUsers : row.active_users), date: row.date || row.dt || null });
  if (query.type === 'wins') Object.assign(result, {
    eventTitle: row.event_title || '', eventSlug: row.event_slug || '', initialValue: number(row.initial_value), finalValue: number(row.final_value),
    resolvedAt: row.resolved_at === undefined ? null : row.resolved_at, kind: row.kind || '',
    officialUrl: row.kind !== 'combo' && typeof row.event_slug === 'string' && row.event_slug ? 'https://polymarket.com/event/' + encodeURIComponent(row.event_slug) : null
  });
  if (query.user && query.version === 'v2') {
    result.pnlRank = number(row.pnl_rank === undefined ? row.rank_pnl : row.pnl_rank);
    result.volumeRank = number(row.volume_rank === undefined ? row.rank_volume : row.volume_rank);
    result.rank = query.orderBy === 'VOLUME' ? result.volumeRank : result.pnlRank;
  }
  return result;
}
function response(body, query) {
  const standing = query.version === 'v2' && !!query.user;
  let rows;
  if (standing) {
    const row = body && (body.data || body);
    if (!row || typeof row !== 'object' || Array.isArray(row) || !(row.user_id || row.proxyWallet)) throw failure('个人名次响应无效', 502);
    rows = [row];
  } else rows = query.version === 'v1' ? body : body && body.data;
  if (!Array.isArray(rows)) throw failure('榜单响应无效', 502);
  const pagination = body && body.pagination;
  const local = query.type === 'builder-volume';
  if (query.version === 'v2' && !local && !standing && (!pagination || typeof pagination !== 'object')) throw failure('榜单分页响应无效', 502);
  return { data: rows.map(function (row) { return normalized(row, query); }), pagination: pagination ? copy(pagination) : null };
}
function result(value, query, fetchedAt) {
  const route = routes[query.type][query.version];
  const local = query.type === 'builder-volume';
  const standing = query.version === 'v2' && !!query.user;
  const pagination = value.pagination || {};
  const nextCursor = !standing && !local && query.version === 'v2' && typeof pagination.next_cursor === 'string' && pagination.next_cursor ? pagination.next_cursor : null;
  const output = {
    type: query.type, version: query.version, timePeriod: query.timePeriod, category: query.category, orderBy: query.orderBy,
    endpoint: route[0], sourceUrl: docs + route[1], data: local ? value.data.slice(query.offset, query.offset + query.limit) : value.data,
    limit: query.version === 'v2' && !standing && !local && number(pagination.limit) > 0 ? number(pagination.limit) : query.limit,
    offset: query.version === 'v2' && !standing && !local && number(pagination.offset) !== null ? number(pagination.offset) : query.offset,
    nextCursor,
    hasMore: standing ? false : local ? query.offset + query.limit < value.data.length : query.version === 'v2' ? !!nextCursor && pagination.has_more !== false : value.data.length === query.limit && query.offset + query.limit <= 1000,
    paginationKind: standing ? 'standing' : local ? 'local' : query.version === 'v2' ? 'cursor' : 'offset',
    volumeUnit: query.version === 'v2' ? 'shares' : 'official-v1',
    pnlBasis: query.type === 'wins' ? 'position-final-minus-initial' : query.type !== 'traders' ? 'not-applicable' : query.version === 'v1' ? 'official-v1' : query.timePeriod === 'all' ? 'realized-lifetime' : 'marked-equity-change',
    fetchedAt
  };
  if (local) { output.total = value.data.length; if (query.version === 'v2') output.bucketLimit = query.bucketLimit; }
  const independent = copy(output);
  if (standing) independent.data[0].rank = query.orderBy === 'VOLUME' ? independent.data[0].volumeRank : independent.data[0].pnlRank;
  return independent;
}
function create(options) {
  options = options || {};
  const http = options.http || defaultHttp;
  const base = options.config && options.config.dataUrl || require('../../config').paper.dataUrl;
  const now = options.now || Date.now;
  const cache = new Map(), pending = new Map();
  function catalog() {
    return {
      types: [['traders', '交易员榜'], ['wins', '单笔大额盈利榜'], ['builders', '建设者榜'], ['builder-volume', '建设者成交趋势']].map(function ([id, label]) { return { id, label, versions: Object.keys(routes[id]) }; }),
      categories: categories.map(function ([id, label]) { return { id, label }; }),
      periods: periods.map(function (id, index) { return { id, label: ['日', '周', '月', '全部'][index] }; }),
      orders: [{ id: 'PNL', label: '收益' }, { id: 'VOLUME', label: '成交量' }]
    };
  }
  function query(input, callback) {
    let selection, params, key;
    try { selection = filters(input === undefined ? {} : input); params = requestParams(selection); key = routes[selection.type][selection.version][0] + ':' + JSON.stringify(params); } catch (err) { return callback(err); }
    if (selection.force) cache.delete(key);
    const cached = cache.get(key);
    if (cached && now() - cached.at < 30000) return callback(null, result(cached.value, selection, cached.fetchedAt));
    cache.delete(key);
    const waiter = { selection, callback };
    if (pending.has(key)) { pending.get(key).push(waiter); return; }
    pending.set(key, [waiter]);
    async.waterfall([
      function (next) { http.request(base, routes[selection.type][selection.version][0], params, next); },
      function (body, next) {
        let value;
        try { value = response(body, selection); } catch (err) { return next(err); }
        next(null, value);
      }
    ], function (err, value) {
      const fetchedAt = new Date(now()).toISOString();
      if (!err) {
        cache.set(key, { value: copy(value), at: now(), fetchedAt });
        while (cache.size > 100) cache.delete(cache.keys().next().value);
      }
      const waiters = pending.get(key); pending.delete(key);
      waiters.forEach(function (item) { item.callback(err, err ? undefined : result(value, item.selection, fetchedAt)); });
    });
  }
  return { catalog, query };
}
module.exports = { create };
