# RAG no WhatsApp (GestRisk) — passo a passo

## O que foi implementado

1. **Laravel** busca contexto clínico da gestante (consultas, análise, interpretação, documentos indexados, últimas msgs WhatsApp).
2. Ranqueia trechos pela mensagem atual (retrieval lexical — fase 1–2).
3. **n8n** chama esse endpoint **antes** do Gemini (`Laravel_RAG` → `Montar_prompt`).
4. O prompt injeta o bloco RAG e manda o modelo **só usar o que estiver nos trechos**.

## Fluxo

```text
WAHA → Preparar → Laravel log entrada → Mesclar → Supabase sessão
  → IF continuar → Laravel_RAG → Montar_prompt (+ RAG) → Gemini → …
```

## Passo 1 — Migration Laravel

```powershell
cd C:\Users\Carol Jorgino\Documents\GitHub\sistemapretriagem
docker exec pretriagem-app php artisan migrate --force --path=database/migrations/2026_07_24_140000_create_gestante_documentos_rag_tables.php
```

Cria:
- `gestante_documentos`
- `gestante_documento_chunks`

## Passo 2 — Endpoint RAG

`POST` ou `GET`  
`/api/v1/n8n/whatsapp/rag/{telefone}`  
Header: `X-Webhook-Secret` (mesmo do `.env`)

Body (POST):

```json
{ "mensagem": "minha pressão está alta?", "top_k": 6 }
```

Resposta:

```json
{
  "found": true,
  "gestante_id": 5001,
  "gestante_id_publico": "G-5001",
  "chunks": [{ "source": "consulta", "title": "Consulta #3", "text": "...", "score": 1.25 }],
  "contexto_texto": "PatientSnapshot + documentos + histórico...",
  "patient_snapshot": {
    "primeiro_nome": "Caroline",
    "idade_gestacional": "22",
    "pressao_sistolica": 110,
    "analise_resumo": "risco moderado; eco recomendada",
    "interpretacao_resumo": "..."
  },
  "historico_conversa": [
    { "role": "user", "text": "Oi", "at": "2026-10-29T19:00:00-03:00" },
    { "role": "staff", "text": "Olá, aqui é a equipe.", "at": "2026-10-29T19:01:00-03:00" }
  ],
  "intencao": "conversa_livre",
  "total_fontes": 10
}
```

O `Montar_prompt` no n8n:
- injeta **sempre** o contexto clínico (`contexto_texto` / PatientSnapshot), não só em `exames_consultas`;
- funde `historico_conversa` (Laravel) com o histórico Supabase — falas `staff` viram turns `model` com prefixo `[Mensagem da equipe]`.

Intenções Laravel: `conversa_livre` | `sintoma` | `exames_consultas` | `atendimento_humano` | `falar_medico` | `fora_escopo`.

Escopo: canal só para gestantes. Declaração “não estou mais grávida” → Laravel `resposta_pronta` + n8n envia sem Gemini. RAG expõe `gestacao_ativa` / `fora_escopo`. Prompt anti-vícios (sem consentimento repetido, sem inventar contexto, disclaimer no máx. 1x).

Teste:

```powershell
Invoke-RestMethod -Method POST `
  -Uri "http://localhost:8000/api/v1/n8n/whatsapp/rag/5511987654321" `
  -Headers @{ "X-Webhook-Secret"="um-segredo-forte"; Accept="application/json" } `
  -ContentType "application/json" `
  -Body '{"mensagem":"pressao e glicemia","top_k":6}'
```

## Passo 3 — Indexar um documento de paciente

Texto livre (exame/laudo digitado ou OCR):

```powershell
docker exec pretriagem-app php artisan whatsapp:rag-index 5001 `
  --titulo="Laudo glicemia 12/03" `
  --tipo=exame `
  --texto="Glicemia de jejum 98 mg/dL. HbA1c 5.4%. Sem alterações."
```

Ou arquivo:

```powershell
docker exec -i pretriagem-app php artisan whatsapp:rag-index 5001 --titulo="Laudo" --tipo=laudo --arquivo=/var/www/html/storage/app/laudo.txt
```

## Passo 4 — Atualizar workflow n8n

```powershell
cd C:\Users\Carol Jorgino\Documents\GitHub\apiwhatsapp
node scripts/build-gestrisk-workflow.js
docker cp workflows/GestRisk-WAHA-Gemini-Supabase.json gestrisk-n8n:/tmp/wf.json
docker exec gestrisk-n8n n8n import:workflow --input=/tmp/wf.json
docker exec gestrisk-n8n n8n publish:workflow --id=a8f7e6d5-c4b3-4210-9876-543210fedcba
docker compose restart n8n
```

## Passo 5 — Testar no WhatsApp

1. Gestante com telefone cadastrado no Laravel.
2. Ideal: já ter consulta/análise ou documento indexado.
3. Enviar no WhatsApp algo como: “como está minha pressão?”.
4. A resposta deve refletir dados do prontuário quando existirem.

## Supabase (opcional / futuro)

Migration `006_gestrisk_document_chunks_rag.sql` cria tabela com **pgvector** para embeddings depois.  
O retrieval **atual** é 100% no Laravel (mais simples e alinhado ao prontuário).

```powershell
npx supabase db reset
# ou rode o SQL 006 no Studio
```

## Fallback de modelos Gemini (cota 429)

Ordem padrão (configurável):

1. `GEMINI_MODEL` (ex.: `gemini-3.5-flash-lite`)
2. `GEMINI_MODEL_FALLBACKS` — lista CSV, default: `gemini-3.1-flash-lite,gemini-3.6-flash,gemini-3.8-flash`

O nó **Gemini_API** (Code) tenta o próximo modelo **somente em HTTP 429 / quota**. Outros erros (401, 400…) não fazem fallback.

## Limitações desta fase

- Retrieval por **palavras-chave**, não embedding semântico ainda.
- PDF/OCR: indexe o **texto já extraído** com `whatsapp:rag-index`.
- Sem consentimento / ticket fechado, o IF do n8n não chega no RAG+Gemini.
- PatientSnapshot + histórico Laravel (20 msgs) entram em **todas** as intenções; chunks completos de documentos/exames continuam priorizados em `exames_consultas`.

## Arquivos principais

| Onde | Arquivo |
|------|---------|
| Serviço | `sistemapretriagem/app/Services/WhatsAppRagContextService.php` |
| API | `.../Http/Controllers/Api/N8nWhatsappRagController.php` |
| Rota | `routes/api.php` |
| Indexar | `php artisan whatsapp:rag-index` |
| n8n | nó `Laravel_RAG` em `workflows/GestRisk-WAHA-Gemini-Supabase.json` |
