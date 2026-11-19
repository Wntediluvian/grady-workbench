// 页面里的日期一律按北京时间算和显示。工作台的前端到处用本地时间的取值方法（getHours 等），
// 电脑时区不是北京时间时，发布时间、“今天/昨天”都会错位。电脑本来就是北京时间时这段不生效。
(() => {
  const OFF = 480, N = Date;
  if (new N().getTimezoneOffset() === -OFF) return;
  const sh = (d) => new N(d.getTime() + OFF * 60000);
  const back = (d, x) => d.setTime(x.getTime() - OFF * 60000);
  class BJDate extends N {
    constructor(...a) {
      if (a.length === 1 && typeof a[0] === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(a[0])) super(a[0].replace(' ', 'T') + '+08:00');
      else if (a.length > 1) super(N.UTC(...a) - OFF * 60000);
      else super(...a);
    }
    getFullYear() { return sh(this).getUTCFullYear(); }
    getMonth() { return sh(this).getUTCMonth(); }
    getDate() { return sh(this).getUTCDate(); }
    getDay() { return sh(this).getUTCDay(); }
    getHours() { return sh(this).getUTCHours(); }
    getMinutes() { return sh(this).getUTCMinutes(); }
    getSeconds() { return sh(this).getUTCSeconds(); }
    setHours(h, m, s, ms) { const x = sh(this); x.setUTCHours(h, m ?? x.getUTCMinutes(), s ?? x.getUTCSeconds(), ms ?? x.getUTCMilliseconds()); return back(this, x); }
    setMinutes(m, s, ms) { const x = sh(this); x.setUTCMinutes(m, s ?? x.getUTCSeconds(), ms ?? x.getUTCMilliseconds()); return back(this, x); }
    setDate(d) { const x = sh(this); x.setUTCDate(d); return back(this, x); }
    setMonth(m, d) { const x = sh(this); x.setUTCMonth(m, d ?? x.getUTCDate()); return back(this, x); }
    setFullYear(y, m, d) { const x = sh(this); x.setUTCFullYear(y, m ?? x.getUTCMonth(), d ?? x.getUTCDate()); return back(this, x); }
    toLocaleDateString(l, o) { return super.toLocaleDateString(l, { timeZone: 'Asia/Shanghai', ...o }); }
    toLocaleTimeString(l, o) { return super.toLocaleTimeString(l, { timeZone: 'Asia/Shanghai', ...o }); }
    toLocaleString(l, o) { return super.toLocaleString(l, { timeZone: 'Asia/Shanghai', ...o }); }
  }
  window.Date = BJDate;
})();
