/* ═══════════════════════════════════════════════════════════════════
   psflowx market worker  —  시세 + 업계 뉴스
   ───────────────────────────────────────────────────────────────────
   parse-po 워커는 PO 파싱만 한다. 시세·뉴스는 전부 여기로 분리했다.
   여기가 죽어도 PO 는 멀쩡하고, PO 파서를 고쳐도 뉴스바는 안 흔들린다.

   GET /            → 전부 (cotton + indices + news)
   GET /news        → 같음 (앱이 쓰던 옛 경로)
   GET /quotes      → 시세만 (빠름)
   GET /health      → 뭐가 살아있고 뭐가 죽었는지

   응답:
   { cotton:  {ok, price, change, pct, unit, symbol, asOf, series:[[ms,price]…], src}
     indices: [{key,name,price,change,pct,asOf,src}…]        // DOW · S&P 500 · NASDAQ
     items:   [{title,url,source,at,breaking,tag}…]
     feeds:   [{topic,ok,n,reason}…]  builtAt }

   왜 소스가 두 개씩인가:
     · 6개월 그래프는 Yahoo 만 준다 (CNBC 는 히스토리를 안 열어줌)
     · 그런데 Yahoo 는 가끔 데이터센터 IP 를 막는다 → 값만이라도 CNBC 로 받는다
     · 뉴스는 Google News RSS 를 쓰다가 전부 503 으로 죽었다 (Cloudflare IP 차단).
       CNBC RSS 는 열려 있어서 그걸로 옮겼다. 피드 하나가 죽어도 나머지로 굴러간다.
   ═══════════════════════════════════════════════════════════════════ */

const CACHE_SEC = 900;              // 15분 — 뉴스바는 실시간일 필요가 없다
const UA = 'Mozilla/5.0 (compatible; psflowx/1.0)';

/* ── CNBC 뉴스 피드 (id 는 확인해서 넣은 것) ── */
const FEEDS = [
  { topic:'economy',  id:'20910258',  label:'CNBC Economy'  },
  { topic:'finance',  id:'10000664',  label:'CNBC Finance'  },
  { topic:'business', id:'10001147',  label:'CNBC Business' },
  { topic:'top',      id:'100003114', label:'CNBC'          },
];

/* ── 우리 장사에 걸리는 말들. 하나도 안 걸리면 그 기사는 버린다 ── */
const KEEP = [
  'cotton','textile[s]?','apparel','garment[s]?','yarn','fabric[s]?','clothing','retail(er[s]?)?',
  'tariff[s]?','trade','import[s]?','export[s]?','supply chain','freight','shipping','container[s]?','seaport[s]?','port of',
  'inflation','cpi','ppi','consumer price[s]?','producer price[s]?','jobs report','nonfarm','payroll[s]?','unemployment',
  'fed','federal reserve','interest rate[s]?','rate cut[s]?','rate hike[s]?','gdp','recession','consumer spending',
  'haiti','nicaragua','honduras','vietnam','bangladesh','china','chinese'
];
/* 단어 단위로 찾는다. 그냥 문자열 포함으로 하면 'port' 가 're-port' 에 걸려서
   AI·코인 기사가 줄줄이 들어온다 (실제로 그랬다). */
const KEEP_RE = new RegExp('\\b(?:' + KEEP.join('|') + ')\\b', 'i');

/* ── 🔴 이건 나오면 바로 알아야 하는 것들 (경제 지표 발표·정책) ── */
const BREAKING = [
  { re:/\b(cpi|consumer price index)\b/i,              tag:'CPI' },
  { re:/\b(ppi|producer price index)\b/i,              tag:'PPI' },
  { re:/\b(pce|inflation gauge)\b/i,                   tag:'INFLATION' },
  { re:/\b(jobs report|nonfarm|payrolls?|unemployment rate)\b/i, tag:'JOBS' },
  { re:/\bfed(eral reserve)?\b.*\b(rate|cut|hike|hold|decision|meeting)\b/i, tag:'FED' },
  { re:/\b(rate cut|rate hike|interest rate decision)\b/i, tag:'FED' },
  { re:/\btariffs?\b/i,                                 tag:'TARIFF' },
  { re:/\bgdp\b/i,                                      tag:'GDP' },
  { re:/\brecession\b/i,                                tag:'RECESSION' },
  { re:/\bcotton\b.*\b(price|surge|plunge|rally|fall|rise)\b/i, tag:'COTTON' },
];

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    const path = url.pathname.replace(/\/+$/, '') || '/';
    const fresh = url.searchParams.has('fresh');

    // Cloudflare 엣지 캐시 — 직원 여럿이 대시보드를 열어도 원본은 15분에 한 번만 때린다
    const cache = caches.default;
    const ck = new Request(url.origin + path, { method: 'GET' });
    if (!fresh) {
      const hit = await cache.match(ck);
      if (hit) return cors(new Response(hit.body, hit));
    }

    let body;
    try {
      if (path === '/quotes')      body = await buildQuotes();
      else if (path === '/health') body = await buildHealth();
      else                         body = await buildAll();
    } catch (e) {
      return cors(json({ error: String(e && e.message || e) }, 500));
    }

    const res = json(body, 200, CACHE_SEC);
    if (path !== '/health') { try { await cache.put(ck, res.clone()); } catch (e) {} }
    return cors(res);
  }
};

/* ═══════════ 조립 ═══════════ */
async function buildAll() {
  const [q, news] = await Promise.all([buildQuotes(), buildNews()]);
  return { ...q, ...news, builtAt: new Date().toISOString() };
}
async function buildQuotes() {
  const [cotton, indices] = await Promise.all([getCotton(), getIndices()]);
  return { cotton, indices };
}
async function buildHealth() {
  const all = await buildAll();
  return {
    cotton:  { ok: !!(all.cotton && all.cotton.ok), src: all.cotton && all.cotton.src, points: (all.cotton && all.cotton.series || []).length },
    indices: (all.indices || []).map(x => ({ key: x.key, ok: x.price != null, src: x.src })),
    feeds:   all.feeds,
    items:   (all.items || []).length,
    builtAt: new Date().toISOString()
  };
}

/* ═══════════ 🌱 면화 ═══════════
   Yahoo 를 먼저 — 6개월 시계열이 필요하다. 실패하면 값만이라도 CNBC 에서. */
async function getCotton() {
  try {
    const r = await get('https://query1.finance.yahoo.com/v8/finance/chart/CT=F?range=6mo&interval=1d');
    const j = await r.json();
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    const meta = res && res.meta;
    const ts = (res && res.timestamp) || [];
    const cl = (res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
    const series = [];
    for (let i = 0; i < ts.length; i++) if (cl[i] != null) series.push([ts[i] * 1000, round2(cl[i])]);
    const price = meta && (meta.regularMarketPrice != null ? meta.regularMarketPrice : null);
    /* 전일 대비여야 한다.
       range=6mo 로 부르면 meta.chartPreviousClose 는 "6개월 전 종가"라서
       그걸 쓰면 하루 변동이 아니라 반년 변동이 찍힌다 (+25.30 / +39.9% 같은 값).
       그래서 시계열의 바로 앞 종가를 전일 종가로 쓴다.
       마지막 점이 오늘 값과 사실상 같으면 그 앞 점이 어제 종가다. */
    let prev = null;
    if (series.length >= 2) {
      const lastC = series[series.length - 1][1];
      prev = (price != null && Math.abs(lastC - price) < 0.005)
             ? series[series.length - 2][1]      // 마지막 점 = 오늘 → 그 앞이 어제
             : lastC;                            // 마지막 점 = 어제 (오늘 아직 안 닫힘)
    }
    if (prev == null && meta) prev = (meta.previousClose != null ? meta.previousClose : meta.chartPreviousClose);
    if (price != null) {
      const change = prev != null ? round2(price - prev) : null;
      return { ok: true, price: round2(price), change,
               pct: (prev ? round2((price - prev) / prev * 100) : null),
               unit: 'USd/lb', symbol: 'CT=F',
               asOf: new Date((meta.regularMarketTime || Date.now() / 1000) * 1000).toISOString(),
               series, src: 'yahoo' };
    }
  } catch (e) {}
  // Yahoo 가 막혔을 때 — 그래프는 없지만 값은 나온다
  try {
    const q = (await cnbcQuotes(['@CT.1']))['@CT.1'];
    if (q) return { ok: true, price: q.price, change: q.change, pct: q.pct,
                    unit: 'USd/lb', symbol: '@CT.1', asOf: q.asOf, series: [], src: 'cnbc' };
  } catch (e) {}
  return { ok: false, series: [], src: null };
}

/* ═══════════ 📈 다우 · S&P · 나스닥 ═══════════ */
const IDX = [
  { key: 'DOW',    cnbc: '.DJI',  yahoo: '^DJI',  name: 'DOW' },
  { key: 'SP500',  cnbc: '.SPX',  yahoo: '^GSPC', name: 'S&P 500' },
  { key: 'NASDAQ', cnbc: '.IXIC', yahoo: '^IXIC', name: 'NASDAQ' },
];
async function getIndices() {
  let m = {};
  try { m = await cnbcQuotes(IDX.map(x => x.cnbc)); } catch (e) {}
  const out = IDX.map(x => {
    const q = m[x.cnbc];
    return q ? { key: x.key, name: x.name, price: q.price, change: q.change, pct: q.pct, asOf: q.asOf, src: 'cnbc' }
             : { key: x.key, name: x.name, price: null, change: null, pct: null, asOf: null, src: null };
  });
  // CNBC 가 하나라도 비면 Yahoo 로 메운다
  const miss = out.filter(x => x.price == null);
  if (miss.length) {
    await Promise.all(miss.map(async x => {
      const sym = (IDX.find(y => y.key === x.key) || {}).yahoo;
      try {
        const r = await get('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1d&interval=1d');
        const meta = (await r.json()).chart.result[0].meta;
        const p = meta.regularMarketPrice, prev = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
        if (p != null) {
          x.price = round2(p);
          x.change = prev != null ? round2(p - prev) : null;
          x.pct = prev ? round2((p - prev) / prev * 100) : null;
          x.asOf = new Date((meta.regularMarketTime || Date.now() / 1000) * 1000).toISOString();
          x.src = 'yahoo';
        }
      } catch (e) {}
    }));
  }
  return out;
}

/* CNBC 시세 — 숫자에 쉼표가 박혀 오고, 변동이 없으면 'UNCH' 라는 글자가 온다 */
async function cnbcQuotes(symbols) {
  const u = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol'
          + '?symbols=' + symbols.map(encodeURIComponent).join('%7C')
          + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1';
  const j = await (await get(u)).json();
  let arr = j && j.FormattedQuoteResult && j.FormattedQuoteResult.FormattedQuote;
  if (!arr) return {};
  if (!Array.isArray(arr)) arr = [arr];
  const out = {};
  arr.forEach(q => {
    out[q.symbol] = {
      price:  num(q.last),
      change: num(q.change),
      pct:    num(q.change_pct),
      asOf:   q.last_time ? new Date(q.last_time).toISOString() : null,
      name:   q.shortName || q.name || q.symbol
    };
  });
  return out;
}
function num(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').replace('%', '').trim();
  if (!s || /^unch$/i.test(s)) return 0;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

/* ═══════════ 📰 뉴스 ═══════════ */
async function buildNews() {
  const feeds = [];
  const got = await Promise.all(FEEDS.map(async f => {
    try {
      const r = await get('https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=' + f.id);
      if (!r.ok) { feeds.push({ topic: f.topic, ok: false, n: 0, reason: 'http ' + r.status }); return []; }
      const items = parseRss(await r.text(), f.label);
      feeds.push({ topic: f.topic, ok: true, n: items.length });
      return items;
    } catch (e) {
      feeds.push({ topic: f.topic, ok: false, n: 0, reason: String(e && e.message || e).slice(0, 60) });
      return [];
    }
  }));

  const seen = new Set();
  let items = [];
  got.flat().forEach(it => {
    const key = norm(it.title);
    if (!key || seen.has(key)) return;
    if (!KEEP_RE.test(it.title)) return;                   // 우리랑 상관없는 기사는 버린다
    seen.add(key);
    const b = BREAKING.find(x => x.re.test(it.title));
    items.push({ title: it.title, url: it.url, source: it.source, at: it.at,
                 breaking: !!b, tag: b ? b.tag : '' });
  });

  // 🔴 속보 먼저, 그 다음 최신순 — 오래된 속보가 계속 위에 있으면 안 되니 24시간까지만 속보 대접
  const DAY = 24 * 3600 * 1000, now = Date.now();
  items.forEach(it => { if (it.breaking && it.at && (now - Date.parse(it.at)) > DAY) it.breaking = false; });
  items.sort((a, b) => (b.breaking - a.breaking) || (Date.parse(b.at || 0) - Date.parse(a.at || 0)));
  items = items.slice(0, 25);

  return { items, feeds };
}

/* RSS 파서 — 워커엔 DOMParser 가 없어서 정규식으로. 태그가 조금 달라도 죽지 않게. */
function parseRss(xml, source) {
  const out = [];
  const blocks = String(xml).split(/<item[\s>]/i).slice(1);
  blocks.forEach(b => {
    const title = tag(b, 'title');
    const link  = tag(b, 'link') || tag(b, 'guid');
    if (!title || !link) return;
    out.push({ title: clean(title), url: clean(link), source,
               summary: clean(tag(b, 'description') || ''),
               at: toIso(tag(b, 'pubDate') || tag(b, 'dc:date') || '') });
  });
  return out;
}
function tag(s, name) {
  const m = s.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? m[1] : '';
}
function clean(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ').trim();
}
function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80); }
function toIso(s) { const t = Date.parse(s); return isFinite(t) ? new Date(t).toISOString() : null; }

/* ═══════════ 잡동사니 ═══════════ */
async function get(u) {
  return fetch(u, { headers: { 'User-Agent': UA, 'Accept': '*/*' }, cf: { cacheTtl: 300, cacheEverything: true } });
}
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function json(o, status, sec) {
  return new Response(JSON.stringify(o), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8',
               'Cache-Control': 'public, max-age=' + (sec || 60) }
  });
}
function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(res.body, { status: res.status, headers: h });
}
