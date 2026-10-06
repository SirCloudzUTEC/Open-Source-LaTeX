use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::{ipc::Response, AppHandle, Manager, State};
use tokio::process::Command;

/// Carpetas que nunca se muestran en el árbol de archivos.
const IGNORED_DIRS: &[&str] = &["node_modules", "target", "__pycache__"];
/// Tiempo máximo de una compilación antes de matarla.
const COMPILE_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Default)]
struct AppState {
    /// PGID del proceso latexmk en curso, para poder detenerlo.
    running_pgid: Mutex<Option<i32>>,
    /// Serializa las compilaciones: latexmk no tolera dos instancias sobre el mismo outdir.
    compile_lock: tokio::sync::Mutex<()>,
}

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<Entry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompileResult {
    pdf_path: Option<String>,
    pdf_updated: bool,
    log: String,
    output: String,
    exit_code: Option<i32>,
    duration_ms: u128,
    cancelled: bool,
}

#[derive(Serialize)]
struct SyncBox {
    page: u32,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Serialize)]
struct SyncSource {
    file: String,
    line: u32,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Hash FNV-1a: estable entre ejecuciones (a diferencia de DefaultHasher).
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Directorio de compilación fuera del proyecto, para no ensuciarlo con .aux/.log.
fn build_dir(app: &AppHandle, root: &str) -> Result<PathBuf, String> {
    let base = app.path().app_cache_dir().map_err(err)?;
    let name = Path::new(root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "proyecto".into());
    Ok(base.join("builds").join(format!("{}-{:016x}", name, fnv1a(root))))
}

fn pdf_path_for(out: &Path, main: &str) -> PathBuf {
    let stem = Path::new(main)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "main".into());
    out.join(format!("{stem}.pdf"))
}

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

fn walk(dir: &Path) -> Vec<Entry> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let mut entries: Vec<Entry> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            let path = e.path();
            let is_dir = path.is_dir();
            if is_dir && IGNORED_DIRS.contains(&name.as_str()) {
                return None;
            }
            let children = if is_dir { walk(&path) } else { vec![] };
            Some(Entry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir,
                children,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

#[tauri::command]
fn list_tree(root: String) -> Vec<Entry> {
    walk(Path::new(&root))
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(err)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
fn write_text(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::write(&path, content).map_err(err)
}

#[tauri::command]
fn read_binary(path: String) -> Result<Response, String> {
    std::fs::read(&path).map(Response::new).map_err(err)
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(err)
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err(format!("Ya existe: {to}"));
    }
    std::fs::rename(&from, &to).map_err(err)
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(err)
    } else {
        std::fs::remove_file(p).map_err(err)
    }
}

#[tauri::command]
fn copy_file(from: String, to: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&to).parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::copy(&from, &to).map(|_| ()).map_err(err)
}

#[tauri::command]
fn check_tools() -> Vec<(String, bool)> {
    ["latexmk", "pdflatex", "xelatex", "lualatex", "synctex", "texcount"]
        .iter()
        .map(|t| {
            let ok = std::process::Command::new("which")
                .arg(t)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            (t.to_string(), ok)
        })
        .collect()
}

#[tauri::command]
async fn compile(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    main: String,
    engine: String,
) -> Result<CompileResult, String> {
    let _guard = state.compile_lock.lock().await;
    let out = build_dir(&app, &root)?;
    std::fs::create_dir_all(&out).map_err(err)?;

    let main_path = Path::new(&main);
    let cwd = main_path.parent().unwrap_or(Path::new(&root)).to_path_buf();
    let file_name = main_path
        .file_name()
        .ok_or("Archivo principal inválido")?
        .to_string_lossy()
        .to_string();
    let pdf = pdf_path_for(&out, &main);
    let before = mtime(&pdf);

    let engine_flag = match engine.as_str() {
        "xelatex" => "-pdfxe",
        "lualatex" => "-pdflua",
        _ => "-pdf",
    };

    let mut cmd = Command::new("latexmk");
    cmd.current_dir(&cwd)
        .arg(engine_flag)
        // -f: como Overleaf, sigue (y re-ejecuta para referencias) aunque haya errores.
        .arg("-f")
        .arg("-interaction=nonstopmode")
        .arg("-file-line-error")
        .arg("-synctex=1")
        .arg("-norc")
        .arg(format!("-outdir={}", out.display()))
        .arg(&file_name)
        // Evita que TeX corte las líneas del log a 79 columnas: facilita el parseo.
        .env("max_print_line", "10000")
        .env("error_line", "254")
        .env("half_error_line", "238")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);

    let start = Instant::now();
    let child = cmd
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar latexmk: {e}"))?;
    let pgid = child.id().map(|p| p as i32);
    *state.running_pgid.lock().unwrap() = pgid;

    let result = tokio::time::timeout(COMPILE_TIMEOUT, child.wait_with_output()).await;
    let was_running = state.running_pgid.lock().unwrap().take().is_some();

    let (output, exit_code, cancelled) = match result {
        Ok(Ok(o)) => {
            let mut s = String::from_utf8_lossy(&o.stdout).into_owned();
            s.push_str(&String::from_utf8_lossy(&o.stderr));
            // Si stop_compile vació el pgid, la compilación fue cancelada.
            (s, o.status.code(), !was_running)
        }
        Ok(Err(e)) => (format!("Error esperando latexmk: {e}"), None, false),
        Err(_) => {
            if let Some(pg) = pgid {
                unsafe { libc::kill(-pg, libc::SIGKILL) };
            }
            (
                format!("La compilación superó {}s y fue detenida.", COMPILE_TIMEOUT.as_secs()),
                None,
                true,
            )
        }
    };

    let log_path = pdf.with_extension("log");
    let log = std::fs::read(&log_path)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    let after = mtime(&pdf);

    Ok(CompileResult {
        pdf_updated: after.is_some() && after != before,
        pdf_path: after.map(|_| pdf.to_string_lossy().to_string()),
        log,
        output,
        exit_code,
        duration_ms: start.elapsed().as_millis(),
        cancelled,
    })
}

#[tauri::command]
fn stop_compile(state: State<'_, AppState>) -> bool {
    if let Some(pg) = state.running_pgid.lock().unwrap().take() {
        unsafe { libc::kill(-pg, libc::SIGTERM) };
        true
    } else {
        false
    }
}

#[tauri::command]
fn clean_build(app: AppHandle, root: String) -> Result<(), String> {
    let out = build_dir(&app, &root)?;
    if out.exists() {
        std::fs::remove_dir_all(out).map_err(err)?;
    }
    Ok(())
}

fn synctex_fields(stdout: &str) -> Vec<(String, String)> {
    stdout
        .lines()
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// Código → PDF. Devuelve la caja en puntos PDF, con origen arriba a la izquierda.
#[tauri::command]
async fn synctex_forward(
    app: AppHandle,
    root: String,
    main: String,
    file: String,
    line: u32,
    column: u32,
) -> Result<Option<SyncBox>, String> {
    let pdf = pdf_path_for(&build_dir(&app, &root)?, &main);
    if !pdf.exists() {
        return Ok(None);
    }
    let out = Command::new("synctex")
        .arg("view")
        .arg("-i")
        .arg(format!("{line}:{column}:{file}"))
        .arg("-o")
        .arg(&pdf)
        .output()
        .await
        .map_err(err)?;
    let fields = synctex_fields(&String::from_utf8_lossy(&out.stdout));
    let get = |k: &str| {
        fields
            .iter()
            .find(|(key, _)| key == k)
            .and_then(|(_, v)| v.trim().parse::<f64>().ok())
    };
    match (get("Page"), get("h"), get("v"), get("W"), get("H")) {
        (Some(page), Some(h), Some(v), Some(w), Some(hh)) => Ok(Some(SyncBox {
            page: page as u32,
            x: h,
            y: v - hh,
            w,
            h: hh.max(8.0),
        })),
        _ => Ok(None),
    }
}

/// PDF → código. Coordenadas en puntos PDF desde arriba a la izquierda.
#[tauri::command]
async fn synctex_inverse(
    app: AppHandle,
    root: String,
    main: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<Option<SyncSource>, String> {
    let pdf = pdf_path_for(&build_dir(&app, &root)?, &main);
    if !pdf.exists() {
        return Ok(None);
    }
    let out = Command::new("synctex")
        .arg("edit")
        .arg("-o")
        .arg(format!("{page}:{x}:{y}:{}", pdf.display()))
        .output()
        .await
        .map_err(err)?;
    let fields = synctex_fields(&String::from_utf8_lossy(&out.stdout));
    let input = fields.iter().find(|(k, _)| k == "Input").map(|(_, v)| v.clone());
    let line = fields
        .iter()
        .find(|(k, _)| k == "Line")
        .and_then(|(_, v)| v.trim().parse::<u32>().ok());
    let (Some(input), Some(line)) = (input, line) else {
        return Ok(None);
    };
    // synctex devuelve rutas tipo /proyecto/./cap/a.tex; las normalizamos.
    let mut p = PathBuf::from(&input);
    if p.is_relative() {
        p = Path::new(&main).parent().unwrap_or(Path::new(&root)).join(p);
    }
    let file = std::fs::canonicalize(&p)
        .unwrap_or(p)
        .to_string_lossy()
        .to_string();
    Ok(Some(SyncSource { file, line }))
}

#[tauri::command]
async fn word_count(main: String) -> Result<String, String> {
    let main_path = Path::new(&main);
    let out = Command::new("texcount")
        .current_dir(main_path.parent().unwrap_or(Path::new(".")))
        .arg("-inc")
        .arg("-total")
        .arg("-utf8")
        .arg(main_path.file_name().unwrap_or_default())
        .output()
        .await
        .map_err(|e| format!("No se pudo ejecutar texcount: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_tree,
            read_text,
            write_text,
            read_binary,
            path_exists,
            create_dir,
            rename_path,
            delete_path,
            copy_file,
            check_tools,
            compile,
            stop_compile,
            clean_build,
            synctex_forward,
            synctex_inverse,
            word_count
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar LocalTeX");
}
