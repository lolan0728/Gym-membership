use keyring::Entry;
use md5::{Digest, Md5};
use reqwest::{blocking::Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    collections::{HashMap, HashSet},
    fs::OpenOptions,
    io::{Read, Write},
    net::Ipv4Addr,
    path::PathBuf,
    time::{Duration, Instant},
};
use uuid::Uuid;

const SERVICE: &str = "JOYFIT Hikvision";
const ACCOUNT: &str = "connection-v1";
const IMAGE_LIMIT: usize = 5 * 1024 * 1024;
type Result<T> = std::result::Result<T, DeviceError>;

#[derive(Debug, Serialize)]
pub struct DeviceError {
    code: &'static str,
    message: &'static str,
}
fn err(code: &'static str, message: &'static str) -> DeviceError {
    DeviceError { code, message }
}

#[derive(Clone, Serialize, Deserialize)]
struct Config {
    address: String,
    username: String,
    password: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    address: String,
    username: String,
    has_password: bool,
}
impl From<&Config> for Settings {
    fn from(c: &Config) -> Self {
        Self {
            address: c.address.clone(),
            username: c.username.clone(),
            has_password: !c.password.is_empty(),
        }
    }
}
fn entry() -> Result<Entry> {
    Entry::new(SERVICE, ACCOUNT).map_err(|_| {
        err(
            "credential",
            "无法访问 Windows 门禁凭据，请检查当前用户权限",
        )
    })
}
fn load() -> Result<Option<Config>> {
    match entry()?.get_password() {
        Ok(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|_| err("credential", "门禁配置无法读取，请重新保存配置")),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(err("credential", "无法读取门禁凭据，请在本机重新保存配置")),
    }
}
fn configured() -> Result<Config> {
    load()?.ok_or_else(|| {
        err(
            "not_configured",
            "请先在系统设置中保存海康门禁地址、账号和密码",
        )
    })
}
fn validate_address(address: &str) -> Result<Url> {
    let invalid = || err("address", "请输入局域网 IP 地址，例如 http://192.168.110.4");
    let url = Url::parse(address.trim()).map_err(|_| invalid())?;
    let ip = url
        .host_str()
        .and_then(|s| s.parse::<Ipv4Addr>().ok())
        .ok_or_else(invalid)?;
    if !ip.is_private()
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(url)
}
#[tauri::command]
pub fn hikvision_settings() -> Result<Settings> {
    Ok(load()?.as_ref().map(Settings::from).unwrap_or(Settings {
        address: "http://192.168.110.4".into(),
        username: "admin".into(),
        has_password: false,
    }))
}
#[tauri::command]
pub fn save_hikvision_settings(
    address: String,
    username: String,
    password: String,
) -> Result<Settings> {
    let address = validate_address(&address)?.to_string();
    let username = username.trim().to_owned();
    if username.is_empty()
        || username.len() > 128
        || username.chars().any(char::is_control)
        || password.len() > 256
    {
        return Err(err("credentials", "请填写有效的门禁用户名和密码"));
    }
    let password = if password.is_empty() {
        let old = configured()?;
        if validate_address(&old.address)?.as_str() != address || old.username != username {
            return Err(err(
                "password_required",
                "设备地址或用户名已改变，请重新填写门禁密码",
            ));
        }
        old.password
    } else {
        password
    };
    let config = Config {
        address,
        username,
        password,
    };
    entry()?
        .set_password(
            &serde_json::to_string(&config).map_err(|_| err("credential", "无法保存门禁配置"))?,
        )
        .map_err(|_| {
            err(
                "credential",
                "无法保存 Windows 门禁凭据，请检查当前用户权限",
            )
        })?;
    Ok(Settings::from(&config))
}

// Digits must be complete runs; never accept a suffix of a longer number.
fn phones(name: &str) -> Vec<&str> {
    name.split(|c: char| !c.is_ascii_digit())
        .filter(|s| s.len() == 11 && s.starts_with('1') && matches!(s.as_bytes()[1], b'3'..=b'9'))
        .collect()
}
fn valid_phone(phone: &str) -> bool {
    phones(phone) == vec![phone]
}
fn person_name(name: &str, phone: &str) -> Option<String> {
    let name = name.trim();
    if phones(name).len() != 1 {
        return None;
    }
    name.strip_suffix(phone).map(|n| n.trim().to_string())
}

fn challenge_fields(input: &str) -> Result<HashMap<String, String>> {
    let input = input.trim();
    let input = input
        .get(..7)
        .filter(|s| s.eq_ignore_ascii_case("Digest "))
        .map(|_| &input[7..])
        .ok_or_else(|| err("auth_scheme", "设备未提供支持的 Digest 认证"))?;
    let mut parts = Vec::new();
    let mut part = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for c in input.chars() {
        if escaped {
            part.push(c);
            escaped = false;
            continue;
        }
        if c == '\\' && quoted {
            escaped = true;
            continue;
        }
        if c == '"' {
            quoted = !quoted;
            continue;
        }
        if c == ',' && !quoted {
            parts.push(std::mem::take(&mut part));
        } else {
            part.push(c);
        }
    }
    parts.push(part);
    if quoted || escaped {
        return Err(err("auth_format", "设备认证响应格式异常"));
    }
    Ok(parts
        .iter()
        .filter_map(|s| {
            s.split_once('=')
                .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))
        })
        .collect())
}
fn digest_header(
    challenge: &str,
    method: &str,
    uri: &str,
    config: &Config,
    cnonce: &str,
) -> Result<String> {
    let f = challenge_fields(challenge)?;
    let required = |key: &str| {
        f.get(key)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| err("auth_format", "设备认证响应缺少必要字段"))
    };
    let realm = required("realm")?;
    let nonce = required("nonce")?;
    let algorithm = f
        .get("algorithm")
        .map(|s| s.to_ascii_uppercase())
        .unwrap_or("MD5".into());
    if !matches!(
        algorithm.as_str(),
        "MD5" | "MD5-SESS" | "SHA-256" | "SHA-256-SESS"
    ) {
        return Err(err("auth_algorithm", "设备的认证算法暂不支持"));
    }
    let use_qop = f.contains_key("qop");
    if use_qop && !f["qop"].split(',').any(|v| v.trim() == "auth") {
        return Err(err("auth_qop", "设备的认证模式暂不支持"));
    }
    let hash = |s: &str| {
        if algorithm.starts_with("SHA-256") {
            format!("{:x}", Sha256::digest(s.as_bytes()))
        } else {
            format!("{:x}", Md5::digest(s.as_bytes()))
        }
    };
    let mut ha1 = hash(&format!(
        "{}:{}:{}",
        config.username, realm, config.password
    ));
    if algorithm.ends_with("-SESS") {
        ha1 = hash(&format!("{ha1}:{nonce}:{cnonce}"));
    }
    let ha2 = hash(&format!("{method}:{uri}"));
    let response = hash(&if use_qop {
        format!("{ha1}:{nonce}:00000001:{cnonce}:auth:{ha2}")
    } else {
        format!("{ha1}:{nonce}:{ha2}")
    });
    let quote = |s: &str| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""));
    let mut header = format!(
        "Digest username={}, realm={}, nonce={}, uri={}, response={}, algorithm={}",
        quote(&config.username),
        quote(realm),
        quote(nonce),
        quote(uri),
        quote(&response),
        algorithm
    );
    if use_qop {
        header.push_str(&format!(
            ", qop=auth, nc=00000001, cnonce={}",
            quote(cnonce)
        ));
    } else if algorithm.ends_with("-SESS") {
        header.push_str(&format!(", cnonce={}", quote(cnonce)));
    }
    if let Some(opaque) = f.get("opaque") {
        header.push_str(&format!(", opaque={}", quote(opaque)));
    }
    Ok(header)
}

struct Device {
    client: Client,
    config: Config,
    base: Url,
    started: Instant,
    log: Option<PathBuf>,
    operation: String,
}
impl Device {
    fn new(config: Config, log: Option<PathBuf>) -> Result<Self> {
        let base = validate_address(&config.address)?;
        Self::with_base(config, base, log)
    }
    fn with_base(config: Config, base: Url, log: Option<PathBuf>) -> Result<Self> {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| err("client", "门禁网络组件初始化失败"))?;
        Ok(Self {
            client,
            config,
            base,
            started: Instant::now(),
            log,
            operation: Uuid::new_v4().to_string(),
        })
    }
    fn log(&self, event: &str, detail: Value) {
        if let Some(directory) = &self.log {
            let _ = std::fs::create_dir_all(directory);
            let path = directory.join(format!(
                "hikvision-{}.log",
                chrono::Local::now().format("%Y-%m")
            ));
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(
                    file,
                    "{}",
                    json!({"time":chrono::Utc::now().to_rfc3339(),"operation":self.operation,"event":event,"detail":detail})
                );
            }
        }
    }
    fn photo_url(&self, location: &str) -> Result<Url> {
        let url = self
            .base
            .join(location)
            .map_err(|_| err("photo_url", "门禁返回的照片地址无效"))?;
        if url.origin() != self.base.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(err(
                "photo_origin",
                "照片地址与配置的门禁设备不一致，已停止下载",
            ));
        }
        Ok(url)
    }
    fn request(
        &self,
        method: Method,
        url: Url,
        body: Option<Value>,
        stage: &str,
        limit: usize,
    ) -> Result<Vec<u8>> {
        let mut authorization = None;
        for attempt in 1..=2 {
            let remaining = Duration::from_secs(90)
                .checked_sub(self.started.elapsed())
                .filter(|t| !t.is_zero())
                .ok_or_else(|| err("timeout", "门禁查询超时，请检查网络后重试"))?;
            let mut request = self
                .client
                .request(method.clone(), url.clone())
                .timeout(remaining.min(Duration::from_secs(20)));
            if let Some(value) = &body {
                request = request.json(value);
            }
            if let Some(value) = &authorization {
                request = request.header(reqwest::header::AUTHORIZATION, value);
            }
            let started = Instant::now();
            let response = request.send().map_err(|e| {
                if e.is_timeout() {
                    err("timeout", "门禁查询超时，请检查设备网络后重试")
                } else {
                    err("connection", "无法连接门禁，请检查地址、网络和 HTTPS 证书")
                }
            })?;
            let status = response.status().as_u16();
            self.log("http", json!({"stage":stage,"attempt":attempt,"status":status,"elapsedMs":started.elapsed().as_millis()}));
            if status == 401 && attempt == 1 {
                let challenge = response
                    .headers()
                    .get_all(reqwest::header::WWW_AUTHENTICATE)
                    .iter()
                    .filter_map(|v| v.to_str().ok())
                    .find(|v| v.to_ascii_lowercase().starts_with("digest "))
                    .ok_or_else(|| err("auth_scheme", "设备未提供 Digest 认证，请检查设备设置"))?;
                let path = match url.query() {
                    Some(query) => format!("{}?{query}", url.path()),
                    None => url.path().into(),
                };
                authorization = Some(digest_header(
                    challenge,
                    method.as_str(),
                    &path,
                    &self.config,
                    &Uuid::new_v4().simple().to_string(),
                )?);
                continue;
            }
            match status {
                401 => {
                    return Err(err(
                        "authentication",
                        "门禁账号或密码错误，请在系统设置中核对，避免反复尝试",
                    ))
                }
                403 => return Err(err("permission", "门禁账号没有读取或修改人员资料的权限")),
                404 | 405 | 501 => {
                    return Err(err(
                        "unsupported",
                        "设备未提供所需接口，请核对型号、固件和接口设置",
                    ))
                }
                300..=399 => {
                    return Err(err(
                        "redirect",
                        "门禁要求跳转，请核对配置的 HTTP/HTTPS 地址和端口",
                    ))
                }
                200..=299 => (),
                _ => return Err(err("device_http", "门禁返回请求错误，请查看门禁诊断日志")),
            }
            if response
                .content_length()
                .is_some_and(|size| size > limit as u64)
            {
                return Err(err("size", "门禁返回的数据过大，照片不能超过5MB"));
            }
            let mut bytes = Vec::new();
            response
                .take(limit as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| err("download", "门禁数据读取失败或超时，请重试"))?;
            if bytes.len() > limit {
                return Err(err("size", "门禁返回的数据过大，照片不能超过5MB"));
            }
            self.log("received", json!({"stage":stage,"bytes":bytes.len(),"elapsedMs":started.elapsed().as_millis()}));
            return Ok(bytes);
        }
        Err(err("authentication", "门禁认证失败"))
    }
    fn query(&self, path: &str, body: Value, stage: &str) -> Result<Value> {
        let bytes = self.request(
            Method::POST,
            self.base.join(path).unwrap(),
            Some(body),
            stage,
            2 * 1024 * 1024,
        )?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| err("response", "门禁接口响应格式异常，请查看诊断日志"))?;
        if value.get("statusCode").is_some_and(|code| code != 1) {
            let sub = value["subStatusCode"].as_str().unwrap_or("");
            // Do not log device-supplied text: it can include personal data.
            if sub.to_ascii_lowercase().contains("notsupport") {
                return Err(err("unsupported", "当前门禁固件不支持此接口"));
            }
            return Err(err(
                "device_response",
                "门禁未能完成查询，请核对设备权限和接口设置",
            ));
        }
        Ok(value)
    }
    fn find(&self, phone: &str) -> Result<PersonMatch> {
        if !valid_phone(phone) {
            return Err(err("phone", "请先填写正确的11位手机号"));
        }
        let mut seen = HashSet::new();
        let mut position = 0;
        let mut expected = None;
        let mut found = None;
        let mut matches = 0;
        let mut ambiguous = false;
        let search = Uuid::new_v4().simple().to_string();
        for page in 1..=1000 {
            let value = self.query("/ISAPI/AccessControl/UserInfo/Search?format=json", json!({"UserInfoSearchCond":{"searchID":search,"searchResultPosition":position,"maxResults":30}}), "person")?;
            let result = &value["UserInfoSearch"];
            let total = result["totalMatches"]
                .as_u64()
                .ok_or_else(|| err("pagination", "人员分页缺少有效总数，无法确认唯一匹配"))?;
            if expected.is_some_and(|count| count != total) {
                return Err(err("pagination", "门禁人员在查询期间发生变化，请稍后重试"));
            }
            expected = Some(total);
            let empty = Vec::new();
            let people = match result.get("UserInfo") {
                Some(Value::Array(items)) => items,
                None if total == 0 => &empty,
                _ => return Err(err("pagination", "门禁人员分页格式异常")),
            };
            if result
                .get("numOfMatches")
                .is_some_and(|n| n.as_u64() != Some(people.len() as u64))
            {
                return Err(err("pagination", "门禁人员分页数量不一致"));
            }
            if people.len() > 30
                || position + people.len() as u64 > total
                || (people.is_empty() && position < total)
            {
                return Err(err("pagination", "门禁人员分页不完整，已停止取得照片"));
            }
            self.log(
                "person.page",
                json!({"page":page,"returned":people.len(),"total":total}),
            );
            for person in people {
                let id = person["employeeNo"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| err("pagination", "门禁人员缺少编号，无法核对"))?;
                if !seen.insert(id.to_owned()) {
                    return Err(err("pagination", "门禁人员分页重复，无法确认唯一匹配"));
                }
                let name = person["name"].as_str().unwrap_or("");
                let numbers = phones(name);
                if numbers.contains(&phone) && numbers.len() != 1 {
                    ambiguous = true;
                }
                if numbers.contains(&phone) {
                    matches += 1;
                    if let Some(name) = person_name(name, phone) {
                        found = Some(PersonMatch {
                            id: id.to_owned(),
                            name,
                            user_type: person["userType"].as_str().unwrap_or("normal").to_owned(),
                            valid: person.get("Valid").cloned().unwrap_or(Value::Null),
                        });
                    }
                }
            }
            position += people.len() as u64;
            if position == total {
                self.log("person.match", json!({"matches":matches,"pages":page}));
                if ambiguous {
                    return Err(err("ambiguous", "门禁姓名包含多个手机号，请先在门禁中核对"));
                }
                if matches > 1 {
                    return Err(err(
                        "duplicate",
                        "门禁中有多名人员使用这个手机号，请先核对，不能自动选择照片",
                    ));
                }
                return found.ok_or_else(|| {
                    err(
                        "not_found",
                        "门禁中未找到该手机号，请核对姓名末尾号码及人员是否已下发到此设备",
                    )
                });
            }
        }
        Err(err("pagination", "门禁人员查询超出范围，请联系维护人员"))
    }
    fn photo(&self, phone: &str) -> Result<Photo> {
        let person = self.find(phone)?;
        self.photo_for_person(person)
    }
    fn photo_for_person(&self, person: PersonMatch) -> Result<Photo> {
        let value = self.query("/ISAPI/Intelligent/FDLib/FDSearch?format=json", json!({"searchID":Uuid::new_v4().simple().to_string(),"searchResultPosition":0,"maxResults":1,"faceLibType":"blackFD","FDID":"1","FPID":person.id}), "face")?;
        let faces = value["MatchList"].as_array().ok_or_else(|| {
            err(
                "no_photo",
                "该人员没有可读取的登记照片，请在门禁中登记并下发照片",
            )
        })?;
        if faces.is_empty() {
            return Err(err("no_photo", "该人员没有登记照片"));
        }
        if faces.len() != 1 || faces[0]["FPID"].as_str() != Some(person.id.as_str()) {
            return Err(err("face_mismatch", "照片记录与匹配人员不一致，已停止取得"));
        }
        let location = faces[0]["faceURL"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| err("no_photo", "门禁未提供登记照片，请核对是否保留并下发了照片"))?;
        let bytes = self.request(
            Method::GET,
            self.photo_url(location)?,
            None,
            "photo",
            IMAGE_LIMIT,
        )?;
        let mime = if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            "image/jpeg"
        } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            "image/png"
        } else {
            return Err(err("image", "门禁返回的照片不是有效的 JPEG 或 PNG 图片"));
        };
        let invalid = || err("image", "门禁图片无效或超过1600万像素，请重新登记照片");
        let format = if mime == "image/jpeg" {
            image::ImageFormat::Jpeg
        } else {
            image::ImageFormat::Png
        };
        let reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format);
        let (width, height) = reader.into_dimensions().map_err(|_| invalid())?;
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 16_000_000 {
            return Err(invalid());
        }
        let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format);
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(128 * 1024 * 1024);
        reader.limits(limits);
        let decoded = reader.decode().map_err(|_| invalid())?;
        let mut hasher = Sha256::new();
        hasher.update(decoded.width().to_be_bytes());
        hasher.update(decoded.height().to_be_bytes());
        hasher.update(decoded.to_rgba8().as_raw());
        let fingerprint = format!("{:x}", hasher.finalize());
        Ok(Photo {
            bytes,
            mime: mime.into(),
            device_name: person.name,
            photo_fingerprint: fingerprint,
            employee_no: person.id,
            user_type: person.user_type,
            valid: person.valid,
        })
    }
    fn modify_validity(&self, photo: &Photo, begin: &str, end: &str) -> Result<()> {
        let bytes = self.request(
            Method::PUT,
            self.base
                .join("/ISAPI/AccessControl/UserInfo/Modify?format=json")
                .unwrap(),
            Some(json!({"UserInfo":{
                "employeeNo":photo.employee_no,
                "userType":photo.user_type,
                "Valid":{"enable":true,"beginTime":begin,"endTime":end,"timeType":"local"}
            }})),
            "validity.write",
            256 * 1024,
        )?;
        if !bytes.is_empty() {
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| err("response", "门禁有效期写入响应格式异常"))?;
            if value.get("statusCode").is_some_and(|code| code != 1) {
                return Err(err(
                    "device_response",
                    "门禁拒绝修改人员有效期，请检查账号权限和人员状态",
                ));
            }
        }
        Ok(())
    }
    fn verify_validity(&self, phone: &str, begin: &str, end: &str) -> Result<()> {
        let person = self.find(phone)?;
        let valid = &person.valid;
        let read_begin = valid.get("beginTime").and_then(Value::as_str).unwrap_or("");
        let read_end = valid.get("endTime").and_then(Value::as_str).unwrap_or("");
        let enabled = valid
            .get("enable")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !enabled || read_begin != begin || read_end != end {
            return Err(err(
                "verify",
                "门禁返回的有效期与目标值不一致，请在设备中核对",
            ));
        }
        Ok(())
    }
}

struct PersonMatch {
    id: String,
    name: String,
    user_type: String,
    valid: Value,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    bytes: Vec<u8>,
    mime: String,
    device_name: String,
    photo_fingerprint: String,
    #[serde(skip)]
    employee_no: String,
    #[serde(skip)]
    user_type: String,
    #[serde(skip)]
    valid: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidityResult {
    bytes: Vec<u8>,
    mime: String,
    device_name: String,
    photo_fingerprint: String,
    current_begin_time: String,
    current_end_time: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    begin_time: String,
    end_time: String,
    disabled: bool,
}

fn validity_time(start_date: &str, end_date: &str, disabled: bool) -> Result<(String, String)> {
    let parse = |value: &str| {
        chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .map_err(|_| err("date", "门禁有效期日期格式无效"))
    };
    let (start, end) = if disabled {
        (
            chrono::NaiveDate::from_ymd_opt(1970, 1, 1).unwrap(),
            chrono::NaiveDate::from_ymd_opt(1970, 1, 2).unwrap(),
        )
    } else {
        let start = parse(start_date)?;
        let end = parse(end_date)?;
        if end < start {
            return Err(err("date", "门禁到期日期不能早于开始日期"));
        }
        (start, end)
    };
    let minimum = chrono::NaiveDate::from_ymd_opt(1970, 1, 1).unwrap();
    let maximum = chrono::NaiveDate::from_ymd_opt(2037, 12, 31).unwrap();
    if start < minimum || end > maximum {
        return Err(err(
            "date_range",
            "门禁有效期必须在 1970-01-01 至 2037-12-31 之间",
        ));
    }
    Ok((
        format!("{}T00:00:00", start.format("%Y-%m-%d")),
        format!("{}T23:59:59", end.format("%Y-%m-%d")),
    ))
}

#[tauri::command]
pub async fn test_hikvision_connection(
    state: tauri::State<'_, std::sync::Arc<crate::DesktopState>>,
) -> Result<()> {
    let directory = state.operation_log_directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let device = Device::new(configured()?, Some(directory))?;
        let result = device.query("/ISAPI/AccessControl/UserInfo/Search?format=json", json!({"UserInfoSearchCond":{"searchID":Uuid::new_v4().simple().to_string(),"searchResultPosition":0,"maxResults":1}}), "connection_test").and_then(|v| if v["UserInfoSearch"]["totalMatches"].is_u64() { Ok(()) } else { Err(err("response", "设备未返回有效人员查询结果")) });
        device.log("test.result", json!({"code":result.as_ref().err().map(|e| e.code).unwrap_or("ok")})); result
    }).await.map_err(|_| err("internal", "门禁检测任务异常，请重试"))?
}
#[tauri::command]
pub async fn fetch_hikvision_avatar(
    phone: String,
    state: tauri::State<'_, std::sync::Arc<crate::DesktopState>>,
) -> Result<Photo> {
    let directory = state.operation_log_directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let device = Device::new(configured()?, Some(directory))?;
        let result = device.photo(phone.trim());
        device.log("photo.result", json!({"code":result.as_ref().err().map(|e| e.code).unwrap_or("ok"),"elapsedMs":device.started.elapsed().as_millis()})); result
    }).await.map_err(|_| err("internal", "门禁照片读取任务异常，请重试"))?
}

#[tauri::command]
pub async fn preview_hikvision_validity(
    phone: String,
    state: tauri::State<'_, std::sync::Arc<crate::DesktopState>>,
) -> Result<ValidityResult> {
    let directory = state.operation_log_directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let device = Device::new(configured()?, Some(directory))?;
        let photo = device.photo(phone.trim())?;
        let result = ValidityResult {
            current_begin_time: photo
                .valid
                .get("beginTime")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            current_end_time: photo
                .valid
                .get("endTime")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            bytes: photo.bytes.clone(),
            mime: photo.mime.clone(),
            device_name: photo.device_name.clone(),
            photo_fingerprint: photo.photo_fingerprint.clone(),
        };
        device.log(
            "validity.preview",
            json!({"code":"ok","elapsedMs":device.started.elapsed().as_millis()}),
        );
        Ok(result)
    })
    .await
    .map_err(|_| err("internal", "门禁有效期预览任务异常，请重试"))?
}

#[tauri::command]
pub async fn push_hikvision_validity(
    phone: String,
    start_date: String,
    end_date: String,
    disabled: bool,
    expected_photo_fingerprint: String,
    state: tauri::State<'_, std::sync::Arc<crate::DesktopState>>,
) -> Result<PushResult> {
    let directory = state.operation_log_directory.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let (begin,end)=validity_time(&start_date,&end_date,disabled)?;
        let device=Device::new(configured()?,Some(directory))?;
        let photo=device.photo(phone.trim())?;
        if photo.photo_fingerprint!=expected_photo_fingerprint{return Err(err("photo_changed","门禁登记照片在确认后发生变化，请重新核对人员"));}
        device.modify_validity(&photo,&begin,&end)?;
        device.verify_validity(phone.trim(),&begin,&end)?;
        device.log("validity.result",json!({"code":"ok","disabled":disabled,"elapsedMs":device.started.elapsed().as_millis()}));
        Ok(PushResult{begin_time:begin,end_time:end,disabled})
    }).await.map_err(|_|err("internal","门禁有效期写入任务异常，请重试"))?
}

#[cfg(test)]
#[path = "hikvision_tests.rs"]
mod integration_tests;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn phone_rules() {
        for name in [
            "王某某13800138000",
            "王某某 13800138000",
            "王某某　 13800138000　",
        ] {
            assert_eq!(person_name(name, "13800138000").unwrap(), "王某某");
        }
        assert!(phones("王913800138000").is_empty());
        assert!(phones("王138001380001").is_empty());
        assert!(person_name("王13900139000 13800138000", "13800138000").is_none());
        assert!(!valid_phone(""));
        assert!(!valid_phone("138 0013 8000"));
        assert!(valid_phone("13800138000"));
    }
    #[test]
    fn address_rules() {
        for url in ["http://192.168.110.4", "https://10.0.0.1:8443"] {
            assert!(validate_address(url).is_ok());
        }
        for url in [
            "http://example.com",
            "http://127.0.0.1",
            "http://8.8.8.8",
            "http://u:p@192.168.1.1",
            "http://192.168.1.1/path",
            "http://192.168.1.1?x=y",
        ] {
            assert!(validate_address(url).is_err());
        }
    }
    #[test]
    fn rfc_digest_vector() {
        let config = Config {
            address: String::new(),
            username: "Mufasa".into(),
            password: "Circle Of Life".into(),
        };
        let header = digest_header("Digest realm=\"testrealm@host.com\", qop=\"auth,auth-int\", nonce=\"dcd98b7102dd2f0e8b11d0f600bfb0c093\", opaque=\"5ccc069c403ebaf9f0171e9517f40e41\"", "GET", "/dir/index.html", &config, "0a4f113b").unwrap();
        assert!(header.contains("6629fae49393a05397450978507c4ef1"));
        let query = digest_header(
            "Digest realm=\"r\", nonce=\"n\", qop=\"auth\"",
            "POST",
            "/search?format=json",
            &config,
            "c",
        )
        .unwrap();
        assert!(query.contains("uri=\"/search?format=json\""));
    }
    #[test]
    fn validity_date_rules() {
        assert_eq!(
            validity_time("2026-01-02", "2026-12-30", false).unwrap(),
            ("2026-01-02T00:00:00".into(), "2026-12-30T23:59:59".into())
        );
        assert_eq!(
            validity_time("", "", true).unwrap(),
            ("1970-01-01T00:00:00".into(), "1970-01-02T23:59:59".into())
        );
        assert_eq!(
            validity_time("2026-12-30", "2026-01-02", false)
                .unwrap_err()
                .code,
            "date"
        );
        assert_eq!(
            validity_time("2026-01-01", "2038-01-01", false)
                .unwrap_err()
                .code,
            "date_range"
        );
    }
}
