// Vercel Serverless Function: 가게들의 현재 영업 상태를 Gemini(구글 검색 연동)로 확인한다.
// 요청: POST /api/place_status  { dong: "연동", places: [{ name, address }, ...] }  (최대 8곳)
// 응답: { checkedAt, places: [{ name, status, hours, note }] }
// API 키는 Vercel 환경변수 GEMINI_API_KEY 에서만 읽는다. 모델은 GEMINI_MODEL (선택).
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const STATUSES = ['영업중', '영업종료', '휴무', '폐업', '확인불가'];

const clip = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);

// 모델이 코드 블록이나 설명을 붙여도 첫 번째 JSON 배열만 꺼낸다.
function parseArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch (e) {
    return null;
  }
}

module.exports = async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'GEMINI_API_KEY 환경변수가 설정되지 않았어요.' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST 로 요청하세요.' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const dong = clip(body.dong, 20);
  const places = (Array.isArray(body.places) ? body.places : []).slice(0, 8)
    .map(p => ({ name: clip(p && p.name, 60), address: clip(p && p.address, 120) }))
    .filter(p => p.name);
  if (!dong || places.length === 0) {
    return res.status(400).json({ error: 'dong 과 places 가 필요해요.' });
  }

  // 한국 시간 기준 "지금"을 알려 줘야 영업 중인지 판단할 수 있다.
  const now = new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', dateStyle: 'full', timeStyle: 'short'
  });

  const prompt =
    '지금은 한국 시간 ' + now + '이다. 구글 검색으로 아래 제주 가게들이 "지금 영업 중인지"를 확인해 줘.\n\n' +
    places.map((p, i) => (i + 1) + '. ' + p.name + ' (' + dong + ', ' + (p.address || '주소 없음') + ')').join('\n') + '\n\n' +
    '규칙:\n' +
    '- 검색에서 근거를 찾은 것만 판단하고, 근거가 없으면 status 를 "확인불가"로 한다. 추측하거나 지어내지 않는다.\n' +
    '- status 는 "영업중", "영업종료"(오늘 영업 시간이 끝났거나 아직 열기 전), "휴무"(오늘 정기 휴무), "폐업"(폐업·이전 확인), "확인불가" 중 하나다.\n' +
    '- hours 는 오늘의 영업 시간(예: "10:00~21:00"). 모르면 빈 문자열.\n' +
    '- note 는 한 줄(40자 이내) 참고 사항(예: "브레이크타임 15:00~17:00"). 없으면 빈 문자열.\n' +
    '- 입력 순서와 name 을 그대로 지켜서, 아래 모양의 JSON 배열 하나만 출력하고 다른 글은 쓰지 않는다.\n' +
    '[{"name":"가게 이름","status":"영업중","hours":"10:00~21:00","note":""}]';

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent';
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }]
      })
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(502).json({ error: 'Gemini 호출 실패 (' + upstream.status + ') ' + text.slice(0, 200) });
    }
    const data = await upstream.json();
    const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    const text = (parts || []).filter(p => p.text).map(p => p.text).join('\n');
    const arr = parseArray(text);
    if (!arr) {
      return res.status(502).json({ error: 'Gemini 답을 읽지 못했어요. 잠시 뒤 다시 시도해 주세요.' });
    }

    // 요청한 가게 순서대로 이름을 맞춰서, 빠진 곳은 "확인불가"로 채운다.
    const result = places.map(p => {
      const found = arr.find(a => a && clip(a.name, 60) === p.name) || {};
      return {
        name: p.name,
        status: STATUSES.includes(found.status) ? found.status : '확인불가',
        hours: clip(found.hours, 40),
        note: clip(found.note, 60)
      };
    });
    return res.status(200).json({ checkedAt: now, places: result });
  } catch (err) {
    return res.status(502).json({ error: 'Gemini 서버에 연결하지 못했어요.' });
  }
};
