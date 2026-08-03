// Plastiq desktop shell. The webview content is the Plastiq CAD editor
// (apps/plastiq). Development services are owned by the Vite wrapper; packaged
// desktop builds own the same five-service supervisor for the app lifetime.

#[cfg(all(desktop, unix, any(not(debug_assertions), test)))]
mod services {
    use std::path::{Path, PathBuf};

    #[cfg(not(debug_assertions))]
    use std::{
        fs::{self, OpenOptions},
        io,
        process::{Child, Command, Stdio},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
        thread,
        time::Duration,
    };
    #[cfg(not(debug_assertions))]
    use tauri::{AppHandle, Manager, Runtime};

    #[derive(Debug, PartialEq, Eq)]
    struct ServicePaths {
        repository: PathBuf,
        script: PathBuf,
        state: PathBuf,
        log: PathBuf,
        owner: String,
    }

    fn service_paths(resource_dir: &Path, data_dir: &Path, process_id: u32) -> ServicePaths {
        let repository = resource_dir.join("orchestrator");
        let state = data_dir.join("services");
        ServicePaths {
            script: repository.join("scripts/dev-services.sh"),
            repository,
            log: state.join("orchestrator.log"),
            state,
            owner: format!("desktop-{process_id}"),
        }
    }

    #[cfg(not(debug_assertions))]
    pub struct ServiceRuntime {
        child: Arc<Mutex<Option<Child>>>,
        stopping: Arc<AtomicBool>,
        paths: ServicePaths,
    }

    #[cfg(not(debug_assertions))]
    impl ServiceRuntime {
        pub fn start<R: Runtime>(app: &AppHandle<R>) -> io::Result<Self> {
            let resource_dir = app.path().resource_dir().map_err(|error| {
                io::Error::other(format!("resolve resource directory: {error}"))
            })?;
            let data_dir = app.path().app_local_data_dir().map_err(|error| {
                io::Error::other(format!("resolve app-local data directory: {error}"))
            })?;
            let paths = service_paths(&resource_dir, &data_dir, std::process::id());
            if !paths.script.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!(
                        "bundled service supervisor is missing: {}",
                        paths.script.display()
                    ),
                ));
            }
            fs::create_dir_all(&paths.state)?;
            let stdout = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&paths.log)?;
            let stderr = stdout.try_clone()?;
            let child = Command::new("bash")
                .arg(&paths.script)
                .arg("start")
                .current_dir(&paths.repository)
                .env("PLASTIQ_SERVICE_REPO_ROOT", &paths.repository)
                .env("PLASTIQ_SERVICE_STATE_DIR", &paths.state)
                .env("PLASTIQ_SERVICE_OWNER", &paths.owner)
                .stdin(Stdio::null())
                .stdout(Stdio::from(stdout))
                .stderr(Stdio::from(stderr))
                .spawn()?;

            let child = Arc::new(Mutex::new(Some(child)));
            let stopping = Arc::new(AtomicBool::new(false));
            Self::monitor(app.clone(), Arc::clone(&child), Arc::clone(&stopping));
            Ok(Self {
                child,
                stopping,
                paths,
            })
        }

        fn monitor<R: Runtime>(
            app: AppHandle<R>,
            child: Arc<Mutex<Option<Child>>>,
            stopping: Arc<AtomicBool>,
        ) {
            thread::spawn(move || loop {
                thread::sleep(Duration::from_secs(1));
                if stopping.load(Ordering::Acquire) {
                    return;
                }
                let exited = child
                    .lock()
                    .expect("service supervisor child lock poisoned")
                    .as_mut()
                    .and_then(|child| child.try_wait().ok().flatten());
                if let Some(status) = exited {
                    eprintln!("Plastiq service supervisor exited unexpectedly: {status}");
                    app.exit(1);
                    return;
                }
            });
        }

        pub fn stop(&self) {
            if self.stopping.swap(true, Ordering::AcqRel) {
                return;
            }
            // Stop the monitor before its owned services. Otherwise a long,
            // orderly five-service shutdown could trigger the restart policy.
            let mut guard = self
                .child
                .lock()
                .expect("service supervisor child lock poisoned");
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            drop(guard);

            // The state file fingerprints every service PID. This fallback is
            // therefore safe after a crash or forced supervisor termination.
            let status = Command::new("bash")
                .arg(&self.paths.script)
                .arg("stop")
                .arg("--owner")
                .arg(&self.paths.owner)
                .current_dir(&self.paths.repository)
                .env("PLASTIQ_SERVICE_REPO_ROOT", &self.paths.repository)
                .env("PLASTIQ_SERVICE_STATE_DIR", &self.paths.state)
                .status();
            if let Err(error) = status {
                eprintln!("failed to request service shutdown: {error}");
            }
        }
    }

    #[cfg(not(debug_assertions))]
    impl Drop for ServiceRuntime {
        fn drop(&mut self) {
            self.stop();
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn bundled_paths_and_owner_are_app_scoped() {
            let paths = service_paths(Path::new("/bundle"), Path::new("/data"), 42);
            assert_eq!(paths.repository, PathBuf::from("/bundle/orchestrator"));
            assert_eq!(
                paths.script,
                PathBuf::from("/bundle/orchestrator/scripts/dev-services.sh")
            );
            assert_eq!(paths.state, PathBuf::from("/data/services"));
            assert_eq!(paths.log, PathBuf::from("/data/services/orchestrator.log"));
            assert_eq!(paths.owner, "desktop-42");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    #[cfg(all(desktop, unix, not(debug_assertions)))]
    {
        use tauri::Manager;
        builder = builder.setup(|app| {
            let runtime = services::ServiceRuntime::start(app.handle())?;
            app.manage(runtime);
            Ok(())
        });
    }

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app, event| {
        #[cfg(all(desktop, unix, not(debug_assertions)))]
        if matches!(event, tauri::RunEvent::Exit) {
            use tauri::Manager;
            if let Some(runtime) = app.try_state::<services::ServiceRuntime>() {
                runtime.stop();
            }
        }
        #[cfg(not(all(desktop, unix, not(debug_assertions))))]
        let _ = (app, event);
    });
}
