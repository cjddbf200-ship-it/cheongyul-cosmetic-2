// 문의 접수: 검사 -> 슈파베이스에 저장 -> 리센드로 알림 메일
// 비밀 열쇠는 이 파일에 없고, 버셀의 비밀 설정(환경 변수)에서만 읽어요.
const MAX_NAME = 30;
const MAX_PHONE = 20;
const MAX_MESSAGE = 1000;
const DAILY_LIMIT = 50;

function clean(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim();
}

// 수식으로 읽히는 글자(=, +, -, @ 로 시작)는 앞에 ' 를 붙여 글자로만 저장
function safe(v) {
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: '잘못된 요청입니다.' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, NOTIFY_EMAIL, MAIL_FROM } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: '접수 설정이 아직 끝나지 않았습니다.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  // 자동 등록(스팸) 차단: 숨은 칸이 채워져 있으면 조용히 성공으로 응답하고 저장하지 않음
  if (clean(body.website) !== '') return res.status(200).json({ ok: true });

  const name = clean(body.name);
  const phone = clean(body.phone);
  const message = clean(body.message);
  if (!name) return res.status(400).json({ ok: false, error: '이름을 입력해 주세요.' });
  if (!phone) return res.status(400).json({ ok: false, error: '연락처를 입력해 주세요.' });
  if (!message) return res.status(400).json({ ok: false, error: '문의 내용을 입력해 주세요.' });
  if (name.length > MAX_NAME) return res.status(400).json({ ok: false, error: '이름은 ' + MAX_NAME + '자까지 입력할 수 있습니다.' });
  if (phone.length > MAX_PHONE) return res.status(400).json({ ok: false, error: '연락처는 ' + MAX_PHONE + '자까지 입력할 수 있습니다.' });
  if (message.length > MAX_MESSAGE) return res.status(400).json({ ok: false, error: '문의 내용은 ' + MAX_MESSAGE + '자까지 입력할 수 있습니다.' });

  // 새 방식 열쇠(sb_secret_...)는 apikey 칸에만 넣고, 예전 방식(JWT)은 Authorization 에도 넣음
  const sbHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
  if (!SUPABASE_SERVICE_ROLE_KEY.startsWith('sb_')) {
    sbHeaders.Authorization = 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY;
  }

  try {
    // 하루 접수 한도 (한국 시간 기준 오늘 0시부터)
    const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
    const kstMidnightUtc = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()) - 9 * 3600 * 1000).toISOString();
    const countRes = await fetch(
      SUPABASE_URL + '/rest/v1/inquiries?select=id&created_at=gte.' + encodeURIComponent(kstMidnightUtc),
      { headers: { ...sbHeaders, Prefer: 'count=exact', Range: '0-0' } }
    );
    const range = countRes.headers.get('content-range') || '';
    const total = Number(range.split('/')[1] || 0);
    if (total >= DAILY_LIMIT) {
      return res.status(429).json({ ok: false, error: '오늘 접수 가능한 건수를 넘었습니다. 내일 다시 시도해 주세요.' });
    }

    const insertRes = await fetch(SUPABASE_URL + '/rest/v1/inquiries', {
      method: 'POST',
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ name: safe(name), phone: safe(phone), message: safe(message), status: '신규' }),
    });
    if (!insertRes.ok) {
      const detail = (await insertRes.text()).slice(0, 200);
      return res.status(500).json({ ok: false, error: '저장 오류 ' + insertRes.status + ' ' + detail });
    }

    if (RESEND_API_KEY && NOTIFY_EMAIL) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: MAIL_FROM || 'onboarding@resend.dev',
            to: [NOTIFY_EMAIL],
            subject: '[홈페이지 문의] ' + name + ' 님의 상담 신청',
            html:
              '<p>이름: ' + escapeHtml(name) + '</p><p>연락처: ' + escapeHtml(phone) +
              '</p><p>문의 내용:</p><p>' + escapeHtml(message).replace(/\n/g, '<br>') + '</p>',
          }),
        });
      } catch (e) {
        // 메일이 실패해도 문의는 이미 저장됨
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: '접수 중 문제가 발생했습니다: ' + String(e && e.message).slice(0, 150) });
  }
};
// 문의 접수: 검사 -> 슈파베이스에 저장 -> 리센드로 알림 메일
// 비밀 열쇠는 이 파일에 없고, 버셀의 비밀 설정(환경 변수)에서만 읽어요.
const MAX_NAME = 30;
const MAX_PHONE = 20;
const MAX_MESSAGE = 1000;
const DAILY_LIMIT = 50;

function clean(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim();
}

// 수식으로 읽히는 글자(=, +, -, @ 로 시작)는 앞에 ' 를 붙여 글자로만 저장
function safe(v) {
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: '잘못된 요청입니다.' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, NOTIFY_EMAIL, MAIL_FROM } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: '접수 설정이 아직 끝나지 않았습니다.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  // 자동 등록(스팸) 차단: 숨은 칸이 채워져 있으면 조용히 성공으로 응답하고 저장하지 않음
  if (clean(body.website) !== '') return res.status(200).json({ ok: true });

  const name = clean(body.name);
  const phone = clean(body.phone);
  const message = clean(body.message);
  if (!name) return res.status(400).json({ ok: false, error: '이름을 입력해 주세요.' });
  if (!phone) return res.status(400).json({ ok: false, error: '연락처를 입력해 주세요.' });
  if (!message) return res.status(400).json({ ok: false, error: '문의 내용을 입력해 주세요.' });
  if (name.length > MAX_NAME) return res.status(400).json({ ok: false, error: '이름은 ' + MAX_NAME + '자까지 입력할 수 있습니다.' });
  if (phone.length > MAX_PHONE) return res.status(400).json({ ok: false, error: '연락처는 ' + MAX_PHONE + '자까지 입력할 수 있습니다.' });
  if (message.length > MAX_MESSAGE) return res.status(400).json({ ok: false, error: '문의 내용은 ' + MAX_MESSAGE + '자까지 입력할 수 있습니다.' });

  // 새 방식 열쇠(sb_secret_...)는 apikey 칸에만 넣고, 예전 방식(JWT)은 Authorization 에도 넣음
  const sbHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
  if (!SUPABASE_SERVICE_ROLE_KEY.startsWith('sb_')) {
    sbHeaders.Authorization = 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY;
  }

  try {
    // 하루 접수 한도 (한국 시간 기준 오늘 0시부터)
    const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
    const kstMidnightUtc = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()) - 9 * 3600 * 1000).toISOString();
    const countRes = await fetch(
      SUPABASE_URL + '/rest/v1/inquiries?select=id&created_at=gte.' + encodeURIComponent(kstMidnightUtc),
      { headers: { ...sbHeaders, Prefer: 'count=exact', Range: '0-0' } }
    );
    const range = countRes.headers.get('content-range') || '';
    const total = Number(range.split('/')[1] || 0);
    if (total >= DAILY_LIMIT) {
      return res.status(429).json({ ok: false, error: '오늘 접수 가능한 건수를 넘었습니다. 내일 다시 시도해 주세요.' });
    }

    const insertRes = await fetch(SUPABASE_URL + '/rest/v1/inquiries', {
      method: 'POST',
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ name: safe(name), phone: safe(phone), message: safe(message), status: '신규' }),
    });
    if (!insertRes.ok) throw new Error('save failed');

    if (RESEND_API_KEY && NOTIFY_EMAIL) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: MAIL_FROM || 'onboarding@resend.dev',
            to: [NOTIFY_EMAIL],
            subject: '[홈페이지 문의] ' + name + ' 님의 상담 신청',
            html:
              '<p>이름: ' + escapeHtml(name) + '</p><p>연락처: ' + escapeHtml(phone) +
              '</p><p>문의 내용:</p><p>' + escapeHtml(message).replace(/\n/g, '<br>') + '</p>',
          }),
        });
      } catch (e) {
        // 메일이 실패해도 문의는 이미 저장됨
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: '접수 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
};
