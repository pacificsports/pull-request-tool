export default {
  async fetch(request, env) {
    if(new URL(request.url).pathname==='/debug'){ let a={}; try{ const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'content-type':'application/json','anthropic-version':'2023-06-01','x-api-key': env.ANTHROPIC_API_KEY},body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:16,messages:[{role:'user',content:'hi'}]})}); a={st:r.status, body:(await r.text()).slice(0,300)}; }catch(e){ a={err:String(e)}; } return new Response(JSON.stringify({colo:(request.cf||{}).colo, country:(request.cf||{}).country, anth:a}),{headers:{'content-type':'application/json','access-control-allow-origin':'*'}}); }


    if (request.method === 'OPTIONS') {
      return new Response('', {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    // ═══ 📸 사진 라벨 vision (Physical Check / Photo count) — 추가 경로. 기존 PO 파싱은 그대로 ═══
    //  v2 (2026-08-26): 박스 하나하나를 boxes[] 로 돌려준다 (LOT / CTN# 포함).
    //   · detected[] 는 boxes[] 에서 서버가 만들어 준다 → /pic 의 기존 Physical Check 와
    //     Photo count 는 detected 만 보고 돌아가므로 앱은 손댈 필요가 없다.
    //   · 타일(원본을 4등분해서 보내는 것)과 여러 각도 사진을 한 팔레트로 취급하라고 명시.
    //   · 공장 라벨(QR 없음, QTY 가 dozen, "ROOTBEER (US)" 표기)도 읽으라고 명시.
    if (new URL(request.url).pathname === '/vision') {
      try {
        const vb = await request.json();
        const images = vb.images || [];
        const labels = vb.labels || [];
        const expected = vb.expected || [];
        if (!images.length) return respond({ error: 'no images' }, 400);
        if (!env.ANTHROPIC_API_KEY) return respond({ error: 'ANTHROPIC_API_KEY not set' }, 500);

        const content = [];
        for (let gi = 0; gi < images.length; gi++) {
          const img = images[gi];
          const lb = labels[gi] || ('photo ' + (gi + 1));
          content.push({ type: 'text', text: 'Photo labeled "' + lb + '":' });
          const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(img);
          content.push({ type: 'image', source: { type: 'base64', media_type: m ? m[1] : 'image/jpeg', data: m ? m[2] : img } });
        }
        const labelList = labels.length ? labels.join(', ') : '';
        const expTxt = expected.length
          ? ('For reference, our system says this pallet SHOULD contain:\n'
             + expected.map(function (e) { return '- ' + e.style + ' ' + e.color + ' ' + e.size + ' x' + e.qty; }).join('\n')
             + '\n(Use this only as a spelling hint for colors/sizes; still report what you actually SEE.)\n')
          : '';

        content.push({ type: 'text', text:
          'The photos above show ONE warehouse pallet of apparel boxes'
          + (labelList ? (' (photo labels: ' + labelList + ')') : '') + '. '
          + 'Some images may be CROPS (tiles) of a larger photo of that same pallet, or the same face shot from a different angle. '
          + 'Treat them all as views of the ONE pallet, never as separate pallets.\n\n'

          + 'Two label formats are both in use in the field:\n'
          + '  A) Our label — ITEM / COLOR / SIZE / QTY on the left, a large STYLE number, a QR code, and on the right SS or TUB, US, a building number, LOT and CTN#.\n'
          + '  B) The Haiti factory label — ITEM / COLOR / SIZE / QTY in dozens (e.g. "6 DZS") / SKU# / LOT, then STYLE (e.g. "8368 S") and a date. No QR code.\n'
          + 'On format B the colour often carries a country suffix and inconsistent spacing, e.g. "ROOT BEER (US)" or "ROOTBEER (US)". '
          + 'Normalise it to the plain spaced colour name: "ROOT BEER".\n'
          + 'A carton number is sometimes handwritten in marker next to a printed "Carton No." line on the box. '
          + 'Use that only when the printed CTN# is unreadable, and set ctnHandwritten to true when you do.\n\n'

          + 'List EVERY physical box you can see, ONE entry per box.\n'
          + 'DEDUPLICATE. If the same physical box appears in more than one image — overlapping crops, or two angles of the same face — report it ONCE. '
          + 'When CTN# is readable it IS the box identity: two entries with the same CTN# are the same box. When it is not readable, use position in the stack.\n'
          + 'A box only PARTIALLY visible at the edge of a crop is almost always one you already counted in the neighbouring image — do not add it again.\n'
          + expTxt

          + '\nALSO judge each photo separately: is it clear enough to read the box labels? '
          + 'A photo is NOT ok if it is blurry, too dark, too far, or has no readable labels. '
          + 'Be strict about "too far": if you cannot read the SIZE line with confidence, that photo is not ok — '
          + 'a distant shot produces confident but WRONG colours, which is worse than no answer.\n\n'

          + 'Return ONLY a JSON object, no prose, no markdown fences:\n'
          + '{"boxes":[{"style":"8368","color":"ROOT BEER","size":"XL","qty":"72 PCS","lot":"05","ctn":"0-00051","ctnHandwritten":false,"sure":true}],'
          + '"photo_quality":[{"label":"front","ok":true},{"label":"left","ok":false,"reason":"too far to read sizes"}]}\n'
          + 'style, color and size in UPPERCASE. Put "" in any field you cannot read — NEVER guess a value. '
          + 'Set "sure" to false when you can see the box but are not confident of its size or colour. '
          + 'For a box whose label you can see but cannot read at all, use {"style":"","color":"","size":"","sure":false}. '
          + 'In photo_quality include one entry per photo using its given label.' });

        const vr = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16000, messages: [{ role: 'user', content: content }] })
        });
        const vd = await vr.json();
        if (!vr.ok) return respond({ error: (vd.error && vd.error.message) || 'vision api error', status: vr.status }, vr.status);
        var vtxt = '';
        if (vd.content) { for (var j = 0; j < vd.content.length; j++) { if (vd.content[j].type === 'text') { vtxt = vd.content[j].text; break; } } }
        var vclean = vtxt.replace(/```json/gi, '').replace(/```/g, '').trim();
        // 모델이 앞뒤에 설명을 붙여도 JSON 부분만 뽑아냄
        function _extractJson(s){ var a=s.indexOf('{'), b=s.lastIndexOf('}'); if(a>=0 && b>a) return s.slice(a,b+1); var c=s.indexOf('['), d=s.lastIndexOf(']'); if(c>=0 && d>c) return s.slice(c,d+1); return s; }
        var vparsed = null;
        try { vparsed = JSON.parse(vclean); }
        catch (e1) { try { vparsed = JSON.parse(_extractJson(vclean)); } catch (e2) { vparsed = null; } }
        if (vparsed === null) return respond({ error: 'could not parse model output', raw: vclean.slice(0, 400), stop: vd.stop_reason || '' });

        var quality = vparsed.photo_quality || [];
        var boxes = Array.isArray(vparsed.boxes) ? vparsed.boxes : null;

        if (boxes) {
          // boxes[] 가 정본. detected[] 는 여기서 만들어 붙인다 — 앱은 아무것도 안 고쳐도 된다.
          var UP = function (v) { return String(v == null ? '' : v).trim().toUpperCase(); };
          var agg = {}, order = [], unreadable = 0;
          for (var bi = 0; bi < boxes.length; bi++) {
            var bx = boxes[bi] || {};
            var st = UP(bx.style), co = UP(bx.color), sz = UP(bx.size);
            var cnt = (Number(bx.count) > 0) ? Number(bx.count) : 1;
            if (!st || !co || !sz || st === '?' || co === 'UNREADABLE' || sz === '?') { unreadable += cnt; continue; }
            var key = st + '|' + co + '|' + sz;
            if (!agg[key]) { agg[key] = { style: st, color: co, size: sz, count: 0 }; order.push(key); }
            agg[key].count += cnt;
          }
          var detected = order.map(function (k) { return agg[k]; });
          if (unreadable > 0) detected.push({ style: '?', color: 'UNREADABLE', size: '?', count: unreadable });
          return respond({ detected: detected, boxes: boxes, unreadable: unreadable, photo_quality: quality });
        }

        // 모델이 옛 형식(detected 만)으로 답한 경우 — 지금까지와 똑같이 동작
        if (!vparsed.detected) vparsed = { detected: Array.isArray(vparsed) ? vparsed : [], photo_quality: quality };
        return respond(vparsed);
      } catch (e) {
        return respond({ error: e.message }, 500);
      }
    }

    // ═══ 📰 뉴스 · 시세 → market 워커로 이사 (2026-08-27) ═══
    //   시세·뉴스는 전부 https://market.hjbae.workers.dev 로 옮겼다.
    //   이 워커는 이제 PO 파싱(+/vision)만 한다. 뉴스 코드가 여기 있으면
    //   피드 하나 고치려다 PO 파서를 깨뜨리게 되니까 아예 떼어냈다.
    //   지우지 않고 넘겨주는 이유: 옛날 psflowx 탭을 띄워둔 직원이 아직
    //   /news 를 부를 수 있다. 그쪽도 그대로 돌아가야 한다.
    //   리다이렉트가 아니라 그대로 받아서 넘겨준다 — 브라우저는 cors 모드에서
    //   리다이렉트 응답에도 CORS 검사를 걸기 때문에, 그냥 통과시키는 게 안전하다.
    if (new URL(request.url).pathname === '/news') {
      const q = new URL(request.url).search || '';
      try {
        const r = await fetch('https://market.hjbae.workers.dev/news' + q, { method: 'GET' });
        const b = await r.text();
        return new Response(b, {
          status: r.status,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=900',
            'X-Moved-To': 'market.hjbae.workers.dev',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
          }
        });
      } catch (e) {
        return respond({ error: 'news moved to market.hjbae.workers.dev', detail: String(e && e.message || e) }, 502);
      }
    }

    try {
      const body = await request.json();
      const pdf_base64 = body.pdf_base64;

      if (!pdf_base64) {
        return respond({ error: 'pdf_base64 required' }, 400);
      }

      const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
      if (!ANTHROPIC_API_KEY) {
        return respond({ error: 'ANTHROPIC_API_KEY not set' }, 500);
      }

      const prompt = `이 PO PDF에서 모든 주문 정보를 JSON으로 추출해주세요. 반드시 JSON만 출력하고 다른 텍스트는 절대 포함하지 마세요.

⚠️ 매우 중요 — 회사 식별:
- "Peace Textile America" 또는 "Pacific Sports"는 우리 회사 (판매자/Vendor/Seller) 입니다. 절대 이걸 customer로 잡으면 안됩니다.
- customer는 우리에게 PO를 발행한 회사 (구매자/Buyer)입니다. PO를 보낸 쪽, Bill To, Ship To, Delivery Location 등 어디에 있든 우리 회사가 아닌 쪽이 customer입니다.
- PO 구조 예시:
  · 보통: "Ship To: ABC Corp" + "Vendor: Peace Textile" → customer = ABC Corp
  · 반대: "Vendor: Peace Textile" + "Delivery Location: ABC Corp" → customer = ABC Corp
  · 헷갈리면: 로고나 제목에 큰 글씨로 나오는 회사 + 우리(Peace Textile) 아닌 쪽 = customer
- customer_address도 customer 회사의 주소입니다 (Peace Textile 주소가 아닙니다).

기타 중요 규칙:
1. 하나의 라인에 여러 사이즈가 있으면 (예: s-12, m-12, l-40) 사이즈별로 각각 별도 라인으로 분리하세요
2. style 번호는 반드시 추출하세요. 연속된 라인들이 같은 스타일 그룹이면 모두 같은 style/color를 사용하세요
3. 여러 라인이 같은 스타일에 속하면 (예: 첫 라인에 s/m/l/xl, 다음 라인에 2xl만 별도) 모두 같은 style/color 부여하세요
4. "2x", "xxl", "2xl" → "2XL", "3x", "xxxl" → "3XL" 로 표기하세요
5. 수량은 각 사이즈별로 분리 (예: s-12 → size:S, qty:12)
6. 모든 라인을 빠짐없이 포함하세요

{
  "customer_po": "PO번호",
  "po_date": "PO에 찍힌 발행 날짜/오더 날짜 (Date, PO Date, Order Date 등) — 반드시 YYYY-MM-DD 형식으로 변환, 없으면 빈 문자열",
  "customer_name": "거래처명 (우리 회사 Peace Textile 절대 안됨)",
  "customer_phone": "거래처 전화번호",
  "customer_email": "거래처 이메일 (PO 본문에 있는 contact email)",
  "customer_contact": "거래처 담당자 이름 (Buyer, Contact, PO Agent 등)",
  "ship_to": "배송지 주소 (줄바꿈은 \\n) — customer 측 주소",
  "bill_to": "청구지 주소 (줄바꿈은 \\n) — customer 측 주소",
  "terms": "결제조건 (예: Net 30)",
  "lines": [
    { "item_code": "아이템코드", "style": "스타일번호", "description": "아이템/Item 설명 원문 그대로 (예: 30/1 Juvy Tees, Combed Ringspun...)", "color": "색상", "size": "사이즈(단일)", "qty": 수량, "unit_price": 단가 }
  ]
}

예시1: "Style #1210 - black  s-12  m-12  l-40  xl-40 (rate:3.20)" 다음 라인 "2x-40 (rate:3.80)" 은 같은 스타일 그룹이므로:
{"style":"1210","color":"black","size":"S","qty":12,"unit_price":3.20}
{"style":"1210","color":"black","size":"M","qty":12,"unit_price":3.20}
{"style":"1210","color":"black","size":"L","qty":40,"unit_price":3.20}
{"style":"1210","color":"black","size":"XL","qty":40,"unit_price":3.20}
{"style":"1210","color":"black","size":"2XL","qty":40,"unit_price":3.80}

예시2: "1368 Peach S-15 M-52 L-45" 는:
{"style":"1368","color":"Peach","size":"S","qty":15,"unit_price":2.89}
{"style":"1368","color":"Peach","size":"M","qty":52,"unit_price":2.89}
{"style":"1368","color":"Peach","size":"L","qty":45,"unit_price":2.89}

예시3 — Vendor/Delivery 구조 PO (G&G Outfitters 예시):
"Vendor: Peace Textile America Inc"
"Delivery Location: G&G Outfitters, 4901 Forbes Blvd, Lanham MD 20706"
"Phone: 301-731-2099"
→ customer_name = "G&G Outfitters" (우리 Peace Textile 아님!)
→ customer_phone = "301-731-2099"
→ ship_to = "4901 Forbes Blvd\\nLanham MD 20706"`;

      const requestBody = JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 32000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: pdf_base64
                }
              },
              {
                type: 'text',
                text: prompt
              }
            ]
          }
        ]
      });

      // 529 Overloaded 시 최대 4회 재시도
      let resp;
      let data;

      for (let attempt = 1; attempt <= 4; attempt++) {
        if (attempt > 1) {
          const waitMs = 3000 * (attempt - 1);
          await new Promise(function(r) { return setTimeout(r, waitMs); });
        }

        resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: requestBody
        });

        data = await resp.json();

        if (resp.status !== 529 && data.type !== 'overloaded_error') {
          break;
        }

        console.warn('Attempt ' + attempt + ' overloaded, retrying...');
      }

      if (!resp.ok) {
        var errMsg = (data.error && data.error.message) ? data.error.message : (data.type || 'Claude API error');
        return respond({ error: errMsg, status: resp.status }, resp.status);
      }

      var text = '';
      if (data.content && data.content.length > 0) {
        for (var i = 0; i < data.content.length; i++) {
          if (data.content[i].type === 'text') {
            text = data.content[i].text;
            break;
          }
        }
      }

      var clean = text.replace(/```json/g, '').replace(/```/g, '').trim();

      try {
        var parsed = JSON.parse(clean);

        // 안전망: 만약 customer_name에 "Peace Textile"이나 "Pacific Sports"가 들어있으면 비움
        // (Worker가 잘못 잡았을 경우 대비)
        if (parsed.customer_name) {
          var custLower = parsed.customer_name.toLowerCase();
          if (custLower.indexOf('peace textile') !== -1 || custLower.indexOf('pacific sports') !== -1) {
            console.warn('customer_name was our company:', parsed.customer_name, '— clearing');
            parsed.customer_name = '';
          }
        }

        return respond({ ok: true, data: parsed });
      } catch (parseErr) {
        return respond({ error: 'Parse failed', raw: clean }, 500);
      }

    } catch (e) {
      return respond({ error: e.message }, 500);
    }
  }
};

function respond(body, status) {
  if (!status) status = 200;
  return new Response(JSON.stringify(body), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
