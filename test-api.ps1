# ============================================================
# SOHAM Backend API Test Script (PowerShell)
# Run from workspace root: .\server\test-api.ps1
# ============================================================

$BASE = "http://localhost:8080"
$KEY  = "soham-secret-key-2025"
$AUTH = @{ "Authorization" = "Bearer $KEY"; "Content-Type" = "application/json" }

function Test-Endpoint($label, $method, $path, $body = $null) {
    Write-Host "`n--- $label ---" -ForegroundColor Cyan
    try {
        $uri = "$BASE$path"
        if ($method -eq "GET") {
            $r = Invoke-RestMethod -Uri $uri -Method GET -Headers $AUTH -TimeoutSec 30
        } else {
            $json = $body | ConvertTo-Json -Depth 5
            $r = Invoke-RestMethod -Uri $uri -Method POST -Headers $AUTH -Body $json -TimeoutSec 60
        }
        Write-Host "PASS" -ForegroundColor Green
        $r | ConvertTo-Json -Depth 3 | Select-Object -First 30 | Write-Host
    } catch {
        Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# 1. Health (no auth needed)
Write-Host "`n=== 1. Health Check ===" -ForegroundColor Yellow
try {
    $h = Invoke-RestMethod -Uri "$BASE/api/health" -Method GET -TimeoutSec 10
    Write-Host "PASS - Status: $($h.status), Uptime: $($h.system.uptimeHuman)" -ForegroundColor Green
} catch {
    Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red
}

# 2. Chat
Test-Endpoint "Chat" "POST" "/api/chat" @{
    message = "Say hello in one sentence"
    history = @()
    settings = @{ model = "auto"; tone = "helpful"; technicalLevel = "intermediate" }
}

# 3. Search
Test-Endpoint "Search" "POST" "/api/ai/search" @{
    query = "What is the capital of France?"
    maxResults = 3
}

# 4. Solve
Test-Endpoint "Solve" "POST" "/api/ai/solve" @{
    problem = "What is 15 * 7?"
    tone = "helpful"
    technicalLevel = "beginner"
}

# 5. Translate
Test-Endpoint "Translate" "POST" "/api/ai/translate" @{
    text = "Hello, how are you?"
    targetLanguage = "Spanish"
}

# 6. Joke
Test-Endpoint "Joke" "POST" "/api/ai/joke" @{
    type = "pun"
    topic = "programming"
}

Write-Host "`n=== Done ===" -ForegroundColor Yellow
