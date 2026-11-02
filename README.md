# GestRisk AI WhatsApp

Ambiente Docker Compose com **WAHA** (WhatsApp HTTP API) e **n8n** (automação), na mesma rede, com volumes persistentes.

## Pré-requisitos

- Docker Engine e Docker Compose v2

## Subir o ambiente

1. Copie o arquivo de ambiente e edite os segredos:

   ```powershell
   cd gestrisk-ai-whatsapp
   Copy-Item .env.example .env
   ```

   O Docker Compose lê automaticamente o arquivo `.env` na mesma pasta do `docker-compose.yml` e injeta as variáveis nos serviços.

2. Gere valores fortes para `N8N_ENCRYPTION_KEY` (ex.: `openssl rand -hex 32`), `WAHA_API_KEY`, `WAHA_DASHBOARD_PASSWORD` e `WHATSAPP_SWAGGER_PASSWORD`.

3. Inicie os serviços:

   ```powershell
   docker compose up -d
   ```

4. Acompanhe os logs se necessário:

   ```powershell
   docker compose logs -f waha n8n
   ```

## Acessos

| Serviço | URL |
|--------|-----|
| n8n | http://localhost:5678 |
| WAHA Swagger | http://localhost:3000 |
| WAHA Dashboard | http://localhost:3000/dashboard |

## “Server connection failed” / API Key no Dashboard

O servidor **está correto** se `docker compose ps` mostrar o `waha` em execução. Com `WAHA_API_KEY` definido, a API exige o header `X-Api-Key`; o **Dashboard não lê o `.env` sozinho** — você precisa informar a chave na UI (como na [documentação WAHA — API Key no Dashboard](https://waha.devlike.pro/docs/how-to/dashboard/#api-key)).

1. Abra http://localhost:3000/dashboard e faça login com `WAHA_DASHBOARD_USERNAME` / `WAHA_DASHBOARD_PASSWORD` do `.env`.
2. Na configuração do Dashboard (ícone de ajustes / tela inicial de conexão), informe:
   - **URL do servidor:** `http://localhost:3000` (se abrir o navegador **neste mesmo PC**). Se usar outro computador ou celular na rede, use `http://<IP-do-servidor>:3000` — **não** use `localhost` nesse caso.
   - **API Key:** o valor **exato** da linha `WAHA_API_KEY` do arquivo `.env` (sem aspas e sem espaço no começo/fim).
3. Salve / conecte de novo.

Teste rápido no PowerShell (mesma máquina do Docker):

```powershell
cd C:\Users\alexo\gestrisk-ai-whatsapp
$k = ((Get-Content .env) | Where-Object { $_ -match '^WAHA_API_KEY=' }) -replace '^WAHA_API_KEY=',''
Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/version" -Headers @{ "X-Api-Key" = $k } -UseBasicParsing
```

Se retornar **200**, o WAHA e a chave estão corretos; o que faltava era só colar a mesma chave na configuração do Dashboard.

## QR Code do WhatsApp

1. Abra o **Dashboard** (credenciais em `.env`: `WAHA_DASHBOARD_USERNAME` / `WAHA_DASHBOARD_PASSWORD`).
2. Crie ou selecione uma **sessão** e siga o fluxo de pareamento (QR na interface).

Alternativa via API (com header `X-Api-Key: <WAHA_API_KEY>`): use o endpoint documentado no Swagger para captura de QR (por exemplo **GET** `/api/screenshot` conforme a versão do WAHA).

## Webhook WAHA → n8n

No `docker-compose.yml`, o WAHA envia eventos para:

`http://n8n:5678/webhook/whatsapp`

Isso é resolvido **dentro da rede Docker** pelo nome do serviço `n8n`.

### No n8n

1. Crie um workflow com um nó **Webhook**.
2. Método **POST**, path **`whatsapp`** (produção: `/webhook/whatsapp` quando o workflow está **ativo**).
3. Ative o workflow para passar a receber chamadas de produção.

### Ajustes opcionais

- Altere `WHATSAPP_HOOK_URL` e `WHATSAPP_HOOK_EVENTS` no `.env`.
- Para cabeçalhos extras no POST do webhook (HMAC/token), adicione em `docker-compose.yml` sob `waha.environment`, por exemplo: `WHATSAPP_HOOK_CUSTOM_HEADERS: "X-Meu-Token:valor"` (veja documentação WAHA).

### API do WAHA (por sessão)

Além do webhook global via `.env`, é possível registrar webhook por sessão na API WAHA; a URL de destino continua sendo a do n8n: `http://n8n:5678/webhook/whatsapp` (rede Docker) ou a URL pública se o n8n estiver exposto externamente.

## n8n chamando o WAHA

Em um nó **HTTP Request** (ou credencial HTTP):

- URL base: `http://waha:3000` (nome do serviço na rede Docker).
- Se você **não** usa `WAHA_NO_API_KEY=true`, envie o header `X-Api-Key: <WAHA_API_KEY>`.

Assim os fluxos no n8n enviam mensagens pela API do WAHA sem expor o host.

## Workflow GestRisk: WAHA → Gemini → Supabase

Arquivo pronto para importar: `workflows/GestRisk-WAHA-Gemini-Supabase.json`.

### Variáveis no `.env` (e reinício do n8n)

| Variável | Uso |
|----------|-----|
| `GEMINI_API_KEY` | Chave da [Google AI Studio](https://aistudio.google.com/apikey) (não commite). |
| `SUPABASE_URL` | URL do projeto, ex. `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | **Service role** do Supabase (só servidor; nunca no app público). |
| `GESTRISK_DEFAULT_GESTANTE_ID` | `gestante_id` usado quando o telefone da paciente não estiver no mapa do nó Code (ex. `GEST-001`). |
| `LARAVEL_APP_URL` | Base do backend Laravel **sem** barra final (ex. `http://host.docker.internal:8000` com n8n no Docker e Laravel no PC). Os nós **Laravel_log_*** usam `POST /api/v1/n8n/whatsapp/mensagens/{telefone}`. |
| `WAHA_WEBHOOK_SECRET` | Opcional; se definido no Laravel, use o mesmo valor (header `X-Webhook-Secret`). |
| `GEMINI_MODEL` | Padrão recomendado: `gemini-3.6-flash`. |

Depois de editar o `.env`: `docker compose up -d n8n`.

### Importar no n8n

1. Importe `workflows/GestRisk-WAHA-Gemini-Supabase.json` (ou rode `node scripts/build-gestrisk-workflow.js` e reimporte).
2. Publique/ative o workflow.
3. Webhook de produção: `http://localhost:5678/webhook/gestrisk-whatsapp`.

### Apontar o WAHA para este fluxo

No `.env`, defina:

`WHATSAPP_HOOK_URL=http://n8n:5678/webhook/gestrisk-whatsapp`

(rede Docker). Reinicie o WAHA: `docker compose up -d waha`.

### Mapa telefone → gestante

No nó **Preparar_WAHA**, edite o objeto `PHONE_TO_GESTANTE` (dígitos do WhatsApp, sem `+`, ex. `5521987654321`) para o `gestante_id` que existe na tabela `gestantes`.

### Tabelas Supabase (obrigatórias)

**Dev local:** `npx supabase start` + `npx supabase db reset` neste repositório.  
No `.env`: `SUPABASE_URL=http://host.docker.internal:54321` e `SUPABASE_SERVICE_ROLE_KEY` de `npx supabase status -o env`. Studio: http://127.0.0.1:54323

No **SQL Editor** (cloud) ou via reset local, execute nesta ordem:

1. `supabase/migrations/003_gestrisk_sessoes.sql`
2. `supabase/migrations/004_gestrisk_sessoes_consentimento.sql`
3. `supabase/migrations/005_gestrisk_grants.sql`
4. `supabase/migrations/006_gestrisk_document_chunks_rag.sql` (opcional — pgvector futuro)

### RAG WhatsApp (Laravel)

Documentação completa: [`docs/RAG-WHATSAPP.md`](docs/RAG-WHATSAPP.md).

- Endpoint: `POST /api/v1/n8n/whatsapp/rag/{telefone}`
- Indexar documento: `php artisan whatsapp:rag-index {gestante_id} --texto="..."`
- Nó n8n: `Laravel_RAG` (antes do `Montar_prompt`)


**`gestrisk_sessoes`:** `chat_id`, `gestante_id`, `historico`, `status` (`open`|`closed_user`|`closed_timeout`), `consentimento` (`pending`|`accepted`|`declined`), `timeout_minutos` (default 1440), `memoria` (jsonb), timestamps.

**`gestrisk_gestantes_cadastro`:** telefone + consentimento LGPD (upsert quando a gestante aceita).

O fluxo: lê sessão → se consentimento `declined` ou timeout na hora, encerra sem Gemini → senão Gemini → grava sessão (histórico + memória) → WAHA `sendText`. Laravel só registra entrada/saída.

### Contrato JSON do Gemini (`Montar_prompt`)

Campos principais: `resposta_paciente`, `intencao`, `gravidade`, `consentimento_resposta` (`sim`|`nao`|null), `encerrar_ticket`, `memoria_patch`, `consulta`. Respostas curtas; sem alarmismo (“emergência”, “urgente”, …); sem prescrição de medicamentos.

### Modelo Gemini

Defina `GEMINI_MODEL=gemini-3.6-flash` no `.env` (validado com a chave atual).

## Credenciais externas no n8n

Configure em **Credentials** (OpenAI, HTTP Header Auth, OAuth2, etc.). Elas ficam criptografadas com `N8N_ENCRYPTION_KEY` no volume `n8n_data`.

## Produção

- Coloque **Traefik** ou **Nginx** na frente com TLS; defina `N8N_WEBHOOK_URL` e `WAHA_BASE_URL` com `https://...`.
- Ative `N8N_BASIC_AUTH_ACTIVE=true` (ou SSO) se a UI do n8n for exposta.
- Restrinja portas `3000` e `5678` no firewall à VPN ou IPs confiáveis.
- Para imagem **WAHA Plus**, altere `image` para `devlikeapro/waha-plus` e faça `docker login` conforme a documentação oficial.

## Volumes

| Volume | Uso |
|--------|-----|
| `gestrisk-ai-whatsapp_n8n_data` | Dados e credenciais do n8n |
| `gestrisk-ai-whatsapp_waha_sessions` | Sessões WhatsApp |
| `gestrisk-ai-whatsapp_waha_media` | Mídia WAHA |
