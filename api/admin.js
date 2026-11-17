// 관리자 전용: 로그인 -> 문의 목록 보기 -> 상태 바꾸기
// 비밀번호와 열쇠는 이 파일에 없고, 버셀의 비밀 설정(환경 변수)에서만 읽어요.
const crypto = require('crypto');

const TOKEN_TTL_MS = 8 * 3600 * 1000;
const STATUSES = ['신규', '상담중', '완료'];

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeToken(secret) {
  const exp = String(Date.now() + TOKEN_TTL_MS);
  const sig = b64url(crypto.createHmac('sha256', secret).update(exp).digest());
  return exp + '.' + sig;
}

function checkToken(token, secret) {
  if (typeof token !== 'string' || token.indexOf('.') < 1) return false;
  const [exp, sig] = token.split('.');
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const good = b64url(crypto.createHmac('sha256', secret).update(exp).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(good);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sameText(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: '잘못된 요청입니다.' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_PASSWORD } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ADMIN_PASSWORD) {
    return res.status(500).json({ ok: false, error: '관리자 설정이 아직 끝나지 않았습니다.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const secret = SUPABASE_SERVICE_ROLE_KEY + '|admin';

  if (body.action === 'login') {
    if (typeof body.password === 'string' && body.password.length > 0 && sameText(body.password, ADMIN_PASSWORD)) {
      return res.status(200).json({ ok: true, token: makeToken(secret) });
    }
    await sleep(1500);
    return res.status(401).json({ ok: false, error: '비밀번호가 맞지 않습니다.' });
  }

  if (!checkToken(body.token, secret)) {
    return res.status(401).json({ ok: false, error: '다시 로그인해 주세요.' });
  }

  const sbHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
  if (!SUPABASE_SERVICE_ROLE_KEY.startsWith('sb_')) {
    sbHeaders.Authorization = 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY;
  }

  try {
    if (body.action === 'list') {
      const r = await fetch(
        SUPABASE_URL + '/rest/v1/inquiries?select=id,created_at,name,phone,message,status&order=id.desc&limit=200',
        { headers: sbHeaders }
      );
      if (!r.ok) throw new Error('list failed');
      return res.status(200).json({ ok: true, items: await r.json() });
    }

    if (body.action === 'status') {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id < 1 || STATUSES.indexOf(body.status) < 0) {
        return res.status(400).json({ ok: false, error: '잘못된 요청입니다.' });
      }
      const r = await fetch(SUPABASE_URL + '/rest/v1/inquiries?id=eq.' + id, {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: body.status }),
      });
      if (!r.ok) throw new Error('update failed');
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: '잘못된 요청입니다.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: '처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
};
