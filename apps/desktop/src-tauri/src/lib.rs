// Plastiq desktop shell. The webview content is the Plastiq CAD editor
// (apps/plastiq): tauri.conf.json points `devUrl` at its Vite dev server and
// `frontendDist` at its build output, so this crate only hosts the window —
// there are no custom Tauri commands yet.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
