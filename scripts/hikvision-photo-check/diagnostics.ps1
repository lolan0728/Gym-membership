# Diagnostic files contain sanitized structures, never raw credentials or image bytes.
$script:DiagnosticDirectory = $null
$script:DiagnosticSecrets = @()
$script:DiagnosticIds = @{}
$script:DiagnosticRequestNumber = 0

function Protect-DiagnosticText([string]$Text) {
    foreach ($secretValue in $script:DiagnosticSecrets) {
        if ($secretValue) { $Text = $Text.Replace([string]$secretValue, '[redacted]') }
    }
    $Text = [regex]::Replace($Text, '(?i)https?://[^\s"<>]+', '[url redacted]')
    $Text = [regex]::Replace($Text, '[0-9]{11,}', '[number redacted]')
    $Text = [regex]::Replace($Text, '(?i)[a-z]:\\[^\r\n,;]+', '[local path]')
    return $Text
}

function Protect-DiagnosticValue($Value, [string]$Key = '') {
    if ($null -eq $Value) { return $null }
    if ($Key -match '(?i)password|secret|token|cookie|authorization|nonce|opaque|faceURL|picURL|pictureURL|faceData|finger.*data|certificate|cardNo|serialNumber|macAddress|phone|mobile|email|address|^name$|userName|deviceName') {
        return '[redacted]'
    }
    if ($Key -in @('employeeNo', 'FPID')) {
        $identifier = [string]$Value
        if (-not $script:DiagnosticIds.ContainsKey($identifier)) { $script:DiagnosticIds[$identifier] = 'person-' + ($script:DiagnosticIds.Count + 1) }
        return $script:DiagnosticIds[$identifier]
    }
    if ($Value -is [Collections.IDictionary]) {
        $clean = [ordered]@{}
        foreach ($property in $Value.Keys) { $clean[$property] = Protect-DiagnosticValue $Value[$property] ([string]$property) }
        return $clean
    }
    if ($Value -is [Management.Automation.PSCustomObject]) {
        $clean = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) { $clean[$property.Name] = Protect-DiagnosticValue $property.Value $property.Name }
        return $clean
    }
    if ($Value -is [Collections.IEnumerable] -and $Value -isnot [string]) {
        $clean = @(); foreach ($element in $Value) { $clean += ,(Protect-DiagnosticValue $element $Key) }
        return ,$clean
    }
    # Preserve documented technical scalar fields; unknown fields retain structure but not values.
    if ($Key -match '^(searchID|searchResultPosition|maxResults|totalMatches|numOfMatches|responseStatusStrg|responseStatus|statusCode|statusString|subStatusCode|errorCode|FDID|faceLibType|model|firmwareVersion|firmwareReleasedDate|deviceType|numOfFace|numOfCard|numOfFP|userType|gender|localUIRight)$') {
        if ($Value -is [string]) { return Protect-DiagnosticText $Value }
        return $Value
    }
    return '[redacted value]'
}

function Convert-DiagnosticXml($Node) {
    if ($Node.NodeType -ne [Xml.XmlNodeType]::Element) { return $null }
    $attributes = [ordered]@{}
    foreach ($attribute in $Node.Attributes) { $attributes[$attribute.LocalName] = '[redacted value]' }
    $children = @($Node.ChildNodes | Where-Object { $_.NodeType -eq [Xml.XmlNodeType]::Element })
    if ($children.Count -eq 0) { return @{ element = $Node.LocalName; attributes = $attributes; value = (Protect-DiagnosticValue $Node.InnerText $Node.LocalName) } }
    return @{ element = $Node.LocalName; attributes = $attributes; children = @($children | ForEach-Object { Convert-DiagnosticXml $_ }) }
}

function Get-DiagnosticBody([byte[]]$Bytes, [string]$ContentType) {
    if ($Bytes.Length -eq 0) { return @{ format = 'empty' } }
    if ($ContentType -match '^image/' -or ($Bytes.Length -ge 2 -and $Bytes[0] -eq 255 -and $Bytes[1] -eq 216)) {
        return @{ format = 'image'; bytes = $Bytes.Length; note = 'Image bytes excluded from logs' }
    }
    $text = [Text.Encoding]::UTF8.GetString($Bytes)
    try { return @{ format = 'json'; data = (Protect-DiagnosticValue ($text | ConvertFrom-Json)) } } catch {}
    $reader = $null
    try {
        $settings = [Xml.XmlReaderSettings]::new(); $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit; $settings.XmlResolver = $null
        $reader = [Xml.XmlReader]::Create([IO.StringReader]::new($text), $settings)
        $document = [Xml.XmlDocument]::new(); $document.XmlResolver = $null; $document.Load($reader)
        return @{ format = 'xml'; data = (Convert-DiagnosticXml $document.DocumentElement) }
    } catch {
        return @{ format = 'unparsed'; bytes = $Bytes.Length; note = 'Unstructured content omitted because reliable field redaction is unavailable' }
    } finally { if ($reader) { $reader.Dispose() } }
}

function Write-Diagnostic([string]$Event, $Data = $null, [switch]$Http) {
    if (-not $script:DiagnosticDirectory) { return }
    $entry = [ordered]@{ time = [DateTimeOffset]::Now.ToString('o'); event = $Event; data = $Data }
    $file = if ($Http) { 'http.jsonl' } else { 'diagnostic.log' }
    $line = ConvertTo-Json -InputObject $entry -Depth 60 -Compress
    [IO.File]::AppendAllText((Join-Path $script:DiagnosticDirectory $file), $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Initialize-Diagnostics([string]$Directory) {
    $Directory = [IO.Path]::GetFullPath($Directory)
    if ($script:DiagnosticDirectory -eq $Directory) { return }
    [void][IO.Directory]::CreateDirectory($Directory)
    $script:DiagnosticDirectory = $Directory; $script:DiagnosticIds = @{}; $script:DiagnosticSecrets = @(); $script:DiagnosticRequestNumber = 0
    foreach ($file in @('diagnostic.log', 'http.jsonl')) { [IO.File]::WriteAllText((Join-Path $Directory $file), '', [Text.UTF8Encoding]::new($false)) }
    Write-Diagnostic 'run.start' @{ toolVersion = '1.2'; powershell = $PSVersionTable.PSVersion.ToString(); dotnet = [Environment]::Version.ToString(); os = [Environment]::OSVersion.VersionString; process64Bit = [Environment]::Is64BitProcess; timezone = [TimeZoneInfo]::Local.Id }
}

function Write-DiagnosticException([string]$Stage, $Record) {
    $chain = @(); $exception = $Record.Exception
    while ($exception -and $chain.Count -lt 12) {
        $chain += @{ type = $exception.GetType().FullName; hresult = $exception.HResult; message = (Protect-DiagnosticText $exception.Message) }
        $exception = $exception.InnerException
    }
    Write-Diagnostic 'exception' @{ stage = $Stage; exceptions = $chain; category = [string]$Record.CategoryInfo.Category; scriptLine = $Record.InvocationInfo.ScriptLineNumber; stack = (Protect-DiagnosticText $Record.ScriptStackTrace) }
}

function Complete-Diagnostics {
    Write-Diagnostic 'run.end' @{ note = 'Diagnostic bundle excludes sample-photo.jpg' }
    $files = @('diagnostic.log', 'http.jsonl', 'report.json') | ForEach-Object { Join-Path $script:DiagnosticDirectory $_ } | Where-Object { Test-Path -LiteralPath $_ }
    try { Compress-Archive -LiteralPath $files -DestinationPath (Join-Path $script:DiagnosticDirectory 'diagnostics.zip') -Force }
    catch { Write-DiagnosticException 'package' $_; Write-Host '日志已保存，但打包失败；请带回 report.json、diagnostic.log 和 http.jsonl。' }
}
