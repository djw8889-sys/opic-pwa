// 멀티플레이 방 상태 저장/동기화 API (Supabase PostgREST 프록시)
// 낙관적 잠금: version이 일치할 때만 갱신, 불일치 시 409로 클라이언트가 재동기화

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const base = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_ANON_KEY || '').trim();
  if (!base || !key) {
    return res.status(500).json({ error: '서버에 DB 설정(SUPABASE_URL, SUPABASE_ANON_KEY)이 없습니다.' });
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  };
  const table = `${base}/rest/v1/mystery_rooms`;
  const { action } = req.body || {};

  try {
    if (action === 'create') {
      const { state } = req.body;
      if (!state) return res.status(400).json({ error: 'state가 필요합니다.' });
      // 코드 충돌(이미 존재) 시 새 코드로 몇 번 재시도
      for (let i = 0; i < 5; i++) {
        const code = genCode();
        const r = await fetch(table, {
          method: 'POST',
          headers,
          body: JSON.stringify({ code, state, version: 1 })
        });
        if (r.status === 201) return res.status(200).json({ code, version: 1 });
        if (r.status !== 409) {
          return res.status(500).json({ error: `방 생성 실패 (${r.status})` });
        }
      }
      return res.status(500).json({ error: '방 코드를 만들지 못했어요. 다시 시도해주세요.' });
    }

    if (action === 'get') {
      const { code, sinceVersion } = req.body;
      if (!code) return res.status(400).json({ error: 'code가 필요합니다.' });
      const r = await fetch(
        `${table}?code=eq.${encodeURIComponent(String(code).toUpperCase())}&select=state,version`,
        { headers }
      );
      if (!r.ok) return res.status(500).json({ error: `방 조회 실패 (${r.status})` });
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(404).json({ error: '방을 찾을 수 없어요. 초대 코드를 확인해주세요.' });
      }
      const row = rows[0];
      if (typeof sinceVersion === 'number' && row.version <= sinceVersion) {
        return res.status(200).json({ unchanged: true, version: row.version });
      }
      return res.status(200).json({ state: row.state, version: row.version });
    }

    if (action === 'set') {
      const { code, state, version } = req.body;
      if (!code || !state || typeof version !== 'number') {
        return res.status(400).json({ error: 'code, state, version이 필요합니다.' });
      }
      const r = await fetch(
        `${table}?code=eq.${encodeURIComponent(String(code).toUpperCase())}&version=eq.${version}`,
        {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify({ state, version: version + 1, updated_at: new Date().toISOString() })
        }
      );
      if (!r.ok) return res.status(500).json({ error: `저장 실패 (${r.status})` });
      const rows = await r.json().catch(() => []);
      if (!Array.isArray(rows) || rows.length === 0) {
        // 다른 참가자가 먼저 갱신함 → 클라이언트가 최신 상태를 받아 재시도
        return res.status(409).json({ error: 'conflict' });
      }
      return res.status(200).json({ version: version + 1 });
    }

    return res.status(400).json({ error: '알 수 없는 action입니다.' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 헷갈리는 문자(I,L,O,0,1) 제외
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
