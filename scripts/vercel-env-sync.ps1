param(
    [string]$SourceProject = "v0-v0-quickitquote",
    [string]$TargetProject = "qiq-mcp-server",
    [string]$TeamId = "qiq1",
    [switch]$SkipIfNoValue
)

if (-not $Env:VERCEL_TOKEN) {
    Write-Error "VERCEL_TOKEN is not set. Please set \$Env:VERCEL_TOKEN and retry."; exit 1
}

$baseUrl = "https://api.vercel.com"
$headers = @{ Authorization = "Bearer $($Env:VERCEL_TOKEN)"; "Content-Type" = "application/json" }

function Get-ProjectEnv($project) {
    $url = "$baseUrl/v9/projects/$project/env?teamId=$TeamId"
    try {
        $resp = Invoke-RestMethod -Uri $url -Headers $headers -Method GET -ErrorAction Stop
        return $resp
    }
    catch {
        Write-Error ("Failed to fetch envs for {0}: {1}" -f $project, $_.Exception.Message); return $null
    }
}

function Upsert-Env($project, $envItem) {
    $url = "$baseUrl/v9/projects/$project/env?teamId=$TeamId"
    if ($SkipIfNoValue -and ([string]::IsNullOrEmpty($envItem.value))) {
        Write-Host ("Skipping {0} due to missing/redacted value" -f $envItem.key) -ForegroundColor Yellow
        return $null
    }
    $body = [pscustomobject]@{
        key       = $envItem.key
        value     = $envItem.value
        type      = $envItem.type
        target    = $envItem.target
        gitBranch = $envItem.gitBranch
        encrypted = $envItem.encrypted
    } | ConvertTo-Json -Depth 5

    try {
        $resp = Invoke-RestMethod -Uri $url -Headers $headers -Method POST -Body $body -ErrorAction Stop
        return $resp
    }
    catch {
        Write-Error ("Failed to upsert env {0} on {1}: {2}" -f $envItem.key, $project, $_.Exception.Message); return $null
    }
}

Write-Host "Fetching envs from source project: $SourceProject (teamId=$TeamId)" -ForegroundColor Cyan
$sourceEnvs = Get-ProjectEnv -project $SourceProject
if (-not $sourceEnvs) { exit 1 }

Write-Host "Found $($sourceEnvs.envs.Count) env entries. Syncing to target: $TargetProject" -ForegroundColor Cyan

$results = @()
foreach ($env in $sourceEnvs.envs) {
    $res = Upsert-Env -project $TargetProject -envItem $env
    $status = if ($res) { 'ok' } else { if ($SkipIfNoValue -and ([string]::IsNullOrEmpty($env.value))) { 'skipped-redacted' } else { 'error' } }
    $results += [pscustomobject]@{ key = $env.key; status = $status }
}

Write-Host "Sync complete:" -ForegroundColor Green
$results | Format-Table -AutoSize
