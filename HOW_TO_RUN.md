# SOHAM Backend — How to Run & Test

## Start the Server

```powershell
# From workspace root
cd server
npm run dev        # development (ts-node, auto-reload)
# OR
npm run build && npm start   # production build
```

Server starts at: `http://localhost:8080`

---

## API Key

Every endpoint except `/api/health` requires this header:

```
Authorization: Bearer soham-secret-key-2025
```

Set in `server/.env` as `SOHAM_API_KEY=soham-secret-key-2025`

---

## Test with PowerShell (Invoke-RestMethod)

```powershell
$KEY  = "soham-secret-key-2025"
$AUTH = @{ "Authorization" = "Bearer $KEY"; "Content-Type" = "application/json" }
$BASE = "http://localhost:8080"

# Health (no auth needed)
Invoke-RestMethod "$BASE/api/health"

# Chat
$body = @{ message="Hello!"; history=@(); settings=@{model="auto"} } | ConvertTo-Json
Invoke-RestMethod "$BASE/api/chat" -Method POST -Headers $AUTH -Body $body

# Search
$body = @{ query="capital of France"; maxResults=3 } | ConvertTo-Json
Invoke-RestMethod "$BASE/api/ai/search" -Method POST -Headers $AUTH -Body $body

# Solve
$body = @{ problem="What is 15 * 7?"; tone="helpful"; technicalLevel="beginner" } | ConvertTo-Json
Invoke-RestMethod "$BASE/api/ai/solve" -Method POST -Headers $AUTH -Body $body

# Translate
$body = @{ text="Hello world"; targetLanguage="Spanish" } | ConvertTo-Json
Invoke-RestMethod "$BASE/api/ai/translate" -Method POST -Headers $AUTH -Body $body

# Joke
$body = @{ type="pun"; topic="programming" } | ConvertTo-Json
Invoke-RestMethod "$BASE/api/ai/joke" -Method POST -Headers $AUTH -Body $body

# Recipe
$body = @{ query="pasta carbonara"; cuisine="Italian" } | ConvertTo-Json
Invoke-RestMethod "$BASE/api/ai/recipe" -Method POST -Headers $AUTH -Body $body
```

## Run Full Test Suite

```powershell
.\server\test-api.ps1
```

---

## Test with curl (bash/WSL)

```bash
KEY="soham-secret-key-2025"
BASE="http://localhost:8080"

# Health
curl $BASE/api/health

# Chat
curl -X POST $BASE/api/chat \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello!","history":[],"settings":{"model":"auto"}}'

# Search
curl -X POST $BASE/api/ai/search \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"capital of France","maxResults":3}'
```

---

## Common Mistakes

| What you did | What to do instead |
|---|---|
| `GET /api/chat` in browser | Use POST with a JSON body |
| Put auth in the URL | Put it in the `Authorization` header |
| `curl http://localhost:8080/api/chat` | Add `-X POST -H "Authorization: Bearer soham-secret-key-2025" -H "Content-Type: application/json" -d '{...}'` |

---

## All Endpoints

| Method | Path | Body fields |
|---|---|---|
| GET | `/api/health` | — |
| POST | `/api/chat` | `message`, `history[]`, `settings.model` |
| POST | `/api/ai/search` | `query`, `maxResults` |
| POST | `/api/ai/solve` | `problem`, `tone`, `technicalLevel` |
| POST | `/api/ai/summarize` | `text`, `style` |
| POST | `/api/ai/translate` | `text`, `targetLanguage` |
| POST | `/api/ai/sentiment` | `text` |
| POST | `/api/ai/grammar` | `text` |
| POST | `/api/ai/classify` | `text`, `categories[]` |
| POST | `/api/ai/quiz` | `topic`, `difficulty`, `count` |
| POST | `/api/ai/recipe` | `query`, `cuisine` |
| POST | `/api/ai/joke` | `type`, `topic` |
| POST | `/api/ai/dictionary` | `word` |
| POST | `/api/ai/fact-check` | `claim` |
| POST | `/api/image/generate` | `prompt` |
| POST | `/api/voice/tts` | `text`, `voice` |
| POST | `/api/voice/transcribe` | `audio` (base64) |
| POST | `/api/memory/extract` | `userMessage`, `assistantResponse`, `userId` |
