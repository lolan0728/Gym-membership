use super::*;
use std::{
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

struct Fixture {
    url: Url,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
    requests: Arc<Mutex<Vec<String>>>,
}
impl Fixture {
    fn new(mode: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let base = url.to_string();
        let stop = Arc::new(AtomicBool::new(false));
        let s = stop.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let records = requests.clone();
        let validity = Arc::new(Mutex::new((
            "2026-01-01T00:00:00".to_string(),
            "2026-12-31T23:59:59".to_string(),
        )));
        let validity_state = validity.clone();
        let handle = thread::spawn(move || {
            while !s.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut bytes = Vec::new();
                        let mut buffer = [0u8; 4096];
                        let (header, length) = loop {
                            let n = stream.read(&mut buffer).unwrap_or(0);
                            if n == 0 {
                                return;
                            }
                            bytes.extend_from_slice(&buffer[..n]);
                            if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                                let header = String::from_utf8_lossy(&bytes[..end]).to_string();
                                let length = header
                                    .lines()
                                    .find_map(|line| {
                                        line.to_ascii_lowercase()
                                            .strip_prefix("content-length:")
                                            .and_then(|v| v.trim().parse::<usize>().ok())
                                    })
                                    .unwrap_or(0);
                                break (header, (end + 4, length));
                            }
                        };
                        while bytes.len() < length.0 + length.1 {
                            let n = stream.read(&mut buffer).unwrap_or(0);
                            if n == 0 {
                                break;
                            }
                            bytes.extend_from_slice(&buffer[..n]);
                        }
                        let path = header
                            .lines()
                            .next()
                            .unwrap()
                            .split_whitespace()
                            .nth(1)
                            .unwrap()
                            .to_string();
                        if !header
                            .to_ascii_lowercase()
                            .contains("authorization: digest")
                            || mode == "unauthorized"
                        {
                            respond(&mut stream,401,"WWW-Authenticate: Digest realm=\"fixture\", nonce=\"nonce\", qop=\"auth\", algorithm=MD5\r\n",b"");
                            continue;
                        }
                        assert!(header.contains(&format!("uri=\"{path}\"")));
                        records.lock().unwrap().push(path.clone());
                        if mode == "forbidden" {
                            respond(&mut stream, 403, "", b"");
                            continue;
                        }
                        if mode == "unsupported" {
                            respond(&mut stream, 404, "", b"");
                            continue;
                        }
                        if mode == "malformed" {
                            respond(&mut stream, 200, "", b"invalid-json");
                            continue;
                        }
                        let body: Value =
                            serde_json::from_slice(&bytes[length.0..]).unwrap_or(Value::Null);
                        if path.contains("UserInfo/Search") {
                            let position = body["UserInfoSearchCond"]["searchResultPosition"]
                                .as_u64()
                                .unwrap() as usize;
                            assert!(body["UserInfoSearchCond"].get("EmployeeNoList").is_none());
                            let name = match mode {
                                "space" => "王某某　 13800138000　",
                                "missing" => "王某某13800138001",
                                "ambiguous" => "王13800138000 13900139000",
                                _ => "王某某13800138000",
                            };
                            let current = validity_state.lock().unwrap().clone();
                            let mut people = vec![
                                json!({"employeeNo":"1","name":"无关913800138000"}),
                                json!({"employeeNo":"7","name":name,"userType":"normal","Valid":{"enable":true,"beginTime":current.0,"endTime":current.1,"timeType":"local"}}),
                            ];
                            if mode == "duplicate" {
                                people.push(json!({"employeeNo":"8","name":"李13800138000"}));
                            }
                            if mode == "repeated" {
                                people[1] = people[0].clone();
                            }
                            let page = if mode == "incomplete" && position == 1 {
                                vec![]
                            } else {
                                vec![people[position].clone()]
                            };
                            let value = json!({"UserInfoSearch":{"totalMatches":people.len(),"UserInfo":page}});
                            respond(&mut stream, 200, "", value.to_string().as_bytes());
                        } else if path.contains("UserInfo/Modify") {
                            assert_eq!(body["UserInfo"]["employeeNo"], "7");
                            assert_eq!(body["UserInfo"]["userType"], "normal");
                            assert_eq!(body["UserInfo"]["Valid"]["enable"], true);
                            *validity_state.lock().unwrap() = (
                                body["UserInfo"]["Valid"]["beginTime"]
                                    .as_str()
                                    .unwrap()
                                    .to_string(),
                                body["UserInfo"]["Valid"]["endTime"]
                                    .as_str()
                                    .unwrap()
                                    .to_string(),
                            );
                            respond(
                                &mut stream,
                                200,
                                "",
                                json!({"statusCode":1}).to_string().as_bytes(),
                            );
                        } else if path.contains("FDSearch") {
                            assert_eq!(body["FPID"], "7");
                            let id = if mode == "wrong-person" { "8" } else { "7" };
                            let photo = if mode == "foreign" {
                                "http://example.invalid/photo".to_string()
                            } else {
                                format!("{base}photo")
                            };
                            let matches = if mode == "no-photo" {
                                vec![]
                            } else {
                                vec![json!({"FPID":id,"faceURL":photo})]
                            };
                            respond(
                                &mut stream,
                                200,
                                "",
                                json!({"MatchList":matches}).to_string().as_bytes(),
                            );
                        } else if path == "/photo" {
                            if mode == "redirect" {
                                respond(
                                    &mut stream,
                                    302,
                                    "Location: http://example.invalid/\r\n",
                                    b"",
                                );
                            } else if mode == "oversize" {
                                let _=stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6000000\r\nConnection: close\r\n\r\n");
                            } else {
                                let mut output = std::io::Cursor::new(Vec::new());
                                image::DynamicImage::new_rgb8(2, 2)
                                    .write_to(&mut output, image::ImageFormat::Jpeg)
                                    .unwrap();
                                let bytes = output.into_inner();
                                respond(
                                    &mut stream,
                                    200,
                                    "",
                                    if mode == "bad-image" {
                                        b"not-an-image"
                                    } else if mode == "corrupt-image" {
                                        &[0xff, 0xd8, 0xff, 0x01]
                                    } else {
                                        &bytes
                                    },
                                );
                            }
                        } else {
                            panic!("unexpected endpoint");
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(e) => panic!("{e}"),
                }
            }
        });
        Self {
            url,
            stop,
            thread: Some(handle),
            requests,
        }
    }
    fn device(&self) -> Device {
        Device::with_base(
            Config {
                address: self.url.to_string(),
                username: "tester".into(),
                password: "secret".into(),
            },
            self.url.clone(),
            None,
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn respond(stream: &mut TcpStream, status: u16, headers: &str, body: &[u8]) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
        body.len()
    );
    let _ = stream.write_all(body);
}

#[test]
fn paginated_photo_and_failures() {
    for (mode, code) in [
        ("success", "ok"),
        ("space", "ok"),
        ("missing", "not_found"),
        ("ambiguous", "ambiguous"),
        ("duplicate", "duplicate"),
        ("repeated", "pagination"),
        ("incomplete", "pagination"),
        ("wrong-person", "face_mismatch"),
        ("foreign", "photo_origin"),
        ("no-photo", "no_photo"),
        ("bad-image", "image"),
        ("corrupt-image", "image"),
        ("oversize", "size"),
        ("redirect", "redirect"),
        ("unauthorized", "authentication"),
        ("forbidden", "permission"),
        ("unsupported", "unsupported"),
        ("malformed", "response"),
    ] {
        let fixture = Fixture::new(mode);
        let result = fixture.device().photo("13800138000");
        assert_eq!(
            result.as_ref().err().map(|e| e.code).unwrap_or("ok"),
            code,
            "mode {mode}"
        );
        if code == "ok" {
            assert_eq!(result.unwrap().device_name, "王某某");
        }
        if ["not_found", "ambiguous", "duplicate", "pagination"].contains(&code) {
            assert!(!fixture
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|s| s.contains("FDSearch")));
        }
    }
}
#[test]
fn deadline_and_origin() {
    let fixture = Fixture::new("success");
    let mut device = fixture.device();
    device.started = Instant::now() - Duration::from_secs(91);
    assert_eq!(device.photo("13800138000").err().unwrap().code, "timeout");
    assert!(device.photo_url("http://example.invalid/p").is_err());
    assert!(device.photo_url("//user:pass@127.0.0.1/p").is_err());
    assert!(device.photo_url("/p").is_ok());
}

#[test]
fn validity_write_and_read_back() {
    let fixture = Fixture::new("success");
    let device = fixture.device();
    let photo = device.photo("13800138000").unwrap();
    device
        .modify_validity(&photo, "2027-01-02T00:00:00", "2027-12-30T23:59:59")
        .unwrap();
    device
        .verify_validity("13800138000", "2027-01-02T00:00:00", "2027-12-30T23:59:59")
        .unwrap();
    assert!(fixture
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|p| p.contains("UserInfo/Modify")));
}
