/**
 * Gera workflows/GestRisk-WAHA-Gemini-Supabase.json
 * Topologia do fluxo anexado + prompt/consentimento/timeout/memória.
 */
const fs = require('fs');
const path = require('path');

const prepararWaha = String.raw`const root = items[0].json;
const body = root.body ?? root;
const event = body.event ?? root.event;
const payload = body.payload ?? root.payload ?? {};

if (event !== 'message') {
  return [];
}
if (payload.fromMe === true) {
  return [];
}

const message = String(payload.body ?? '').trim();
if (!message) {
  return [];
}

function waMsgId(p) {
  const id = p && p.id;
  if (id == null || id === '') return '';
  if (typeof id === 'string') return id;
  if (typeof id === 'object' && id._serialized) return String(id._serialized);
  return String(id);
}

const mid = waMsgId(payload);
if (mid) {
  const sd = $getWorkflowStaticData('global');
  sd._gestriskSeenIds = sd._gestriskSeenIds || {};
  const seen = sd._gestriskSeenIds;
  const now = Date.now();
  if (seen[mid] && now - seen[mid] < 120000) {
    return [];
  }
  seen[mid] = now;
  const keys = Object.keys(seen);
  while (keys.length > 300) {
    delete seen[keys.shift()];
  }
}

const session = body.session || root.session || 'default';
const helpers = this.helpers;

function jidLocalPart(jid) {
  const s = String(jid || '');
  const i = s.indexOf('@');
  return i === -1 ? s : s.slice(0, i);
}

function hasLid(j) {
  return j && String(j).includes('@lid');
}

function isPhoneJid(j) {
  if (!j || hasLid(j)) return false;
  const s = String(j);
  return s.includes('@c.us') || s.includes('@s.whatsapp.net');
}

function allJidCandidates(p) {
  const key = (p._data && p._data.key) || {};
  return [key.remoteJidAlt, key.remoteJid, key.participant, p.from, p.chatId]
    .map((x) => (x == null ? '' : String(x).trim()))
    .filter(Boolean);
}

function pickContactPhoneJid(p) {
  const cands = allJidCandidates(p);
  for (const j of cands) {
    if (isPhoneJid(j)) return j;
  }
  for (const j of cands) {
    if (!hasLid(j)) return j;
  }
  return cands[0] || '';
}

function toTelefoneDigits(jidOrDigits) {
  return jidLocalPart(jidOrDigits).replace(/\D/g, '');
}

function toChatIdForWaha(jid) {
  if (!jid) return '';
  const s = String(jid);
  if (s.includes('@s.whatsapp.net')) {
    return jidLocalPart(s) + '@c.us';
  }
  if (!s.includes('@')) {
    return jidLocalPart(s) + '@c.us';
  }
  return s;
}

async function wahaGet(pathAndQuery) {
  const url = 'http://waha:3000' + pathAndQuery;
  return helpers.httpRequest({ method: 'GET', url, json: true });
}

async function resolveLidToPn(lidJid) {
  const lid = jidLocalPart(lidJid);
  if (!lid) return null;
  try {
    const data = await wahaGet(
      '/api/' + encodeURIComponent(session) + '/lids/' + encodeURIComponent(lid),
    );
    const pn = data && data.pn ? String(data.pn) : '';
    return pn || null;
  } catch (e) {
    return null;
  }
}

async function resolveContact(contactId) {
  if (!contactId) return null;
  try {
    const data = await wahaGet(
      '/api/contacts?contactId=' +
        encodeURIComponent(contactId) +
        '&session=' +
        encodeURIComponent(session),
    );
    if (!data) return null;
    return Array.isArray(data) ? data[0] : data;
  } catch (e) {
    return null;
  }
}

function pareceNumeroBrValido(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (!d) return false;
  if (d.startsWith('55') && d.length >= 12 && d.length <= 13) return true;
  if (d.length === 10 || d.length === 11) return true;
  return false;
}

function normalizeTelefoneBrParaApi(digits) {
  let d = String(digits || '').replace(/\D/g, '');
  if (!d) return '';

  if (!d.startsWith('55') && d.length === 11) {
    const d1 = d.charCodeAt(0) - 48;
    const d2 = d.charCodeAt(1) - 48;
    const ddd = d1 * 10 + d2;
    if (ddd >= 11 && ddd <= 99) {
      d = '55' + d;
    }
  }

  if (d.startsWith('55') && d.length === 12 && d.charAt(4) !== '9') {
    d = d.slice(0, 4) + '9' + d.slice(4);
  }

  return d;
}

return (async () => {
  const key = payload._data && payload._data.key;
  const cands = allJidCandidates(payload);
  let phoneJid = pickContactPhoneJid(payload);
  let fromRaw = String(payload.from || '').trim();
  let chatId = toChatIdForWaha(phoneJid || fromRaw);
  let telefone = toTelefoneDigits(phoneJid || fromRaw);

  const lidJids = [...new Set(cands.filter(hasLid))];
  const precisaResolver =
    lidJids.length > 0 ||
    hasLid(fromRaw) ||
    hasLid(phoneJid) ||
    (key && hasLid(key.participant)) ||
    (key && hasLid(key.remoteJid)) ||
    !pareceNumeroBrValido(telefone);

  if (precisaResolver) {
    let pnJid = null;
    const tentarLids = [
      ...lidJids,
      fromRaw,
      phoneJid,
      key && key.participant,
      key && key.remoteJid,
      key && key.remoteJidAlt,
    ];
    for (const j of tentarLids) {
      if (j && hasLid(j)) {
        pnJid = await resolveLidToPn(j);
        if (pnJid) break;
      }
    }

    if (pnJid) {
      phoneJid = pnJid;
      chatId = toChatIdForWaha(pnJid);
      telefone = toTelefoneDigits(pnJid);
    } else {
      let c = null;
      for (const id of [...new Set(cands)]) {
        c = await resolveContact(id);
        if (c && (c.number || c.id)) break;
      }

      if (c) {
        if (c.number) {
          telefone = String(c.number).replace(/\D/g, '');
        } else if (c.id) {
          telefone = toTelefoneDigits(c.id);
        }
        if (c.id) {
          chatId = toChatIdForWaha(c.id);
          phoneJid = c.id;
        }
      }
    }
  }

  telefone = normalizeTelefoneBrParaApi(telefone);

  const PHONE_TO_GESTANTE = {};
  const gestante_id = PHONE_TO_GESTANTE[telefone] ? String(PHONE_TO_GESTANTE[telefone]) : '';

  return [
    {
      json: {
        message,
        chatId,
        telefone,
        session,
        gestante_id,
        telefone_resolvido: pareceNumeroBrValido(telefone),
      },
    },
  ];
})();`;

const mesclarLaravel = String.raw`const prep = $('Preparar_WAHA').first().json;
const laravelItem = $('Laravel_log_entrada').first().json;

function parseBody(raw) {
  if (raw == null) return null;
  let b = raw.body !== undefined ? raw.body : raw;
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch (e) {
      return null;
    }
  }
  return b && typeof b === 'object' ? b : null;
}

const status = laravelItem.statusCode ?? laravelItem.status;
const body = parseBody(laravelItem);
const ok = status === 201 || status === '201';

let gestante_id = '';
if (ok && body && body.gestante_id != null && body.gestante_id !== '') {
  gestante_id = String(body.gestante_id);
}

if (!gestante_id && prep.gestante_id) {
  gestante_id = String(prep.gestante_id);
}

const fallback = $env.GESTRISK_DEFAULT_GESTANTE_ID || '';
if (!gestante_id && fallback) {
  gestante_id = String(fallback);
}

const respostaPronta = ok && body ? String(body.resposta_pronta || '').trim() : '';
const fluxo_respondido = respostaPronta.length > 0;
const pular_ia = fluxo_respondido || (ok && body && body.pular_ia === true);

return [
  {
    json: {
      ...prep,
      gestante_id,
      laravel_gestante_id: ok && body ? body.gestante_id : null,
      fluxo_respondido,
      pular_ia,
      resposta_pronta: respostaPronta || null,
      intencao_laravel: ok && body ? body.intencao || null : null,
      fluxo_estado: ok && body ? body.fluxo_estado || null : null,
    },
  },
];`;

const supabaseGet = String.raw`const prep = $('Mesclar_Laravel_gestante').first().json;
let base = String($env.SUPABASE_URL ?? '');
if (base.endsWith('/')) base = base.slice(0, -1);
const select =
  'chat_id,gestante_id,historico,status,consentimento,consentimento_em,fechado_em,ultima_interacao_em,timeout_minutos,memoria';
const url =
  base +
  '/rest/v1/gestrisk_sessoes?chat_id=eq.' +
  encodeURIComponent(prep.chatId) +
  '&select=' +
  select;
const key = $env.SUPABASE_SERVICE_ROLE_KEY;
const helpers = this.helpers;

return (async () => {
  let rows = [];
  try {
    const data = await helpers.httpRequest({
      method: 'GET',
      url,
      headers: {
        apikey: key,
        Authorization: 'Bearer ' + key,
        Accept: 'application/json',
      },
      json: true,
    });
    rows = Array.isArray(data) ? data : [];
  } catch (e) {
    rows = [];
  }

  const row = rows[0] || null;
  let status = row && row.status ? String(row.status) : 'open';
  let consentimento = row && row.consentimento ? String(row.consentimento) : 'pending';
  const timeoutMin = Number(row && row.timeout_minutos != null ? row.timeout_minutos : 1440) || 1440;
  const ultima = row && row.ultima_interacao_em ? new Date(row.ultima_interacao_em) : null;
  const memoria =
    row && row.memoria && typeof row.memoria === 'object' && !Array.isArray(row.memoria)
      ? row.memoria
      : {};

  let motivo_encerramento = null;
  let mensagem_encerramento = null;
  let timedOut = false;

  if (status === 'open' && ultima && !Number.isNaN(ultima.getTime())) {
    const limiteMs = timeoutMin * 60 * 1000;
    if (Date.now() - ultima.getTime() > limiteMs) {
      timedOut = true;
      status = 'open';
    }
  }

  // Ticket já fechado: a nova mensagem retoma o atendimento (exceto consentimento recusado).
  if (status === 'closed_user' || status === 'closed_timeout') {
    status = 'open';
  }

  if (!motivo_encerramento && consentimento === 'declined') {
    motivo_encerramento = 'consentimento_declined';
    mensagem_encerramento =
      'Tudo bem. Sem o seu consentimento não seguimos com o atendimento por aqui. Cuide-se e conte com a equipe de saúde do seu acompanhamento presencial.';
  }

  const continuar_gemini = !motivo_encerramento && !prep.fluxo_respondido && !prep.pular_ia;

  return [
    {
      json: {
        rows,
        row,
        status,
        consentimento,
        timedOut,
        timeout_minutos: timeoutMin,
        memoria,
        continuar_gemini,
        motivo_encerramento,
        mensagem_encerramento,
      },
    },
  ];
})();`;

const montarPrompt = String.raw`const prep = $('Mesclar_Laravel_gestante').first().json;
const sess = $('Supabase_GET_sessao').first().json;
const msg = String(prep.message || '').trim();
if (!msg) {
  return [];
}

let historicoCarregado = [];
let rowList = Array.isArray(sess.rows) ? sess.rows : [];
if (Array.isArray(rowList) && rowList[0] && Array.isArray(rowList[0].historico)) {
  historicoCarregado = rowList[0].historico;
}

let gestante_id = String(prep.gestante_id || '');
if (!gestante_id && Array.isArray(rowList) && rowList[0] && rowList[0].gestante_id) {
  gestante_id = String(rowList[0].gestante_id);
}

const memoria =
  sess.memoria && typeof sess.memoria === 'object' ? sess.memoria : {};
const consentimento = String(sess.consentimento || 'pending');
const semana =
  memoria.semana_gestacional != null ? String(memoria.semana_gestacional) : '';

// RAG Laravel (PatientSnapshot + prontuário + historico_conversa)
let ragTexto = '';
let ragFound = false;
let ragIntencao = '';
let ragSnapshot = null;
let ragHistorico = [];
let ragGestacaoAtiva = true;
let ragForaEscopo = false;
try {
  const ragItem = $('Laravel_RAG').first().json;
  let rb = ragItem && (ragItem.body !== undefined ? ragItem.body : ragItem);
  if (typeof rb === 'string') {
    try { rb = JSON.parse(rb); } catch (e) { rb = null; }
  }
  if (rb && typeof rb === 'object') {
    ragFound = !!rb.found;
    ragIntencao = String(rb.intencao || '');
    ragTexto = String(rb.contexto_texto || '');
    ragSnapshot = rb.patient_snapshot && typeof rb.patient_snapshot === 'object' ? rb.patient_snapshot : null;
    ragHistorico = Array.isArray(rb.historico_conversa) ? rb.historico_conversa : [];
    ragGestacaoAtiva = rb.gestacao_ativa !== false;
    ragForaEscopo = !!rb.fora_escopo || ragIntencao === 'fora_escopo';
    if (!gestante_id && rb.gestante_id != null) {
      gestante_id = String(rb.gestante_id);
    }
  }
} catch (e) {
  ragTexto = '';
}

const detalheExames = ragIntencao === 'exames_consultas';
const regrasRag = [
  'ESCOPO: Cardioprenatal é para gestantes em acompanhamento (rastreio de cardiopatias congênitas). Quem já está cadastrada neste chat deve ser acolhida como gestante do serviço.',
  'Há contexto clínico (PatientSnapshot / RAG; found=' + String(ragFound) + ', intencao=' + (ragIntencao || 'conversa_livre') + ', gestacao_ativa=' + String(ragGestacaoAtiva) + ', fora_escopo=' + String(ragForaEscopo) + ').',
  'gestacao_ativa=false só significa que falta IG/consulta no prontuário — NÃO use isso para encerrar nem dizer que ela não está grávida.',
  'Use só o que estiver nos trechos; se não houver dado, diga com carinho que não há registro e ofereça a equipe. Não invente exames, datas, locais, passeios.',
  'Nunca interprete exames, faça diagnóstico ou indique medicamento.',
  ragForaEscopo
    ? 'FORA DE ESCOPO (ela DECLAROU que não está mais grávida): acolha com empatia, diga que o canal é para gestantes em acompanhamento, oriente UBS/equipe e encerrar_ticket=true.'
    : '',
  detalheExames
    ? 'Pedido de exames/consultas: priorize trechos do prontuário.'
    : 'Em conversa livre/sintoma: use o snapshot e o histórico; fale de perto, como quem acompanha o pré-natal.',
].filter(Boolean).join('\n');

function normTxt(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function turnText(turn) {
  const parts = turn && Array.isArray(turn.parts) ? turn.parts : [];
  return parts.map((p) => (p && p.text != null ? String(p.text) : '')).join(' ');
}

const priorSupabase = Array.isArray(historicoCarregado) ? historicoCarregado.slice(-24) : [];
const seen = new Set(priorSupabase.map((t) => normTxt(turnText(t))).filter(Boolean));

// Funde mensagens Laravel (esp. equipe na ficha) que ainda não estão no historico Supabase.
const fusedExtra = [];
for (const h of ragHistorico) {
  const text = String(h && h.text != null ? h.text : '').trim();
  if (!text) continue;
  const key = normTxt(text);
  if (key && seen.has(key)) continue;
  if (key) seen.add(key);
  const roleLaravel = String(h.role || 'assistant');
  if (roleLaravel === 'user') {
    fusedExtra.push({ role: 'user', parts: [{ text }] });
  } else if (roleLaravel === 'staff') {
    fusedExtra.push({
      role: 'model',
      parts: [{ text: '[Mensagem da equipe] ' + text }],
    });
  } else {
    fusedExtra.push({ role: 'model', parts: [{ text }] });
  }
}

const prior = priorSupabase.concat(fusedExtra).slice(-24);
const contents = prior.concat([{ role: 'user', parts: [{ text: msg }] }]);

const snapshotLine = ragSnapshot
  ? 'PatientSnapshot (JSON Laravel): ' + JSON.stringify(ragSnapshot)
  : 'PatientSnapshot: não disponível nesta mensagem.';

const primeiroNomeSnap =
  ragSnapshot && ragSnapshot.primeiro_nome != null && String(ragSnapshot.primeiro_nome).trim() !== ''
    ? String(ragSnapshot.primeiro_nome).trim()
    : (memoria && memoria.nome ? String(memoria.nome).split(/\s+/)[0] : '');

const systemText = [
  'Você é a assistente do Cardioprenatal: companheira de cuidado para gestantes no rastreio de cardiopatias congênitas.',
  'Canal EXCLUSIVO para gestantes em acompanhamento — mas quem já está cadastrada aqui é tratada como gestante do serviço, mesmo se faltar IG no prontuário.',
  '',
  'TOM ÍNTIMO (obrigatório):',
  '- Fale como uma profissional que conhece a gestante: calorosa, próxima, humana — nunca robótica nem “script de call center”.',
  primeiroNomeSnap
    ? '- Use o primeiro nome (“' + primeiroNomeSnap + '”) de forma natural (não em toda frase).'
    : '- Se souber o nome na memória/snapshot, use-o com carinho; se não souber, pergunte uma vez.',
  '- Mostre que está ouvindo: retome o que ela acabou de dizer em 1 pedaço curto (“entendi que a dor começou ontem…”).',
  '- Em saudação ou “como você está?”, responda com afeto e já puxe o fio do pré-natal (“estou aqui com você — como está se sentindo hoje na gestação?”).',
  '- Em sintoma: acolha de verdade antes de perguntar; 1 pergunta por vez, tom de quem acompanha, não de formulário.',
  '- Varie o jeito de falar; evite respostas idênticas e frases prontas repetidas.',
  '- Português do Brasil, linguagem simples. 2 a 4 frases. Sem inventar histórias, passeios ou detalhes que ela não escreveu.',
  '',
  'Use o histórico, a memória e o PatientSnapshot. NÃO repita perguntas já respondidas (nome, sintomas, consentimento).',
  'Turns [Mensagem da equipe] vieram da ficha — respeite.',
  '',
  'ANTI-VÍCIOS DE IA:',
  '- NÃO peça consentimento de novo se já for accepted.',
  '- NÃO repita “não substitui consulta” em toda mensagem (no máx. 1x se ainda não apareceu no histórico).',
  '- NÃO invente contexto (balão, viagem, esporte, comida) se ela não falou.',
  '- NÃO diga que a gestação “não está ativa” só porque falta idade gestacional no sistema — isso NÃO encerra o atendimento.',
  '- Papo casual leve: responda com carinho em 1–2 frases e gentilmente volte ao cuidado (“pode me contar se está se sentindo bem na gestação?”).',
  '- Só fora de escopo / encerrar se ela DECLARAR que não está (mais) grávida OU pedir para parar: acolha, oriente equipe/UBS, encerrar_ticket=true.',
  '- Dúvida genérica (“posso engravidar?”) de quem já está no cadastro: acolha e explique o papel do canal no pré-natal; não encerre.',
  '',
  'Memória atual (JSON): ' + JSON.stringify(memoria),
  snapshotLine,
  'Consentimento LGPD atual: ' + consentimento,
  semana ? 'Semana gestacional conhecida: ' + semana + '. Adapte o tom à fase da gravidez.' : 'Semana gestacional ainda desconhecida — pode perguntar com carinho se fizer sentido.',
  '',
  'Contexto clínico Laravel (sempre disponível quando found=true):',
  ragTexto || 'Sem trechos RAG / PatientSnapshot textuais nesta mensagem.',
  regrasRag,
  '',
  'Regras de segurança:',
  '- Nunca prescreva medicamentos, doses ou condutas invasivas.',
  '- NÃO use palavras alarmistas: emergência, emergencial, urgente, urgência, imediato, correr.',
  '- Se gravidade=high, oriente com calma a procurar a unidade / equipe de referência, sem alarmismo.',
  '',
  'Consentimento (SOMENTE se consentimento=pending):',
  '- Em 1 frase peça SIM ou NÃO para guardar dados do atendimento.',
  '- Se a mensagem atual já for sim/não, preencha consentimento_resposta e siga SEM repetir o pedido.',
  '- Se consentimento=accepted ou declined, NÃO mencione consentimento.',
  '',
  'Encerrar ticket: finalizar/encerrar/parar OU fora de escopo (não gestante) → encerrar_ticket=true e despedida curta.',
  '',
  'Extraia dados clínicos só se estiverem na mensagem ou no contexto (memoria_patch + consulta).',
  'O IMC NÃO deve aparecer no JSON.',
  '',
  'Classificação interna (não verbalizar alarmismo):',
  '- pressao_sistolica >= 160 → gravidade high',
  '- glicemia >= 180 → gravidade high',
  '- doppler_umbilical == 2 → gravidade high',
  '- visão escurecendo / desmaio / sangramento intenso → gravidade high',
  '',
  'IMPORTANTE: responda APENAS com JSON válido, sem markdown e sem texto fora do JSON.',
  '',
  'Formato:',
  '{',
  '  "resposta_paciente": "string",',
  '  "intencao": "sintoma|medida|duvida|saudacao|consentimento|encerrar|fora_escopo|outro",',
  '  "gravidade": "low|mid|high",',
  '  "consentimento_resposta": "sim|nao|null",',
  '  "encerrar_ticket": false,',
  '  "memoria_patch": {',
  '    "nome": null,',
  '    "semana_gestacional": null,',
  '    "sintomas": [],',
  '    "preferencias": {},',
  '    "exames": {},',
  '    "clinico": {',
  '      "pressao_sistolica": null,',
  '      "glicemia": null,',
  '      "frequencia_cardiaca": null,',
  '      "febre": null,',
  '      "doppler_umbilical": null,',
  '      "percentil_peso": null,',
  '      "volume_liquido": null,',
  '      "peso_gestante": null,',
  '      "altura_gestante": null',
  '    }',
  '  },',
  '  "consulta": {',
  '    "idade": null,',
  '    "pressao_sistolica": null,',
  '    "glicemia": null,',
  '    "frequencia_cardiaca": null,',
  '    "doppler_umbilical": null,',
  '    "percentil_peso": null,',
  '    "volume_liquido": null,',
  '    "peso_gestante": null,',
  '    "altura_gestante": null',
  '  }',
  '}',
].join('\n');

const geminiBody = {
  systemInstruction: { parts: [{ text: systemText }] },
  contents,
  generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
};

return [
  {
    json: {
      ...prep,
      gestante_id,
      consentimento,
      memoria,
      status: sess.status || 'open',
      timeout_minutos: sess.timeout_minutos || 1440,
      rag_found: ragFound,
      geminiBody,
      _historicoAntes: prior,
    },
  },
];`;

const geminiComFallback = String.raw`const mp = $('Montar_prompt').first().json;
const geminiBody = mp.geminiBody;
const apiKey = String($env.GEMINI_API_KEY || '').trim();
if (!apiKey) {
  throw new Error('GEMINI_API_KEY ausente');
}
if (!geminiBody || typeof geminiBody !== 'object') {
  throw new Error('geminiBody ausente no Montar_prompt');
}

const primary = String($env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim();
const fromEnv = String($env.GEMINI_MODEL_FALLBACKS || 'gemini-3.1-flash-lite,gemini-3.6-flash,gemini-3.8-flash')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const models = [];
for (const m of [primary, ...fromEnv]) {
  if (m && !models.includes(m)) models.push(m);
}

function isQuotaError(e) {
  const status =
    e?.statusCode ||
    e?.httpCode ||
    e?.response?.statusCode ||
    e?.response?.status ||
    e?.cause?.statusCode;
  const msg = String(e?.message || e?.description || e?.statusMessage || '');
  return Number(status) === 429 || /429|RESOURCE_EXHAUSTED|quota|Too Many Requests|rate.?limit/i.test(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const helpers = this.helpers;
const tentativas = [];

return (async () => {
  let lastErr = null;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) +
      ':generateContent?key=' +
      encodeURIComponent(apiKey);
    try {
      const data = await helpers.httpRequest({
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: geminiBody,
        json: true,
        timeout: 120000,
      });
      tentativas.push({ model, ok: true });
      return [
        {
          json: {
            ...(data && typeof data === 'object' ? data : { raw: data }),
            gemini_model_used: model,
            gemini_fallback_tentativas: tentativas,
          },
        },
      ];
    } catch (e) {
      lastErr = e;
      const quota = isQuotaError(e);
      tentativas.push({
        model,
        ok: false,
        quota,
        error: String(e?.message || e).slice(0, 240),
      });
      if (!quota) {
        throw new Error(
          'Gemini falhou em ' + model + ' (sem fallback): ' + String(e?.message || e).slice(0, 400),
        );
      }
      // 429: espera um pouco e tenta o próximo modelo da lista
      if (i < models.length - 1) {
        await sleep(1200);
      }
    }
  }

  throw new Error(
    'Gemini: todos os modelos esgotaram cota (429). Tentativas: ' +
      JSON.stringify(tentativas) +
      ' | último: ' +
      String(lastErr?.message || lastErr).slice(0, 300),
  );
})();`;

const montarResposta = String.raw`const prep = $('Mesclar_Laravel_gestante').first().json;
const mp = $('Montar_prompt').first().json;
const prior = Array.isArray(mp._historicoAntes) ? mp._historicoAntes.slice() : [];
const g = items[0].json;
const helpers = this.helpers;

return (async () => {
  let text = g.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const fence = String.fromCharCode(96).repeat(3);
  text = text
    .replace(new RegExp('^' + fence + 'json\\s*', 'i'), '')
    .replace(new RegExp(fence + '\\s*$'), '')
    .trim();

  let ai;
  try {
    ai = JSON.parse(text);
  } catch (e) {
    throw new Error('Gemini não retornou JSON válido: ' + String(text).slice(0, 800));
  }

  function deepMerge(base, patch) {
    const out = { ...(base || {}) };
    if (!patch || typeof patch !== 'object') return out;
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        const prev = Array.isArray(out[k]) ? out[k] : [];
        out[k] = [...new Set(prev.concat(v).map((x) => String(x)))].slice(-40);
      } else if (typeof v === 'object') {
        out[k] = deepMerge(out[k] && typeof out[k] === 'object' ? out[k] : {}, v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  let reply = String(
    ai.resposta_paciente ||
      'Obrigada pela mensagem. Estou aqui para apoiar no seu acompanhamento. Este canal não substitui a consulta presencial com a equipe de saúde.',
  );

  const banned = /\b(emerg[eê]ncia|emergencial|urg[eê]ncia|urgente|imediato|corra|correr)\b/gi;
  reply = reply.replace(banned, '').replace(/\s{2,}/g, ' ').trim();

  let memoria = deepMerge(mp.memoria || {}, ai.memoria_patch || {});
  if (ai.consulta && typeof ai.consulta === 'object') {
    memoria.clinico = deepMerge(memoria.clinico || {}, ai.consulta);
  }

  let consentimento = String(mp.consentimento || 'pending');
  let status = String(mp.status || 'open');
  let consentimento_em = null;
  let fechado_em = null;
  const nowIso = new Date().toISOString();

  const cr = ai.consentimento_resposta;
  if (cr === 'sim' || cr === 'SIM' || cr === true) {
    consentimento = 'accepted';
    consentimento_em = nowIso;
  }
  if (cr === 'nao' || cr === 'não' || cr === 'NAO' || cr === 'NÃO' || cr === false) {
    consentimento = 'declined';
    consentimento_em = nowIso;
    status = 'closed_user';
    fechado_em = nowIso;
    reply =
      'Tudo bem. Sem o seu consentimento não seguimos com o atendimento por aqui. Cuide-se e conte com a equipe de saúde do seu acompanhamento presencial.';
  }

  if (ai.encerrar_ticket === true) {
    status = 'closed_user';
    fechado_em = nowIso;
  }

  const msg = String(prep.message || '').trim();
  let h = prior;
  h.push({ role: 'user', parts: [{ text: msg }] });
  h.push({ role: 'model', parts: [{ text: reply }] });
  h = h.slice(-40);

  const gestante_id = mp.gestante_id || prep.gestante_id || '';

  if (consentimento === 'accepted' && prep.telefone) {
    try {
      let base = String($env.SUPABASE_URL ?? '');
      if (base.endsWith('/')) base = base.slice(0, -1);
      const key = $env.SUPABASE_SERVICE_ROLE_KEY;
      await helpers.httpRequest({
        method: 'POST',
        url: base + '/rest/v1/gestrisk_gestantes_cadastro?on_conflict=telefone',
        headers: {
          apikey: key,
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: {
          telefone: String(prep.telefone).replace(/\D/g, ''),
          nome: memoria.nome || null,
          consentimento: 'accepted',
          consentimento_em: consentimento_em || nowIso,
          gestante_id: gestante_id || null,
          updated_at: nowIso,
        },
        json: true,
      });
    } catch (e) {
      // não interrompe o fluxo
    }
  }

  return [
    {
      json: {
        resposta_paciente: reply,
        telefone: prep.telefone,
        chatId: prep.chatId,
        session: prep.session,
        gestante_id,
        ai,
        sessao_body: {
          chat_id: prep.chatId,
          gestante_id,
          historico: h,
          status,
          consentimento,
          consentimento_em,
          fechado_em,
          ultima_interacao_em: nowIso,
          timeout_minutos: mp.timeout_minutos || 1440,
          memoria,
          updated_at: nowIso,
        },
      },
    },
  ];
})();`;

const respostaProntaLaravel = String.raw`const prep = $('Mesclar_Laravel_gestante').first().json;
const text = String(prep.resposta_pronta || '').trim();
// pular_ia sem texto = pausa humana (equipe na ficha): não envia nada pelo n8n
if (!text) {
  return [];
}

const nowIso = new Date().toISOString();
const encerrar = String(prep.intencao_laravel || '') === 'fora_escopo';

return [
  {
    json: {
      resposta_paciente: text,
      telefone: prep.telefone,
      chatId: prep.chatId,
      session: prep.session,
      gestante_id: prep.gestante_id || '',
      sessao_body: {
        chat_id: prep.chatId,
        gestante_id: prep.gestante_id || null,
        status: encerrar ? 'closed_user' : 'open',
        consentimento: 'pending',
        ultima_interacao_em: nowIso,
        fechado_em: encerrar ? nowIso : null,
        historico: [
          { role: 'user', parts: [{ text: String(prep.message || '') }] },
          { role: 'model', parts: [{ text }] },
        ],
        memoria: {},
      },
    },
  },
];`;

const respostaEncerramento = String.raw`const prep = $('Mesclar_Laravel_gestante').first().json;
const sess = $('Supabase_GET_sessao').first().json;
const nowIso = new Date().toISOString();

const reply = String(
  sess.mensagem_encerramento ||
    'Esta conversa já foi finalizada. Se precisar de um novo atendimento, envie uma nova mensagem.',
);

const row = sess.row || {};
const historico = Array.isArray(row.historico) ? row.historico.slice(-40) : [];
historico.push({ role: 'user', parts: [{ text: String(prep.message || '') }] });
historico.push({ role: 'model', parts: [{ text: reply }] });

const status = String(sess.status || 'closed_user');
const consentimento = String(sess.consentimento || 'pending');

return [
  {
    json: {
      resposta_paciente: reply,
      telefone: prep.telefone,
      chatId: prep.chatId,
      session: prep.session,
      gestante_id: prep.gestante_id || (row.gestante_id ? String(row.gestante_id) : ''),
      sessao_body: {
        chat_id: prep.chatId,
        gestante_id: prep.gestante_id || row.gestante_id || null,
        historico,
        status,
        consentimento,
        consentimento_em: row.consentimento_em || null,
        fechado_em: row.fechado_em || (status.startsWith('closed') ? nowIso : null),
        ultima_interacao_em: nowIso,
        timeout_minutos: sess.timeout_minutos || 1440,
        memoria: sess.memoria || {},
        updated_at: nowIso,
      },
    },
  },
];`;

const workflow = {
  id: 'a8f7e6d5-c4b3-4210-9876-543210fedcba',
  name: 'GestRisk — WAHA → Gemini → Sessão',
  active: true,
  nodes: [
    {
      parameters: {
        httpMethod: 'POST',
        path: 'gestrisk-whatsapp',
        responseMode: 'onReceived',
        options: {},
      },
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'Webhook_WAHA',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 0],
      webhookId: 'gestrisk-waha-gemini',
    },
    {
      parameters: { mode: 'runOnceForAllItems', jsCode: prepararWaha },
      id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
      name: 'Preparar_WAHA',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [208, 0],
    },
    {
      parameters: {
        method: 'POST',
        url: "={{ ($env.LARAVEL_APP_URL || '').replace(/\\/$/, '') + '/api/v1/n8n/whatsapp/mensagens/' + encodeURIComponent(String($json.telefone || '').replace(/\\D/g, '')) }}",
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Accept', value: 'application/json' },
            { name: 'X-Webhook-Secret', value: "={{ $env.WAHA_WEBHOOK_SECRET || '' }}" },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify({ mensagem: String($json.message || ''), tipo: 'entrada' }) }}",
        options: {
          response: { response: { fullResponse: true, neverError: true } },
          timeout: 30000,
        },
      },
      id: 'f1a2b3c4-d5e6-4789-a012-345678901aaa',
      name: 'Laravel_log_entrada',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [432, 112],
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 2000,
      continueOnFail: true,
    },
    {
      parameters: { mode: 'runOnceForAllItems', jsCode: mesclarLaravel },
      id: '8464d689-7106-4375-8386-ee877f84fd6e',
      name: 'Mesclar_Laravel_gestante',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [400, -304],
    },
    {
      parameters: {
        conditions: {
          options: {
            caseSensitive: true,
            leftValue: '',
            typeValidation: 'strict',
            version: 2,
          },
          conditions: [
            {
              id: 'cond-pular-ia-laravel',
              leftValue: '={{ $json.pular_ia }}',
              rightValue: true,
              operator: { type: 'boolean', operation: 'true', singleValue: true },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
      id: 'if-pular-ia-laravel-01',
      name: 'IF_pular_ia_laravel',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [520, -160],
    },
    {
      parameters: { mode: 'runOnceForAllItems', jsCode: respostaProntaLaravel },
      id: 'resp-pronta-laravel-01',
      name: 'Resposta_pronta_laravel',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [720, -80],
    },
    {
      parameters: { mode: 'runOnceForAllItems', jsCode: supabaseGet },
      id: 'b3c4d5e6-f7a8-9012-bcde-f23456789012',
      name: 'Supabase_GET_sessao',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [656, -320],
    },
    {
      parameters: {
        conditions: {
          options: {
            caseSensitive: true,
            leftValue: '',
            typeValidation: 'strict',
            version: 2,
          },
          conditions: [
            {
              id: 'cond-continuar-gemini',
              leftValue: '={{ $json.continuar_gemini }}',
              rightValue: true,
              operator: { type: 'boolean', operation: 'true', singleValue: true },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
      id: 'if-continuar-gemini-01',
      name: 'IF_continuar_gemini',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [820, -320],
    },
    {
      parameters: {
        method: 'POST',
        url: "={{ ($env.LARAVEL_APP_URL || '').replace(/\\/$/, '') + '/api/v1/n8n/whatsapp/rag/' + encodeURIComponent(String($('Mesclar_Laravel_gestante').first().json.telefone || '').replace(/\\D/g, '')) }}",
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Accept', value: 'application/json' },
            { name: 'X-Webhook-Secret', value: "={{ $env.WAHA_WEBHOOK_SECRET || '' }}" },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          "={{ JSON.stringify({ mensagem: String($('Mesclar_Laravel_gestante').first().json.message || ''), top_k: 6 }) }}",
        options: {
          response: { response: { fullResponse: true, neverError: true } },
          timeout: 30000,
        },
      },
      id: 'laravel-rag-01',
      name: 'Laravel_RAG',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [960, -400],
      continueOnFail: true,
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 2000,
    },
    {
      parameters: { mode: 'runOnceForAllItems', jsCode: montarPrompt },
      id: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
      name: 'Montar_prompt',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1140, -400],
    },
    {
      parameters: { mode: 'runOnceForAllItems', jsCode: geminiComFallback },
      id: 'd4e5f6a7-b8c9-0123-def0-234567890123',
      name: 'Gemini_API',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1320, -400],
    },
    {
      parameters: { mode: 'runOnceForAllItems', jsCode: montarResposta },
      id: 'e5f6a7b8-c9d0-1234-ef01-345678901234',
      name: 'Montar_resposta',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1500, -400],
    },
    {
      parameters: { mode: 'runOnceForAllItems', jsCode: respostaEncerramento },
      id: 'resp-encerrar-01',
      name: 'Resposta_encerramento',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1000, -160],
    },
    {
      parameters: {
        method: 'POST',
        url: "={{ ($env.LARAVEL_APP_URL || '').replace(/\\/$/, '') + '/api/v1/n8n/whatsapp/mensagens/' + encodeURIComponent(String($json.telefone || '').replace(/\\D/g, '')) }}",
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Accept', value: 'application/json' },
            { name: 'X-Webhook-Secret', value: "={{ $env.WAHA_WEBHOOK_SECRET || '' }}" },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          "={{ JSON.stringify({ mensagem: String($json.resposta_paciente || ''), tipo: 'saida' }) }}",
        options: {
          response: { response: { fullResponse: true, neverError: true } },
          timeout: 30000,
        },
      },
      id: 'f1a2b3c4-d5e6-4789-a012-34567890abbb',
      name: 'Laravel_log_saida',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1680, -280],
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 65000,
      continueOnFail: true,
    },
    {
      parameters: {
        method: 'POST',
        url: "={{ $env.SUPABASE_URL.replace(/\\/$/, '') + '/rest/v1/gestrisk_sessoes?on_conflict=chat_id' }}",
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'apikey', value: '={{ $env.SUPABASE_SERVICE_ROLE_KEY }}' },
            { name: 'Authorization', value: '=Bearer {{ $env.SUPABASE_SERVICE_ROLE_KEY }}' },
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Prefer', value: 'resolution=merge-duplicates,return=minimal' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          "={{ JSON.stringify($('Montar_resposta').isExecuted ? $('Montar_resposta').first().json.sessao_body : ($('Resposta_pronta_laravel').isExecuted ? $('Resposta_pronta_laravel').first().json.sessao_body : $('Resposta_encerramento').first().json.sessao_body)) }}",
        options: {},
      },
      id: 'f6a7b8c9-d0e1-2345-f012-456789012345',
      name: 'Supabase_save_sessao',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1860, -280],
      continueOnFail: true,
    },
    {
      parameters: {
        method: 'POST',
        url: '=http://waha:3000/api/sendText',
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          "={{ JSON.stringify({ session: ($('Montar_resposta').isExecuted ? $('Montar_resposta').first().json.session : ($('Resposta_pronta_laravel').isExecuted ? $('Resposta_pronta_laravel').first().json.session : $('Resposta_encerramento').first().json.session)), chatId: ($('Montar_resposta').isExecuted ? $('Montar_resposta').first().json.chatId : ($('Resposta_pronta_laravel').isExecuted ? $('Resposta_pronta_laravel').first().json.chatId : $('Resposta_encerramento').first().json.chatId)), text: ($('Montar_resposta').isExecuted ? $('Montar_resposta').first().json.resposta_paciente : ($('Resposta_pronta_laravel').isExecuted ? $('Resposta_pronta_laravel').first().json.resposta_paciente : $('Resposta_encerramento').first().json.resposta_paciente)) }) }}",
        options: {},
      },
      id: 'b8c9d0e1-f2a3-4567-1234-678901234567',
      name: 'WAHA_sendText',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [2040, -280],
      continueOnFail: true,
    },
  ],
  connections: {
    Webhook_WAHA: { main: [[{ node: 'Preparar_WAHA', type: 'main', index: 0 }]] },
    Preparar_WAHA: { main: [[{ node: 'Laravel_log_entrada', type: 'main', index: 0 }]] },
    Laravel_log_entrada: {
      main: [[{ node: 'Mesclar_Laravel_gestante', type: 'main', index: 0 }]],
    },
    Mesclar_Laravel_gestante: {
      main: [[{ node: 'IF_pular_ia_laravel', type: 'main', index: 0 }]],
    },
    IF_pular_ia_laravel: {
      main: [
        [{ node: 'Resposta_pronta_laravel', type: 'main', index: 0 }],
        [{ node: 'Supabase_GET_sessao', type: 'main', index: 0 }],
      ],
    },
    Resposta_pronta_laravel: {
      main: [[{ node: 'Laravel_log_saida', type: 'main', index: 0 }]],
    },
    Supabase_GET_sessao: {
      main: [[{ node: 'IF_continuar_gemini', type: 'main', index: 0 }]],
    },
    IF_continuar_gemini: {
      main: [
        [{ node: 'Laravel_RAG', type: 'main', index: 0 }],
        [{ node: 'Resposta_encerramento', type: 'main', index: 0 }],
      ],
    },
    Laravel_RAG: { main: [[{ node: 'Montar_prompt', type: 'main', index: 0 }]] },
    Montar_prompt: { main: [[{ node: 'Gemini_API', type: 'main', index: 0 }]] },
    Gemini_API: { main: [[{ node: 'Montar_resposta', type: 'main', index: 0 }]] },
    Montar_resposta: { main: [[{ node: 'Laravel_log_saida', type: 'main', index: 0 }]] },
    Resposta_encerramento: {
      main: [[{ node: 'Laravel_log_saida', type: 'main', index: 0 }]],
    },
    Laravel_log_saida: {
      main: [[{ node: 'Supabase_save_sessao', type: 'main', index: 0 }]],
    },
    Supabase_save_sessao: {
      main: [[{ node: 'WAHA_sendText', type: 'main', index: 0 }]],
    },
  },
  pinData: {},
  settings: { executionOrder: 'v1', binaryMode: 'separate' },
  meta: { templateCredsSetupCompleted: true },
  tags: [],
};

const out = path.join(__dirname, '..', 'workflows', 'GestRisk-WAHA-Gemini-Supabase.json');
fs.writeFileSync(out, JSON.stringify(workflow, null, 2), 'utf8');
console.log('Wrote', out);
