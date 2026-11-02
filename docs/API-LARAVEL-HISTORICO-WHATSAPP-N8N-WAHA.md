# API Laravel — Histórico WhatsApp (integração n8n + WAHA)

Este documento descreve os endpoints HTTP usados para **gravar mensagens recebidas e enviadas** na tabela `gestante_whatsapp`, para consumo pelo **n8n** (e fluxos ligados ao **WAHA**).

**Base URL (desenvolvimento):** `http://localhost:8000` (ou a URL do seu `APP_URL` + prefixo `/api`).

**Prefixo das rotas API:** todas as rotas abaixo ficam sob **`/api`**.

---

## Autenticação opcional

Se no `.env` do Laravel existir **`WAHA_WEBHOOK_SECRET`** preenchido, cada requisição deve enviar o mesmo valor em um destes formatos:

| Onde | Valor |
|------|--------|
| Header `X-Webhook-Secret` | token literal |
| Header `Authorization` | `Bearer <token>` |

Se **`WAHA_WEBHOOK_SECRET`** estiver vazio, o endpoint fica **aberto** (apenas para rede local / dev — não recomendado em produção sem outra camada de proteção).

---

## 1) Ingestão com telefone no **corpo** (legado / webhook)

**`POST /api/gestante-whatsapp`**

**Headers**

- `Content-Type: application/json`
- `Accept: application/json`
- `X-Webhook-Secret` ou `Authorization: Bearer ...` (se configurado)

**Body (JSON)**

```json
{
  "telefone": "5521999999999",
  "mensagem": "Texto da mensagem",
  "tipo": "entrada"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `telefone` | string | sim | Só dígitos, formato E.164 Brasil (ex.: **`5511987266302`** = 55 + DDD + 9 + 8). No n8n, o nó **Preparar_WAHA** obtém o número pelo payload WAHA (`remoteJidAlt`, resolução LID/contacts) e aplica `normalizeTelefoneBrParaApi` antes de enviar. |
| `mensagem` | string | sim | Conteúdo da mensagem. |
| `tipo` | string | sim | **`entrada`**: paciente → sistema (recebida). **`saida`**: sistema → paciente (enviada). |

**Resposta `201 Created`**

```json
{
  "id": 42,
  "gestante_id": 3,
  "tempo_atendimento": 120,
  "tempo_atendimento_formatado": "2m 0s"
}
```

- **`gestante_id`**: ID interno em `gestantes` quando o telefone bate com um cadastro; caso contrário pode ser `null` (mensagem ainda é salva para auditoria).
- **`tempo_atendimento`**: segundos desde a **última** mensagem dessa gestante; `null` se for a primeira mensagem vinculada a ela.

**Erros comuns:** `422` (validação), `401` (secret inválido), `429` (throttle).

---

## 2) Ingestão com telefone na **URL** (recomendado para n8n)

**`POST /api/v1/n8n/whatsapp/mensagens/{telefone}`**

- **`{telefone}`**: **somente dígitos**, **10 a 16 caracteres** (ex.: `5521999999999`).
- Não use espaços, traços ou `+` no path; normalize no n8n antes (Expression: só dígitos).

**Headers** — iguais ao endpoint anterior.

**Body (JSON)** — telefone **não** vai no JSON (já está na URL):

```json
{
  "mensagem": "Texto da mensagem",
  "tipo": "saida"
}
```

**Resposta** — igual ao endpoint `POST /api/gestante-whatsapp` (`201` + mesmo JSON).

**Exemplo cURL**

```bash
curl -s -X POST "http://localhost:8000/api/v1/n8n/whatsapp/mensagens/5521999999999" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"mensagem":"Olá!","tipo":"entrada"}'
```

---

## n8n — HTTP Request (sugestão)

1. **Method:** POST  
2. **URL:** `{{ $env.APP_URL }}/api/v1/n8n/whatsapp/mensagens/{{ $json.telefoneDigits }}`  
   - Montar `telefoneDigits` com função que remove tudo que não for dígito (WAHA costuma mandar `5511...@c.us` — extrair só o número antes do `@`).
3. **Body:** JSON  
   - `mensagem`: texto vindo do WAHA / seu fluxo  
   - `tipo`: `entrada` se for mensagem **recebida** do usuário; `saida` se for **enviada** pela sessão/linha  

4. Se usar secret: header `X-Webhook-Secret` = valor de `WAHA_WEBHOOK_SECRET` no Laravel.

**Throttle:** até **120 requisições por minuto** por rota (middleware `throttle:120,1`). Em carga maior, ajuste no Laravel ou use fila no n8n.

---

## WAHA — relação com esta API

- O **WAHA** envia/recebe mensagens via HTTP próprio (`POST .../api/sendText`, webhooks de eventos, etc.).
- Este endpoint Laravel **não substitui** o WAHA: ele **persiste** no banco do GestRisk/Cardioprenatal o que o n8n decidir enviar (por exemplo, após um Webhook que recebe payload do WAHA).
- Fluxo típico: **WAHA → Webhook n8n → HTTP Request → Laravel** (`/api/v1/n8n/...`).

---

## Tabela no banco

- **Tabela:** `gestante_whatsapp`  
- **Campos relevantes:** `gestante_id` (FK opcional), `mensagem`, `tipo` (`entrada` | `saida`), `tempo_atendimento`, `created_at`

---

## Referência rápida

| Método | Caminho | Telefone |
|--------|---------|----------|
| POST | `/api/gestante-whatsapp` | campo JSON `telefone` |
| POST | `/api/v1/n8n/whatsapp/mensagens/{telefone}` | segmento de URL (só dígitos) |

Ambos gravam o mesmo registro e retornam o mesmo formato de resposta em sucesso.

---

## Fluxo GestRisk no n8n (import `GestRisk-WAHA-Gemini-Supabase.json`)

Topologia: **Webhook_WAHA → Preparar_WAHA → Laravel_log_entrada → Mesclar_Laravel_gestante → Supabase_GET_sessao → IF_continuar_gemini → (Montar_prompt → Gemini_API → Montar_resposta | Resposta_encerramento) → Laravel_log_saida → Supabase_save_sessao → WAHA_sendText → Respond_Webhook**.

Os nós **Laravel_log_*** chamam `POST /api/v1/n8n/whatsapp/mensagens/{telefone}` com `{ mensagem, tipo }` (`entrada` ou `saida`).

**Variáveis no `.env` do Docker Compose (serviço n8n):**

| Variável | Descrição |
|----------|-----------|
| `LARAVEL_APP_URL` | URL base do Laravel **sem** barra final (ex.: `http://host.docker.internal:8000`). |
| `WAHA_WEBHOOK_SECRET` | Mesmo valor do Laravel — header `X-Webhook-Secret`. |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Modelo recomendado: `gemini-3.6-flash`. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Projeto Supabase + service role. |

**SQL no Supabase:** `003_gestrisk_sessoes.sql` + `004_gestrisk_sessoes_consentimento.sql` (status, timeout, consentimento, memória, cadastro LGPD).

Após alterar o `.env`: `docker compose up -d n8n`. Os nós Laravel usam `continueOnFail: true`.
