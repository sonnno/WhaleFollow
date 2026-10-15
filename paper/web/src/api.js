/* explicit-ui-i18n */
import { t, translateHumanMessage, getIntlLocale, useLanguage } from './i18n';
export function request(route, body, callback) {
  const xhr = new XMLHttpRequest();
  xhr.open(body === null ? 'GET' : 'POST', '/api' + route);
  xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
  if (body !== null) xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.timeout = 20000;
  xhr.onload = function () {
    let value;
    try { value = JSON.parse(xhr.responseText); } catch (_) { return callback(new Error(t("服务器响应格式错误"))); }
    if (xhr.status >= 400) return callback(Object.assign(new Error(value.error || t("请求失败")), { status: xhr.status }));
    callback(null, value);
  };
  xhr.onerror = function () { callback(new Error(t("无法连接后台"))); };
  xhr.ontimeout = function () { callback(new Error(t("请求超时"))); };
  xhr.send(body === null ? null : JSON.stringify(body));
  return function () { xhr.abort(); };
}
