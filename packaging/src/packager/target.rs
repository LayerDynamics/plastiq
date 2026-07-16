use std::{fmt, path::Path};

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HostPlatform {
    Macos,
    Windows,
    Linux,
}

impl HostPlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Macos
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

impl fmt::Display for HostPlatform {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Macos => formatter.write_str("macos"),
            Self::Windows => formatter.write_str("windows"),
            Self::Linux => formatter.write_str("linux"),
        }
    }
}

pub fn is_native_installer(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let lowercase = name.to_ascii_lowercase();
    [".dmg", ".pkg", ".msi", ".exe", ".deb", ".rpm", ".appimage"]
        .iter()
        .any(|extension| lowercase.ends_with(extension))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_native_installer_formats() {
        assert!(is_native_installer(Path::new("Plastiq.dmg")));
        assert!(is_native_installer(Path::new("plastiq.AppImage")));
        assert!(!is_native_installer(Path::new("plastiq.tar.gz")));
    }
}
