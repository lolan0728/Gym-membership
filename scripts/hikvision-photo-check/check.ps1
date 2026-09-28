param(
    [string]$DeviceAddress = 'http://192.168.110.4',
    [string]$PhoneNumber,
    [System.Management.Automation.PSCredential]$Credential,
    [string]$OutputDirectory,
    [string]$LibraryId = '1',
    [switch]$LoadFunctionsOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'diagnostics.ps1')

function Get-PhoneSuffix([string]$Name) {
    $numbers = [regex]::Matches($Name, '(?<![0-9])1[3-9][0-9]{9}(?![0-9])')
    if ($numbers.Count -eq 1 -and $Name.Trim().EndsWith($numbers[0].Value)) { return $numbers[0].Value }
    return $null
}

function Get-SameOriginUri([uri]$Origin, [string]$Location) {
    $candidate = [uri]::new($Origin, $Location)
    if ($candidate.Scheme -ne $Origin.Scheme -or $candidate.Host -ne $Origin.Host -or
        $candidate.Port -ne $Origin.Port -or $candidate.UserInfo -or $candidate.Fragment) {
        throw '照片地址不属于当前设备，已停止下载。'
    }
    return $candidate
}

function New-DigestHeader([string]$Challenge, [string]$Method, [uri]$Uri, $Login) {
    $fields = @{}
    foreach ($item in [regex]::Matches($Challenge, '(\w+)=(?:"([^"]*)"|([^,\s]+))')) {
        $fields[$item.Groups[1].Value.ToLowerInvariant()] = $item.Groups[2].Value + $item.Groups[3].Value
    }
    $algorithm = $fields['algorithm']; if (-not $algorithm) { $algorithm = 'MD5' }
    if ($algorithm -notin @('MD5', 'MD5-sess', 'SHA-256', 'SHA-256-sess')) { throw '设备 Digest 算法尚不支持。' }
    if (-not $fields['nonce'] -or -not $fields.ContainsKey('realm')) { throw '设备认证响应格式异常。' }
    $qop = $fields['qop']
    if ($qop -and 'auth' -notin @($qop.Split(',') | ForEach-Object { $_.Trim() })) { throw '设备 Digest qop 尚不支持。' }
    $encoding = [Text.Encoding]::GetEncoding(28591)
    if ($fields['charset'] -eq 'UTF-8') { $encoding = [Text.Encoding]::UTF8 }
    $hash = { param([string]$Value)
        $hasher = if ($algorithm.StartsWith('SHA-256')) { [Security.Cryptography.SHA256]::Create() } else { [Security.Cryptography.MD5]::Create() }
        try { return ([BitConverter]::ToString($hasher.ComputeHash($encoding.GetBytes($Value)))).Replace('-', '').ToLowerInvariant() }
        finally { $hasher.Dispose() }
    }
    $credentials = $Login.GetNetworkCredential()
    $nonce = $fields['nonce']; $realm = $fields['realm']; $cnonce = [guid]::NewGuid().ToString('N')
    $ha1 = & $hash ($credentials.UserName + ':' + $realm + ':' + $credentials.Password)
    if ($algorithm.EndsWith('-sess')) { $ha1 = & $hash ($ha1 + ':' + $nonce + ':' + $cnonce) }
    $ha2 = & $hash ($Method + ':' + $Uri.PathAndQuery)
    $digestInput = $ha1 + ':' + $nonce + ':'
    if ($qop) { $digestInput += '00000001:' + $cnonce + ':auth:' }
    $responseHash = & $hash ($digestInput + $ha2)
    $quote = { param([string]$Value) return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"' }
    $parts = @(
        ('username=' + (& $quote $credentials.UserName))
        ('realm=' + (& $quote $realm))
        ('nonce=' + (& $quote $nonce))
        ('uri=' + (& $quote $Uri.PathAndQuery))
        ('response="' + $responseHash + '"')
        ('algorithm=' + $algorithm)
    )
    if ($qop) { $parts += @('qop=auth', 'nc=00000001', ('cnonce="' + $cnonce + '"')) }
    elseif ($algorithm.EndsWith('-sess')) { $parts += 'cnonce="' + $cnonce + '"' }
    if ($fields['opaque']) { $parts += 'opaque=' + (& $quote $fields['opaque']) }
    return 'Digest ' + ($parts -join ', ')
}

function Invoke-DeviceRead($Client, [uri]$Uri, [string]$Method = 'GET', $Body = $null, $Login) {
    # Only the two documented search POSTs are permitted; no configuration writes.
    $searchPaths = @('/ISAPI/AccessControl/UserInfo/Search', '/ISAPI/Intelligent/FDLib/FDSearch')
    if ($Method -ne 'GET' -and ($Method -ne 'POST' -or $Uri.AbsolutePath -notin $searchPaths)) {
        throw '工具仅允许查询操作。'
    }
    $request = $null
    $response = $null
    try {
        $authorization = $null
        for ($attempt = 0; $attempt -lt 2; $attempt++) {
            $script:DiagnosticRequestNumber++
            $requestId = $script:DiagnosticRequestNumber
            $route = if ($Uri.AbsolutePath -in @('/ISAPI/System/deviceInfo', '/ISAPI/AccessControl/UserInfo/Search', '/ISAPI/Intelligent/FDLib/FDSearch')) { $Uri.PathAndQuery } else { '[photo download URL redacted]' }
            Write-Diagnostic 'http.request' @{ requestId = $requestId; attempt = $attempt + 1; method = $Method; route = $route; digestApplied = [bool]$authorization; body = (Protect-DiagnosticValue $Body) } -Http
            $watch = [Diagnostics.Stopwatch]::StartNew()
            $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Uri)
            if ($null -ne $Body) {
                $json = ConvertTo-Json -InputObject $Body -Depth 12 -Compress
                $request.Content = [System.Net.Http.StringContent]::new($json, [Text.Encoding]::UTF8, 'application/json')
            }
            if ($authorization) { $request.Headers.Add('Authorization', $authorization) }
            $response = $Client.SendAsync($request).GetAwaiter().GetResult()
            $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
            $watch.Stop()
            $contentType = [string]$response.Content.Headers.ContentType.MediaType
            Write-Diagnostic 'http.response' @{ requestId = $requestId; status = [int]$response.StatusCode; elapsedMs = $watch.ElapsedMilliseconds; contentType = $contentType; bytes = $bytes.Length; authenticationSchemes = @($response.Headers.WwwAuthenticate | ForEach-Object { $_.Scheme }); body = (Get-DiagnosticBody $bytes $contentType) } -Http
            if ([int]$response.StatusCode -ne 401 -or $attempt -eq 1) { break }
            $challenge = @($response.Headers.WwwAuthenticate | Where-Object { $_.Scheme -eq 'Digest' })
            if ($challenge.Count -eq 0) { throw '设备未提供 Digest 认证，请核对接口认证设置。' }
            $authorization = New-DigestHeader $challenge[0].Parameter $Method $Uri $Login
            $response.Dispose(); $response = $null; $request.Dispose(); $request = $null
        }
        $status = [int]$response.StatusCode
        if ($status -eq 401) { throw 'HTTP 401：设备账号或密码错误，或认证方式不兼容。请核对后再运行，避免重复尝试。' }
        if ($status -eq 403) { throw 'HTTP 403：账号权限不足，或设备拒绝访问。' }
        if ($status -ge 300 -and $status -lt 400) { throw "HTTP $status：设备要求跳转，请确认 HTTP/HTTPS 地址；本工具不自动跳转。" }
        if (-not $response.IsSuccessStatusCode) { throw "HTTP $status：查询失败，需进一步核对接口、权限或固件支持。" }
        return [pscustomobject]@{ Bytes = $bytes; Status = $status }
    } catch {
        Write-DiagnosticException ('http.request.' + $requestId) $_
        throw
    } finally {
        if ($response) { $response.Dispose() }
        if ($request) { $request.Dispose() }
    }
}

function Convert-DeviceJson($Reply) {
    try { $data = [Text.Encoding]::UTF8.GetString($Reply.Bytes) | ConvertFrom-Json }
    catch { throw '设备未返回预期的 JSON 数据，需核对该固件接口格式。' }
    if ($null -ne $data.statusCode -and [string]$data.statusCode -ne '1') {
        $code = [string]$data.subStatusCode
        if ($code -notmatch '^[a-zA-Z0-9_. -]{1,80}$') { $code = 'unknown' }
        throw "设备返回查询错误：$code。此结果不代表设备一定不支持照片读取。"
    }
    return $data
}

function Find-DevicePersonByPhone($Client, [uri]$Origin, $Login, [string]$Phone) {
    # Scan every page locally; do not depend on firmware-specific fuzzy search.
    $searchId = [guid]::NewGuid().ToString('N')
    $position = 0; $expectedTotal = $null; $found = $null
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    for ($page = 0; $page -lt 1000; $page++) {
        $body = @{ UserInfoSearchCond = @{ searchID = $searchId; searchResultPosition = $position; maxResults = 30 } }
        $data = Convert-DeviceJson (Invoke-DeviceRead $Client ([uri]::new($Origin, '/ISAPI/AccessControl/UserInfo/Search?format=json')) 'POST' $body -Login $Login)
        $result = $data.UserInfoSearch
        $total = 0
        if ($null -eq $result -or -not [int]::TryParse([string]$result.totalMatches, [ref]$total) -or $total -lt 0) {
            throw '人员分页响应缺少有效总数，无法确认手机号唯一匹配。'
        }
        if ($null -eq $expectedTotal) { $expectedTotal = $total }
        elseif ($total -ne $expectedTotal) { throw '查询期间人员总数发生变化，请稍后重新检测。' }
        $people = @($result.UserInfo | Where-Object { $null -ne $_ })
        Write-Diagnostic 'person.page' @{ page = $page + 1; offset = $position; total = $total; returned = $people.Count }
        if ($people.Count -gt 30 -or ($position + $people.Count) -gt $total -or ($people.Count -eq 0 -and $position -lt $total)) {
            throw '人员分页响应不完整，无法确认手机号唯一匹配。'
        }
        foreach ($person in $people) {
            $id = [string]$person.employeeNo
            $personName = [string]$person.name
            $parsedPhone = Get-PhoneSuffix $personName
            Write-Diagnostic 'person.nameCheck' @{ person = (Protect-DiagnosticValue $id 'employeeNo'); nameLength = $personName.Length; whitespaceCount = [regex]::Matches($personName, '\s').Count; phoneSuffixRecognized = [bool]$parsedPhone; matchesInput = ($parsedPhone -ceq $Phone) }
            if ([string]::IsNullOrWhiteSpace($id) -or -not $seen.Add($id)) { throw '人员分页包含缺失或重复编号，已停止以避免匹配错误。' }
            if ($parsedPhone -ceq $Phone) {
                Write-Diagnostic 'person.phoneMatch' @{ person = (Protect-DiagnosticValue $id 'employeeNo'); page = $page + 1; alreadyMatched = ($null -ne $found) }
                if ($null -ne $found) { throw '有多名人员的姓名包含同一个手机号，请先在 iVMS-4200 核对；工具不会任选照片。' }
                $found = $person
            }
        }
        $position += $people.Count
        Write-Host ('已核对人员：' + $position + '/' + $total)
        if ($position -eq $total) {
            if ($null -eq $found) { throw '未找到姓名末尾手机号一致的人员。请核对完整11位号码、姓名格式及人员是否已下发到此门禁。' }
            return $found
        }
    }
    throw '查询页数超出检测范围，未完成唯一匹配验证。'
}

function Invoke-PhotoCheck([string]$Address, [string]$Phone, $Login, [string]$Destination, [string]$FaceLibraryId) {
    Initialize-Diagnostics $Destination
    $script:DiagnosticSecrets = @($Phone, $Login.UserName, $Login.GetNetworkCredential().Password)
    $report = [ordered]@{
        toolVersion = '1.2'; time = (Get-Date).ToString('s'); device = ''
        deviceInfo = '未检测'; personRead = '未检测'; phoneSuffix = '未检测'
        photoRead = '未检测'; faceLibraryId = $FaceLibraryId; faceLibraryType = 'blackFD'
        result = '未完成'; detail = ''; photoFile = $null
    }
    $client = $null
    $stage = 'deviceInfo'
    try {
        Add-Type -AssemblyName System.Net.Http
        Add-Type -AssemblyName System.Drawing
        $origin = [uri]$Address
        if (-not $origin.IsAbsoluteUri -or $origin.Scheme -notin @('http', 'https') -or
            $origin.UserInfo -or $origin.Query -or $origin.Fragment -or $origin.AbsolutePath -ne '/') {
            throw '设备地址应类似 http://192.168.110.4，不能包含账号、密码或路径。'
        }
        $Phone = $Phone.Trim()
        if ($Phone -notmatch '^1[3-9][0-9]{9}$') { throw '请输入完整的11位中国大陆手机号。' }
        $report.device = $origin.Authority
        $handler = [System.Net.Http.HttpClientHandler]::new()
        $handler.AllowAutoRedirect = $false; $handler.UseProxy = $false
        $client = [System.Net.Http.HttpClient]::new($handler)
        $client.Timeout = [TimeSpan]::FromSeconds(20)
        $client.MaxResponseContentBufferSize = 5 * 1024 * 1024
        Write-Diagnostic 'connection.settings' @{ device = $origin.Authority; scheme = $origin.Scheme; timeoutSeconds = 20; proxy = $false; redirects = $false; faceLibrary = $FaceLibraryId }
        Write-Diagnostic 'stage.start' @{ stage = $stage }
        Write-Host '1/3 正在验证设备连接和登录...'
        $info = Invoke-DeviceRead $client ([uri]::new($origin, '/ISAPI/System/deviceInfo')) -Login $Login
        $xmlSettings = [Xml.XmlReaderSettings]::new()
        $xmlSettings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
        $xmlSettings.XmlResolver = $null
        $reader = [Xml.XmlReader]::Create([IO.StringReader]::new([Text.Encoding]::UTF8.GetString($info.Bytes)), $xmlSettings)
        try {
            $doc = [Xml.XmlDocument]::new(); $doc.XmlResolver = $null; $doc.Load($reader)
            $model = $doc.SelectSingleNode('//*[local-name()="model"]')
            $firmware = $doc.SelectSingleNode('//*[local-name()="firmwareVersion"]')
            if (-not $model) { throw '响应中没有设备型号，尚未确认设备连接。' }
            $report.deviceInfo = '成功'
            $report.model = $model.InnerText
            if ($firmware) { $report.firmware = $firmware.InnerText }
        } finally { $reader.Dispose() }

        $stage = 'personRead'
        Write-Diagnostic 'stage.start' @{ stage = $stage }
        Write-Host '2/3 正在按手机号核对门禁人员姓名...'
        $person = Find-DevicePersonByPhone $client $origin $Login $Phone
        $EmployeeId = [string]$person.employeeNo
        $report.personRead = '成功'
        $report.phoneSuffix = '已按姓名末尾的11位手机号唯一匹配人员'
        Write-Host ('手机号匹配成功：' + $Phone.Substring(0,3) + '****' + $Phone.Substring(7))

        $stage = 'photoRead'
        Write-Diagnostic 'stage.start' @{ stage = $stage }
        Write-Host '3/3 正在查询并下载该人员的登记照片...'
        # Probe the common access-terminal library. A failure is inconclusive, not a claim of no support.
        $faceBody = @{ searchID = [guid]::NewGuid().ToString('N'); searchResultPosition = 0; maxResults = 1; faceLibType = 'blackFD'; FDID = $FaceLibraryId; FPID = $EmployeeId }
        $face = Convert-DeviceJson (Invoke-DeviceRead $client ([uri]::new($origin, '/ISAPI/Intelligent/FDLib/FDSearch?format=json')) 'POST' $faceBody -Login $Login)
        $faces = @($face.MatchList | Where-Object { $null -ne $_ })
        if ($faces.Count -ne 1 -or [string]$faces[0].FPID -cne $EmployeeId) {
            throw '未返回唯一且编号一致的人脸记录；需核对人脸库编号、接口格式或照片保存设置。'
        }
        if (-not $faces[0].faceURL) { throw '记录中没有可下载照片地址；需核对该固件返回格式及是否保留登记底图。' }
        $photoUri = Get-SameOriginUri $origin ([string]$faces[0].faceURL)
        $photo = Invoke-DeviceRead $client $photoUri -Login $Login
        $stream = [IO.MemoryStream]::new($photo.Bytes, $false)
        $bitmap = $null
        try {
            $bitmap = [Drawing.Image]::FromStream($stream)
            if ($bitmap.Width -lt 1 -or $bitmap.Height -lt 1 -or ([long]$bitmap.Width * $bitmap.Height) -gt 16000000) { throw '照片尺寸超出检测范围。' }
            $bitmap.Save((Join-Path $Destination 'sample-photo.jpg'), [Drawing.Imaging.ImageFormat]::Jpeg)
            Write-Diagnostic 'photo.saved' @{ width = $bitmap.Width; height = $bitmap.Height; receivedBytes = $photo.Bytes.Length; file = 'sample-photo.jpg' }
        } finally { if ($bitmap) { $bitmap.Dispose() }; $stream.Dispose() }
        $report.photoRead = '成功'
        $report.photoFile = 'sample-photo.jpg'
        $report.result = '手机号唯一匹配和照片下载均通过；请在本机核对照片是否为测试人员。'
    } catch {
        Write-DiagnosticException $stage $_
        $report[$stage] = '未通过'
        $report.result = '检测未全部通过；尚不能据此断定设备不支持。'
        # Avoid saving raw network exceptions, which can include sensitive URLs.
        if ($_.Exception -is [System.Management.Automation.RuntimeException] -and $_.Exception.Message -notmatch 'Exception calling|调用.*异常') {
            $report.detail = $_.Exception.Message
        } else { $report.detail = '连接超时、网络/证书异常或响应处理失败。请将此报告交给开发人员。' }
    } finally {
        if ($client) { $client.Dispose() }
        $reportPath = Join-Path $Destination 'report.json'
        $report.detail = Protect-DiagnosticText $report.detail
        $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
        Write-Diagnostic 'check.result' @{ deviceInfo = $report.deviceInfo; personRead = $report.personRead; photoRead = $report.photoRead; detail = (Protect-DiagnosticText $report.detail) }
        Complete-Diagnostics
        $script:DiagnosticSecrets = @()
    }
    Write-Host $report.result
    if ($report.detail) { Write-Host $report.detail }
    Write-Host ('结果目录：' + $Destination)
    return [pscustomobject]$report
}

if ($LoadFunctionsOnly) { return }
try {
    if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot ('results-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6)) }
    Initialize-Diagnostics $OutputDirectory
    Write-Host '悦体健身 - 海康登记照片读取检测'
    Write-Host '请在门店电脑运行。按手机号查询登记照片，不改动人员、权限或会员数据。'
    Write-Host ('设备地址：' + $DeviceAddress)
    if (-not $PhoneNumber) { $PhoneNumber = Read-Host '请输入要查询的11位手机号（如姓名为 张三 13800138000，只输入号码）' }
    $PhoneNumber = $PhoneNumber.Trim()
    if ($PhoneNumber -notmatch '^1[3-9][0-9]{9}$') { throw '请输入完整的11位中国大陆手机号。' }
    if (-not $Credential) {
        $username = Read-Host '设备登录用户名（直接回车使用 admin）'
        if (-not $username) { $username = 'admin' }
        $secret = Read-Host '设备登录密码（输入不会显示；不是 iVMS-4200 软件登录密码）' -AsSecureString
        $Credential = [System.Management.Automation.PSCredential]::new($username, $secret)
    }
    $result = Invoke-PhotoCheck $DeviceAddress $PhoneNumber $Credential $OutputDirectory $LibraryId
    if ($result.photoRead -ne '成功') { exit 1 }
} catch {
    if ($script:DiagnosticDirectory) { Write-DiagnosticException 'startup' $_; Complete-Diagnostics; Write-Host ('日志目录：' + $script:DiagnosticDirectory) }
    Write-Host '无法开始检测，请检查填写内容、目录写入权限及运行环境。'; exit 1
}
